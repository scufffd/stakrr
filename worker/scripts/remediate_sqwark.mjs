/**
 * One-off SQWARK remediation runbook. Drains the 51.4M SQWARK that's stuck
 * in the stake-mint reward vault to GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC
 * (the backup-treasury wallet), wipes the broken reward-line state, and
 * primes every active position cleanly so future early-unstake penalties
 * accrue normally.
 *
 * Why this script exists, in order:
 *   1. The on-chain `claim` handler runs a "baseline-safe init" — when a
 *      checkpoint doesn't exist, it gets created at the CURRENT
 *      `acc_per_share`. That's correct for new stakers but it silently
 *      forfeits historical penalty rewards for stakers who joined before
 *      the stake-mint reward line was registered, never had their
 *      checkpoint primed, and then claimed for the first time after
 *      penalties had bumped the accumulator. GE9JWdz hit this and
 *      forfeited 4.68M SQWARK; the other 7 active stakers were headed
 *      for the same outcome before the frontend safety gate landed.
 *   2. The user has chosen to redirect the entire stake-mint reward vault
 *      (51.44M SQWARK including ~36.8M orphan from past closed positions)
 *      to GE9JWdz as a one-off backup-treasury sweep, then reset the
 *      reward-line state so future penalties split among current stakers
 *      via the existing `acc_per_share` math.
 *
 * Steps (each step is idempotent — re-runnable after a partial failure):
 *   1. set_paused(true)
 *   2. createATA(GE9JWdz, SQWARK) if missing
 *   3. sweep_reward_vault(amount=0)  // 0 means "everything"
 *   4. admin_reset_reward_mint(acc_per_share=0, totalDeposited=0, totalClaimed=0)
 *   5. admin_reset_checkpoint(GE9JWdz_position, stake_mint_reward, 0)
 *      — only if their checkpoint exists; zeroes the pinned 249481640083236407
 *   6. prime_checkpoint(other_7_positions, stake_mint_reward)
 *      — they had no checkpoint yet; bake them in at the new acc_per_share=0
 *   7. set_paused(false)
 *
 * Invariants checked at the end:
 *   - Vault SQWARK balance = 0
 *   - reward_mint.acc_per_share = 0
 *   - All active positions have checkpoint with acc_per_share = 0
 *   - Pool unpaused
 *
 * Usage:
 *   node scripts/remediate_sqwark.mjs               # dry-run (default)
 *   node scripts/remediate_sqwark.mjs --execute     # actually send txs
 *   node scripts/remediate_sqwark.mjs --execute --skip-pause   # if pool already paused/unpaused mid-run
 *
 * Requires PLATFORM_AUTHORITY_PRIVATE_KEY (or PLATFORM_TREASURY_PRIVATE_KEY)
 * in env to match the on-chain pool.authority.
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
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import {
  findPoolPda,
  findRewardMintPda,
  findCheckpointPda,
  fetchPool,
  fetchActivePositions,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
  setPausedIx,
  sweepRewardVaultIx,
  adminResetRewardMintIx,
  adminResetCheckpointIx,
  primeCheckpointIx,
} from '../src/stake-program.js';
import { config } from '../src/config.js';

const SQWARK_MINT = new PublicKey('yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump');
const BACKUP_TREASURY = new PublicKey('GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC');

/**
 * SQWARK's pool was initialised by the user's personal connected wallet
 * (`Aik2nZeQ…`), NOT by the platform treasury/authority — so we read a
 * dedicated `POOL_AUTH` env var (raw base58 secretKey) instead of using
 * `authoritySigner()` from config. The keypair only needs to live in the
 * local .env for the duration of the remediation run.
 */
function loadPoolAuthority() {
  const raw = (process.env.POOL_AUTH || '').trim();
  if (!raw) {
    throw new Error(
      'POOL_AUTH env var missing (base58 secretKey for the SQWARK pool authority)',
    );
  }
  let secret;
  try {
    secret = bs58.decode(raw);
  } catch {
    throw new Error('POOL_AUTH must be base58-encoded 64-byte secret key');
  }
  if (secret.length !== 64) {
    throw new Error(`POOL_AUTH decoded to ${secret.length} bytes (expected 64)`);
  }
  return Keypair.fromSecretKey(secret);
}

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');
const SKIP_PAUSE = args.has('--skip-pause');
const SKIP_UNPAUSE = args.has('--skip-unpause');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

