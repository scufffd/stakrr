// Encrypted sniper wallet vault.
//
// Two flavours of wallet live here:
//   - 'pool'      — persistent keypairs that admins maintain across launches
//                   (pre-funded once, reused; cheaper but links launches on-chain).
//   - 'ephemeral' — fresh keypairs minted per launch (cleaner footprint;
//                   admin must fund & later sweep).
//
// Secret keys are encrypted at rest with AES-256-GCM. The 32-byte key is
// derived from the SNIPE_VAULT_KEY env var (hex). Generate one with
//   openssl rand -hex 32
// If the env var is missing the vault refuses writes (read-only/disabled),
// so a misconfigured prod box can't accidentally store plaintext keys.
//
// File: worker/data/sniper-vault.json (gitignored — see STAKRR/.gitignore).
// Layout:
//   {
//     "version": 1,
//     "wallets": [{
//       "id": "wlt_abc",
//       "label": "snipe-1",
//       "source": "pool" | "ephemeral",
//       "publicKey": "...",
//       "tags": ["..."],
//       "launchMint": "..." | null,    // ephemeral wallets pin to a launch
//       "createdAt": "ISO",
//       "secretKeyEnc": {
//         "iv": "<hex>",
//         "tag": "<hex>",
//         "ct":  "<hex>"
//       }
//     }]
//   }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, getConnection } from '../config.js';

const VAULT_VERSION = 1;
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function vaultFilePath() {
  return process.env.SNIPE_VAULT_FILE
    ? path.resolve(process.env.SNIPE_VAULT_FILE)
    : path.join(path.dirname(path.resolve(config.registryFile)), 'sniper-vault.json');
}

function getVaultKey() {
  const raw = (process.env.SNIPE_VAULT_KEY || '').trim();
  if (!raw) return null;
  // Accept hex or base64. Hex preferred (openssl rand -hex 32).
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const buf = Buffer.from(raw, 'base64');
    if (buf.length === 32) return buf;
  } catch { /* fallthrough */ }
  throw new Error('SNIPE_VAULT_KEY must be a 32-byte hex (64 chars) or base64 string');
}

export function vaultEnabled() {
  return Boolean(getVaultKey());
}

function ensureKey() {
  const k = getVaultKey();
  if (!k) {
    throw new Error('SNIPE_VAULT_KEY not configured — run `openssl rand -hex 32` and add to worker .env');
  }
  return k;
}

function encryptSecret(secretBytes) {
  const key = ensureKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString('hex'), tag: tag.toString('hex'), ct: ct.toString('hex') };
}

function decryptSecret(enc) {
  const key = ensureKey();
  const iv = Buffer.from(enc.iv, 'hex');
  const tag = Buffer.from(enc.tag, 'hex');
  const ct = Buffer.from(enc.ct, 'hex');
  if (iv.length !== IV_BYTES) throw new Error('vault: bad iv length');
  if (tag.length !== TAG_BYTES) throw new Error('vault: bad tag length');
  const decipher = crypto.createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readVaultRaw() {
  const file = vaultFilePath();
  if (!fs.existsSync(file)) return { version: VAULT_VERSION, wallets: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.wallets)) return { version: VAULT_VERSION, wallets: [] };
    return data;
  } catch (e) {
    throw new Error(`sniper vault corrupted: ${e.message}`);
  }
}

function writeVault(data) {
  const file = vaultFilePath();
  ensureDir(file);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Belt + braces — restrict perms even if writeFileSync mode wasn't honoured
  // (some platforms / umask values).
  try { fs.chmodSync(file, 0o600); } catch { /* ignore */ }
}

function newId() {
  return `wlt_${crypto.randomBytes(6).toString('hex')}`;
}

