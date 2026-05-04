import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { authoritySigner, config, getConnection } from './config.js';
import { listPools, readRecentEvents } from './registry.js';
import {
  fetchOwnerPositionsInPool,
  fetchCheckpointsForRewardMint,
  fetchRewardMint,
} from './stake-program.js';

// MasterChef-style accumulator scale used by the on-chain stake program.
// MUST match `ACC_PRECISION = 1_000_000_000_000_000_000` (1e18) in
// programs/pob-index-stake/src/state.rs. Previously this was wrong (1e12) and
// inflated every dashboard "earned/pending" reading by 1,000,000×, which made
// the leaderboard look insane (e.g. 367,000 SOL pending against a vault that
// only ever held single-digit SOL).
const SCALE = new BN('1000000000000000000');

/**
 * Compute totalClaimed + currently-claimable (incl. projected accrual since
 * the position's last checkpoint) for one position, using the same logic as
 * fetchStakersLeaderboard. We project from `accPerShare` deltas so the UI
 * shows up-to-the-second pending fees without forcing the user to prime.
 */
function computePositionRewards({ position, accPerShareLatest, checkpointByPos }) {
  const acc = position.account;
  const effectiveBn = new BN(acc.effective.toString());
  const cp = checkpointByPos.get(position.publicKey.toBase58());
  const totalClaimedBn = cp ? new BN(cp.account.totalClaimed.toString()) : new BN(0);
  const cpClaimable = cp ? new BN(cp.account.claimable.toString()) : new BN(0);
  const cpAcc = cp ? new BN(cp.account.accPerShare.toString()) : new BN(0);
  const projectedAccrual = accPerShareLatest.gt(cpAcc)
    ? accPerShareLatest.sub(cpAcc).mul(effectiveBn).div(SCALE)
    : new BN(0);
  const claimableBn = cpClaimable.add(projectedAccrual);
  const earnedBn = totalClaimedBn.add(claimableBn);
  return {
    totalClaimedRaw: totalClaimedBn.toString(),
    claimableRaw: claimableBn.toString(),
    earnedRaw: earnedBn.toString(),
    hasCheckpoint: !!cp,
  };
}

function serializePosition(p, rewards = null) {
  const a = p.account;
  return {
    position: p.publicKey.toBase58(),
    amount: a.amount?.toString?.() ?? String(a.amount),
    effective: a.effective?.toString?.() ?? String(a.effective),
    multiplierBps: a.multiplierBps ?? a.multiplier_bps,
    lockDays: a.lockDays ?? a.lock_days,
    lockEnd: (a.lockEnd ?? a.lock_end)?.toString?.() ?? String(a.lockEnd ?? a.lock_end ?? 0),
    // Reward enrichment (lifetime claimed + currently-claimable + projected
    // accrual since last checkpoint). Always present so the UI never has
    // to guess between "loading" and "0".
    totalClaimedRaw: rewards?.totalClaimedRaw ?? '0',
    claimableRaw: rewards?.claimableRaw ?? '0',
    earnedRaw: rewards?.earnedRaw ?? '0',
    hasCheckpoint: rewards?.hasCheckpoint ?? false,
  };
}

/**
 * Portfolio-style summary for a wallet: launched tokens, open stake positions
 * (each enriched with on-chain reward data), recent activity, and a portfolio-
 * wide totals roll-up so the dashboard can show a single "Lifetime fees
 * earned" headline.
 */
