// PumpDev API adapter — Pump.fun integration.
// Docs: https://github.com/pumpdev3/pumpdev.io  /  https://pumpdev.io/welcome
//
// Endpoints we use:
//   POST /api/create        -> create a pump.fun token (client-signed)
//   POST /api/claim-account -> claim accumulated creator fees (client-signed)
//
// Notes:
// - `/api/create` returns JSON `{ mint, mintSecretKey, transaction }` where
//   `transaction` is a base58-encoded VersionedTransaction. Caller signs with
//   the creator (treasury) + the returned mint keypair, then sends via our RPC.
// - `/api/claim-account` returns a raw serialized VersionedTransaction in the
//   response body (Uint8Array via arrayBuffer()). Caller signs with the creator
//   wallet and sends.
// - PumpDev does NOT host metadata for `/api/create`; the caller must pre-upload
//   the metadata JSON and pass the resulting `uri`. We use pump.fun/api/ipfs
//   in `pumpfun-ipfs.js` for that step.

import { Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from './config.js';

function endpoint(path) {
  return `${config.pumpdev.base.replace(/\/$/, '')}${path}`;
}

function authHeaders(extra = {}) {
  const h = { 'content-type': 'application/json', ...extra };
  if (config.pumpdev.apiKey) h.authorization = `Bearer ${config.pumpdev.apiKey}`;
  return h;
}

/**
 * Build the create-token transaction for Pump.fun.
 *
 * @returns {Promise<{
 *   tx: VersionedTransaction,
 *   mint: string,
 *   mintKeypair: Keypair,
 * }>}
 */
export async function buildCreateTokenTx({
  publicKey,         // base58 creator pubkey (treasury)
  name,
  symbol,
  uri,               // pre-uploaded metadata URI
  buyAmountSol = 0,  // optional dev buy in SOL
  slippage = 30,
  jitoTip,
  cashbackEnabled,
}) {
  if (!publicKey) throw new Error('buildCreateTokenTx: publicKey required');
  if (!name || !symbol) throw new Error('buildCreateTokenTx: name + symbol required');
  if (!uri) throw new Error('buildCreateTokenTx: uri required (upload metadata first)');

  const body = {
    publicKey,
    name,
    symbol,
    uri,
    buyAmountSol: Number(buyAmountSol) || 0,
    slippage: Number(slippage) || 30,
  };
  if (jitoTip != null) body.jitoTip = Number(jitoTip);
  if (cashbackEnabled) body.cashbackEnabled = true;

  const res = await fetch(endpoint('/api/create'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`PumpDev /api/create HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`PumpDev /api/create non-JSON: ${text.slice(0, 200)}`);
  }
  if (json.error) {
    throw new Error(`PumpDev /api/create error: ${json.error}`);
  }
  if (!json.mint || !json.mintSecretKey || !json.transaction) {
    throw new Error(`PumpDev /api/create missing fields: ${text.slice(0, 200)}`);
  }
  const mintKeypair = Keypair.fromSecretKey(bs58.decode(json.mintSecretKey));
  const tx = VersionedTransaction.deserialize(bs58.decode(json.transaction));
  return { tx, mint: json.mint, mintKeypair };
}

/**
 * Build a Pump.fun buy/sell transaction via PumpDev `/api/trade-local`.
 *
 * Used by the worker when a pool's `rewardMode === 'token'`: each cycle the
 * worker swaps the stakers' share of claimed creator-fees (SOL) into the
 * launched token via the bonding curve, then deposits the resulting tokens
 * into the staking pool's reward vault.
 *
 * Returns a deserialized VersionedTransaction. Caller signs with `publicKey`'s
 * keypair and sends.
 *
 * @returns {Promise<VersionedTransaction>}
 */
export async function buildTradeTx({
  publicKey,                 // base58 pubkey of the wallet that will sign + receive tokens
  action,                    // 'buy' | 'sell'
  mint,                      // token mint to buy/sell
  amount,                    // SOL when denominatedInSol=true; token amount otherwise
  denominatedInSol = 'true',
  slippage = 5,              // percent; pump.fun bonding curve can move fast
  priorityFee = 0.0001,
  pool = 'pump',             // 'pump' (bonding curve) | 'pump-amm' | 'auto'
}) {
  if (!publicKey) throw new Error('buildTradeTx: publicKey required');
  if (!mint) throw new Error('buildTradeTx: mint required');
  if (!action || !['buy', 'sell'].includes(action)) {
    throw new Error("buildTradeTx: action must be 'buy' or 'sell'");
  }
  const body = {
    publicKey,
    action,
    mint,
    amount: Number(amount),
    denominatedInSol: String(denominatedInSol) === 'true' ? 'true' : 'false',
    slippage: Number(slippage),
    priorityFee: Number(priorityFee),
    pool,
  };
  const res = await fetch(endpoint('/api/trade-local'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpDev /api/trade-local HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(buf);
}

/**
 * Convenience: SOL-denominated buy via the bonding curve.
 */
export async function buildBuyTokenTx({ publicKey, mint, solAmount, slippage = 5, priorityFee = 0.0001, pool = 'auto' }) {
  return buildTradeTx({
    publicKey,
    action: 'buy',
    mint,
    amount: Number(solAmount),
    denominatedInSol: 'true',
    slippage,
    priorityFee,
    pool,
  });
}

/**
 * Build a claim-creator-fees transaction.
 *
 * @returns {Promise<VersionedTransaction>}
 */
export async function buildClaimCreatorFeesTx({ publicKey, mint, priorityFee = 0.0001 }) {
  if (!publicKey) throw new Error('buildClaimCreatorFeesTx: publicKey required');
  const body = { publicKey, priorityFee };
  if (mint) body.mint = mint;

  const res = await fetch(endpoint('/api/claim-account'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpDev /api/claim-account HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(buf);
}
