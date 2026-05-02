// KOL airdrop helpers — turning a CSV / paste / KolScan fetch into a
// validated, deduped list of (wallet, weight) entries that the orchestrator
// can hand to the auto-stake batch builder.
//
// Three input shapes:
//   1. Plain text / CSV — one address per line, optional comma-separated
//      weight: `Pubkey,Weight` or just `Pubkey`. Lines starting with `#` are
//      treated as comments. Whitespace tolerated.
//   2. Structured JSON list — `[{ wallet, weight, label? }, ...]`.
//   3. KolScan fetch — server-side scrape of kolscan.io's leaderboards
//      keyed by category (`pump`, `lp`, `1d`, `7d`, ...). Anything kolscan
//      restructures we contain in this single module.
//
// All paths return: `[{ wallet, weight, label? }]` with weight defaulting
// to 1 if unspecified. Allocator (kol-airdrop.js) takes it from there.

import { PublicKey } from '@solana/web3.js';

/**
 * Parse a free-form text list. Supports CSV with optional weight column,
 * and bare pubkey-per-line. Comments (#) and blank lines ignored.
 * Throws on the first invalid pubkey so the admin sees the offending line.
 */
export function parseTextWalletList(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  const lines = text.split(/\r?\n/);
  let lineno = 0;
  for (const raw of lines) {
    lineno += 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Split on comma OR tab OR multiple spaces — flexible enough for CSV +
    // copy-paste from spreadsheets / kolscan tables.
    const parts = line.split(/[,\t]| {2,}/).map((s) => s.trim()).filter(Boolean);
    const pkRaw = parts[0];
    let pk;
    try {
      pk = new PublicKey(pkRaw).toBase58();
    } catch {
      throw new Error(`line ${lineno}: invalid pubkey "${pkRaw}"`);
    }
    if (seen.has(pk)) continue; // dedupe
    seen.add(pk);
    let weight = 1;
    if (parts[1] != null) {
      const w = Number(parts[1]);
      if (!Number.isFinite(w) || w <= 0) {
        throw new Error(`line ${lineno}: invalid weight "${parts[1]}" (must be positive number)`);
      }
      weight = w;
    }
    const label = parts[2] || null; // optional 3rd col
    out.push({ wallet: pk, weight, label });
  }
  return out;
}

/**
 * Parse a structured JSON list. Use when the UI sends a JSON-Body POST.
 * Same dedupe + validation as parseTextWalletList.
 */
export function normalizeJsonWalletList(arr) {
  if (!Array.isArray(arr)) throw new Error('expected an array of wallets');
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i += 1) {
    const row = arr[i];
    const wRaw = row?.wallet || row?.address || row?.pubkey;
    if (!wRaw) throw new Error(`row ${i}: missing wallet/address/pubkey`);
    let pk;
    try {
      pk = new PublicKey(wRaw).toBase58();
    } catch {
      throw new Error(`row ${i}: invalid pubkey "${wRaw}"`);
    }
    if (seen.has(pk)) continue;
    seen.add(pk);
    const weight = Number(row.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`row ${i}: invalid weight ${row.weight}`);
    }
    out.push({ wallet: pk, weight, label: row.label || null });
  }
  return out;
}

// ── KolScan integration ─────────────────────────────────────────────────────

/**
 * KolScan exposes a JSON API behind their Next.js leaderboard pages. We hit
 * their /api/leaderboard endpoint server-side (CORS makes browser-direct
 * brittle anyway, and we cache server-side to be polite). If kolscan
 * restructures the URL/payload we contain the change here.
 *
 * Categories (subject to KolScan changes — admin can pick any):
 *   pnl-24h | pnl-7d | pnl-30d | volume-24h | top-traders | new-fomo
 *
 * Returns: `[{ wallet, label, weight }]` where label is the KolScan
 * display-name and weight defaults to 1 (admin can rebalance manually).
 *
 * Failure modes:
 *   - 4xx/5xx from kolscan → throw with status code in the message
 *   - JSON shape changed → throw with a "shape unexpected" message
 *
 * Cache: in-memory, 60s TTL, keyed by category. Avoids hammering kolscan
 * when the admin is iterating in the UI.
 */
