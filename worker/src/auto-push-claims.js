// Per-pool auto-push: settle every active staker's claimable rewards via
// `claim_push` so users don't have to visit our UI to receive what they're
// owed. Triggered event-driven from `claim-and-distribute.js` immediately
// after a successful `deposit_rewards` for that pool.
//
// Key design points:
//  - **Per-user opt-out**: stakers can flip `autoPush: false` in user-prefs;
//    we skip them and their rewards stay claimable on the site.
//  - **Threshold-gated**: skip positions whose post-bump claimable is below
//    MIN_AUTO_PUSH_LAMPORTS so we don't burn ~0.0002 SOL of priority fee
//    pushing dust.
//  - **Multi-reward-line**: when the pool has more than one registered
//    reward mint (e.g. SQWARK has wSOL + stake-mint for early-unstake
//    penalty redistribution), iterate all of them. Each (position, reward)
//    pair gets its own claim_push.
//  - **Per-pool authority signer**: pools we control directly via env keys
//    (POOL_AUTH for SQWARK Aik2nZeQ, FAITH_KEYPAID for FLfR 9J9Lczx)
//    benefit even though they predate the platform-as-authority default.
//  - **Batched into multi-ix txs**: pack as many (createATA + claim_push)
//    pairs per tx as fit under the 1232-byte packet budget.
//  - **wSOL stays wrapped**: we can't auto-unwrap because closeAccount
//    requires the ATA owner to sign (which is the user, not us). UI exposes
//    a one-click unwrap as a follow-up enhancement.

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import { config, authoritySigner, getConnection } from './config.js';
import { signAndPollConfirm } from './confirm.js';
import {
  detectTokenProgram,
  fetchActivePositions,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
  findCheckpointPda,
  findPoolPda,
  findRewardMintPda,
  loadProgram,
} from './stake-program.js';
import { isAutoPushEnabled } from './user-prefs.js';

// MUST match `ACC_PRECISION = 1_000_000_000_000_000_000` in state.rs.
const SCALE = new BN('1000000000000000000');

// Per-position claimable threshold — below this we skip the push to avoid
// burning more in priority fee than the user receives. Tuned to ~$1 worth
// of SOL at $200, well above the ~$0.04 priority fee cost per push.
const MIN_AUTO_PUSH_LAMPORTS_WSOL = BigInt(
  process.env.AUTO_PUSH_MIN_LAMPORTS_WSOL || 5_000_000n,
);
// Token rewards (SQWARK-style stake-mint reward line for early-unstake
// penalties) are harder to value in real time, so we use a smaller floor:
// any meaningful amount triggers a push. Override per-deployment if dust
// pushes become a problem.
const MIN_AUTO_PUSH_TOKEN_RAW = BigInt(process.env.AUTO_PUSH_MIN_TOKEN_RAW || 1n);

// Conservative tx packet budget so a tightly-packed batch always fits with
// signatures + headers. ~1180 of the 1232-byte v0 limit.
const TX_PACKET_BUDGET_BYTES = 1180;

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

// Auto-push runs in the background — there's no UX urgency, so we use the
// lowest meaningful priority fee instead of inheriting the worker's default
// (1_000_000 micro-lamports/CU is right for launch txs that race snipers,
// but ~50,000 lamports of priority per push adds up across hundreds of
// stakers/cycle). 1 micro-lamport/CU gives effectively-free inclusion in
// normal congestion — under heavy chain load the txs may take longer to
// land, which is acceptable for a settle-when-you-can flow. Bump via
// AUTO_PUSH_PRIORITY_MICROLAMPORTS if observability shows persistent
// confirmation lag.
const AUTO_PUSH_PRIORITY_MICROLAMPORTS = Number(
  process.env.AUTO_PUSH_PRIORITY_MICROLAMPORTS ?? 1,
);

function priorityFeeIx() {
  if (!AUTO_PUSH_PRIORITY_MICROLAMPORTS || AUTO_PUSH_PRIORITY_MICROLAMPORTS <= 0) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: AUTO_PUSH_PRIORITY_MICROLAMPORTS,
  });
}

// ---- Per-pool authority resolution ----------------------------------------

/**
 * Resolve a Keypair that can sign `claim_push` for this pool, or null if
 * we don't have one. Tries the platform authority first (covers all new
 * launches via the v3 launch-flow rotation), then falls back to per-pool
 * env keys for legacy pools whose authority is still the original deployer.
 */
