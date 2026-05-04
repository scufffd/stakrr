import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  StakeClient,
  DEFAULT_PROGRAM_ID,
  detectMintTokenProgram,
  getStakeProgram,
  makeProvider,
} from '../staking-sdk/index.js';
import { confirmWithFallback } from '../lib/confirm.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Build claim ixs for EVERY reward mint registered on a pool that has either
 * non-zero accrual since the position's last checkpoint OR a non-zero booked
 * `claimable` balance.
 *
 * This is the single source of truth for "drain everything this position is
 * owed across all reward lines". Both the `Claim` button (`claimPositionRewards`
 * below) and the `Unstake` flow (`StakePoolView.onUnstake`) call this so they
 * never silently leave the stake-mint reward line behind. (The stake-mint
 * reward line is where 10% early-unstake penalties accumulate and pay out as
 * additional stake-mint tokens — it's separate from the wSOL line and was
 * previously invisible to the UI.)
 *
 * Returns `{ ixs, wsolAtasToClose }` so callers can decide where to splice the
 * claim ixs (e.g. before/after an unstake ix) and whether to also append the
 * `closeAccount` ixs that auto-unwrap wSOL back to native SOL.
 *
 * Skips reward lines where there's nothing to do — keeps tx size below the
 * 1232-byte limit and avoids paying rent for ATAs the user wouldn't otherwise
 * touch.
 */
export async function buildClaimAllIxs({
  connection,
  client,
  ownerPk,
  positionPk,
}) {
  const ixs = [];
  const wsolAtasToClose = new Set();
  // Reward lines we deliberately did NOT claim because doing so would
  // silently forfeit pending entitlement to the on-chain baseline-safe
  // init. Returned to the caller so the UI can surface a recovery hint
  // instead of pretending nothing was owed.
  const skipped = [];
  const allRewardMints = await client.fetchAllRewardMints();

  for (const rm of allRewardMints) {
    const rewardTokenMint = rm.account.mint;
    let tokenProgram;
    try {
      tokenProgram = await detectMintTokenProgram(connection, rewardTokenMint);
    } catch {
      // Mint missing from chain (shouldn't happen in practice). Skip rather
      // than fail the whole batch.
      continue;
    }

    const rewardMintPda = client.rewardMintPda(rewardTokenMint);
    const ck = await client.fetchCheckpoint(positionPk, rewardMintPda);
    const rmAcc = BigInt(String(rm.account.accPerShare || 0));
    const ckAcc = BigInt(String(ck?.accPerShare || 0));
    const booked = BigInt(String(ck?.claimable || 0));
    if (rmAcc === ckAcc && booked === 0n) continue; // nothing to claim

    // CRITICAL SAFETY GATE: never include a claim ix that would create a
    // first-time `RewardCheckpoint` against a reward line where
    // `acc_per_share` has already grown above zero. The on-chain handler's
    // baseline-safe init (claim.rs) snapshots the checkpoint at the
    // CURRENT acc_per_share to prevent late stakers from retroactively
    // claiming historical rewards — but that protection becomes a footgun
    // for stakers who joined BEFORE the line was registered (or before
    // anyone primed their checkpoint). For them, "first claim against a
    // hot reward line" silently pins them at the current value and
    // forfeits their fair share forever.
    //
    // The correct fix is a server-side prime_checkpoint at the right
    // historical accPerShare (or an admin reset ix added in the program
    // upgrade). Until that lands, skipping this claim ix preserves the
    // option to recover. Surface it via the `skipped` array so the UI
    // can show a "rewards pending recovery" hint instead of silently
    // claiming nothing.
    if (!ck && rmAcc > 0n) {
      skipped.push({
        rewardMint: rewardTokenMint.toBase58(),
        accPerShare: rmAcc.toString(),
        reason: 'first-claim-would-baseline-and-forfeit',
      });
      continue;
    }

    const userAta = getAssociatedTokenAddressSync(
      rewardTokenMint, ownerPk, false, tokenProgram,
    );
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        ownerPk, userAta, ownerPk, rewardTokenMint, tokenProgram,
      ),
    );
    ixs.push(
      await client.claimIx({
        owner: ownerPk,
        position: positionPk,
        rewardTokenMint,
        userTokenAccount: userAta,
        tokenProgram,
      }),
    );
    if (rewardTokenMint.equals(WSOL)) {
      wsolAtasToClose.add(userAta.toBase58());
    }
  }

  return { ixs, wsolAtasToClose, skipped };
}

/**
 * Claim every reward line for a single position in one tx. Wraps
 * `buildClaimAllIxs` with tx assembly + send + confirm. Auto-unwraps any
 * wSOL claimed by closing the wSOL ATA at the end of the tx.
 *
 * The legacy `rewardMode` / `rewardMintB58` parameters are accepted for
 * backward compat with older callers but no longer change behavior — every
 * registered reward line is claimed regardless. This is what lets stakers
 * collect their share of early-unstake penalty redistributions (which post
 * to a separate `RewardMint` keyed off the stake mint itself).
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@coral-xyz/anchor').Wallet} wallet Anchor wallet
 * @param {(tx: Transaction) => Promise<Transaction>} signTransaction
 */
export async function claimPositionRewards({
  connection,
  wallet,
  signTransaction,
  stakeMintB58,
  positionB58,
  programId = DEFAULT_PROGRAM_ID,
  // Accepted for backward compat — ignored. We always claim all reward lines.
  // eslint-disable-next-line no-unused-vars
  rewardMode,
  // eslint-disable-next-line no-unused-vars
  rewardMintB58,
}) {
  if (!wallet?.publicKey) throw new Error('wallet not connected');
  if (!signTransaction) throw new Error('wallet cannot sign transactions');

  const stakeMint = new PublicKey(stakeMintB58);
  const stakeTokenProgram = await detectMintTokenProgram(connection, stakeMint);
  const provider = makeProvider(connection, wallet);
  const program = getStakeProgram(provider, programId);
  const client = new StakeClient({ program, programId, stakeMint, stakeTokenProgram });
  const positionPk = new PublicKey(positionB58);

  const { ixs: claimIxs, wsolAtasToClose } = await buildClaimAllIxs({
    connection,
    client,
    ownerPk: wallet.publicKey,
    positionPk,
  });

  if (claimIxs.length === 0) {
    // Nothing to claim — surface this to the caller so the UI can show a
    // friendly "no rewards yet" toast instead of a successful-empty tx.
    throw new Error('No claimable rewards on this position yet');
  }

  const closeIxs = Array.from(wsolAtasToClose).map((b58) =>
    createCloseAccountInstruction(
      new PublicKey(b58), wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID,
    ),
  );

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;
  for (const ix of [...claimIxs, ...closeIxs]) tx.add(ix);

  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  await confirmWithFallback(connection, sig, { blockhash, lastValidBlockHeight }, { commitment: 'confirmed' });
  return sig;
}
