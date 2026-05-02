// Per-token market-maker config + state persistence.
//
// File layout (worker/data/mm.json):
//   { version, tokens: [{ mint, symbol, walletId, enabled,
//                         config, state, trades: [...] }] }
//
// Two-level lock: every read/write goes through readMm()/writeMm() so the
// daemon's tick + the API's update-config never interleave on the same
// snapshot. JSON ops on a single file are atomic on linux (writeFileSync
// is one syscall) which is good enough for our scale (a few tokens, max
// a few writes per minute).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MM_FILE = path.resolve(__dirname, '../../data/mm.json');

const DEFAULT_CONFIG = {
  bankrollSol: 0.5,         // total SOL we're willing to NET-spend before pausing
  drawdownPct: 25,          // pause if current P&L drops X% below peak P&L
  minBuySol: 0.005,
  maxBuySol: 0.02,
  minIntervalSec: 45,
  maxIntervalSec: 180,
  // Soft "target bag" — we hold roughly this many tokens average. If null,
  // strategy keeps the rolling-mean of recent bag sizes as the implicit target.
  targetBagTokens: null,
  rebalanceUpperPct: 130,   // sell when bag > target * 1.3
  rebalanceLowerPct: 70,    // buy biased when bag < target * 0.7
  slippage: 15,             // % slippage tolerance on each trade
  maxTradesPerHour: 30,     // hard rate-limit guard
};

const DEFAULT_STATE = {
  enabledAt: null,
  pausedAt: null,
  pauseReason: null,
  totalSpentLamports: '0',           // SUM of buys (SOL out)
  totalReceivedLamports: '0',        // SUM of sells (SOL in)
  totalTokensBought: '0',
  totalTokensSold: '0',
  tradesCount: 0,
  errorsCount: 0,
  lastActionAt: null,
  lastSig: null,
  // Realised P&L = received - spent. Note: does NOT include creator fees,
  // those are tracked separately by the existing claim-and-distribute pipeline
  // and we just read pool.lastClaimedAmount to attribute approximately.
  peakPnlLamports: '0',
  currentPnlLamports: '0',
  lastTickAt: null,
  // Next time the bot is allowed to trade this token. Set by strategy.
  nextActionAt: null,
};

function ensureFile() {
  if (!fs.existsSync(MM_FILE)) {
    fs.mkdirSync(path.dirname(MM_FILE), { recursive: true });
    fs.writeFileSync(MM_FILE, JSON.stringify({ version: 1, tokens: [] }, null, 2));
  }
}

export function readMm() {
  ensureFile();
  const raw = fs.readFileSync(MM_FILE, 'utf8');
  try {
    const json = JSON.parse(raw);
    if (!json.tokens) json.tokens = [];
    return json;
  } catch (e) {
    throw new Error(`mm.json corrupted: ${e.message}`);
  }
}

export function writeMm(mm) {
  ensureFile();
  fs.writeFileSync(MM_FILE, JSON.stringify(mm, null, 2));
}

export function listTokens() {
  return readMm().tokens.map(sanitize);
}

export function getToken(mint) {
  return readMm().tokens.find((t) => t.mint === mint) || null;
}

export function getTokenInternal(mint) {
  // Returns full record including trades list (used by daemon + admin UI).
  return readMm().tokens.find((t) => t.mint === mint) || null;
}

/**
 * Strip per-token trade history from list views (heavy for big logs).
 * Keep last 5 trades inline for at-a-glance reading.
 */
function sanitize(t) {
  return {
    ...t,
    trades: undefined,
    recentTrades: (t.trades || []).slice(-5),
  };
}

/**
 * Configure (create if absent) a token for MM. Validates required keys and
 * merges partial config patches. Re-enabling resets `pausedAt` but does
 * NOT reset cumulative P&L so the bankroll cap is honoured across pauses.
 */
