#!/usr/bin/env node
// Prune the vanity mint pool by removing entries whose mint is already
// claimed on-chain. Safe to run ad-hoc — it rewrites the JSON in place
// (atomic via .tmp + rename, same path that `popUnusedMintKeypairFromPool`
// uses internally).
//
//   npm run prune-vanity
//
// Reads VANITY_MINT_POOL_FILE + VANITY_MINT_SUFFIX from worker .env.
// If you want to limit RPC chatter, the script batches 100 pubkeys per
// `getMultipleAccountsInfo` call.

import { config, getConnection } from '../src/config.js';
import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';

function readPool(path) {
  if (!path || !fs.existsSync(path)) return null;
  try {
    const list = JSON.parse(fs.readFileSync(path, 'utf8'));
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

function writePool(path, list) {
  const tmp = `${path}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, path);
}

async function main() {
  const path = config.vanityMintPoolFile;
  const suffix = config.vanityMintSuffix;
  if (!path) {
    console.error('VANITY_MINT_POOL_FILE not set in .env — nothing to do');
    process.exit(2);
  }
  const list = readPool(path);
  if (!list) {
    console.error(`pool file missing or unreadable: ${path}`);
    process.exit(1);
  }
  const total = list.length;
  console.log(`pool ${path}: ${total} entries (suffix filter: '${suffix}')`);

  const candidates = list
    .map((e, idx) => ({ idx, entry: e }))
    .filter(({ entry }) => !suffix || (entry?.publicKey && String(entry.publicKey).endsWith(suffix)));
  console.log(`  ${candidates.length} match suffix`);

  const connection = getConnection();
  const usedIdx = new Set();
  const batchSize = 100;
  for (let start = 0; start < candidates.length; start += batchSize) {
    const slice = candidates.slice(start, start + batchSize);
    const pks = slice.map(({ entry }) => new PublicKey(entry.publicKey));
    process.stdout.write(`  checking ${start + 1}-${start + slice.length} of ${candidates.length}… `);
    const infos = await connection.getMultipleAccountsInfo(pks, 'confirmed');
    let usedHere = 0;
    for (let i = 0; i < slice.length; i++) {
      if (infos[i] !== null) {
        usedIdx.add(slice[i].idx);
        usedHere += 1;
      }
    }
    console.log(`used so far: ${usedIdx.size}, this batch: ${usedHere}`);
  }

  if (usedIdx.size === 0) {
    console.log('no used mints found — pool unchanged');
    return;
  }

  const next = list.filter((_, i) => !usedIdx.has(i));
  writePool(path, next);
  console.log(`pruned ${usedIdx.size} used entries; ${next.length} remaining`);
  console.log('used (now removed):');
  for (const i of usedIdx) console.log(`  - ${list[i].publicKey}`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
