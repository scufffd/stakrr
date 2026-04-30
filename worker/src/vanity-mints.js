import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';

/**
 * Pop the first keypair from a JSON pool file whose public key ends with `suffix`
 * (base58 suffix, e.g. STK or pump). Same file shape as revflow vanity pools:
 * [{ "publicKey": "...", "secretKey": "<base64>" }, ...]
 *
 * Removes the entry atomically so it is not reused. Caller should only call
 * after deciding to attempt a launch (if create fails, the key is lost — keep backups).
 */
export function popMintKeypairFromPool(filePath, suffix) {
  if (!filePath || !suffix) return null;
  if (!fs.existsSync(filePath)) return null;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
  if (!Array.isArray(list)) return null;
  const suf = String(suffix);
  const idx = list.findIndex((e) => e?.publicKey && String(e.publicKey).endsWith(suf));
  if (idx < 0) return null;
  const entry = list[idx];
  let kp;
  try {
    const buf = Buffer.from(entry.secretKey, 'base64');
    kp = Keypair.fromSecretKey(new Uint8Array(buf));
  } catch {
    return null;
  }
  if (kp.publicKey.toBase58() !== entry.publicKey) return null;
  list.splice(idx, 1);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, filePath);
  return kp;
}
