import { PublicKey } from '@solana/web3.js';
import { authoritySigner, getConnection } from './config.js';
import { listPools, readRecentEvents } from './registry.js';
import { fetchOwnerPositionsInPool } from './stake-program.js';

function serializePosition(p) {
  const a = p.account;
  return {
    position: p.publicKey.toBase58(),
    amount: a.amount?.toString?.() ?? String(a.amount),
    effective: a.effective?.toString?.() ?? String(a.effective),
    multiplierBps: a.multiplierBps ?? a.multiplier_bps,
    lockDays: a.lockDays ?? a.lock_days,
    lockEnd: (a.lockEnd ?? a.lock_end)?.toString?.() ?? String(a.lockEnd ?? a.lock_end ?? 0),
  };
}

/**
 * Portfolio-style summary for a wallet: launched tokens, open stake positions, recent activity.
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
      staked.push({
        stakeMint: p.stakeMint,
        symbol: p.metadata?.symbol,
        name: p.metadata?.name,
        image: p.metadata?.image,
        rewardMode: p.rewardMode,
        rewardMint: p.rewardMint,
        positions: mine.map(serializePosition),
      });
    } catch {
      /* skip pool on RPC errors */
    }
  }

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
    recentActivity: events,
  };
}
