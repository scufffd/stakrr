// Market-maker daemon entry point. Run via pm2 (`stakrr-mm`).
//
// Loop: every 10s, scan mm.json for enabled tokens whose nextActionAt is
// in the past (or unset), call strategyStep() for each, then schedule
// the next action time. Sequential per-token to avoid two trades on the
// same wallet racing for blockhash.
//
// Honest framing: this bot WILL spend SOL. It tracks every lamport in
// mm.json. Use the bankrollSol cap + drawdownPct kill switches to bound
// loss. Read worker/data/mm.json or hit /api/admin/mm/* to inspect P&L.

import 'dotenv/config';
import { listTokens } from '../src/mm/store.js';
import { strategyStep, scheduleNext } from '../src/mm/strategy.js';

const TICK_INTERVAL_MS = 10_000;

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), tag: 'mm', message, ...extra }));
}

let isShuttingDown = false;
process.on('SIGINT', () => { isShuttingDown = true; log('SIGINT — draining'); });
process.on('SIGTERM', () => { isShuttingDown = true; log('SIGTERM — draining'); });

async function tick() {
  const tokens = listTokens();
  const now = Date.now();
  for (const t of tokens) {
    if (isShuttingDown) break;
    if (!t.enabled) continue;
    const nextAt = t.state?.nextActionAt ? Date.parse(t.state.nextActionAt) : 0;
    if (nextAt > now) continue;
    try {
      const out = await strategyStep(t.mint);
      log(`step ${out.action}`, { mint: t.mint, symbol: t.symbol, ...out });
    } catch (e) {
      log('step crashed', { mint: t.mint, error: e.message });
    } finally {
      // Always schedule a next interval so we don't busy-loop on a broken token.
      const ns = scheduleNext(t.mint);
      log('scheduled next', { mint: t.mint, nextAt: ns });
    }
  }
}

async function main() {
  log('mm daemon started', { pid: process.pid, tickIntervalMs: TICK_INTERVAL_MS });
  while (!isShuttingDown) {
    try {
      await tick();
    } catch (e) {
      log('tick crashed', { error: e.message });
    }
    await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS));
  }
  log('mm daemon stopped');
  process.exit(0);
}

main().catch((e) => {
  log('fatal', { error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  process.exit(1);
});