function sanitize(w) {
  if (!w) return null;
  // Strip the encrypted blob from the API surface; only `publicKey` and
  // metadata are safe to expose. Decryption only happens server-side via
  // getKeypairById().
  const { secretKeyEnc, ...rest } = w;
  return rest;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function listWallets({ source = null, launchMint = null } = {}) {
  const reg = readVaultRaw();
  return reg.wallets
    .filter((w) => (source == null || w.source === source))
    .filter((w) => (launchMint == null || w.launchMint === launchMint))
    .map(sanitize);
}

export function getWallet(id) {
  const reg = readVaultRaw();
  return sanitize(reg.wallets.find((w) => w.id === id) || null);
}

export function getKeypairById(id) {
  const reg = readVaultRaw();
  const row = reg.wallets.find((w) => w.id === id);
  if (!row) throw new Error(`vault: no wallet with id ${id}`);
  if (!row.secretKeyEnc) throw new Error(`vault: wallet ${id} has no encrypted secret`);
  const secret = decryptSecret(row.secretKeyEnc);
  if (secret.length !== 64) throw new Error(`vault: wallet ${id} secret length ${secret.length} (expected 64)`);
  return Keypair.fromSecretKey(secret);
}

/** Generate a brand-new keypair and persist it. */
export function generateWallet({ label, source = 'pool', tags = [], launchMint = null } = {}) {
  if (source !== 'pool' && source !== 'ephemeral') {
    throw new Error(`vault: invalid source "${source}" (expected pool|ephemeral)`);
  }
  // Ephemeral wallets typically pin to a launchMint, but that's set AFTER the
  // bundle confirms (we don't know the mint until then). Allow null on create.
  ensureKey();
  const kp = Keypair.generate();
  const enc = encryptSecret(Buffer.from(kp.secretKey));
  const reg = readVaultRaw();
  const w = {
    id: newId(),
    label: label || `${source}-${reg.wallets.length + 1}`,
    source,
    publicKey: kp.publicKey.toBase58(),
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    launchMint: launchMint || null,
    createdAt: new Date().toISOString(),
    secretKeyEnc: enc,
  };
  reg.wallets.push(w);
  writeVault(reg);
  return sanitize(w);
}

/**
 * Import an existing keypair (base58 secret OR JSON array of bytes).
 * Refuses to add a duplicate publicKey.
 */
export function importWallet({ label, secretKey, source = 'pool', tags = [], launchMint = null } = {}) {
  if (!secretKey) throw new Error('vault: secretKey required');
  if (source !== 'pool' && source !== 'ephemeral') {
    throw new Error(`vault: invalid source "${source}"`);
  }
  ensureKey();

  let bytes;
  const trimmed = String(secretKey).trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('expected JSON array of 64 bytes');
      }
      bytes = Uint8Array.from(arr);
    } catch (e) {
      throw new Error(`vault: invalid JSON secret (${e.message})`);
    }
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch (e) {
      throw new Error(`vault: invalid base58 secret (${e.message})`);
    }
    if (bytes.length !== 64) {
      throw new Error(`vault: bad secret length ${bytes.length} (expected 64)`);
    }
  }

  const kp = Keypair.fromSecretKey(bytes);
  const pk = kp.publicKey.toBase58();

  const reg = readVaultRaw();
  if (reg.wallets.some((w) => w.publicKey === pk)) {
    throw new Error(`vault: wallet ${pk} already imported`);
  }
  const enc = encryptSecret(Buffer.from(bytes));
  const w = {
    id: newId(),
    label: label || `imported-${reg.wallets.length + 1}`,
    source,
    publicKey: pk,
    tags: Array.isArray(tags) ? tags.slice(0, 8) : [],
    launchMint: launchMint || null,
    createdAt: new Date().toISOString(),
    secretKeyEnc: enc,
    imported: true,
  };
  reg.wallets.push(w);
  writeVault(reg);
  return sanitize(w);
}

export function removeWallet(id) {
  const reg = readVaultRaw();
  const before = reg.wallets.length;
  reg.wallets = reg.wallets.filter((w) => w.id !== id);
  if (reg.wallets.length === before) return false;
  writeVault(reg);
  return true;
}

export function updateWallet(id, patch = {}) {
  const reg = readVaultRaw();
  const idx = reg.wallets.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const allowed = ['label', 'tags', 'launchMint'];
  const next = { ...reg.wallets[idx] };
  for (const k of allowed) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  reg.wallets[idx] = next;
  writeVault(reg);
  return sanitize(next);
}

/**
 * Export a wallet's secret as base58 (for emergency recovery / migration).
 * Caller must pass a `confirm: true` flag — endpoints require an explicit
 * extra confirmation header so we don't accidentally leak keys via a
 * misclick in the UI.
 */
export function exportWalletSecret(id, { confirm = false } = {}) {
  if (!confirm) throw new Error('vault: exportWalletSecret requires confirm=true');
  const kp = getKeypairById(id);
  return {
    publicKey: kp.publicKey.toBase58(),
    secretKeyB58: bs58.encode(kp.secretKey),
  };
}

// ── Balance helpers ───────────────────────────────────────────────────────────

/**
 * Return SOL balances for every wallet (or a filtered subset). Failures fall
 * back to `null` so a single bad RPC doesn't break the whole listing.
 */
export async function listWalletsWithBalances(filter = {}) {
  const wallets = listWallets(filter);
  if (wallets.length === 0) return [];
  const connection = getConnection();
  // Chunk to keep request size manageable; getMultipleAccountsInfo caps at 100.
  const out = wallets.map((w) => ({ ...w, solLamports: null, solError: null }));
  const chunkSize = 90;
  for (let i = 0; i < out.length; i += chunkSize) {
    const chunk = out.slice(i, i + chunkSize);
    const pks = chunk.map((w) => new PublicKey(w.publicKey));
    try {
      const infos = await connection.getMultipleAccountsInfo(pks, 'confirmed');
      infos.forEach((info, j) => {
        const target = out[i + j];
        target.solLamports = info?.lamports ?? 0;
      });
    } catch (e) {
      chunk.forEach((_, j) => {
        out[i + j].solError = e.message;
      });
    }
  }
  return out.map((w) => ({
    ...w,
    sol: w.solLamports == null ? null : w.solLamports / LAMPORTS_PER_SOL,
  }));
}

export function vaultStats() {
  const reg = readVaultRaw();
  const counts = { pool: 0, ephemeral: 0, total: reg.wallets.length };
  for (const w of reg.wallets) {
    counts[w.source] = (counts[w.source] || 0) + 1;
  }
  return {
    enabled: vaultEnabled(),
    file: vaultFilePath(),
    counts,
  };
}
