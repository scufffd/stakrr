#!/usr/bin/env node
/**
 * grind-vanity.js — Stakrr vanity address pool filler.
 *
 * Wraps `solana-keygen grind` (Rust, multithreaded, ~50M keys/s) and merges
 * the resulting keypairs into the JSON pool file the launch flow consumes
 * (see `popUnusedMintKeypairFromPool`).
 *
 * Multi-suffix: this script accepts CLI args so multiple instances can run
 * in parallel — one per (suffix, pool) pair. Pump.fun launches use the
 * `pump`-suffix pool; Meteora launches use the `stkr`-suffix pool. Run a
 * dedicated pm2 process for each.
 *
 * Usage:
 *   node scripts/grind-vanity.js                           # one-shot, env defaults
 *   node scripts/grind-vanity.js --daemon                  # daemon, env defaults
 *   node scripts/grind-vanity.js --daemon \\
 *     --label stkr --suffix stkr --pool ./data/vanity-stkr.json --target 200
 *
 * CLI args (override env):
 *   --pool <path>            output JSON pool file (env VANITY_MINT_POOL_FILE)
 *   --suffix <str>           base58 suffix to grind, CASE-SENSITIVE
 *                            (env VANITY_MINT_SUFFIX). Common: pump | stkr | STK.
 *   --target <n>             stop topping up once pool ≥ n (env GRIND_TARGET=300)
 *   --batch <n>              keys per solana-keygen invocation (env GRIND_BATCH=1)
 *   --threads <n>            solana-keygen --num-threads (env GRIND_THREADS=1)
 *   --sleep-ms <n>           daemon sleep after a successful grind (env GRIND_SLEEP_MS=90000)
 *   --sleep-full-ms <n>      daemon sleep when pool full (env GRIND_SLEEP_FULL_MS=600000)
 *   --nice <0..19>           unix nice level (env GRIND_NICE=19; 19 = lowest prio)
 *   --label <name>           log identifier (default: derived from suffix). Useful
 *                            when running parallel instances so pm2 logs are easy
 *                            to filter.
 *   --daemon                 long-running pm2 mode (no flag = exit after one round)
 *
 * Difficulty by suffix length (case-sensitive base58):
 *   3 chars (STK):  58^3   ≈ 195k keys/match  → instant on 1 vCPU
 *   4 chars (stkr): 58^4   ≈ 11M keys/match   → seconds-to-tens-of-seconds
 *   5 chars (stakr): 58^5  ≈ 656M keys/match  → minutes per match
 *
 * Production preset on Faith droplet (1 vCPU, 458 MiB RAM):
 *   1 thread, batch 1, sleep 90s, nice 19 — never starves stakrr-api /
 *   stakrr-loop. Target 300 ≈ many days of "1 launch / 40 min" before refill.
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

// CLI args parsing — supports `--key value` and `--key=value`. Only the
// flags listed in the file header are honoured; unknown flags are ignored.
function parseCliArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--daemon') { out.daemon = true; continue; }
    const eq = a.indexOf('=');
    let key, val;
    if (eq > 0) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
    out[key] = val;
  }
  return out;
}
const CLI = parseCliArgs(process.argv);

function pickStr(cliKey, envKey, fallback) {
  const v = CLI[cliKey];
  if (typeof v === 'string' && v.trim()) return v.trim();
  const e = process.env[envKey];
  if (typeof e === 'string' && e.trim()) return e.trim();
  return fallback;
}
function pickInt(cliKey, envKey, fallback) {
  const v = CLI[cliKey];
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return intEnv(envKey, fallback);
}

const POOL_REL = pickStr('pool', 'VANITY_MINT_POOL_FILE', 'data/vanity-pump.json');
const POOL_FILE = path.isAbsolute(POOL_REL)
  ? POOL_REL
  : path.resolve(__dirname, '..', POOL_REL);
// CASE-SENSITIVE: solana-keygen `--ends-with` is case-sensitive, and the
// worker's `popUnusedMintKeypairFromPool` does a case-sensitive
// `String.endsWith` match. We must NOT lowercase here or "STK" would grind
// keys ending in "stk" that the launcher then can't find. Mismatch silently.
const SUFFIX           = pickStr('suffix', 'VANITY_MINT_SUFFIX', 'pump');
const TARGET           = pickInt('target', 'GRIND_TARGET', 300);
const BATCH            = Math.max(1, pickInt('batch', 'GRIND_BATCH', 1));
const THREADS          = Math.max(1, pickInt('threads', 'GRIND_THREADS', 1));
const SLEEP_MS         = pickInt('sleep-ms', 'GRIND_SLEEP_MS', 90_000);
const SLEEP_FULL_MS    = pickInt('sleep-full-ms', 'GRIND_SLEEP_FULL_MS', 600_000);
const NICE             = clamp(pickInt('nice', 'GRIND_NICE', 19), 0, 19);
const DAEMON           = !!CLI.daemon || process.argv.includes('--daemon');
const LABEL            = pickStr('label', 'GRIND_LABEL', SUFFIX);

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
  label: LABEL,
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
          // CASE-SENSITIVE match — must align with worker's
          // popUnusedMintKeypairFromPool which uses String.endsWith.
          if (!pubKey.endsWith(SUFFIX)) continue;
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
  // `label` is set after CLI parsing — guard for the early-startup `log()`
  // calls that happen before LABEL exists (e.g. "solana-keygen not found").
  const label = typeof LABEL === 'string' ? LABEL : null;
  const tagged = label ? { label, ...extra } : extra;
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...tagged }));
}
