// Pending KOL claim store.
//
// During an admin launch, the unified flow may carve a slice of the dev-buy
// bag for promotional partners ("KOLs"). Two delivery modes exist:
//
//   - mode='push' (default): position is created on-chain immediately via
//     stake_for, same code path as `runKolAirdrop` push branch. KOL has no
//     consent step but their position is visible on the staking page from
//     the moment of launch — useful as social proof. Reclaim of a still-
//     unclaimed position only via the all-or-nothing `sweep_reward_vault`
//     emergency lever (see post-mortem comments there).
//   - mode='pending-claim': tokens stay earmarked in the dev wallet for
//     `claimWindowDays` (default 30). The KOL signs a message within the
//     window to materialise their position (`stake_for` with the stored
//     allocation, paid + signed by the dev wallet). After the window
//     expires the entry is marked `expired` and the dev keeps the tokens —
//     no on-chain action needed since they never moved. Use when explicit
//     consent matters more than visibility.
//
// This module owns the JSON-backed pending-claim store and the helpers to
// query, accept, and sweep entries. It is INTENTIONALLY decoupled from the
// stake-program client: the materialise tx is built in the API handler so
// this file has no Solana dependencies and can be unit-tested in isolation.
//
// Storage: data/kol-claims.json, atomic write via tmp+rename (mirrors
// registry.js + user-prefs.js).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VERSION = 1;
const DEFAULT_FILE = './data/kol-claims.json';
const DEFAULT_CLAIM_WINDOW_DAYS = 30;
const DEFAULT_LOCK_DAYS_AFTER_CLAIM = 30;

function getFile() {
  return process.env.KOL_CLAIMS_FILE || DEFAULT_FILE;
}

function emptyDoc() {
  return { version: VERSION, claims: {} };
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readDoc() {
  const file = getFile();
  if (!fs.existsSync(file)) return emptyDoc();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data.claims !== 'object') return emptyDoc();
    return data;
  } catch (e) {
    console.warn('kol-claims: failed to read, starting empty', e.message);
    return emptyDoc();
  }
}

