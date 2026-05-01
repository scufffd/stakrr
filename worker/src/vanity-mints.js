import fs from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';

/**
 * JSON pool of pre-ground vanity keypairs (revflow shape):
 *   [{ "publicKey": "...", "secretKey": "<base64>", "createdAt"?: "..." }, ...]
 *
 * `popMintKeypairFromPool` removes the first matching entry atomically and
 * returns the Keypair. The newer `popUnusedMintKeypairFromPool` first checks
 * each candidate against the chain so we don't try to mint an address that
 * has already been used (e.g. the same vanity pool got partially consumed
 * by another tool — happens when the JSON is shared across projects).
 */

function readPool(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function writePool(filePath, list) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, filePath);
}

function entryToKeypair(entry) {
  if (!entry?.publicKey || !entry?.secretKey) return null;
  let kp;
  try {
    const buf = Buffer.from(entry.secretKey, 'base64');
    kp = Keypair.fromSecretKey(new Uint8Array(buf));
  } catch {
    return null;
  }
  if (kp.publicKey.toBase58() !== entry.publicKey) return null;
  return kp;
}

/**
 * Pop the first keypair from the pool whose public key ends with `suffix`
 * (base58 suffix, e.g. "STK" or "pump"). Removes the entry atomically.
 *
 * Does NOT check on-chain usage — see `popUnusedMintKeypairFromPool` for
 * a chain-aware variant. Use the chain-aware one in the launch flow.
 */
export function popMintKeypairFromPool(filePath, suffix) {
  if (!filePath || !suffix) return null;
  const list = readPool(filePath);
  if (!list) return null;
  const suf = String(suffix);
  const idx = list.findIndex((e) => e?.publicKey && String(e.publicKey).endsWith(suf));
  if (idx < 0) return null;
  const kp = entryToKeypair(list[idx]);
  if (!kp) return null;
  list.splice(idx, 1);
  writePool(filePath, list);
  return kp;
}

/**
 * Pop the first UNUSED keypair from the pool whose public key ends with
 * `suffix`. "Unused" means the on-chain account at that pubkey doesn't
 * exist yet. Any used candidates encountered along the way are pruned
 * from the pool (so subsequent calls don't waste RPC roundtrips).
 *
 * Returns `{ keypair, pruned }` where `pruned` is the count of already-used
 * entries we removed during the search. Returns `null` if no unused entry
 * with the suffix is available.
 *
 * Caller passes a `Connection` (use `getConnection()` from config.js).
 *
 * Implementation: we batch up to `batchSize` candidates per
 * `getMultipleAccountsInfo` call to keep RPC usage bounded. For typical
 * pool sizes (<200 entries) and a healthy pool (mostly unused) this is one
 * RPC call.
 */
export async function popUnusedMintKeypairFromPool(filePath, suffix, connection, opts = {}) {
  if (!filePath || !suffix || !connection) return null;
  const list = readPool(filePath);
  if (!list) return null;
  const suf = String(suffix);

  const candidates = [];
  list.forEach((e, i) => {
    if (e?.publicKey && String(e.publicKey).endsWith(suf)) {
      candidates.push({ idx: i, entry: e });
    }
  });
  if (candidates.length === 0) return null;

  const batchSize = Math.max(1, Math.min(100, opts.batchSize || 100));
  const used = new Set();
  let chosen = null;

  for (let start = 0; start < candidates.length; start += batchSize) {
    const slice = candidates.slice(start, start + batchSize);
    let infos;
    try {
      const pks = slice.map((c) => new PublicKey(c.entry.publicKey));
      infos = await connection.getMultipleAccountsInfo(pks, 'confirmed');
    } catch (err) {
      // RPC outage — fall back to the legacy non-checking pop so launches
      // don't block on a transient failure. Worst case: we try a used mint
      // and the create tx fails fast (cheap, user retries).
      console.warn(JSON.stringify({
        ts: new Date().toISOString(),
        message: 'vanity-mints: getMultipleAccountsInfo failed, falling back to legacy pop',
        error: err.message || String(err),
      }));
      return null;
    }
    for (let i = 0; i < slice.length; i++) {
      const acc = infos[i];
      if (acc !== null) {
        used.add(slice[i].idx);
        continue;
      }
      const kp = entryToKeypair(slice[i].entry);
      if (kp) {
        chosen = { idx: slice[i].idx, keypair: kp };
        break;
      }
      used.add(slice[i].idx); // bad entry — remove
    }
    if (chosen) break;
  }

  if (used.size === 0 && !chosen) return null;
  // Build the new list, removing both `chosen` (consumed) and any `used`.
  const removeIdx = new Set(used);
  if (chosen) removeIdx.add(chosen.idx);
  const next = list.filter((_, i) => !removeIdx.has(i));
  if (next.length !== list.length) writePool(filePath, next);
  return chosen ? { keypair: chosen.keypair, pruned: used.size } : null;
}

/**
 * Read-only stats for /api/vanity-pool/stats and ops dashboards.
 *
 * `chainCheckCap` limits how many candidates we hit RPC for; pool may have
 * thousands of entries and we don't want a stats endpoint to thrash Helius.
 * Default 0 = no on-chain check, just return the file count for the suffix.
 */
export async function getVanityPoolStats(filePath, suffix, connection = null, chainCheckCap = 0) {
  const stats = {
    filePath: filePath || null,
    suffix: suffix || null,
    fileExists: false,
    totalEntries: 0,
    suffixMatching: 0,
    chainChecked: 0,
    knownAvailable: null,
    knownUsed: null,
  };
  if (!filePath || !suffix) return stats;
  const list = readPool(filePath);
  if (!list) return stats;
  stats.fileExists = true;
  stats.totalEntries = list.length;
  const matches = list.filter((e) => e?.publicKey && String(e.publicKey).endsWith(suffix));
  stats.suffixMatching = matches.length;

  if (!connection || chainCheckCap <= 0 || matches.length === 0) return stats;
  const sample = matches.slice(0, Math.min(matches.length, chainCheckCap));
  let infos;
  try {
    infos = await connection.getMultipleAccountsInfo(
      sample.map((e) => new PublicKey(e.publicKey)),
      'confirmed',
    );
  } catch {
    return stats;
  }
  let used = 0;
  for (const a of infos) if (a !== null) used += 1;
  stats.chainChecked = sample.length;
  stats.knownUsed = used;
  stats.knownAvailable = sample.length - used;
  return stats;
}
