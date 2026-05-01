#!/usr/bin/env node
/**
 * grind-vanity.js — Stakrr vanity address pool filler.
 *
 * Wraps `solana-keygen grind` (Rust, multithreaded, ~50M keys/s) and merges
 * the resulting keypairs into Stakrr's `data/vanity-pump.json`. Same shape
 * the launch flow already consumes (see `popUnusedMintKeypairFromPool`).
 *
 * Usage:
 *   node scripts/grind-vanity.js              # one-shot: grind GRIND_BATCH then exit
 *   node scripts/grind-vanity.js --daemon     # long-running pm2 mode
 *
 * Env (worker .env):
 *   VANITY_MINT_POOL_FILE   → output pool path (./data/vanity-pump.json)
 *   VANITY_MINT_SUFFIX      → base58 suffix (pump)
 *   GRIND_TARGET            → stop topping up once pool reaches this size (300)
 *   GRIND_BATCH             → keys per `solana-keygen grind` invocation (1)
 *   GRIND_THREADS           → solana-keygen --num-threads (1 — keep low on shared boxes)
 *   GRIND_SLEEP_MS          → daemon sleep after a successful grind (90000)
 *   GRIND_SLEEP_FULL_MS     → daemon sleep when pool ≥ TARGET (600000)
 *   GRIND_NICE              → unix nice level 0..19 (19 — lowest priority on Linux)
 *
 * Production preset on Faith droplet (1 vCPU, 458 MiB RAM):
 *   1 thread, batch 1, sleep 90s, nice 19. Average CPU ~5–10% over time;
 *   never starves stakrr-api / stakrr-loop. ~3 mints/min when grinding,
 *   ~0% when pool is full. Target 300 = ~9 days of "1 launch every 40 min"
 *   before refill is even needed.
 */

import { spawn, execSync } from 'node:child_process';
import fs   from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const POOL_FILE = process.env.VANITY_MINT_POOL_FILE
  ? path.resolve(__dirname, '..', process.env.VANITY_MINT_POOL_FILE)
  : path.resolve(__dirname, '..', 'data', 'vanity-pump.json');
const SUFFIX           = (process.env.VANITY_MINT_SUFFIX || 'pump').toLowerCase();
const TARGET           = intEnv('GRIND_TARGET', 300);
const BATCH            = Math.max(1, intEnv('GRIND_BATCH', 1));
const THREADS          = Math.max(1, intEnv('GRIND_THREADS', 1));
const SLEEP_MS         = intEnv('GRIND_SLEEP_MS', 90_000);
const SLEEP_FULL_MS    = intEnv('GRIND_SLEEP_FULL_MS', 600_000);
const NICE             = clamp(intEnv('GRIND_NICE', 19), 0, 19);
const DAEMON           = process.argv.includes('--daemon');

// ── solana-keygen discovery ──────────────────────────────────────────────────

const KEYGEN_PATHS = [
  process.env.SOLANA_KEYGEN_BIN,
  '/root/.local/share/solana/install/active_release/bin/solana-keygen',
  '/home/stakrr/.local/share/solana/install/active_release/bin/solana-keygen',
  `${os.homedir()}/.local/share/solana/install/active_release/bin/solana-keygen`,
  '/usr/local/bin/solana-keygen',
  '/usr/bin/solana-keygen',
  'solana-keygen',
].filter(Boolean);

let KEYGEN = null;
for (const p of KEYGEN_PATHS) {
  try {
    execSync(`${p} --version`, { stdio: 'ignore' });
    KEYGEN = p;
    break;
  } catch (_) { /* try next */ }
}

if (!KEYGEN) {
  log('grind: solana-keygen not found', { searched: KEYGEN_PATHS });
  process.exit(1);
}

log('grind: starting', {
  daemon: DAEMON,
  poolFile: POOL_FILE,
  suffix: SUFFIX,
  target: TARGET,
  batch: BATCH,
  threads: THREADS,
  niceLevel: NICE,
  sleepMs: SLEEP_MS,
  sleepFullMs: SLEEP_FULL_MS,
  keygenBin: KEYGEN,
});

// ── Pool helpers (atomic via tmp + rename) ───────────────────────────────────