function writeDoc(doc) {
  const file = getFile();
  ensureDir(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Status lifecycle:
 *   pending → claimed   (KOL signed accept, on-chain stake_for confirmed)
 *   pending → expired   (claim window passed without acceptance)
 *   pending → revoked   (admin manually revoked, e.g. KOL fell off the list)
 *
 * Once non-pending the entry is immutable except for adding metadata
 * (e.g. `position`, `txSig` after claim).
 */
const VALID_STATUSES = new Set(['pending', 'claimed', 'expired', 'revoked']);

/**
 * Insert a batch of pending claims atomically. Returns the inserted records.
 *
 * Each input row:
 *   {
 *     wallet: string,             // KOL pubkey (base58)
 *     mint: string,               // token mint (base58)
 *     symbol?: string,            // for UI rendering
 *     tokensRaw: string|bigint,   // amount earmarked
 *     devWalletId: string,        // wallet-vault id holding the tokens
 *     stakeLockDays?: number,     // applied to position once claimed
 *     claimWindowDays?: number,   // window for KOL to accept
 *     earlyUnstakeBps?: number,   // v4 per-position penalty override (0-9000).
 *                                 // Applied via set_position_early_unstake_bps
 *                                 // bundled with stake_for at accept time.
 *                                 // 0 / undefined = use pool default (10%).
 *     launchSnipeId?: string,     // back-link to admin snipe row
 *     label?: string,
 *   }
 */
export function createPendingClaims(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const doc = readDoc();
  const now = new Date();
  const inserted = [];
  for (const r of rows) {
    if (!r.wallet || !r.mint || !r.tokensRaw || !r.devWalletId) {
      throw new Error('createPendingClaims: wallet, mint, tokensRaw, devWalletId required');
    }
    const id = newId();
    const claimWindowDays = Number(r.claimWindowDays || DEFAULT_CLAIM_WINDOW_DAYS);
    const stakeLockDays = Number(r.stakeLockDays || DEFAULT_LOCK_DAYS_AFTER_CLAIM);
    const earlyUnstakeBps = Math.max(0, Math.min(9000, Number(r.earlyUnstakeBps || 0)));
    const expiresAt = new Date(now.getTime() + claimWindowDays * 86400 * 1000);
    const rec = {
      id,
      wallet: String(r.wallet),
      mint: String(r.mint),
      symbol: r.symbol || null,
      tokensRaw: String(r.tokensRaw),
      devWalletId: String(r.devWalletId),
      stakeLockDays,
      claimWindowDays,
      earlyUnstakeBps,
      launchSnipeId: r.launchSnipeId || null,
      label: r.label || null,
      status: 'pending',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      claimedAt: null,
      txSig: null,
      position: null,
    };
    doc.claims[id] = rec;
    inserted.push(rec);
  }
  writeDoc(doc);
  return inserted;
}

/**
 * Look up a single claim by id.
 */
export function getClaimById(id) {
  if (!id) return null;
  const doc = readDoc();
  return doc.claims[id] || null;
}

/**
 * List all pending+claimed claims for a wallet across every launch. Sorted
 * newest-first. Used by the user dashboard widget.
 */
export function listClaimsForWallet(wallet) {
  if (!wallet) return [];
  const doc = readDoc();
  return Object.values(doc.claims)
    .filter((c) => c.wallet === wallet)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

/**
 * Returns just the actively claimable rows (status=pending AND not expired)
 * for a wallet — what the user dashboard "Claim" widget should render.
 */
export function listActivePendingForWallet(wallet) {
  const now = Date.now();
  return listClaimsForWallet(wallet).filter(
    (c) => c.status === 'pending' && new Date(c.expiresAt).getTime() > now,
  );
}

/**
 * List every claim, optionally filtered. Used by the admin dashboard.
 */
export function listAllClaims({ status, mint, devWalletId } = {}) {
  const doc = readDoc();
  let rows = Object.values(doc.claims);
  if (status) rows = rows.filter((r) => r.status === status);
  if (mint) rows = rows.filter((r) => r.mint === mint);
  if (devWalletId) rows = rows.filter((r) => r.devWalletId === devWalletId);
  return rows.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

/**
 * Mutate a claim. Caller passes only the fields they want to change. Throws
 * if the claim doesn't exist or the new status isn't valid.
 */
export function updateClaim(id, patch) {
  if (!id) throw new Error('updateClaim: id required');
  const doc = readDoc();
  const cur = doc.claims[id];
  if (!cur) throw new Error(`updateClaim: no claim with id ${id}`);
  if (patch.status && !VALID_STATUSES.has(patch.status)) {
    throw new Error(`updateClaim: invalid status ${patch.status}`);
  }
  doc.claims[id] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  writeDoc(doc);
  return doc.claims[id];
}

/**
 * Sweep expired pending claims. Marks them `expired` and bumps `expiredAt`.
 * Tokens stay in the dev wallet (no on-chain action). Returns the swept ids.
 *
 * Run from the worker's daily cron. Idempotent — calling it twice on the
 * same expired claim is a no-op the second time.
 */
export function sweepExpiredClaims({ now = Date.now() } = {}) {
  const doc = readDoc();
  const swept = [];
  for (const [id, rec] of Object.entries(doc.claims)) {
    if (rec.status !== 'pending') continue;
    if (new Date(rec.expiresAt).getTime() > now) continue;
    doc.claims[id] = {
      ...rec,
      status: 'expired',
      expiredAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    swept.push(id);
  }
  if (swept.length) writeDoc(doc);
  return swept;
}

/**
 * Aggregate stats for a single mint. Used by the public token page to render
 * a "X% of supply was reserved for promotional partners; Y of N have
 * accepted" disclosure.
 */
export function summariseClaimsForMint(mint) {
  if (!mint) return null;
  const rows = listAllClaims({ mint });
  if (rows.length === 0) return null;
  const total = rows.length;
  const pending = rows.filter((r) => r.status === 'pending').length;
  const claimed = rows.filter((r) => r.status === 'claimed').length;
  const expired = rows.filter((r) => r.status === 'expired').length;
  const revoked = rows.filter((r) => r.status === 'revoked').length;
  const totalTokensRaw = rows
    .reduce((acc, r) => acc + BigInt(r.tokensRaw), 0n)
    .toString();
  const claimedTokensRaw = rows
    .filter((r) => r.status === 'claimed')
    .reduce((acc, r) => acc + BigInt(r.tokensRaw), 0n)
    .toString();
  return {
    mint,
    total,
    pending,
    claimed,
    expired,
    revoked,
    totalTokensRaw,
    claimedTokensRaw,
  };
}