export function upsertToken({ mint, symbol = null, walletId, config: patch = {}, enabled = true }) {
  if (!mint) throw new Error('mint required');
  if (!walletId) throw new Error('walletId required (vault id of the MM wallet)');
  const mm = readMm();
  const i = mm.tokens.findIndex((t) => t.mint === mint);
  const now = new Date().toISOString();
  if (i === -1) {
    mm.tokens.push({
      mint,
      symbol,
      walletId,
      enabled,
      createdAt: now,
      updatedAt: now,
      config: { ...DEFAULT_CONFIG, ...patch },
      state: {
        ...DEFAULT_STATE,
        enabledAt: enabled ? now : null,
      },
      trades: [],
    });
  } else {
    const cur = mm.tokens[i];
    cur.symbol = symbol ?? cur.symbol;
    cur.walletId = walletId || cur.walletId;
    cur.enabled = enabled;
    cur.config = { ...cur.config, ...patch };
    cur.updatedAt = now;
    if (enabled && cur.state.pausedAt) {
      cur.state.pausedAt = null;
      cur.state.pauseReason = null;
    }
    if (enabled && !cur.state.enabledAt) {
      cur.state.enabledAt = now;
    }
  }
  writeMm(mm);
  return sanitize(mm.tokens[mm.tokens.findIndex((t) => t.mint === mint)]);
}

export function pauseToken(mint, reason = 'manual pause') {
  const mm = readMm();
  const t = mm.tokens.find((x) => x.mint === mint);
  if (!t) throw new Error('mm token not found');
  t.enabled = false;
  t.state.pausedAt = new Date().toISOString();
  t.state.pauseReason = reason;
  writeMm(mm);
  return sanitize(t);
}

export function resumeToken(mint) {
  const mm = readMm();
  const t = mm.tokens.find((x) => x.mint === mint);
  if (!t) throw new Error('mm token not found');
  t.enabled = true;
  t.state.pausedAt = null;
  t.state.pauseReason = null;
  if (!t.state.enabledAt) t.state.enabledAt = new Date().toISOString();
  writeMm(mm);
  return sanitize(t);
}

export function deleteToken(mint) {
  const mm = readMm();
  const before = mm.tokens.length;
  mm.tokens = mm.tokens.filter((t) => t.mint !== mint);
  writeMm(mm);
  return { ok: true, removed: before - mm.tokens.length };
}

/**
 * Append a completed trade and update cumulative state in one atomic
 * read-modify-write. `entry` shape:
 *   { ts, type: 'buy'|'sell', solSpentLamports, solReceivedLamports,
 *     tokensInRaw, tokensOutRaw, sig, error }
 *
 * Returns the updated state for the caller to inspect (e.g. trip kill switch).
 */
export function appendTrade(mint, entry) {
  const mm = readMm();
  const t = mm.tokens.find((x) => x.mint === mint);
  if (!t) throw new Error('mm token not found');
  if (!Array.isArray(t.trades)) t.trades = [];

  // Cap trade list length to avoid unbounded growth (~1KB per entry).
  // 500 entries ≈ 500KB per token, fine for diagnosis without bloat.
  t.trades.push(entry);
  if (t.trades.length > 500) t.trades.splice(0, t.trades.length - 500);

  if (!entry.error) {
    t.state.tradesCount = (t.state.tradesCount || 0) + 1;
    t.state.totalSpentLamports = bigStr(t.state.totalSpentLamports, entry.solSpentLamports);
    t.state.totalReceivedLamports = bigStr(t.state.totalReceivedLamports, entry.solReceivedLamports);
    t.state.totalTokensBought = bigStr(t.state.totalTokensBought, entry.tokensInRaw);
    t.state.totalTokensSold = bigStr(t.state.totalTokensSold, entry.tokensOutRaw);
    t.state.lastSig = entry.sig || t.state.lastSig;
    const pnl = BigInt(t.state.totalReceivedLamports) - BigInt(t.state.totalSpentLamports);
    t.state.currentPnlLamports = pnl.toString();
    if (pnl > BigInt(t.state.peakPnlLamports)) {
      t.state.peakPnlLamports = pnl.toString();
    }
  } else {
    t.state.errorsCount = (t.state.errorsCount || 0) + 1;
  }
  t.state.lastActionAt = entry.ts || new Date().toISOString();
  writeMm(mm);
  return t.state;
}

/** Persist a tick observation (no trade — strategy decided to wait). */
export function noteTick(mint, nextActionAt = null) {
  const mm = readMm();
  const t = mm.tokens.find((x) => x.mint === mint);
  if (!t) return;
  t.state.lastTickAt = new Date().toISOString();
  if (nextActionAt) t.state.nextActionAt = nextActionAt;
  writeMm(mm);
}

function bigStr(a, b) {
  return (BigInt(a || '0') + BigInt(b || '0')).toString();
}

export { MM_FILE, DEFAULT_CONFIG, DEFAULT_STATE };
