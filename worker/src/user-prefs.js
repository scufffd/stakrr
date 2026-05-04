// Per-wallet preferences for staking UX.
//
// Currently tracks one setting: `autoPush` — whether the worker should
// automatically push reward claims to the user's ATA each cycle (true) or
// leave them to claim manually via the UI (false).
//
// Defaults:
//   - Wallets the user opted into via `stake_for` (presale auto-stake, KOL
//     drops) get `autoPush: true` because they never visited our UI and
//     shouldn't have to in order to receive rewards.
//   - Wallets that signed `stake` themselves on the site get `autoPush: true`
//     by default too — frictionless out of the box, opt out via Settings if
//     they want to time their claims.
//   - When no record exists for a wallet, the resolver returns `true` so
//     legacy stakers (pre-prefs) also get auto-push. Tradeoff: a wallet that
//     toggled OFF then somehow lost their record reverts to ON; acceptable.
//
// Storage: JSON file at `data/user-prefs.json`, atomic write via tmp+rename
// (mirrors registry.js so it never half-writes during a crash).

import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_FILE = './data/user-prefs.json';

function getFile() {
  return process.env.USER_PREFS_FILE || DEFAULT_FILE;
}

function emptyDoc() {
  return { version: VERSION, wallets: {} };
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
    if (!data || typeof data.wallets !== 'object') return emptyDoc();
    return data;
  } catch (e) {
    console.warn('user-prefs: failed to read, starting empty', e.message);
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

/**
 * Resolve the auto-push preference for a wallet. Returns `true` (auto) when
 * no record exists. Use this in the auto-push job.
 */
export function isAutoPushEnabled(wallet) {
  if (!wallet) return true;
  const doc = readDoc();
  const rec = doc.wallets[wallet];
  if (!rec) return true;
  return rec.autoPush !== false;
}

/**
 * Read the full preference record for a wallet, or null if no record exists.
 * Used by the API to render the current state in the user's settings UI.
 */
export function getUserPrefs(wallet) {
  if (!wallet) return null;
  const doc = readDoc();
  return doc.wallets[wallet] || null;
}

/**
 * Upsert preferences for a wallet. Pass only the fields you want to change;
 * existing fields are preserved. Always stamps `updatedAt`.
 */
export function setUserPrefs(wallet, patch) {
  if (!wallet || typeof wallet !== 'string') throw new Error('setUserPrefs: wallet required');
  if (!patch || typeof patch !== 'object') throw new Error('setUserPrefs: patch required');
  const doc = readDoc();
  const now = new Date().toISOString();
  const existing = doc.wallets[wallet] || { createdAt: now };
  doc.wallets[wallet] = { ...existing, ...patch, updatedAt: now };
  writeDoc(doc);
  return doc.wallets[wallet];
}

/**
 * Mark a wallet as auto-push-enabled IF no record exists yet. Used by
 * `stake_for` flows (presale, KOL drops) so beneficiaries get auto-push
 * even if they never visit our UI. No-op when the wallet already has a
 * record (preserves explicit opt-outs).
 */
export function ensureAutoPushDefault(wallet) {
  if (!wallet) return null;
  const doc = readDoc();
  if (doc.wallets[wallet]) return doc.wallets[wallet];
  const now = new Date().toISOString();
  doc.wallets[wallet] = {
    autoPush: true,
    autoPushSource: 'stake_for_default',
    createdAt: now,
    updatedAt: now,
  };
  writeDoc(doc);
  return doc.wallets[wallet];
}

/**
 * List all wallets that have explicitly opted out of auto-push. Used by the
 * auto-push job to skip them in bulk without per-wallet RPC reads.
 */
export function listAutoPushOptOuts() {
  const doc = readDoc();
  return Object.entries(doc.wallets)
    .filter(([_, rec]) => rec && rec.autoPush === false)
    .map(([wallet]) => wallet);
}
