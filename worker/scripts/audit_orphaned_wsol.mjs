/**
 * Audit unclaimable / orphaned wSOL sitting in pool reward vaults.
 *
 * Background: when `deposit_rewards` (or the worker's `claim_push`) lands
 * on a pool, it bumps `reward_mint.acc_per_share` proportional to
 * `pool.total_effective` AT THAT MOMENT. Every staker present at that
 * point becomes entitled to `(rm.acc_per_share - cp.acc_per_share) ×
 * position.effective / 1e18` worth of reward.
 *
 * If a staker later closes their position via `unstake` / `unstake_early`,
 * Anchor's `close = owner` constraint on `RewardCheckpoint` cascades all
 * their checkpoints into the trash. The lamports they were "owed" stay
 * in the vault but no living account references them — they're
 * permanently unclaimable from on-chain math alone.
 *
 * For each pool we compute:
 *   reservedForActiveStakers = sum_over_active_positions[
 *     (rm.acc_per_share - cp.acc_per_share) × pos.effective / ACC_PRECISION
 *   ]
 *   orphan = vault_balance - reservedForActiveStakers
 *
 * `orphan` is what we could safely `sweep_reward_vault` from each pool
 * without taking anything stakers can still claim. Numbers can be slightly
 * off due to rounding (we round down each per-position claim to mirror the
 * on-chain integer math, so reservedForActiveStakers is a SLIGHT
 * UNDER-estimate, meaning orphan is a SLIGHT OVER-estimate). We apply a
 * 0.1% safety margin before reporting "safe to sweep".
 *
 * Usage:
 *   node scripts/audit_orphaned_wsol.mjs                     # all pools
 *   node scripts/audit_orphaned_wsol.mjs --mint <mint>       # one pool
 *   node scripts/audit_orphaned_wsol.mjs --threshold 0.005   # minimum SOL to report (default 0.001)
 *   node scripts/audit_orphaned_wsol.mjs --json              # machine-readable
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  findPoolPda,
  findRewardMintPda,
  fetchActivePositions,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
} from '../src/stake-program.js';
import { config } from '../src/config.js';

const args = process.argv.slice(2);
const SINGLE_MINT = (() => {
  const i = args.indexOf('--mint');
  return i >= 0 ? args[i + 1] : null;
})();
const THRESHOLD_SOL = (() => {
  const i = args.indexOf('--threshold');
  return i >= 0 ? parseFloat(args[i + 1]) : 0.001;
})();
const JSON_OUT = args.includes('--json');

const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

// MUST match `ACC_PRECISION = 1_000_000_000_000_000_000` in state.rs.
const SCALE = new BN('1000000000000000000');
const PLATFORM_AUTHORITY = '9sfK1heMLLBCaYhUEH7C2ZsRtQYDCGpa956HEVS6TgWu';

async function listAllPools() {
  // Pool layout = 8(disc)+1(bump)+32(auth)+32(stake_mint)+32(stake_vault)+8(total_staked)+16(total_eff)+4(reward_count)+8(created_at)+1(paused)+128(reserved) = 270
  const accs = await connection.getProgramAccounts(config.programId, {
    encoding: 'base64',
    filters: [{ dataSize: 270 }],
  });
  return accs.map((e) => {
    const data = e.account.data;
    const bump = data[8];
    const authority = new PublicKey(data.subarray(9, 9 + 32));
    const stakeMint = new PublicKey(data.subarray(9 + 32, 9 + 64));
    const totalStaked = data.readBigUInt64LE(9 + 96);
    return {
      pool: e.pubkey,
      bump,
      authority: authority.toBase58(),
      stakeMint,
      totalStaked: totalStaked.toString(),
    };
  });
}

async function auditPool(p) {
  const stakeMint = p.stakeMint;
  const wsol = config.wsolMint;

  const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: wsol });
  if (!rm) {
    return { ...p, skipped: 'no wsol reward line' };
  }

  const wsolVault = getAssociatedTokenAddressSync(wsol, p.pool, true, TOKEN_PROGRAM_ID);
  const balInfo = await connection.getTokenAccountBalance(wsolVault).catch(() => null);
  const vaultBalance = balInfo ? BigInt(balInfo.value.amount) : 0n;

  const positions = await fetchActivePositions({ connection, stakeMint });
  const cpData = await fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint: wsol });

  const accLatest = new BN(rm.accPerShare.toString());
  const totalEffectiveActive = positions.reduce(
    (s, x) => s.add(new BN(x.account.effective.toString())),
    new BN(0),
  );

  let reservedForActive = 0n;
  for (const pos of positions) {
    const effective = new BN(pos.account.effective.toString());
    const cp = cpData.byPosition.get(pos.publicKey.toBase58());
    if (!cp) {
      // No checkpoint yet — would be initialized on first claim at the current
      // acc_per_share, so they get NOTHING from accruals so far. Don't reserve.
      continue;
    }
    const cpAcc = new BN(cp.account.accPerShare.toString());
    if (accLatest.lte(cpAcc)) continue;
    const projected = accLatest.sub(cpAcc).mul(effective).div(SCALE);
    const cpClaimable = new BN(cp.account.claimable.toString());
    reservedForActive += BigInt(projected.add(cpClaimable).toString());
  }

  // Apply a 0.1% safety margin so we never accidentally short an active staker.
  const safetyMarginRaw = reservedForActive / 1000n;
  const safeReserve = reservedForActive + safetyMarginRaw;
  const orphan = vaultBalance > safeReserve ? vaultBalance - safeReserve : 0n;

  return {
    ...p,
    stakeMint: stakeMint.toBase58(),
    wsolVault: wsolVault.toBase58(),
    vaultBalanceLamports: vaultBalance.toString(),
    vaultBalanceSol: Number(vaultBalance) / 1e9,
    activePositions: positions.length,
    totalEffective: totalEffectiveActive.toString(),
    rewardAccPerShare: accLatest.toString(),
    rewardTotalDeposited: rm.totalDeposited.toString(),
    rewardTotalClaimed: rm.totalClaimed.toString(),
    reservedForActiveLamports: reservedForActive.toString(),
    reservedForActiveSol: Number(reservedForActive) / 1e9,
    orphanLamports: orphan.toString(),
    orphanSol: Number(orphan) / 1e9,
    authorityIsPlatform: p.authority === PLATFORM_AUTHORITY,
  };
}

async function main() {
  let pools;
  if (SINGLE_MINT) {
    const stakeMint = new PublicKey(SINGLE_MINT);
    const pool = findPoolPda(stakeMint);
    const acc = await connection.getAccountInfo(pool);
    if (!acc) throw new Error(`pool not found for ${SINGLE_MINT}`);
    const data = acc.data;
    pools = [
      {
        pool: pool.toBase58(),
        bump: data[8],
        authority: new PublicKey(data.subarray(9, 41)).toBase58(),
        stakeMint,
        totalStaked: data.readBigUInt64LE(105).toString(),
      },
    ];
  } else {
    pools = await listAllPools();
  }

  if (!JSON_OUT) {
    console.log('==============================================================');
    console.log(`Orphaned wSOL audit  (${RPC})`);
    console.log('==============================================================');
    console.log(`  Total pools:         ${pools.length}`);
    console.log(`  Threshold to report: ${THRESHOLD_SOL.toFixed(4)} SOL`);
    console.log(`  Safety margin:       0.1% of active reservation`);
    console.log();
  }

  const results = [];
  let totalOrphanSol = 0;
  let totalReservedSol = 0;
  let totalVaultSol = 0;
  let platformOrphanSol = 0;
  let userOrphanSol = 0;

  for (const p of pools) {
    try {
      const r = await auditPool(p);
      if (r.skipped) continue;
      results.push(r);
      totalOrphanSol += r.orphanSol;
      totalReservedSol += r.reservedForActiveSol;
      totalVaultSol += r.vaultBalanceSol;
      if (r.authorityIsPlatform) platformOrphanSol += r.orphanSol;
      else userOrphanSol += r.orphanSol;
    } catch (err) {
      if (!JSON_OUT) console.log(`  ! ${p.stakeMint.toBase58?.() || p.stakeMint}: ${err.message}`);
    }
  }

  results.sort((a, b) => b.orphanSol - a.orphanSol);

  if (JSON_OUT) {
    console.log(JSON.stringify({ pools: results, totals: { orphanSol: totalOrphanSol, reservedSol: totalReservedSol, vaultSol: totalVaultSol, platformOrphanSol, userOrphanSol } }, null, 2));
    return;
  }

  console.log('--------------------------------------------------------------');
  console.log(`Per-pool breakdown (${results.length} pools, sorted by orphan size):`);
  console.log('--------------------------------------------------------------');
  for (const r of results) {
    if (r.orphanSol < THRESHOLD_SOL) continue;
    const tag = r.authorityIsPlatform ? 'PLATFORM' : 'USER    ';
    console.log(
      `  ${tag}  ${r.stakeMint}  vault=${r.vaultBalanceSol.toFixed(6)}  ` +
        `reserved=${r.reservedForActiveSol.toFixed(6)}  orphan=${r.orphanSol.toFixed(6)}  ` +
        `(${r.activePositions} active)`,
    );
  }

  console.log();
  console.log('--------------------------------------------------------------');
  console.log('Totals:');
  console.log('--------------------------------------------------------------');
  console.log(`  Vault SOL across all pools:  ${totalVaultSol.toFixed(6)} SOL`);
  console.log(`  Reserved for active stakers: ${totalReservedSol.toFixed(6)} SOL`);
  console.log(`  Orphan total:                ${totalOrphanSol.toFixed(6)} SOL`);
  console.log(`    of which platform-auth:    ${platformOrphanSol.toFixed(6)} SOL  (sweepable now with PLATFORM_AUTHORITY_PRIVATE_KEY)`);
  console.log(`    of which user-auth:        ${userOrphanSol.toFixed(6)} SOL  (needs the user's connected wallet to sweep)`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
