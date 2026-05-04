// Anchor client wrapping the multi-pool pob-index-stake program for Stakrr.
//
// Stakrr deploys nothing on-chain — every per-token staking pool is a fresh
// `StakePool` account on the existing program. This module builds the four
// instructions Stakrr needs: initialize_pool, add_reward_mint, deposit_rewards,
// claim_push.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { config } from './config.js';

const { Program, AnchorProvider } = anchor;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDL_PATH = path.resolve(__dirname, '..', '..', 'shared', 'idl', 'pob_index_stake.json');

const SEEDS = {
  pool: Buffer.from('pool'),
  reward: Buffer.from('reward'),
  position: Buffer.from('position'),
  checkpoint: Buffer.from('checkpoint'),
};

const VALID_LOCK_DAYS = new Set([1, 3, 7, 14, 21, 30]);

let cachedIdl = null;
function loadIdl() {
  if (!cachedIdl) cachedIdl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
  return { ...cachedIdl, address: config.programId.toBase58() };
}

export function findPoolPda(stakeMint) {
  return PublicKey.findProgramAddressSync([SEEDS.pool, stakeMint.toBuffer()], config.programId)[0];
}

export function findRewardMintPda(pool, mint) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.reward, pool.toBuffer(), mint.toBuffer()],
    config.programId,
  )[0];
}

export function findCheckpointPda(position, rewardMintPda) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.checkpoint, position.toBuffer(), rewardMintPda.toBuffer()],
    config.programId,
  )[0];
}

export function findPositionPda(pool, beneficiary, nonce) {
  const nonceBn = BN.isBN(nonce) ? nonce : new BN(nonce);
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.position,
      pool.toBuffer(),
      beneficiary.toBuffer(),
      nonceBn.toArrayLike(Buffer, 'le', 8),
    ],
    config.programId,
  )[0];
}

export function rewardVaultAta(pool, mint, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, pool, true, tokenProgram);
}

export async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not SPL / Token-2022`);
}

/**
 * Same as `detectTokenProgram` but returns a fallback when the mint isn't on
 * chain yet. Used by the launch flow to pre-build the pool tx in parallel
 * with the Pump create tx (so we can bundle them into a single Phantom
 * prompt).
 *
 * IMPORTANT: pump.fun bonding-curve tokens are owned by **Token-2022**
 * (TokenzQd…) — verifiable on any pump mint. Callers that pre-build pool
 * txs for fresh pump mints MUST pass `fallback = TOKEN_2022_PROGRAM_ID`,
 * otherwise the resulting `stakeVault` ATA will be derived under the
 * wrong token program and the InitializePool ix fails simulation with
 * "incorrect program id for instruction" (the ATA program tries to call
 * GetAccountDataSize on the mint via classic SPL Token, which doesn't own
 * it). Existing mints always get the real owner check.
 */
export async function detectTokenProgramOr(connection, mint, fallback = TOKEN_PROGRAM_ID) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) return fallback;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not SPL / Token-2022`);
}

function keypairWallet(keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(keypair); return tx; }),
  };
}

