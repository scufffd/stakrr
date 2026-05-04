import { config } from './config.js';
import { listPools, recordEvent } from './registry.js';
import { runPoolCycle } from './claim-and-distribute.js';
import { runOnce as runOrphanRedistribute } from './redistribute-orphans.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

export async function runOnce() {
  const pools = listPools({ status: 'active' });
  log('loop: cycle start', { poolCount: pools.length });
  const results = [];
  for (const pool of pools) {
    try {
      const r = await runPoolCycle({ pool });
      results.push({ stakeMint: pool.stakeMint, ...r });
    } catch (e) {
      log('loop: pool cycle failed', { stakeMint: pool.stakeMint, error: e.message });
      recordEvent({ type: 'cycle_error', stakeMint: pool.stakeMint, error: e.message });
      results.push({ stakeMint: pool.stakeMint, status: 'error', error: e.message });
    }
  }
  log('loop: cycle done', { results });
  return results;
}

// Track the last-completed orphan-redistribute run so we can fire it on its
// own cadence inside the main loop. Default 24h; override via env. Using
// the same loop (rather than a parallel timer) keeps the worker
// single-threaded and avoids RPC-burst overlap with claim cycles.
const REDISTRIBUTE_INTERVAL_MS = Number(
  process.env.REDISTRIBUTE_INTERVAL_MS || 24 * 60 * 60 * 1000,
);
let lastRedistributeAt = 0;

async function maybeRunOrphanRedistribute() {
  const now = Date.now();
  if (now - lastRedistributeAt < REDISTRIBUTE_INTERVAL_MS) return;
  try {
    const summary = await runOrphanRedistribute();
    lastRedistributeAt = now;
    if (summary.poolsRedistributed > 0) {
      recordEvent({
        type: 'orphan_redistribute_cycle',
        poolsScanned: summary.poolsScanned,
        poolsRedistributed: summary.poolsRedistributed,
        totalRedistributedSol: summary.totalRedistributedSol,
      });
    }
  } catch (e) {
    log('loop: orphan-redistribute failed', { error: e.message });
  }
}

export async function runLoop() {
  log('loop: start', {
    intervalMs: config.loopIntervalMs,
    redistributeIntervalMs: REDISTRIBUTE_INTERVAL_MS,
    minDistributeLamports: config.minDistributeLamports,
    platformFeeBps: config.platformFeeBps,
  });
  while (true) {
    try {
      await runOnce();
      await maybeRunOrphanRedistribute();
    } catch (e) {
      log('loop: top-level error', { error: e.message });
    }
    await new Promise((r) => setTimeout(r, config.loopIntervalMs));
  }
}