export async function buildWalletSummary(walletB58) {
  let owner;
  try {
    owner = new PublicKey(walletB58);
  } catch {
    throw new Error('invalid wallet');
  }

  const pools = listPools({ status: 'active' });
  const launched = pools
    .filter((p) => p.creatorWallet === walletB58)
    .map((p) => ({
      stakeMint: p.stakeMint,
      symbol: p.metadata?.symbol,
      name: p.metadata?.name,
      image: p.metadata?.image,
      rewardMode: p.rewardMode,
      createdAt: p.createdAt,
    }));

  const connection = getConnection();
  const authority = authoritySigner();

  const staked = [];
  // Per-wallet portfolio totals. Kept in lamports for SOL pools and raw token
  // units for token-reward pools (UI converts using each pool's decimals).
  const totals = {
    lifetimeEarnedSolLamports: '0',
    lifetimeClaimedSolLamports: '0',
    pendingSolLamports: '0',
    perTokenReward: [], // [{ mint, symbol, lifetimeEarnedRaw, lifetimeClaimedRaw, pendingRaw }]
  };
  let earnedSolBn = new BN(0);
  let claimedSolBn = new BN(0);
  let pendingSolBn = new BN(0);

  for (const p of pools) {
    try {
      const stakeMint = new PublicKey(p.stakeMint);
      const mine = await fetchOwnerPositionsInPool({
        connection,
        signer: authority,
        stakeMint,
        owner,
      });
      if (!mine.length) continue;

      // One RPC pair per pool (regardless of how many positions the wallet
      // has in it) — fetchCheckpointsForRewardMint returns ALL checkpoints
      // for the (pool, rewardMint) pair indexed by position pubkey.
      const rewardMode = p.rewardMode || 'sol';
      const rewardMintB58 = rewardMode === 'token'
        ? p.stakeMint
        : (p.rewardMint || config.wsolMint.toBase58());
      const rewardMintPk = new PublicKey(rewardMintB58);

      let cpData = null;
      let rmData = null;
      try {
        [cpData, rmData] = await Promise.all([
          fetchCheckpointsForRewardMint({ connection, stakeMint, rewardMint: rewardMintPk }),
          fetchRewardMint({ connection, stakeMint, rewardMint: rewardMintPk }),
        ]);
      } catch {
        // RPC error on the reward queries — fall through with empty rewards
        // so the position still renders (just shows 0 fees instead of erroring
        // the whole wallet load).
      }
      const accPerShareLatest = rmData?.accPerShare
        ? new BN(rmData.accPerShare.toString())
        : new BN(0);
      const checkpointByPos = cpData?.byPosition || new Map();

      const positionsSerialized = mine.map((pos) => {
        const rewards = computePositionRewards({
          position: pos,
          accPerShareLatest,
          checkpointByPos,
        });
        return serializePosition(pos, rewards);
      });

      // Per-pool totals
      const poolEarnedBn = positionsSerialized.reduce(
        (acc, ps) => acc.add(new BN(ps.earnedRaw)),
        new BN(0),
      );
      const poolClaimedBn = positionsSerialized.reduce(
        (acc, ps) => acc.add(new BN(ps.totalClaimedRaw)),
        new BN(0),
      );
      const poolPendingBn = positionsSerialized.reduce(
        (acc, ps) => acc.add(new BN(ps.claimableRaw)),
        new BN(0),
      );

      staked.push({
        stakeMint: p.stakeMint,
        symbol: p.metadata?.symbol,
        name: p.metadata?.name,
        image: p.metadata?.image,
        rewardMode,
        rewardMint: rewardMintB58,
        positions: positionsSerialized,
        // Per-pool roll-up so the UI can render aggregate row metrics
        // (lifetime earned / pending) without re-summing on the client.
        poolEarnedRaw: poolEarnedBn.toString(),
        poolClaimedRaw: poolClaimedBn.toString(),
        poolPendingRaw: poolPendingBn.toString(),
      });

      if (rewardMode === 'sol') {
        earnedSolBn = earnedSolBn.add(poolEarnedBn);
        claimedSolBn = claimedSolBn.add(poolClaimedBn);
        pendingSolBn = pendingSolBn.add(poolPendingBn);
      } else {
        // Token-reward pool: keep its totals separate (different decimals,
        // different token), one entry per mint.
        totals.perTokenReward.push({
          mint: p.stakeMint,
          symbol: p.metadata?.symbol || null,
          lifetimeEarnedRaw: poolEarnedBn.toString(),
          lifetimeClaimedRaw: poolClaimedBn.toString(),
          pendingRaw: poolPendingBn.toString(),
        });
      }
    } catch {
      /* skip pool on RPC errors */
    }
  }

  totals.lifetimeEarnedSolLamports = earnedSolBn.toString();
  totals.lifetimeClaimedSolLamports = claimedSolBn.toString();
  totals.pendingSolLamports = pendingSolBn.toString();

  const mintSet = new Set([
    ...launched.map((x) => x.stakeMint),
    ...staked.map((x) => x.stakeMint),
  ]);

  const events = readRecentEvents(400)
    .reverse()
    .filter((e) => {
      if (e.creatorWallet === walletB58) return true;
      if (e.stakeMint && mintSet.has(e.stakeMint)) return true;
      return false;
    })
    .slice(0, 80);

  return {
    wallet: walletB58,
    launched,
    staked,
    stats: {
      launchedCount: launched.length,
      stakedTokenCount: staked.length,
      positionCount: staked.reduce((n, s) => n + s.positions.length, 0),
    },
    totals,
    recentActivity: events,
  };
}
