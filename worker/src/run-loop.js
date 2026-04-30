import { config } from './config.js';
import { listPools, recordEvent } from './registry.js';
import { runPoolCycle } from './claim-and-distribute.js';

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

export async function runLoop() {
  log('loop: start', {
    intervalMs: config.loopIntervalMs,
    minDistributeLamports: config.minDistributeLamports,
    platformFeeBps: config.platformFeeBps,
  });
  while (true) {
    try {
      await runOnce();
    } catch (e) {
      log('loop: top-level error', { error: e.message });
    }
    await new Promise((r) => setTimeout(r, config.loopIntervalMs));
  }
}
