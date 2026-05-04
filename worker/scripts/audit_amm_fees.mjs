import { Connection, PublicKey } from '@solana/web3.js';
import { findFeeSharingConfigPda, findCoinCreatorVaultAuthorityPda, findBondingCurvePda, WSOL_MINT, fetchFeeSharingConfig } from '../src/pump-fees.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import fs from 'node:fs';

const c = new Connection(process.env.RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const raw = JSON.parse(fs.readFileSync('data/pools.json','utf8'));
const list = Array.isArray(raw) ? raw : (Array.isArray(raw.pools) ? raw.pools : Object.values(raw));
const pools = list.filter(p => p && p.stakeMint && (p.status === 'active' || !p.status));
console.log(`Auditing ${pools.length} active pools for unclaimed AMM creator fees…\n`);

const rows = [];
for (const p of pools) {
  const mint = new PublicKey(p.stakeMint);
  const cfg  = findFeeSharingConfigPda(mint);
  const cvAuth = findCoinCreatorVaultAuthorityPda(cfg);
  const cvAta  = getAssociatedTokenAddressSync(WSOL_MINT, cvAuth, true);
  const bcPda  = findBondingCurvePda(mint);

  // BC complete?
  let bcComplete = '?';
  try {
    const bc = await c.getAccountInfo(bcPda);
    if (bc) bcComplete = bc.data[8 + 40] ? 'graduated' : 'pre-grad';
  } catch {}

  // Locked?
  let locked = false;
  try {
    locked = !!(await fetchFeeSharingConfig(c, mint));
  } catch {}

  // AMM vault WSOL balance
  let ammLamports = 0n;
  try {
    const info = await c.getAccountInfo(cvAta, 'confirmed');
    if (info && info.data.length >= 72) {
      ammLamports = info.data.readBigUInt64LE(64);
    }
  } catch {}

  rows.push({
    symbol: p.symbol || '?',
    mint: p.stakeMint,
    locked,
    bc: bcComplete,
    ammLamports,
  });
  await new Promise(r=>setTimeout(r,150));
}

console.log('symbol  | bc-state    | locked | AMM unclaimed (SOL) | mint');
console.log('--------+-------------+--------+---------------------+--------------------------------------------');
let total = 0n;
for (const r of rows) {
  const sol = (Number(r.ammLamports) / 1e9).toFixed(6);
  total += r.ammLamports;
  console.log(`${r.symbol.padEnd(7)} | ${r.bc.padEnd(11)} | ${(r.locked?'yes':'no').padEnd(6)} | ${sol.padStart(19)} | ${r.mint}`);
}
console.log('---');
console.log(`TOTAL stranded AMM fees: ${(Number(total)/1e9).toFixed(6)} SOL across ${rows.length} pools`);