function resolvePoolAuthorityKeypair(onchainPoolAuthority) {
  // Fast path: platform-authority pools (the default for new launches).
  const platform = authoritySigner();
  if (platform && onchainPoolAuthority.equals(platform.publicKey)) return platform;

  // Per-pool overrides for legacy pools we still control.
  const overrides = [
    { env: 'POOL_AUTH', label: 'POOL_AUTH (SQWARK)' },
    { env: 'FAITH_KEYPAID', label: 'FAITH_KEYPAID (FLfR)' },
  ];
  for (const { env, label } of overrides) {
    const raw = (process.env[env] || '').trim();
    if (!raw) continue;
    try {
      const kp = Keypair.fromSecretKey(bs58.decode(raw));
      if (kp.publicKey.equals(onchainPoolAuthority)) return kp;
    } catch (e) {
      log('auto-push: bad keypair env', { env: label, error: e.message });
    }
  }
  return null;
}

// ---- Per (position, reward_mint) computation ------------------------------

function computeClaimableLamports({ rewardMintAcc, positionEffective, checkpoint }) {
  const accLatest = new BN(rewardMintAcc.toString());
  const eff = new BN(positionEffective.toString());
  if (!checkpoint) {
    // No checkpoint exists yet. claim_push will init it AT the current
    // acc_per_share inside the same ix, so the user accrues NOTHING from
    // past deposits — only future ones. Skip; nothing to push right now.
    return 0n;
  }
  const cpAcc = new BN(checkpoint.account.accPerShare.toString());
  const cpClaimable = new BN(checkpoint.account.claimable.toString());
  if (accLatest.lte(cpAcc)) {
    return BigInt(cpClaimable.toString());
  }
  const projected = accLatest.sub(cpAcc).mul(eff).div(SCALE);
  return BigInt(projected.add(cpClaimable).toString());
}

// ---- claim_push ix builder (uses same pattern as buildClaimPushIx in
// claim-and-distribute.js but enumerates the user_token_account for the
// CALLER so we can also include an idempotent ATA-create) ------------------

async function buildPushPair({
  connection,
  authority,
  stakeMint,
  rewardMint,
  position,
  positionOwner,
  tokenProgram,
}) {
  const program = loadProgram(connection, authority);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const userTokenAccount = getAssociatedTokenAddressSync(rewardMint, positionOwner, false, tokenProgram);

  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    authority.publicKey,
    userTokenAccount,
    positionOwner,
    rewardMint,
    tokenProgram,
  );

  const claimIx = await program.methods
    .claimPush()
    .accounts({
      pool,
      authority: authority.publicKey,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault,
      position,
      checkpoint,
      userTokenAccount,
      tokenProgram,
      systemProgram: SystemProgram.programId,
      rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
    })
    .instruction();

  return [ataIx, claimIx];
}

// ---- Tx packing -----------------------------------------------------------

function packIxsIntoTxs({ groups, feePayer, recentBlockhash }) {
  const txs = [];
  let current = new Transaction();
  current.feePayer = feePayer;
  current.recentBlockhash = recentBlockhash;
  const fee = priorityFeeIx();
  if (fee) current.add(fee);

  const sizeOf = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };

  for (const group of groups) {
    const trial = Transaction.from(current.serialize({ requireAllSignatures: false, verifySignatures: false }));
    trial.feePayer = feePayer;
    trial.recentBlockhash = recentBlockhash;
    for (const ix of group) trial.add(ix);
    if (sizeOf(trial) <= TX_PACKET_BUDGET_BYTES) {
      for (const ix of group) current.add(ix);
    } else {
      const baseLen = priorityFeeIx() ? 1 : 0;
      if (current.instructions.length > baseLen) txs.push(current);
      current = new Transaction();
      current.feePayer = feePayer;
      current.recentBlockhash = recentBlockhash;
      const f = priorityFeeIx();
      if (f) current.add(f);
      for (const ix of group) current.add(ix);
    }
  }
  const baseLen = priorityFeeIx() ? 1 : 0;
  if (current.instructions.length > baseLen) txs.push(current);
  return txs;
}

// ---- Public entrypoint: push for one pool, all reward mints ----------------

/**
 * Build and send `claim_push` txs for every active position in `stakeMint`'s
 * pool, across every reward mint passed in.
 *
 * Returns a per-reward-mint summary suitable for inclusion in the cycle log.
 *
 * @param {object} opts
 * @param {Connection} opts.connection
 * @param {PublicKey} opts.stakeMint
 * @param {PublicKey[]} opts.rewardMints  reward mints to push (1+)
 * @param {Keypair}   [opts.authorityOverride]  optional explicit signer
 *   (used when the caller already knows which keypair owns the pool;
 *   bypasses the resolvePoolAuthorityKeypair lookup)
 * @param {bigint}    [opts.minPushLamports]  override the threshold
 */