function readPool() {
  if (!fs.existsSync(POOL_FILE)) return [];
  try {
    const list = JSON.parse(fs.readFileSync(POOL_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    log('grind: pool unreadable', { error: e.message });
    return [];
  }
}

function writePool(list) {
  const dir = path.dirname(POOL_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${POOL_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, POOL_FILE);
}

// ── One grind round: spawn solana-keygen, return the new entries ─────────────

function grindOnce(needed, knownKeys) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stakrr-grind-'));

  const cleanup = () => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };

  return new Promise((resolve, reject) => {
    // Wrap in `nice` on Linux so the kernel pre-empts the grinder for the
    // API/loop. On macOS `nice` is also POSIX so this still works locally.
    const useNice = process.platform === 'linux' || process.platform === 'darwin';
    const cmd = useNice ? 'nice' : KEYGEN;
    const args = useNice
      ? ['-n', String(NICE), KEYGEN, 'grind', '--ends-with', `${SUFFIX}:${needed}`, '--num-threads', String(THREADS)]
      : ['grind', '--ends-with', `${SUFFIX}:${needed}`, '--num-threads', String(THREADS)];

    const child = spawn(cmd, args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => { cleanup(); reject(err); });
    child.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`solana-keygen exit ${code}: ${stderr.slice(0, 200)}`);
        cleanup();
        return reject(err);
      }
      try {
        const files = fs.readdirSync(workDir).filter((f) => f.endsWith('.json'));
        const fresh = [];
        for (const file of files) {
          const pubKey = path.basename(file, '.json');
          if (!pubKey.toLowerCase().endsWith(SUFFIX)) continue;
          if (knownKeys.has(pubKey)) continue;
          const secretBytes = JSON.parse(fs.readFileSync(path.join(workDir, file), 'utf8'));
          fresh.push({
            publicKey: pubKey,
            secretKey: Buffer.from(secretBytes).toString('base64'),
            createdAt: new Date().toISOString(),
          });
          knownKeys.add(pubKey);
        }
        cleanup();
        resolve(fresh);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Main loop ────────────────────────────────────────────────────────────────

let stopping = false;
process.on('SIGTERM', () => { stopping = true; log('grind: SIGTERM, finishing current round'); });
process.on('SIGINT',  () => { stopping = true; log('grind: SIGINT, finishing current round'); });

(async () => {
  do {
    // Re-read every loop so manual SCP / prune-vanity / launches stay consistent.
    const pool = readPool();
    const known = new Set(pool.map((e) => e.publicKey));

    if (pool.length >= TARGET) {
      if (!DAEMON) {
        log('grind: pool already full, exiting', { size: pool.length, target: TARGET });
        return;
      }
      log('grind: pool full, sleeping', { size: pool.length, target: TARGET, sleepMs: SLEEP_FULL_MS });
      await sleep(SLEEP_FULL_MS);
      continue;
    }

    const needed = Math.min(BATCH, TARGET - pool.length);
    const startedAt = Date.now();
    log('grind: round start', { poolSize: pool.length, target: TARGET, needed });

    let fresh = [];
    try {
      fresh = await grindOnce(needed, known);
    } catch (e) {
      log('grind: round failed', { error: e.message });
      if (!DAEMON) process.exit(1);
      await sleep(SLEEP_MS);
      continue;
    }
    const elapsedMs = Date.now() - startedAt;

    if (fresh.length > 0) {
      // Re-read pool right before write to minimize race with concurrent
      // popUnusedMintKeypairFromPool; merge fresh on top of latest state.
      const latest = readPool();
      const dedup = new Map(latest.map((e) => [e.publicKey, e]));
      for (const e of fresh) if (!dedup.has(e.publicKey)) dedup.set(e.publicKey, e);
      const next = Array.from(dedup.values());
      writePool(next);
      log('grind: round done', {
        added: fresh.length,
        newPoolSize: next.length,
        elapsedMs,
        msPerKey: Math.round(elapsedMs / fresh.length),
      });
      for (const e of fresh) log('grind: minted', { publicKey: e.publicKey });
    } else {
      log('grind: round done (no new entries)', { elapsedMs });
    }

    if (!DAEMON) return;
    await sleep(SLEEP_MS);
  } while (DAEMON && !stopping);

  log('grind: stopping');
})().catch((e) => {
  log('grind: fatal', { error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
  process.exit(1);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function intEnv(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}
