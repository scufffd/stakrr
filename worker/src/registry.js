import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const REGISTRY_VERSION = 1;

function emptyRegistry() {
  return { version: REGISTRY_VERSION, pools: [] };
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readRegistryRaw() {
  const file = config.registryFile;
  if (!fs.existsSync(file)) return emptyRegistry();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || !Array.isArray(data.pools)) return emptyRegistry();
    return data;
  } catch (e) {
    console.warn('registry: failed to read, starting empty', e.message);
    return emptyRegistry();
  }
}

function writeRegistry(reg) {
  ensureDir(config.registryFile);
  const tmp = `${config.registryFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2));
  fs.renameSync(tmp, config.registryFile);
}

export function listPools({ status = 'active' } = {}) {
  const reg = readRegistryRaw();
  if (status === 'all') return reg.pools;
  return reg.pools.filter((p) => p.status === status);
}

export function getPool(stakeMint) {
  return readRegistryRaw().pools.find((p) => p.stakeMint === stakeMint) || null;
}

export function upsertPool(pool) {
  if (!pool || !pool.stakeMint) throw new Error('upsertPool: stakeMint required');
  const reg = readRegistryRaw();
  const idx = reg.pools.findIndex((p) => p.stakeMint === pool.stakeMint);
  const now = new Date().toISOString();
  const merged = idx >= 0
    ? { ...reg.pools[idx], ...pool, updatedAt: now }
    : {
        version: 1,
        status: 'active',
        rewardMint: 'So11111111111111111111111111111111111111112',
        rewardMode: 'sol',
        platformFeeBps: 200,
        totalCreatorFeesClaimedLamports: '0',
        totalPlatformFeesLamports: '0',
        totalRewardsDistributedLamports: '0',
        totalRewardsTokenRaw: '0',
        lastClaimedAt: null,
        lastDistributedAt: null,
        createdAt: now,
        updatedAt: now,
        ...pool,
      };
  if (idx >= 0) reg.pools[idx] = merged;
  else reg.pools.push(merged);
  writeRegistry(reg);
  return merged;
}

export function removePool(stakeMint) {
  const reg = readRegistryRaw();
  reg.pools = reg.pools.filter((p) => p.stakeMint !== stakeMint);
  writeRegistry(reg);
}

export function recordEvent(event) {
  ensureDir(config.eventLedgerFile);
  const line = JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n';
  fs.appendFileSync(config.eventLedgerFile, line);
}

/** Read last N JSONL events (newest last in returned array). */
export function readRecentEvents(limit = 200) {
  const file = config.eventLedgerFile;
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const slice = lines.slice(-Math.max(1, Math.min(2000, limit)));
  const out = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

// Convenience helpers for accumulating per-pool metrics atomically.
export function addToPoolMetrics(stakeMint, deltas) {
  const reg = readRegistryRaw();
  const idx = reg.pools.findIndex((p) => p.stakeMint === stakeMint);
  if (idx < 0) return null;
  const pool = reg.pools[idx];
  for (const [key, lamports] of Object.entries(deltas)) {
    const current = BigInt(pool[key] || '0');
    pool[key] = (current + BigInt(lamports)).toString();
  }
  pool.updatedAt = new Date().toISOString();
  reg.pools[idx] = pool;
  writeRegistry(reg);
  return pool;
}

/**
 * Set arbitrary scalar/object fields on a pool atomically. Used by the worker
 * to persist diagnostics like `lastClaimAttemptAt` / `lastClaimedAt` /
 * `lastClaimAttemptEstimate` without going through the deltas helper.
 */
export function updatePoolFields(stakeMint, fields) {
  const reg = readRegistryRaw();
  const idx = reg.pools.findIndex((p) => p.stakeMint === stakeMint);
  if (idx < 0) return null;
  const pool = reg.pools[idx];
  for (const [key, value] of Object.entries(fields)) {
    pool[key] = value;
  }
  pool.updatedAt = new Date().toISOString();
  reg.pools[idx] = pool;
  writeRegistry(reg);
  return pool;
}