function readOnlyWallet() {
  return {
    publicKey: config.programId,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
}

/** @param {import('@solana/web3.js').Keypair | PublicKey} k */
export function pubkeyOf(k) {
  return k instanceof PublicKey ? k : k.publicKey;
}

export function loadProgram(connection, signerKeypair) {
  const provider = new AnchorProvider(connection, keypairWallet(signerKeypair), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(loadIdl(), provider);
}

/** Program handle for account reads and unsigned ix builds (no real signer). */
export function loadProgramReadOnly(connection) {
  const provider = new AnchorProvider(connection, readOnlyWallet(), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(loadIdl(), provider);
}

// --- Instruction builders ---------------------------------------------------

export async function initializePoolIx({
  connection,
  authority,
  stakeMint,
  allowMissingMint = false,
  fallbackTokenProgram = TOKEN_2022_PROGRAM_ID,
}) {
  const program = loadProgramReadOnly(connection);
  const authorityPk = pubkeyOf(authority);
  const tokenProgram = allowMissingMint
    ? await detectTokenProgramOr(connection, stakeMint, fallbackTokenProgram)
    : await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, tokenProgram);
  const ix = await program.methods
    .initializePool()
    .accounts({
      authority: authorityPk,
      stakeMint,
      pool,
      stakeVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, stakeVault, tokenProgram };
}

export async function addRewardMintIx({
  connection,
  authority,
  stakeMint,
  rewardMint,
  allowMissingMint = false,
  fallbackTokenProgram = TOKEN_2022_PROGRAM_ID,
}) {
  const program = loadProgramReadOnly(connection);
  const authorityPk = pubkeyOf(authority);
  const tokenProgram = allowMissingMint
    ? await detectTokenProgramOr(connection, rewardMint, fallbackTokenProgram)
    : await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const rewardVault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const ix = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: authorityPk,
      rewardTokenMint: rewardMint,
      rewardMint: rewardMintPda,
      rewardVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, rewardMintPda, rewardVault, tokenProgram };
}

export async function depositRewardsIx({ connection, funder, stakeMint, rewardMint, amountLamports }) {
  const program = loadProgramReadOnly(connection);
  const funderPk = pubkeyOf(funder);
  const tokenProgram = await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const funderAta = getAssociatedTokenAddressSync(rewardMint, funderPk, false, tokenProgram);
  const ix = await program.methods
    .depositRewards(new BN(amountLamports.toString()))
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault,
      funder: funderPk,
      funderTokenAccount: funderAta,
      tokenProgram,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault, funderAta, tokenProgram };
}

/**
 * Build a `stake_for` instruction. Treasury (payer) funds tokens + rent for a
 * fresh position whose `owner` is `beneficiary` — used to atomically stake
 * dev-bought tokens on behalf of a launcher inside the launch flow.
 */
export async function stakeForIx({
  connection,
  payer,           // Keypair | PublicKey — pays + signs stake_for
  stakeMint,
  beneficiary,     // PublicKey — wallet that will own the position
  amountRaw,       // bigint | string | number — raw token units
  lockDays,        // number — must be one of LOCK_TIERS
  nonce,           // BN | number | string
}) {
  if (!VALID_LOCK_DAYS.has(Number(lockDays))) {
    throw new Error(`Invalid lock tier: ${lockDays}`);
  }
  const program = loadProgramReadOnly(connection);
  const payerPk = pubkeyOf(payer);
  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, tokenProgram);
  const payerTokenAccount = getAssociatedTokenAddressSync(stakeMint, payerPk, false, tokenProgram);
  const position = findPositionPda(pool, beneficiary, nonce);
  const nonceBn = BN.isBN(nonce) ? nonce : new BN(nonce);
  const ix = await program.methods
    .stakeFor(new BN(amountRaw.toString()), Number(lockDays), nonceBn, beneficiary)
    .accounts({
      pool,
      stakeMint,
      stakeVault,
      payer: payerPk,
      payerTokenAccount,
      position,
      tokenProgram,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, position, payerTokenAccount, stakeVault, tokenProgram };
}

/**
 * Build a `prime_checkpoint` instruction so a fresh position is baselined
 * against an existing reward mint and starts accruing from the next deposit.
 */
export async function primeCheckpointIx({
  connection,
  payer,           // Keypair | PublicKey — pays rent / signs
  stakeMint,
  position,
  rewardTokenMint,
}) {
  const program = loadProgramReadOnly(connection);
  const payerPk = pubkeyOf(payer);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const ix = await program.methods
    .primeCheckpoint()
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      position,
      checkpoint,
      payer: payerPk,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, checkpoint, rewardMintPda };
}

// --- v2 admin instruction builders -----------------------------------------
// Mirror the on-chain instructions added in the upgrade for SQWARK
// remediation + ongoing operational headroom. All authority-gated; the
// caller is responsible for passing the correct signer.

