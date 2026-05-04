/**
 * Orphaned wSOL recovery across pools.
 *
 * "Orphan" = vault balance minus what active stakers can claim. Builds up
 * over a pool's life because `unstake` / `unstake_early` cascade-close the
 * leaving staker's `RewardCheckpoint` accounts. Their wSOL entitlement
 * stays in the vault but no checkpoint references it ever again, so the
 * on-chain `claim` math can't pay it out.
 *
 * THREE modes (in default-preference order):
 *   (a) `--redistribute` (DEFAULT)  Permissionless v3 `redistribute_orphan`
 *       ix. ANY caller bumps `acc_per_share` + `total_deposited` so the
 *       orphan becomes claimable by current stakers. No authority key
 *       required, no token movement. Works for any pool — including ones
 *       launched by third-party deployers whose authority key we don't
 *       have. This is the long-term recommended path and the same logic
 *       the worker cron uses.
 *   (b) `--sweep`  Authority-gated v2 `sweep_reward_vault`. Drains the
 *       orphan to a destination wallet (default: GE9JWdz). Requires the
 *       pool authority key to be loaded from env.
 *   (c) `--admin-redistribute`  Authority-gated `admin_reset_reward_mint`.
 *       Same effect as (a) but signed by pool authority. Useful only if
 *       the v3 ix is unavailable; left in for emergencies.
 *
 * For (a) the script doesn't even need the authority keypair — it can run
 * against every pool on the program. For (b) we list the pools whose
 * authority keys we have in POOLS at the top of the file.
 *
 * Each operation computes the orphan amount LIVE just before sending so
 * the RPC race between the audit and the tx can't accidentally over-credit.
 * We add a 0.1% safety margin so ANY rounding favors stakers, and the v3
 * ix's on-chain validator will revert if our number exceeds the true
 * orphan (defence in depth).
 *
 * Usage:
 *   node scripts/recover_orphan_wsol.mjs                          # dry-run, all pools, redistribute
 *   node scripts/recover_orphan_wsol.mjs --execute                # redistribute all pools
 *   node scripts/recover_orphan_wsol.mjs --execute --sweep        # sweep authority-gated pools to GE9JWdz
 *   node scripts/recover_orphan_wsol.mjs --execute --sweep --to <pubkey>   # custom destination
 *   node scripts/recover_orphan_wsol.mjs --only sqwark            # one pool only
 *   node scripts/recover_orphan_wsol.mjs --threshold 0.01         # min SOL to bother with
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';
import BN from 'bn.js';
import 'dotenv/config';
import {
  findPoolPda,
  findRewardMintPda,
  fetchActivePositions,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
  sweepRewardVaultIx,
  adminResetRewardMintIx,
  redistributeOrphanIx,
} from '../src/stake-program.js';
import { config } from '../src/config.js';

// ---- Configuration ---------------------------------------------------------

const DEFAULT_DESTINATION = 'GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC';

// Pools whose authority keypair we have access to. Used by --sweep and
// --admin-redistribute modes. Default --redistribute (v3 permissionless ix)
// works for ANY pool on the program — these entries are NOT consulted in
// that mode. As more launches happen, the v3 ix scales without entries here.
const POOLS_WITH_KEYS = [
  {
    label: 'SQWARK',
    stakeMint: 'yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump',
    authorityEnv: 'POOL_AUTH',
    expectedAuth: 'Aik2nZeQKU323Mq8pLvcViTynPdeyYYKZPbd257US8Kq',
  },
  {
    label: 'FLfR',
    stakeMint: 'FLfR1oidByB8pgX2zy4MqgUH5VsKEoKbKEcgyRKpump',
    authorityEnv: 'FAITH_KEYPAID',
    expectedAuth: '9J9LczxG4En77Mb7iJUCCpQkhiyq1taQpWYCfgB198HT',
  },
];

// ---- Args ------------------------------------------------------------------

const args = process.argv.slice(2);
const EXECUTE = args.includes('--execute');
const SWEEP = args.includes('--sweep');
const ADMIN_REDISTRIBUTE = args.includes('--admin-redistribute');
const REDISTRIBUTE = !SWEEP && !ADMIN_REDISTRIBUTE; // default mode = permissionless v3 redistribute
const ONLY = (() => {
  const i = args.indexOf('--only');
  return i >= 0 ? args[i + 1].toLowerCase() : null;
})();
const DESTINATION = (() => {
  const i = args.indexOf('--to');
  return i >= 0 ? args[i + 1] : DEFAULT_DESTINATION;
})();
const THRESHOLD_SOL = (() => {
  const i = args.indexOf('--threshold');
  return i >= 0 ? parseFloat(args[i + 1]) : 0.001;
})();

const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

// MUST match `ACC_PRECISION = 1_000_000_000_000_000_000` in state.rs.
const SCALE = new BN('1000000000000000000');

// ---- Helpers ---------------------------------------------------------------

function loadKeypair(envName) {
  const raw = (process.env[envName] || '').trim();
  if (!raw) throw new Error(`env ${envName} missing`);
  const secret = bs58.decode(raw);
  if (secret.length !== 64) throw new Error(`${envName} decoded to ${secret.length} bytes (expected 64)`);
  return Keypair.fromSecretKey(secret);
}

async function computeOrphanForPool(stakeMint) {
  const wsol = NATIVE_MINT;
  const pool = findPoolPda(stakeMint);
  const wsolVault = getAssociatedTokenAddressSync(wsol, pool, true, TOKEN_PROGRAM_ID);
  const balInfo = await connection.getTokenAccountBalance(wsolVault).catch(() => null);
  const vaultBalance = balInfo ? BigInt(balInfo.value.amount) : 0n;

  const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: wsol });
  if (!rm) {
    return { vaultBalance, reservedForActive: 0n, orphan: 0n, accLatest: '0', totalEffective: '0', positions: [] };
  }
  const positions = await fetchActivePositions({ connection, stakeMint });
  const cpData = await fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint: wsol });
  const accLatest = new BN(rm.accPerShare.toString());
  const totalEffective = positions.reduce(
    (s, x) => s.add(new BN(x.account.effective.toString())),
    new BN(0),
  );

  let reservedForActive = 0n;
  for (const pos of positions) {
    const eff = new BN(pos.account.effective.toString());
    const cp = cpData.byPosition.get(pos.publicKey.toBase58());
    if (!cp) continue; // baseline-init at first claim → no past claim
    const cpAcc = new BN(cp.account.accPerShare.toString());
    if (accLatest.lte(cpAcc)) continue;
    const projected = accLatest.sub(cpAcc).mul(eff).div(SCALE);
    const cpClaimable = new BN(cp.account.claimable.toString());
    reservedForActive += BigInt(projected.add(cpClaimable).toString());
  }

  // 0.1% safety margin in favor of stakers
  const safety = reservedForActive / 1000n;
  const safeReserve = reservedForActive + safety;
  const orphan = vaultBalance > safeReserve ? vaultBalance - safeReserve : 0n;

  return {
    vaultBalance,
    reservedForActive,
    orphan,
    accLatest: accLatest.toString(),
    totalEffective: totalEffective.toString(),
    positions,
    rm,
  };
}

async function send(label, ixs, payer, signers) {
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }))
    .add(...ixs);
  tx.feePayer = payer;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  if (!EXECUTE) {
    console.log(`    [DRY-RUN] ${label}  (${ixs.length} ix${ixs.length === 1 ? '' : 's'})`);
    return null;
  }
  const sig = await sendAndConfirmTransaction(connection, tx, signers, {
    commitment: 'confirmed',
    skipPreflight: false,
  });
  console.log(`    ✓ ${label}   sig=${sig}`);
  return sig;
}

// ---- Pool enumeration (for permissionless mode) ----------------------------

async function listAllPools() {
  // StakePool layout = 270 bytes (see state.rs).
  const accs = await connection.getProgramAccounts(config.programId, {
    encoding: 'base64',
    filters: [{ dataSize: 270 }],
  });
  return accs.map((e) => {
    const data = e.account.data;
    const stakeMint = new PublicKey(data.subarray(9 + 32, 9 + 64));
    return {
      label: stakeMint.toBase58().slice(0, 8) + '…',
      stakeMint: stakeMint.toBase58(),
      poolPda: e.pubkey,
    };
  });
}

// ---- Per-pool handling -----------------------------------------------------

async function handleRedistribute(poolCfg, payerKeypair) {
  // Permissionless mode: no authority needed. Anyone can pay tx fees.
  const stakeMint = new PublicKey(poolCfg.stakeMint);
  console.log(`\n┌─ ${poolCfg.label}  (${poolCfg.stakeMint})`);

  const audit = await computeOrphanForPool(stakeMint);
  console.log(`│  vault wSOL:         ${Number(audit.vaultBalance) / 1e9} SOL`);
  console.log(`│  reserved (active):  ${Number(audit.reservedForActive) / 1e9} SOL`);
  console.log(`│  orphan:             ${Number(audit.orphan) / 1e9} SOL`);
  console.log(`│  active stakers:     ${audit.positions.length}`);

  if (audit.orphan === 0n) {
    console.log('│  nothing to redistribute');
    console.log('└─');
    return { recovered: 0n };
  }
  if (Number(audit.orphan) / 1e9 < THRESHOLD_SOL) {
    console.log(`│  below --threshold ${THRESHOLD_SOL} SOL — skipping`);
    console.log('└─');
    return { recovered: 0n };
  }
  if (audit.totalEffective === '0' || audit.positions.length === 0) {
    console.log('│  no active stakers — cannot redistribute (use --sweep instead)');
    console.log('└─');
    return { recovered: 0n };
  }

  console.log(`│  REDISTRIBUTE: ${Number(audit.orphan) / 1e9} SOL → bumps acc_per_share for ${audit.positions.length} active stakers`);

  const { ix } = await redistributeOrphanIx({
    connection,
    stakeMint,
    rewardTokenMint: NATIVE_MINT,
    amount: audit.orphan,
  });
  await send(`redistribute_orphan(${poolCfg.label}, ${Number(audit.orphan) / 1e9} SOL)`, [ix], payerKeypair.publicKey, [payerKeypair]);
  console.log('└─');
  return { recovered: audit.orphan };
}

async function handleAuthorityGated(poolCfg, destination) {
  const stakeMint = new PublicKey(poolCfg.stakeMint);
  console.log(`\n┌─ ${poolCfg.label}  (${poolCfg.stakeMint})`);

  const authority = loadKeypair(poolCfg.authorityEnv);
  if (authority.publicKey.toBase58() !== poolCfg.expectedAuth) {
    throw new Error(
      `${poolCfg.label}: ${poolCfg.authorityEnv} pubkey ${authority.publicKey.toBase58()} != expected ${poolCfg.expectedAuth}`,
    );
  }

  const audit = await computeOrphanForPool(stakeMint);
  console.log(`│  vault wSOL:         ${Number(audit.vaultBalance) / 1e9} SOL`);
  console.log(`│  reserved (active):  ${Number(audit.reservedForActive) / 1e9} SOL`);
  console.log(`│  orphan:             ${Number(audit.orphan) / 1e9} SOL`);

  if (audit.orphan === 0n) {
    console.log('│  nothing to recover');
    console.log('└─');
    return { recovered: 0n };
  }

  if (ADMIN_REDISTRIBUTE) {
    if (audit.totalEffective === '0') {
      console.log('│  no active stakers — cannot redistribute');
      console.log('└─');
      return { recovered: 0n };
    }
    const orphanBn = new BN(audit.orphan.toString());
    const accBump = orphanBn.mul(SCALE).div(new BN(audit.totalEffective));
    const newAcc = new BN(audit.accLatest).add(accBump);
    const newTotalDeposited = new BN(audit.rm.totalDeposited.toString()).add(orphanBn);
    console.log(`│  ADMIN_REDISTRIBUTE: bump acc ${audit.accLatest} → ${newAcc.toString()}`);

    const { ix } = await adminResetRewardMintIx({
      connection,
      authority: authority.publicKey,
      stakeMint,
      rewardTokenMint: NATIVE_MINT,
      newAccPerShare: newAcc,
      newTotalDeposited,
      newTotalClaimed: new BN(audit.rm.totalClaimed.toString()),
    });
    await send(`admin_reset_reward_mint(${poolCfg.label})`, [ix], authority.publicKey, [authority]);
    console.log('└─');
    return { recovered: audit.orphan };
  }

  // SWEEP mode
  const recipientAta = getAssociatedTokenAddressSync(NATIVE_MINT, destination, false, TOKEN_PROGRAM_ID);
  const recipientAtaInfo = await connection.getAccountInfo(recipientAta);
  console.log(`│  destination ATA:    ${recipientAta.toBase58()}  ${recipientAtaInfo ? '(exists)' : '(WILL CREATE)'}`);
  console.log(`│  SWEEP: ${Number(audit.orphan) / 1e9} SOL → ${destination.toBase58()}`);

  const ixs = [];
  if (!recipientAtaInfo) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        recipientAta,
        destination,
        NATIVE_MINT,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }
  const { ix: sweepIx } = await sweepRewardVaultIx({
    connection,
    authority: authority.publicKey,
    stakeMint,
    rewardTokenMint: NATIVE_MINT,
    recipientAta,
    amount: audit.orphan,
  });
  ixs.push(sweepIx);
  await send(`sweep_reward_vault(${poolCfg.label}, ${Number(audit.orphan) / 1e9} SOL)`, ixs, authority.publicKey, [authority]);
  console.log('└─');
  return { recovered: audit.orphan };
}

// ---- Main ------------------------------------------------------------------

async function main() {
  const destination = new PublicKey(DESTINATION);
  const mode = REDISTRIBUTE ? 'REDISTRIBUTE (v3 permissionless)' : SWEEP ? `SWEEP to ${destination.toBase58()}` : 'ADMIN_REDISTRIBUTE';
  console.log('==============================================================');
  console.log(`Orphan wSOL recovery  (${EXECUTE ? 'EXECUTE' : 'DRY-RUN'})`);
  console.log('==============================================================');
  console.log(`  RPC:            ${RPC}`);
  console.log(`  Mode:           ${mode}`);
  console.log(`  Threshold:      ${THRESHOLD_SOL.toFixed(4)} SOL`);
  if (ONLY) console.log(`  Filter:         ${ONLY}`);

  let totalRecovered = 0n;

  if (REDISTRIBUTE) {
    // Permissionless: enumerate ALL pools on the program. Pay fees from
    // PLATFORM_TREASURY (any wallet with SOL would work — choose treasury
    // because it's already loaded and is the obvious "platform" payer).
    const payer = config.treasuryKeypair;
    const allPools = await listAllPools();
    console.log(`  Discovered:     ${allPools.length} pools on program ${config.programId.toBase58()}`);
    for (const p of allPools) {
      if (ONLY && !p.label.toLowerCase().includes(ONLY) && !p.stakeMint.toLowerCase().includes(ONLY)) continue;
      try {
        const r = await handleRedistribute(p, payer);
        totalRecovered += r.recovered;
      } catch (err) {
        console.log(`\n  ✗ ${p.label} failed: ${err.message}`);
      }
    }
  } else {
    // SWEEP / ADMIN_REDISTRIBUTE: only pools whose authority key we have.
    for (const p of POOLS_WITH_KEYS) {
      if (ONLY && p.label.toLowerCase() !== ONLY) continue;
      try {
        const r = await handleAuthorityGated(p, destination);
        totalRecovered += r.recovered;
      } catch (err) {
        console.log(`\n  ✗ ${p.label} failed: ${err.message}`);
      }
    }
  }

  console.log('\n==============================================================');
  const verb = REDISTRIBUTE || ADMIN_REDISTRIBUTE
    ? 'redistributed to current stakers'
    : 'swept to ' + destination.toBase58().slice(0, 8) + '…';
  console.log(`Total ${verb}: ${Number(totalRecovered) / 1e9} SOL`);
  if (!EXECUTE) console.log('Re-run with --execute to send transactions.');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