export async function pushClaimsForPool({
  connection,
  stakeMint,
  rewardMints,
  authorityOverride = null,
  minPushLamports = null,
}) {
  if (!Array.isArray(rewardMints) || rewardMints.length === 0) {
    return { perReward: [], totalPushed: 0, totalSkipped: 0, totalOptedOut: 0 };
  }

  // Determine the on-chain pool authority so we know which keypair to use.
  const program = loadProgram(connection, authoritySigner());
  const pool = findPoolPda(stakeMint);
  const onchain = await program.account.stakePool.fetchNullable(pool);
  if (!onchain) return { perReward: [], totalPushed: 0, totalSkipped: 0, totalOptedOut: 0 };

  const authority = authorityOverride || resolvePoolAuthorityKeypair(onchain.authority);
  if (!authority) {
    log('auto-push: no authority keypair available — skipping', {
      stakeMint: stakeMint.toBase58(),
      poolAuthority: onchain.authority.toBase58(),
    });
    return { perReward: [], totalPushed: 0, totalSkipped: 0, totalOptedOut: 0, reason: 'no_authority' };
  }

  const positions = await fetchActivePositions({ connection, stakeMint });
  if (positions.length === 0) {
    return { perReward: [], totalPushed: 0, totalSkipped: 0, totalOptedOut: 0 };
  }

  const perReward = [];
  let totalPushed = 0;
  let totalSkipped = 0;
  let totalOptedOut = 0;
  const allGroups = [];

  for (const rewardMint of rewardMints) {
    const tokenProgram = await detectTokenProgram(connection, rewardMint);
    const rm = await fetchRewardMint({ connection, stakeMint, rewardMint });
    if (!rm) continue;
    const cpData = await fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint });

    const isWsol = rewardMint.equals(NATIVE_MINT);
    const threshold = minPushLamports != null
      ? BigInt(minPushLamports)
      : (isWsol ? MIN_AUTO_PUSH_LAMPORTS_WSOL : MIN_AUTO_PUSH_TOKEN_RAW);

    let pushed = 0;
    let skippedBelowThreshold = 0;
    let optedOut = 0;

    for (const p of positions) {
      const owner = p.account.owner.toBase58();
      if (!isAutoPushEnabled(owner)) {
        optedOut += 1;
        continue;
      }
      const cp = cpData.byPosition.get(p.publicKey.toBase58());
      const claimable = computeClaimableLamports({
        rewardMintAcc: rm.accPerShare,
        positionEffective: p.account.effective,
        checkpoint: cp,
      });
      if (claimable < threshold) {
        skippedBelowThreshold += 1;
        continue;
      }
      try {
        const pair = await buildPushPair({
          connection,
          authority,
          stakeMint,
          rewardMint,
          position: p.publicKey,
          positionOwner: p.account.owner,
          tokenProgram,
        });
        allGroups.push(pair);
        pushed += 1;
      } catch (e) {
        log('auto-push: build failed', {
          stakeMint: stakeMint.toBase58(),
          rewardMint: rewardMint.toBase58(),
          position: p.publicKey.toBase58(),
          error: e.message,
        });
        skippedBelowThreshold += 1;
      }
    }

    perReward.push({
      rewardMint: rewardMint.toBase58(),
      eligible: pushed,
      belowThreshold: skippedBelowThreshold,
      optedOut,
    });
    totalPushed += pushed;
    totalSkipped += skippedBelowThreshold;
    totalOptedOut += optedOut;
  }

  if (allGroups.length === 0) {
    return { perReward, totalPushed, totalSkipped, totalOptedOut, txSigs: [] };
  }

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const txs = packIxsIntoTxs({ groups: allGroups, feePayer: authority.publicKey, recentBlockhash: blockhash });
  const sigs = [];
  for (const tx of txs) {
    try {
      const s = await signAndPollConfirm(connection, tx, [authority], {
        commitment: 'confirmed',
        label: 'auto_push_claims',
      });
      sigs.push(s);
    } catch (e) {
      log('auto-push: tx failed', { stakeMint: stakeMint.toBase58(), error: e.message });
    }
  }

  log('auto-push: completed', {
    stakeMint: stakeMint.toBase58(),
    authority: authority.publicKey.toBase58(),
    totalPushed,
    totalSkipped,
    totalOptedOut,
    txCount: sigs.length,
    perReward,
  });

  return { perReward, totalPushed, totalSkipped, totalOptedOut, txSigs: sigs };
}

/**
 * Convenience: enumerate every reward mint registered for a pool by
 * scanning RewardMint accounts where the `pool` field matches. Used by the
 * orchestrator when it doesn't know the registered list ahead of time.
 *
 * RewardMint layout:  disc(8) bump(1) pool(32) ... → pool at offset 9.
 */
export async function listPoolRewardMints({ connection, stakeMint }) {
  const program = loadProgram(connection, authoritySigner());
  const pool = findPoolPda(stakeMint);
  const all = await program.account.rewardMint.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  return all.map((x) => x.account.mint);
}