/**
 * Build a `claim_push` instruction. Same accounting as user-signed `claim`,
 * but `pool.authority` signs and pays for any first-time `RewardCheckpoint`
 * rent. Recipient is enforced on-chain as `position.owner`'s ATA — authority
 * cannot redirect.
 *
 * Used by the auto-push job to settle rewards on a cadence so users don't
 * need to manually claim. For wSOL rewards the user receives wrapped SOL
 * in their wSOL ATA (we can't auto-unwrap since closeAccount needs the ATA
 * owner's signature — they unwrap in their wallet/Jupiter when convenient).
 */
export async function claimPushIx({
  connection,
  authority,
  stakeMint,
  rewardTokenMint,
  position,
  userTokenAccount,
}) {
  const program = loadProgramReadOnly(connection);
  const tokenProgram = await detectTokenProgram(connection, rewardTokenMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const vault = getAssociatedTokenAddressSync(rewardTokenMint, pool, true, tokenProgram);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const ix = await program.methods
    .claimPush()
    .accounts({
      pool,
      authority: pubkeyOf(authority),
      rewardMint: rewardMintPda,
      mint: rewardTokenMint,
      vault,
      position,
      checkpoint,
      userTokenAccount,
      tokenProgram,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault, checkpoint, tokenProgram };
}

export async function setPoolAuthorityIx({ connection, authority, stakeMint, newAuthority }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const ix = await program.methods
    .setPoolAuthority(newAuthority)
    .accounts({ pool, authority: pubkeyOf(authority) })
    .instruction();
  return { ix, pool };
}

export async function setPausedIx({ connection, authority, stakeMint, paused }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const ix = await program.methods
    .setPaused(Boolean(paused))
    .accounts({ pool, authority: pubkeyOf(authority) })
    .instruction();
  return { ix, pool };
}

/**
 * v4: Build a `set_position_early_unstake_bps` instruction.
 *
 * Pool authority writes a per-position early-unstake penalty override into
 * `position.reserved[0..2]` (LE u16). The override takes precedence over the
 * pool default and the global 10% constant when `unstake_early` is called.
 *
 * Typical use: bundle this ix immediately after `stake_for` in the same tx so
 * the override is applied atomically with the stake itself. That's what the
 * presale-autostake batcher and the KOL airdrop / KOL claim accept flows do
 * (see `presale-autostake.js`, `snipe/kol-airdrop.js`, server.js KOL accept).
 *
 * Constraints:
 *   - `bps` must be `<= 9000` (90%) — enforced on-chain.
 *   - `bps == 0` clears the override (revert to pool/global default).
 *   - Position must not be closed.
 *   - Authority must equal `pool.authority`.
 *
 * Cost: ~3.5k CU and ~120 bytes added to the tx; cheap enough to pair with
 * stake_for + prime_checkpoint × N without exceeding the 1232-byte tx limit
 * for typical 1-2 positions per tx batches.
 */
export async function setPositionEarlyUnstakeBpsIx({
  connection,
  authority,        // Keypair | PublicKey — pool authority
  stakeMint,
  position,
  bps,              // u16, 0..=9000
}) {
  const bpsNum = Number(bps);
  if (!Number.isInteger(bpsNum) || bpsNum < 0 || bpsNum > 9000) {
    throw new Error(`Invalid early-unstake bps: ${bps} (must be integer 0..9000)`);
  }
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const ix = await program.methods
    .setPositionEarlyUnstakeBps(bpsNum)
    .accounts({ pool, position, authority: pubkeyOf(authority) })
    .instruction();
  return { ix, pool, position };
}

/**
 * Drain a reward vault to a recipient ATA. `amount = 0` sweeps everything.
 * Caller must have already created `recipientAta` (use
 * `createAssociatedTokenAccountIdempotentInstruction` if unsure).
 */
export async function sweepRewardVaultIx({
  connection,
  authority,
  stakeMint,
  rewardTokenMint,
  recipientAta,
  amount = 0,
}) {
  const program = loadProgramReadOnly(connection);
  const tokenProgram = await detectTokenProgram(connection, rewardTokenMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const vault = getAssociatedTokenAddressSync(rewardTokenMint, pool, true, tokenProgram);
  const ix = await program.methods
    .sweepRewardVault(new BN(amount.toString()))
    .accounts({
      pool,
      authority: pubkeyOf(authority),
      rewardMint: rewardMintPda,
      mint: rewardTokenMint,
      vault,
      recipientAta,
      tokenProgram,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault };
}

export async function adminResetCheckpointIx({
  connection,
  authority,
  stakeMint,
  rewardTokenMint,
  position,
  newAccPerShare,
}) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const ix = await program.methods
    .adminResetCheckpoint(new BN(newAccPerShare.toString()))
    .accounts({
      pool,
      authority: pubkeyOf(authority),
      rewardMint: rewardMintPda,
      position,
      checkpoint,
    })
    .instruction();
  return { ix, pool, rewardMintPda, checkpoint };
}

export async function adminResetRewardMintIx({
  connection,
  authority,
  stakeMint,
  rewardTokenMint,
  newAccPerShare = 0,
  newTotalDeposited = 0,
  newTotalClaimed = 0,
}) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const ix = await program.methods
    .adminResetRewardMint(
      new BN(newAccPerShare.toString()),
      new BN(newTotalDeposited.toString()),
      new BN(newTotalClaimed.toString()),
    )
    .accounts({
      pool,
      authority: pubkeyOf(authority),
      rewardMint: rewardMintPda,
    })
    .instruction();
  return { ix, pool, rewardMintPda };
}

/**
 * Build a v3 `redistribute_orphan` instruction. **No signer required** — this
 * is permissionless. The on-chain handler validates that
 * `vault_balance >= total_deposited - total_claimed` AFTER the bump, so an
 * over-specified `amount` will revert with `InsufficientVaultForRedistribute`
 * and no state changes.
 *
 * `amount` is the orphan to re-attribute to current active stakers. It bumps
 * `reward_mint.acc_per_share` by `(amount × 1e18) / pool.total_effective`
 * and `reward_mint.total_deposited` by `amount`. Vault is NOT touched.
 *
 * Compute it off-chain as:
 *   ```
 *   orphan = vault_balance - sum_over_active[
 *     cp.claimable + (rm.acc_per_share - cp.acc_per_share) * pos.effective / 1e18
 *   ]
 *   ```
 * with a small (~0.1%) safety margin in stakers' favour.
 */
export async function redistributeOrphanIx({
  connection,
  stakeMint,
  rewardTokenMint,
  amount,
}) {
  const program = loadProgramReadOnly(connection);
  const tokenProgram = await detectTokenProgram(connection, rewardTokenMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const vault = getAssociatedTokenAddressSync(rewardTokenMint, pool, true, tokenProgram);
  const ix = await program.methods
    .redistributeOrphan(new BN(amount.toString()))
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      mint: rewardTokenMint,
      vault,
      tokenProgram,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault };
}

export async function fetchPool({ connection, signer: _signerIgnored, stakeMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  return program.account.stakePool.fetchNullable(pool);
}

export async function fetchRewardMint({ connection, signer: _signerIgnored, stakeMint, rewardMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  return program.account.rewardMint.fetchNullable(rewardMintPda);
}

export async function fetchActivePositions({ connection, signer: _signerIgnored, stakeMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  // Position layout: [discriminator(8)][bump(1)][pool(32)] -> filter offset 9.
  const all = await program.account.stakePosition.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  return all.filter((p) => !p.account.closed);
}

/** Open stake positions for `owner` in one pool (non-closed). */
export async function fetchOwnerPositionsInPool({ connection, signer, stakeMint, owner }) {
  const rows = await fetchActivePositions({ connection, signer, stakeMint });
  return rows.filter((p) => p.account.owner.equals(owner));
}

/**
 * Fetch every RewardCheckpoint for a (pool, rewardMint). Indexes by position
 * pubkey so callers can join with a position list cheaply (one RPC call total
 * regardless of staker count). RewardCheckpoint layout:
 *   disc(8) bump(1) position(32) reward_mint(32) acc_per_share(16) claimable(8) total_claimed(8) reserved(16)
 * `reward_mint` lives at offset 8 + 1 + 32 = 41.
 */
export async function fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const all = await program.account.rewardCheckpoint.all([
    { memcmp: { offset: 41, bytes: rewardMintPda.toBase58() } },
  ]);
  const byPosition = new Map();
  for (const cp of all) {
    byPosition.set(cp.account.position.toBase58(), cp);
  }
  return { rewardMintPda, byPosition };
}

/**
 * Stakers leaderboard data for a single mint. Active positions enriched with
 * lifetime claimed + currently-claimable amounts per position, plus the
 * each-staker share of total effective stake (used for "% of pool" UX).
 *
 * If the pool's RewardMint has accrued more `acc_per_share` than the
 * checkpoint last captured, we project the additional claimable so the UI
 * shows up-to-the-second pending fees without forcing each staker to prime.
 *
 * `rewardMint` is the SOL reward (wsol) for `rewardMode === 'sol'` pools, or
 * the stake mint itself for `rewardMode === 'token'`.
 */
export async function fetchStakersLeaderboard({ connection, stakeMint, rewardMint }) {
  const [pool, positions, cpData, rm] = await Promise.all([
    Promise.resolve(findPoolPda(stakeMint)),
    fetchActivePositions({ connection, stakeMint }),
    fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint }),
    fetchRewardMint({ connection, stakeMint, rewardMint }),
  ]);
  const accPerShareLatest = rm?.accPerShare ? new BN(rm.accPerShare.toString()) : new BN(0);
  // MUST match `ACC_PRECISION = 1_000_000_000_000_000_000` (1e18) in
  // programs/pob-index-stake/src/state.rs. The previous 1e12 baked into this
  // file made every leaderboard "pending" reading 1,000,000× too big.
  const SCALE = new BN('1000000000000000000');

  // Total effective for share-of-pool denomination — sum across positions
  // (more reliable than the StakePool's totalEffective if the pool's value
  // is stale due to a missing prime cycle).
  const totalEffective = positions.reduce(
    (acc, p) => acc.add(new BN(p.account.effective.toString())),
    new BN(0),
  );

  const stakers = positions.map((p) => {
    const acc = p.account;
    const effectiveBn = new BN(acc.effective.toString());
    const cp = cpData.byPosition.get(p.publicKey.toBase58());
    const totalClaimedBn = cp ? new BN(cp.account.totalClaimed.toString()) : new BN(0);
    const cpClaimable = cp ? new BN(cp.account.claimable.toString()) : new BN(0);
    const cpAcc = cp ? new BN(cp.account.accPerShare.toString()) : new BN(0);
    const projectedAccrual = accPerShareLatest.gt(cpAcc)
      ? accPerShareLatest.sub(cpAcc).mul(effectiveBn).div(SCALE)
      : new BN(0);
    const claimableBn = cpClaimable.add(projectedAccrual);
    const earnedBn = totalClaimedBn.add(claimableBn);
    const shareBps = totalEffective.gt(new BN(0))
      ? Number(effectiveBn.muln(10_000).div(totalEffective).toString())
      : 0;
    return {
      position: p.publicKey.toBase58(),
      owner: acc.owner.toBase58(),
      amountRaw: acc.amount.toString(),
      effective: effectiveBn.toString(),
      multiplierBps: acc.multiplierBps ?? acc.multiplier_bps ?? 0,
      lockDays: acc.lockDays ?? acc.lock_days ?? 0,
      lockStart: Number(acc.lockStart ?? acc.lock_start ?? 0),
      lockEnd: Number(acc.lockEnd ?? acc.lock_end ?? 0),
      shareBps,
      totalClaimedRaw: totalClaimedBn.toString(),
      claimableRaw: claimableBn.toString(),
      earnedRaw: earnedBn.toString(),
      hasCheckpoint: !!cp,
    };
  });

  // Default sort: largest stake first.
  stakers.sort((a, b) => {
    const A = BigInt(a.effective);
    const B = BigInt(b.effective);
    return A === B ? 0 : (B > A ? 1 : -1);
  });
  return {
    pool: pool.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMintPda: cpData.rewardMintPda.toBase58(),
    accPerShare: accPerShareLatest.toString(),
    totalEffective: totalEffective.toString(),
    stakerCount: stakers.length,
    stakers,
  };
}

export { BN };
