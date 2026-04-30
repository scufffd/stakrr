// PumpDev API adapter — Pump.fun integration.
// Docs: https://pumpdev.io/
//
// We use two endpoints in MVP:
//   POST /api/create               -> create a pump.fun token (returns mint)
//   POST /api/claim-account        -> claim accumulated creator fees
//
// Notes:
// - Token creation is done client-side: PumpDev returns a serialized tx, we sign
//   with the platform treasury keypair, send it ourselves, and the treasury is
//   recorded as the on-chain creator (so it receives all future creator fees).
// - Claim is also client-side signed by the treasury.

import { VersionedTransaction } from '@solana/web3.js';
import { config } from './config.js';

function authHeaders() {
  const h = { 'content-type': 'application/json' };
  if (config.pumpdev.apiKey) h.authorization = `Bearer ${config.pumpdev.apiKey}`;
  return h;
}

async function postJson(path, body) {
  const url = `${config.pumpdev.base.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PumpDev ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`PumpDev ${path} non-JSON response: ${text.slice(0, 200)}`);
  }
}

async function postRaw(path, body) {
  const url = `${config.pumpdev.base.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpDev ${path} HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export async function buildCreateTokenTx({
  publicKey,            // base58 string of the wallet that will be the creator/fee receiver (treasury)
  metadata,             // { name, symbol, description, twitter?, telegram?, website?, image? }
  initialBuySol = 0,    // optional dev buy in SOL
}) {
  if (!publicKey) throw new Error('buildCreateTokenTx: publicKey required');
  if (!metadata?.name || !metadata?.symbol) {
    throw new Error('buildCreateTokenTx: metadata.name and symbol required');
  }
  const body = {
    publicKey,
    action: 'create',
    tokenMetadata: metadata,
    denominatedInSol: 'true',
    amount: initialBuySol,
    slippage: 1000,
    priorityFee: 0.0005,
    pool: 'pump',
  };
  const buf = await postRaw('/api/create', body);
  return VersionedTransaction.deserialize(buf);
}

export async function buildClaimCreatorFeesTx({ publicKey }) {
  if (!publicKey) throw new Error('buildClaimCreatorFeesTx: publicKey required');
  const buf = await postRaw('/api/claim-account', { publicKey });
  return VersionedTransaction.deserialize(buf);
}

// Optional read endpoint used by the worker to know if a claim is even worth doing.
// PumpDev exposes a token info endpoint; if it changes, fall back to the on-chain
// SOL balance delta of the creator wallet between claims.
export async function getCreatorAccountInfo({ publicKey }) {
  try {
    const url = `${config.pumpdev.base.replace(/\/$/, '')}/api/account/${publicKey}`;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