const KOLSCAN_CACHE = new Map(); // category -> { ts, list }
const KOLSCAN_TTL_MS = 60_000;

const KOLSCAN_ENDPOINTS = {
  // Best-effort URLs based on kolscan.io's public Next.js routes. Each maps
  // to a JSON list of wallet rows. If kolscan changes their site we'll need
  // to update this map (and gracefully fall back to the manual paste path).
  'pnl-24h':    'https://api.kolscan.io/leaderboard?type=pnl&period=1d',
  'pnl-7d':     'https://api.kolscan.io/leaderboard?type=pnl&period=7d',
  'pnl-30d':    'https://api.kolscan.io/leaderboard?type=pnl&period=30d',
  'volume-24h': 'https://api.kolscan.io/leaderboard?type=volume&period=1d',
  'top-traders':'https://api.kolscan.io/leaderboard?type=top&period=all',
};

const KOLSCAN_CATEGORIES = Object.keys(KOLSCAN_ENDPOINTS);

export function listKolScanCategories() {
  return KOLSCAN_CATEGORIES.slice();
}

/**
 * Try a few common JSON shapes that kolscan / similar leaderboards use.
 * Returns null if no shape matched.
 */
function extractWalletsFromKolScanJson(json) {
  // Case A: { wallets: [{ address, name, ... }] }
  if (Array.isArray(json?.wallets)) {
    return json.wallets
      .map((row) => ({
        wallet: row.address || row.wallet || row.pubkey,
        label: row.name || row.label || null,
      }))
      .filter((r) => r.wallet);
  }
  // Case B: { data: [{ wallet, ... }] }
  if (Array.isArray(json?.data)) {
    return json.data
      .map((row) => ({
        wallet: row.address || row.wallet || row.pubkey,
        label: row.name || row.username || row.label || null,
      }))
      .filter((r) => r.wallet);
  }
  // Case C: top-level array
  if (Array.isArray(json)) {
    return json
      .map((row) => ({
        wallet: row.address || row.wallet || row.pubkey,
        label: row.name || row.username || row.label || null,
      }))
      .filter((r) => r.wallet);
  }
  return null;
}

/**
 * Fetch + parse a KolScan leaderboard. `limit` clamps how many wallets we
 * return to keep the airdrop tx-batch count manageable (default 25).
 */
export async function fetchKolScanLeaderboard(category, { limit = 25, force = false } = {}) {
  if (!KOLSCAN_ENDPOINTS[category]) {
    throw new Error(`unknown kolscan category "${category}" (valid: ${KOLSCAN_CATEGORIES.join(', ')})`);
  }
  const cached = KOLSCAN_CACHE.get(category);
  if (!force && cached && Date.now() - cached.ts < KOLSCAN_TTL_MS) {
    return cached.list.slice(0, limit);
  }
  const url = KOLSCAN_ENDPOINTS[category];
  const res = await fetch(url, {
    headers: {
      // KolScan's CDN sometimes 403s without a UA. Use a reasonable one.
      'user-agent': 'stakrr-bot/0.1 (+https://stakrr.xyz)',
      accept: 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`kolscan HTTP ${res.status} for ${category} — they may have changed the API. Use CSV/paste fallback.`);
  }
  const json = await res.json().catch(() => null);
  const rows = extractWalletsFromKolScanJson(json);
  if (!rows) {
    throw new Error('kolscan response shape unexpected — they may have changed the API. Use CSV/paste fallback.');
  }
  // Validate + dedupe pubkeys, drop obviously bad rows.
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    let pk;
    try { pk = new PublicKey(row.wallet).toBase58(); } catch { continue; }
    if (seen.has(pk)) continue;
    seen.add(pk);
    out.push({ wallet: pk, label: row.label || null, weight: 1 });
  }
  KOLSCAN_CACHE.set(category, { ts: Date.now(), list: out });
  return out.slice(0, limit);
}
