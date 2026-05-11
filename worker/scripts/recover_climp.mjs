/**
 * One-off Bread CLIMP decommission runbook. The launch went wrong (treasury
 * was drained creating ATAs for 39 stakers), so the user is choosing to
 * sweep ALL CLIMP-related funds out of the pool to the backup-treasury
 * wallet (GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC) and leave the pool
 * paused so on-chain interactions can't accidentally wedge things further.
 *
 * What this drains:
 *   1. Stake-mint vault   = 416.8M CLIMP  (= principal of every active position)
 *   2. wSOL reward vault  = 0.058 SOL     (accrued cycle rewards not yet claimed)
 *
 * Steps (each step is idempotent — re-runnable after a partial failure):
 *   1. set_paused(true)               (halts stake / unstake / claim)
 *   2. createATA(GE9JWdz, CLIMP)      idempotent, skipped if exists
 *   3. sweep_reward_vault(stake_mint, amount=0)  → all CLIMP to GE9JWdz
 *   4. createATA(GE9JWdz, wSOL)       idempotent
 *   5. sweep_reward_vault(wSOL,       amount=0)  → all wSOL to GE9JWdz
 *   6. admin_reset_reward_mint(stake_mint, 0,0,0)
 *   7. admin_reset_reward_mint(wSOL,       0,0,0)
 *   8. KEEP pool paused — pool stays decommissioned. Stakers must be
 *      compensated off-chain from the backup treasury (39 positions, see
 *      registry / on-chain `Position` accounts for the per-staker amounts).
 *
 * Usage:
 *   node scripts/recover_climp.mjs                 # dry-run (default)
 *   node scripts/recover_climp.mjs --execute       # actually send txs
 *   node scripts/recover_climp.mjs --execute --skip-pause      # if already paused
 *   node scripts/recover_climp.mjs --execute --skip-resets     # don't zero the accumulators
 *
 * Env vars:
 *   POOL_AUTH       — base58 secretKey for the platform authority
 *                     (= 9sfK1heMLLBCaYhUEH7C2ZsRtQYDCGpa956HEVS6TgWu).
 *                     Falls back to PLATFORM_AUTHORITY_PRIVATE_KEY /
 *                     PLATFORM_TREASURY_PRIVATE_KEY from .env.
 *   FEE_PAYER       — (optional) base58 secretKey to fee-pay txs. Useful
 *                     when POOL_AUTH balance is too low. Defaults to
 *                     POOL_AUTH itself.
 *   SOLANA_RPC_URL  — RPC endpoint
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  findPoolPda,
  findRewardMintPda,
  fetchPool,
  fetchActivePositions,
  fetchRewardMint,
  setPausedIx,
  sweepRewardVaultIx,
  adminResetRewardMintIx,
} from '../src/stake-program.js';
import { config } from '../src/config.js';

const CLIMP_MINT = new PublicKey('qQ3ozw2gsZ37r5shavwNNd8t7QQBJvFh1qqZSGZpump');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
// Recipient is overridable via RECIPIENT env var (base58 pubkey).
const BACKUP_TREASURY = new PublicKey(
  (process.env.RECIPIENT || 'GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC').trim(),
);

function loadKeypairFromBs58(envName, val) {
  const raw = (val || '').trim();
  if (!raw) throw new Error(`${envName} env var missing`);
  let secret;
  try { secret = bs58.decode(raw); } catch { throw new Error(`${envName} must be base58 64-byte secretKey`); }
  if (secret.length !== 64) throw new Error(`${envName} decoded to ${secret.length} bytes (expected 64)`);
  return Keypair.fromSecretKey(secret);
}

function loadPoolAuthority() {
  const raw =
    process.env.POOL_AUTH ||
    process.env.PLATFORM_AUTHORITY_PRIVATE_KEY ||
    process.env.PLATFORM_TREASURY_PRIVATE_KEY;
  return loadKeypairFromBs58('POOL_AUTH', raw);
}

function loadFeePayer(authority) {
  if (!process.env.FEE_PAYER || !process.env.FEE_PAYER.trim()) return authority;
  return loadKeypairFromBs58('FEE_PAYER', process.env.FEE_PAYER);
}

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const SKIP_PAUSE = args.has('--skip-pause');
const SKIP_RESETS = args.has('--skip-resets');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

function fmtTokens(raw, decimals = 6) {
  const v = Number(raw) / Math.pow(10, decimals);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function send(label, ixs, feePayer, signers) {
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const tx = new Transaction().add(cuPriceIx, cuLimitIx, ...ixs);
  tx.feePayer = feePayer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  if (!EXECUTE) {
    console.log(`  [DRY-RUN] ${label}  (${ixs.length} ix${ixs.length === 1 ? '' : 's'})`);
    return null;
  }
  // Dedup signers by pubkey
  const seen = new Set();
  const allSigners = [feePayer, ...signers].filter((kp) => {
    const k = kp.publicKey.toBase58();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sig = await sendAndConfirmTransaction(connection, tx, allSigners, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`  ✓ ${label}   sig=${sig}`);
  return sig;
}

async function main() {
  console.log('==============================================================');
  console.log(`Bread CLIMP decommission runbook  (${EXECUTE ? 'EXECUTE' : 'DRY-RUN'})`);
  console.log('==============================================================');
  console.log(`  RPC:           ${RPC}`);
  console.log(`  CLIMP mint:    ${CLIMP_MINT.toBase58()}  (Token-2022)`);
  console.log(`  Backup vault:  ${BACKUP_TREASURY.toBase58()}`);
  console.log(`  Program ID:    ${config.programId.toBase58()}`);

  const authority = loadPoolAuthority();
  const feePayer = loadFeePayer(authority);
  console.log(`  Authority:     ${authority.publicKey.toBase58()}  (POOL_AUTH)`);
  console.log(`  Fee payer:     ${feePayer.publicKey.toBase58()}${feePayer === authority ? '  (= authority)' : '  (FEE_PAYER)'}`);

  const feePayerLamports = await connection.getBalance(feePayer.publicKey);
  console.log(`  Fee payer SOL: ${(feePayerLamports / 1e9).toFixed(6)}`);
  if (feePayerLamports < 0.02 * 1e9) {
    console.warn(`  ⚠ Fee payer balance is low. Recommend ≥ 0.02 SOL for the full sequence.`);
  }

  // ---- Preflight ---------------------------------------------------------
  const pool = findPoolPda(CLIMP_MINT);
  console.log(`  Pool PDA:      ${pool.toBase58()}`);

  const poolAcct = await fetchPool({ connection, stakeMint: CLIMP_MINT });
  if (!poolAcct) throw new Error('CLIMP pool not found');
  if (!poolAcct.authority.equals(authority.publicKey)) {
    throw new Error(
      `Authority mismatch: pool.authority=${poolAcct.authority.toBase58()} but POOL_AUTH=${authority.publicKey.toBase58()}`,
    );
  }
  console.log(`  Pool paused?:  ${poolAcct.paused}`);

  // Reward lines
  const climpRewardPda = findRewardMintPda(pool, CLIMP_MINT);
  const wsolRewardPda = findRewardMintPda(pool, WSOL_MINT);
  const climpRm = await fetchRewardMint({ connection, stakeMint: CLIMP_MINT, rewardMint: CLIMP_MINT });
  const wsolRm = await fetchRewardMint({ connection, stakeMint: CLIMP_MINT, rewardMint: WSOL_MINT });
  if (!climpRm) throw new Error('CLIMP stake-mint reward line missing — unexpected for v4 pools');
  if (!wsolRm) throw new Error('wSOL reward line missing — unexpected');

  console.log(`  CLIMP rewardMint PDA: ${climpRewardPda.toBase58()}  vault=${climpRm.vault.toBase58()}`);
  console.log(`  wSOL  rewardMint PDA: ${wsolRewardPda.toBase58()}  vault=${wsolRm.vault.toBase58()}`);

  // Vault balances
  const climpVaultBal = await connection.getTokenAccountBalance(climpRm.vault).catch(() => null);
  const wsolVaultBal = await connection.getTokenAccountBalance(wsolRm.vault).catch(() => null);
  const climpRaw = climpVaultBal ? BigInt(climpVaultBal.value.amount) : 0n;
  const wsolRaw = wsolVaultBal ? BigInt(wsolVaultBal.value.amount) : 0n;
  console.log(`  CLIMP vault balance: ${climpRaw} (raw)  = ${fmtTokens(climpRaw)} CLIMP`);
  console.log(`  wSOL  vault balance: ${wsolRaw} lamports = ${(Number(wsolRaw) / 1e9).toFixed(6)} SOL`);

  // Active positions (informational)
  const positions = await fetchActivePositions({ connection, stakeMint: CLIMP_MINT });
  console.log(`  Active positions: ${positions.length}`);

  // Recipient ATAs
  const climpAta = getAssociatedTokenAddressSync(
    CLIMP_MINT, BACKUP_TREASURY, false, TOKEN_2022_PROGRAM_ID,
  );
  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT, BACKUP_TREASURY, false, TOKEN_PROGRAM_ID,
  );
  const climpAtaInfo = await connection.getAccountInfo(climpAta);
  const wsolAtaInfo = await connection.getAccountInfo(wsolAta);
  console.log(`  CLIMP recipient ATA: ${climpAta.toBase58()}  ${climpAtaInfo ? '(exists)' : '(WILL CREATE)'}`);
  console.log(`  wSOL  recipient ATA: ${wsolAta.toBase58()}  ${wsolAtaInfo ? '(exists)' : '(WILL CREATE)'}`);

  console.log('\n--------------------------------------------------------------');
  console.log('Plan:');
  console.log('--------------------------------------------------------------');
  let stepNum = 1;
  if (!poolAcct.paused && !SKIP_PAUSE) console.log(`  ${stepNum++}. set_paused(true)`);
  else console.log(`  ${stepNum++}. set_paused(true)  [SKIPPED — already paused or --skip-pause]`);

  if (climpRaw > 0n) {
    console.log(`  ${stepNum++}. create CLIMP ATA (if needed) + sweep_reward_vault(stake_mint, all=${fmtTokens(climpRaw)} CLIMP)`);
  } else {
    console.log(`  ${stepNum++}. sweep stake_mint vault  [SKIPPED — empty]`);
  }

  if (wsolRaw > 0n) {
    console.log(`  ${stepNum++}. create wSOL ATA (if needed) + sweep_reward_vault(wSOL, all=${(Number(wsolRaw) / 1e9).toFixed(6)} SOL)`);
  } else {
    console.log(`  ${stepNum++}. sweep wSOL vault  [SKIPPED — empty]`);
  }

  if (!SKIP_RESETS) {
    const climpDirty = BigInt(climpRm.accPerShare.toString()) !== 0n
      || BigInt(climpRm.totalDeposited.toString()) !== 0n
      || BigInt(climpRm.totalClaimed.toString()) !== 0n;
    const wsolDirty = BigInt(wsolRm.accPerShare.toString()) !== 0n
      || BigInt(wsolRm.totalDeposited.toString()) !== 0n
      || BigInt(wsolRm.totalClaimed.toString()) !== 0n;
    if (climpDirty) console.log(`  ${stepNum++}. admin_reset_reward_mint(stake_mint, 0,0,0)`);
    if (wsolDirty)  console.log(`  ${stepNum++}. admin_reset_reward_mint(wSOL,        0,0,0)`);
  }

  console.log(`  ${stepNum++}. POOL STAYS PAUSED — decommissioned.`);
  console.log(`     ${positions.length} active positions remain on-chain. Compensate stakers off-chain from GE9JWdz`);
  console.log(`     if/when desired. Pool can be re-opened later via set_paused(false) once admin_reset has`);
  console.log(`     been run on every checkpoint and the vaults topped up.`);

  if (!EXECUTE) {
    console.log('\n--------------------------------------------------------------');
    console.log('DRY-RUN complete. Re-run with --execute to send transactions.');
    console.log('--------------------------------------------------------------');
    return;
  }

  console.log('\n--------------------------------------------------------------');
  console.log('Executing …');
  console.log('--------------------------------------------------------------');

  // ---- 1. Pause ----------------------------------------------------------
  if (!poolAcct.paused && !SKIP_PAUSE) {
    const { ix } = await setPausedIx({
      connection,
      authority: authority.publicKey,
      stakeMint: CLIMP_MINT,
      paused: true,
    });
    await send('set_paused(true)', [ix], feePayer, [authority]);
  }

  // ---- 2. Sweep CLIMP vault ---------------------------------------------
  if (climpRaw > 0n) {
    const ixs = [];
    if (!climpAtaInfo) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          climpAta,
          BACKUP_TREASURY,
          CLIMP_MINT,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
    const { ix: sweepIx } = await sweepRewardVaultIx({
      connection,
      authority: authority.publicKey,
      stakeMint: CLIMP_MINT,
      rewardTokenMint: CLIMP_MINT,
      recipientAta: climpAta,
      amount: 0,
    });
    ixs.push(sweepIx);
    await send(
      `sweep stake-mint vault → ${fmtTokens(climpRaw)} CLIMP to GE9JWdz`,
      ixs,
      feePayer,
      [authority],
    );
  }

  // ---- 3. Sweep wSOL vault ----------------------------------------------
  if (wsolRaw > 0n) {
    const ixs = [];
    if (!wsolAtaInfo) {
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          feePayer.publicKey,
          wsolAta,
          BACKUP_TREASURY,
          WSOL_MINT,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }
    const { ix: sweepIx } = await sweepRewardVaultIx({
      connection,
      authority: authority.publicKey,
      stakeMint: CLIMP_MINT,
      rewardTokenMint: WSOL_MINT,
      recipientAta: wsolAta,
      amount: 0,
    });
    ixs.push(sweepIx);
    await send(
      `sweep wSOL vault → ${(Number(wsolRaw) / 1e9).toFixed(6)} SOL to GE9JWdz`,
      ixs,
      feePayer,
      [authority],
    );
  }

  // ---- 4. Reset accumulators --------------------------------------------
  if (!SKIP_RESETS) {
    const climpDirty = BigInt(climpRm.accPerShare.toString()) !== 0n
      || BigInt(climpRm.totalDeposited.toString()) !== 0n
      || BigInt(climpRm.totalClaimed.toString()) !== 0n;
    if (climpDirty) {
      const { ix } = await adminResetRewardMintIx({
        connection,
        authority: authority.publicKey,
        stakeMint: CLIMP_MINT,
        rewardTokenMint: CLIMP_MINT,
        newAccPerShare: 0,
        newTotalDeposited: 0,
        newTotalClaimed: 0,
      });
      await send('admin_reset_reward_mint(stake_mint, 0,0,0)', [ix], feePayer, [authority]);
    }
    const wsolDirty = BigInt(wsolRm.accPerShare.toString()) !== 0n
      || BigInt(wsolRm.totalDeposited.toString()) !== 0n
      || BigInt(wsolRm.totalClaimed.toString()) !== 0n;
    if (wsolDirty) {
      const { ix } = await adminResetRewardMintIx({
        connection,
        authority: authority.publicKey,
        stakeMint: CLIMP_MINT,
        rewardTokenMint: WSOL_MINT,
        newAccPerShare: 0,
        newTotalDeposited: 0,
        newTotalClaimed: 0,
      });
      await send('admin_reset_reward_mint(wSOL, 0,0,0)', [ix], feePayer, [authority]);
    }
  }

  // ---- Final invariants -------------------------------------------------
  console.log('\n--------------------------------------------------------------');
  console.log('Verifying invariants …');
  console.log('--------------------------------------------------------------');
  const climpAfter = await connection.getTokenAccountBalance(climpRm.vault).catch(() => null);
  const wsolAfter = await connection.getTokenAccountBalance(wsolRm.vault).catch(() => null);
  console.log(`  CLIMP vault balance after: ${climpAfter?.value?.amount || '0'} (raw)`);
  console.log(`  wSOL  vault balance after: ${wsolAfter?.value?.amount || '0'} lamports`);
  const poolAfter = await fetchPool({ connection, stakeMint: CLIMP_MINT });
  console.log(`  Pool paused after:         ${poolAfter.paused}`);
  console.log('\nDone. CLIMP pool is decommissioned. Compensate stakers off-chain from GE9JWdz.');
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e.message || e);
  if (e.logs) console.error('logs:', e.logs);
  process.exit(1);
});
