// Persistence for stealth-launch records.
//
// Stored at worker/data/snipes.json (gitignored). One row per launch the
// admin tool initiated. Keeps enough metadata for the UI to render the
// "Active snipes" tab and for post-launch ops to know which wallet owns
// which bag.
//
// Row shape:
//   {
//     id: 'snp_<hex>',
//     mint, symbol, name,
//     devWallet,                // base58 pubkey of the deployer (also the creator)
//     devWalletId | null,       // vault id IF the deployer was a vault wallet
//     metadataUri,
//     bundleId, bundleEndpoint,
//     txSignatures: [...],
//     devBuySol,
//     sniperSolPerWallet,
//     jitoTipSol,
//     snipers: [{
//       walletId, publicKey, source, kind: 'in-bundle'|'overflow',
//       solSpent, buySig, error, soldAt, sweptAt, lastBalanceTokensRaw,
//     }],
//     status: 'pending'|'bundle-ok'|'lock-ok'|'pool-ok'|'finalized'|'failed',
//     statusError: string | null,
//     createdAt, updatedAt,
//     finalizedAt: ISO | null,
//   }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config.js';

const STORE_VERSION = 1;

function storeFilePath() {
  return process.env.SNIPE_STORE_FILE
    ? path.resolve(process.env.SNIPE_STORE_FILE)
    : path.join(path.dirname(path.resolve(config.registryFile)), 'snipes.json');
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readRaw() {
  const file = storeFilePath();
  if (!fs.existsSync(file)) return { version: STORE_VERSION, snipes: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.snipes)) return { version: STORE_VERSION, snipes: [] };
    return data;
  } catch (e) {
    console.warn('snipe store: failed to read, starting empty', e.message);
    return { version: STORE_VERSION, snipes: [] };
  }
}

function writeRaw(data) {
  const file = storeFilePath();
  ensureDir(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function newId() {
  return `snp_${crypto.randomBytes(6).toString('hex')}`;
}

export function listSnipes({ status = null } = {}) {
  const reg = readRaw();
  const rows = status ? reg.snipes.filter((s) => s.status === status) : reg.snipes;
  return rows.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

export function getSnipe(id) {
  return readRaw().snipes.find((s) => s.id === id) || null;
}

export function getSnipeByMint(mint) {
  if (!mint) return null;
  return readRaw().snipes.find((s) => s.mint === mint) || null;
}

export function createSnipe(row) {
  const reg = readRaw();
  const id = row.id || newId();
  const now = new Date().toISOString();
  const next = {
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    finalizedAt: null,
    statusError: null,
    ...row,
    id,
  };
  reg.snipes.push(next);
  writeRaw(reg);
  return next;
}

export function updateSnipe(id, patch = {}) {
  const reg = readRaw();
  const idx = reg.snipes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  reg.snipes[idx] = { ...reg.snipes[idx], ...patch, updatedAt: now };
  writeRaw(reg);
  return reg.snipes[idx];
}

/** Update a single sniper sub-row inside a snipe by walletId or publicKey. */
export function updateSnipeWallet(id, walletKey, patch = {}) {
  const reg = readRaw();
  const idx = reg.snipes.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const snipe = reg.snipes[idx];
  const wIdx = (snipe.snipers || []).findIndex(
    (w) => w.walletId === walletKey || w.publicKey === walletKey,
  );
  if (wIdx === -1) return null;
  snipe.snipers[wIdx] = { ...snipe.snipers[wIdx], ...patch };
  snipe.updatedAt = new Date().toISOString();
  writeRaw(reg);
  return snipe;
}

export function deleteSnipe(id) {
  const reg = readRaw();
  const before = reg.snipes.length;
  reg.snipes = reg.snipes.filter((s) => s.id !== id);
  if (reg.snipes.length === before) return false;
  writeRaw(reg);
  return true;
}