function fmtTokens(raw, decimals = 6) {
  const v = Number(raw) / Math.pow(10, decimals);
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

async function getVaultBalanceRaw() {
  const vault = getAssociatedTokenAddressSync(
    SQWARK_MINT,
    findPoolPda(SQWARK_MINT),
    true,
    TOKEN_2022_PROGRAM_ID,
  );
  const bal = await connection.getTokenAccountBalance(vault).catch(() => null);
  return bal ? BigInt(bal.value.amount) : 0n;
}

async function send(label, ixs, signer, extraSigners = []) {
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const tx = new Transaction().add(cuPriceIx, cuLimitIx, ...ixs);
  tx.feePayer = signer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  if (!EXECUTE) {
    console.log(`  [DRY-RUN] ${label}  (${ixs.length} ix${ixs.length === 1 ? '' : 's'})`);
    return null;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, [signer, ...extraSigners], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`  ✓ ${label}   sig=${sig}`);
  return sig;
}

async function main() {
  console.log('==============================================================');
  console.log(`SQWARK remediation runbook  (${EXECUTE ? 'EXECUTE' : 'DRY-RUN'})`);
  console.log('==============================================================');
  console.log(`  RPC:           ${RPC}`);
  console.log(`  SQWARK mint:   ${SQWARK_MINT.toBase58()}`);
  console.log(`  Backup vault:  ${BACKUP_TREASURY.toBase58()}`);
  console.log(`  Program ID:    ${config.programId.toBase58()}`);

  const authority = loadPoolAuthority();
  console.log(`  Authority:     ${authority.publicKey.toBase58()}  (from POOL_AUTH)`);

  // ---- Preflight ---------------------------------------------------------
  const pool = findPoolPda(SQWARK_MINT);
  console.log(`  Pool PDA:      ${pool.toBase58()}`);

  const poolAcct = await fetchPool({ connection, stakeMint: SQWARK_MINT });
  if (!poolAcct) throw new Error('Pool not found');
  if (!poolAcct.authority.equals(authority.publicKey)) {
    throw new Error(
      `Authority mismatch: pool.authority=${poolAcct.authority.toBase58()} but env signer=${authority.publicKey.toBase58()}`,
    );
  }
  console.log(`  Pool paused?:  ${poolAcct.paused}`);

  const rewardMintPda = findRewardMintPda(pool, SQWARK_MINT);
  const rm = await fetchRewardMint({ connection, stakeMint: SQWARK_MINT, rewardMint: SQWARK_MINT });
  if (!rm) throw new Error('Stake-mint reward line not found — has it been added?');
  console.log(`  Reward line:   ${rewardMintPda.toBase58()}`);
  console.log(`  acc_per_share: ${rm.accPerShare.toString()}`);
  console.log(`  total_dep:     ${rm.totalDeposited.toString()} (raw)  = ${fmtTokens(rm.totalDeposited.toString())} SQWARK`);
  console.log(`  total_clm:     ${rm.totalClaimed.toString()} (raw)  = ${fmtTokens(rm.totalClaimed.toString())} SQWARK`);

  const vaultBalBefore = await getVaultBalanceRaw();
  console.log(`  Vault balance: ${vaultBalBefore} (raw)  = ${fmtTokens(vaultBalBefore)} SQWARK`);

  const positions = await fetchActivePositions({ connection, stakeMint: SQWARK_MINT });
  const cpData = await fetchCheckpointsForRewardMint({
    connection,
    stakeMint: SQWARK_MINT,
    rewardMint: SQWARK_MINT,
  });
  console.log(`  Active positions: ${positions.length}`);
  console.log(`  Existing checkpoints on stake-mint reward line: ${cpData.byPosition.size}`);

  const positionsWithCp = [];
  const positionsWithoutCp = [];
  for (const p of positions) {
    const cp = cpData.byPosition.get(p.publicKey.toBase58());
    if (cp && cp.account.accPerShare && BigInt(cp.account.accPerShare.toString()) !== 0n) {
      positionsWithCp.push({ position: p, checkpoint: cp });
    } else if (cp) {
      // checkpoint exists but already at 0 — nothing to do
      positionsWithCp.push({ position: p, checkpoint: cp, alreadyZero: true });
    } else {
      positionsWithoutCp.push(p);
    }
  }
  console.log(`    of which need acc_per_share reset: ${positionsWithCp.filter(x => !x.alreadyZero).length}`);
  console.log(`    of which need fresh prime:         ${positionsWithoutCp.length}`);

  // ---- Recipient ATA -----------------------------------------------------
  const recipientAta = getAssociatedTokenAddressSync(
    SQWARK_MINT,
    BACKUP_TREASURY,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  console.log(`\n  Recipient ATA: ${recipientAta.toBase58()}  ${recipientAtaInfo ? '(exists)' : '(WILL CREATE)'}`);

  console.log('\n--------------------------------------------------------------');
  console.log('Plan:');
  console.log('--------------------------------------------------------------');
  let stepNum = 1;
  if (!poolAcct.paused && !SKIP_PAUSE) console.log(`  ${stepNum++}. set_paused(true)`);
  else console.log(`  ${stepNum++}. set_paused(true)  [SKIPPED — already paused or --skip-pause]`);
  if (!recipientAtaInfo) console.log(`  ${stepNum++}. Create recipient ATA for ${BACKUP_TREASURY.toBase58().slice(0, 8)}…`);
  if (vaultBalBefore > 0n) console.log(`  ${stepNum++}. sweep_reward_vault(amount=0 → all ${fmtTokens(vaultBalBefore)} SQWARK)`);
  else console.log(`  ${stepNum++}. sweep_reward_vault  [SKIPPED — vault already empty]`);
  const rmAcc = BigInt(rm.accPerShare.toString());
  const rmDep = BigInt(rm.totalDeposited.toString());
  const rmClm = BigInt(rm.totalClaimed.toString());
  if (rmAcc !== 0n || rmDep !== 0n || rmClm !== 0n) {
    console.log(`  ${stepNum++}. admin_reset_reward_mint(acc=0, dep=0, clm=0)`);
  } else {
    console.log(`  ${stepNum++}. admin_reset_reward_mint  [SKIPPED — already zero]`);
  }
  for (const { position, alreadyZero } of positionsWithCp) {
    if (alreadyZero) continue;
    console.log(`  ${stepNum++}. admin_reset_checkpoint(${position.publicKey.toBase58().slice(0, 8)}…, acc=0)  [owner=${position.account.owner.toBase58()}]`);
  }
  for (const p of positionsWithoutCp) {
    console.log(`  ${stepNum++}. prime_checkpoint(${p.publicKey.toBase58().slice(0, 8)}…)  [owner=${p.account.owner.toBase58()}]`);
  }
  if (!SKIP_UNPAUSE) console.log(`  ${stepNum++}. set_paused(false)`);
  else console.log(`  ${stepNum++}. set_paused(false)  [SKIPPED via --skip-unpause]`);

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
      stakeMint: SQWARK_MINT,
      paused: true,
    });
    await send('set_paused(true)', [ix], authority);
  }

  // ---- 2. Create recipient ATA + 3. Sweep --------------------------------
  const sweepIxs = [];
  if (!recipientAtaInfo) {
    sweepIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey, // payer
        recipientAta,
        BACKUP_TREASURY,
        SQWARK_MINT,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  if (vaultBalBefore > 0n) {
    const { ix: sweepIx } = await sweepRewardVaultIx({
      connection,
      authority: authority.publicKey,
      stakeMint: SQWARK_MINT,
      rewardTokenMint: SQWARK_MINT,
      recipientAta,
      amount: 0, // sweep everything
    });
    sweepIxs.push(sweepIx);
  }
  if (sweepIxs.length > 0) {
    await send(
      `sweep_reward_vault → ${fmtTokens(vaultBalBefore)} SQWARK to GE9JWdz`,
      sweepIxs,
      authority,
    );
  }

  // ---- 4. Reset reward mint accumulator ---------------------------------
  if (rmAcc !== 0n || rmDep !== 0n || rmClm !== 0n) {
    const { ix } = await adminResetRewardMintIx({
      connection,
      authority: authority.publicKey,
      stakeMint: SQWARK_MINT,
      rewardTokenMint: SQWARK_MINT,
      newAccPerShare: 0,
      newTotalDeposited: 0,
      newTotalClaimed: 0,
    });
    await send('admin_reset_reward_mint(0, 0, 0)', [ix], authority);
  }

  // ---- 5. Reset GE9JWdz checkpoint (and any others pinned > 0) ----------
  for (const { position, alreadyZero } of positionsWithCp) {
    if (alreadyZero) continue;
    const { ix } = await adminResetCheckpointIx({
      connection,
      authority: authority.publicKey,
      stakeMint: SQWARK_MINT,
      rewardTokenMint: SQWARK_MINT,
      position: position.publicKey,
      newAccPerShare: 0,
    });
    await send(
      `admin_reset_checkpoint(${position.publicKey.toBase58().slice(0, 8)}…, 0)`,
      [ix],
      authority,
    );
  }

  // ---- 6. Prime fresh checkpoints for the other stakers -----------------
  for (const p of positionsWithoutCp) {
    const { ix } = await primeCheckpointIx({
      connection,
      payer: authority.publicKey,
      stakeMint: SQWARK_MINT,
      position: p.publicKey,
      rewardTokenMint: SQWARK_MINT,
    });
    await send(
      `prime_checkpoint(${p.publicKey.toBase58().slice(0, 8)}…)  [owner=${p.account.owner.toBase58().slice(0, 8)}…]`,
      [ix],
      authority,
    );
  }

  // ---- 7. Unpause -------------------------------------------------------
  if (!SKIP_UNPAUSE) {
    const { ix } = await setPausedIx({
      connection,
      authority: authority.publicKey,
      stakeMint: SQWARK_MINT,
      paused: false,
    });
    await send('set_paused(false)', [ix], authority);
  }

  // ---- Verification -----------------------------------------------------
  console.log('\n--------------------------------------------------------------');
  console.log('Post-flight verification:');
  console.log('--------------------------------------------------------------');
  const vaultAfter = await getVaultBalanceRaw();
  const rmAfter = await fetchRewardMint({ connection, stakeMint: SQWARK_MINT, rewardMint: SQWARK_MINT });
  const poolAfter = await fetchPool({ connection, stakeMint: SQWARK_MINT });
  const cpAfter = await fetchCheckpointsForRewardMint({
    connection,
    stakeMint: SQWARK_MINT,
    rewardMint: SQWARK_MINT,
  });
  console.log(`  Vault balance:        ${vaultAfter}  (expect 0)  ${vaultAfter === 0n ? '✓' : '✗'}`);
  console.log(`  acc_per_share:        ${rmAfter.accPerShare.toString()}  (expect 0)  ${BigInt(rmAfter.accPerShare.toString()) === 0n ? '✓' : '✗'}`);
  console.log(`  total_deposited:      ${rmAfter.totalDeposited.toString()}  (expect 0)  ${BigInt(rmAfter.totalDeposited.toString()) === 0n ? '✓' : '✗'}`);
  console.log(`  total_claimed:        ${rmAfter.totalClaimed.toString()}  (expect 0)  ${BigInt(rmAfter.totalClaimed.toString()) === 0n ? '✓' : '✗'}`);
  console.log(`  Pool paused:          ${poolAfter.paused}  (expect ${SKIP_UNPAUSE ? 'true' : 'false'})  ${poolAfter.paused === SKIP_UNPAUSE ? '✓' : '✗'}`);
  console.log(`  Checkpoints on line:  ${cpAfter.byPosition.size}  (expect ${positions.length})  ${cpAfter.byPosition.size === positions.length ? '✓' : '✗'}`);
  let allZero = true;
  for (const [_, cp] of cpAfter.byPosition.entries()) {
    if (BigInt(cp.account.accPerShare.toString()) !== 0n) {
      allZero = false;
      console.log(`    ✗ ${cp.publicKey.toBase58()}  acc=${cp.account.accPerShare.toString()}`);
    }
  }
  console.log(`  All checkpoints at 0:  ${allZero ? '✓' : '✗'}`);

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
