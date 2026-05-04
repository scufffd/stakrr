// Daily orphan-wSOL redistribution job.
//
// Background: when a staker calls `unstake` / `unstake_early` without first
// claiming, Anchor's `close = owner` constraint cascades all their
// `RewardCheckpoint` accounts into the trash. Their share of any
// previously-deposited reward stays in the vault but no checkpoint
// references it, so the on-chain `claim` math can never pay it out — it's
// "orphaned".
//
// The v3 program ships a permissionless `redistribute_orphan(amount)`
// instruction. Anyone can call it; the on-chain handler validates that
// `vault_balance >= total_deposited - total_claimed` post-bump, so a
// caller passing too much reverts with `InsufficientVaultForRedistribute`
// and no state changes.
//
// This worker computes the true orphan off-chain (with a 0.1% safety
// margin in stakers' favour) and submits the ix paid for by the platform
// treasury. Runs daily (configurable via REDISTRIBUTE_INTERVAL_MS).
//
// The orphan accumulator is intentionally generous to active stakers —
// every wSOL drop that would otherwise sit forever in the vault gets
// re-attributed to whoever's still locked in.

import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from '@solana/spl-token';
import BN from 'bn.js';
import { config, getConnection } from './config.js';
import {
  fetchActivePositions,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
  findPoolPda,
  redistributeOrphanIx,
} from './stake-program.js';

// Must match `ACC_PRECISION = 1_000_000_000_000_000_000` in state.rs.
const SCALE = new BN('1000000000000000000');

// Don't bother redistributing micro amounts — RPC + tx fees would exceed
// the value. 0.001 SOL ≈ $0.20 floor.
const DEFAULT_MIN_LAMPORTS = 1_000_000n;

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

async function listAllPools(connection) {
  // StakePool layout = 270 bytes (state.rs).
  const accs = await connection.getProgramAccounts(config.programId, {
    encoding: 'base64',
    filters: [{ dataSize: 270 }],
  });
  return accs.map((e) => {
    const data = e.account.data;
    const stakeMint = new PublicKey(data.subarray(9 + 32, 9 + 64));
    return { stakeMint, poolPda: e.pubkey };
  });
}

async function computeOrphan(connection, stakeMint) {
  const wsol = NATIVE_MINT;
  const pool = findPoolPda(stakeMint);
  const wsolVault = getAssociatedTokenAddressSync(wsol, pool, true, TOKEN_PROGRAM_ID);
  const balInfo = await connection.getTokenAccountBalance(wsolVault).catch(() => null);
  const vaultBalance = balInfo ? BigInt(balInfo.value.amount) : 0n;
  if (vaultBalance === 0n) return { orphan: 0n, vaultBalance, activeCount: 0 };

  const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: wsol });
  if (!rm) return { orphan: 0n, vaultBalance, activeCount: 0 };

  const positions = await fetchActivePositions({ connection, stakeMint });
  if (positions.length === 0) return { orphan: 0n, vaultBalance, activeCount: 0 };

  const cpData = await fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint: wsol });
  const accLatest = new BN(rm.accPerShare.toString());

  let reservedForActive = 0n;
  for (const pos of positions) {
    const cp = cpData.byPosition.get(pos.publicKey.toBase58());
    if (!cp) continue;
    const cpAcc = new BN(cp.account.accPerShare.toString());
    if (accLatest.lte(cpAcc)) continue;
    const eff = new BN(pos.account.effective.toString());
    const projected = accLatest.sub(cpAcc).mul(eff).div(SCALE);
    const cpClaimable = new BN(cp.account.claimable.toString());
    reservedForActive += BigInt(projected.add(cpClaimable).toString());
  }

  // 0.1% safety margin in stakers' favour (any rounding leaves slack in vault).
  const safety = reservedForActive / 1000n;
  const safeReserve = reservedForActive + safety;
  const orphan = vaultBalance > safeReserve ? vaultBalance - safeReserve : 0n;
  return { orphan, vaultBalance, reservedForActive, activeCount: positions.length };
}

async function sendRedistribute(connection, stakeMint, amount, payer) {
  const { ix } = await redistributeOrphanIx({
    connection,
    stakeMint,
    rewardTokenMint: NATIVE_MINT,
    amount,
  });
  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports || 10_000 }))
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }))
    .add(ix);
  tx.feePayer = payer.publicKey;
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: 'confirmed',
    skipPreflight: false,
  });
}

/**
 * Run a single redistribution sweep across every pool on the program.
 *
 * @param {object} opts
 * @param {bigint} [opts.minLamports] — pools with orphan below this are skipped.
 * @returns {Promise<{poolsScanned: number, poolsRedistributed: number, totalRedistributedLamports: bigint, errors: number}>}
 */
export async function runOnce({ minLamports = DEFAULT_MIN_LAMPORTS } = {}) {
  const connection = getConnection();
  const payer = config.treasuryKeypair;

  log('redistribute-orphans: start', {
    payer: payer.publicKey.toBase58(),
    minLamports: minLamports.toString(),
  });

  const pools = await listAllPools(connection);
  let poolsRedistributed = 0;
  let totalRedistributedLamports = 0n;
  let errors = 0;

  for (const p of pools) {
    try {
      const audit = await computeOrphan(connection, p.stakeMint);
      if (audit.orphan < minLamports) continue;
      const sig = await sendRedistribute(connection, p.stakeMint, audit.orphan, payer);
      poolsRedistributed += 1;
      totalRedistributedLamports += audit.orphan;
      log('redistribute-orphans: redistributed', {
        stakeMint: p.stakeMint.toBase58(),
        orphanLamports: audit.orphan.toString(),
        orphanSol: Number(audit.orphan) / 1e9,
        activeStakers: audit.activeCount,
        sig,
      });
    } catch (err) {
      errors += 1;
      log('redistribute-orphans: pool failed', {
        stakeMint: p.stakeMint.toBase58(),
        error: err.message,
      });
    }
  }

  const summary = {
    poolsScanned: pools.length,
    poolsRedistributed,
    totalRedistributedLamports,
    totalRedistributedSol: Number(totalRedistributedLamports) / 1e9,
    errors,
  };
  log('redistribute-orphans: done', {
    ...summary,
    totalRedistributedLamports: summary.totalRedistributedLamports.toString(),
  });
  return summary;
}
