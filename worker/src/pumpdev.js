// PumpDev API adapter — Pump.fun integration.
// Docs: https://github.com/pumpdev3/pumpdev.io  /  https://pumpdev.io/welcome
//
// Endpoints we use:
//   POST /api/create           -> create a pump.fun token (client-signed)
//   POST /api/claim-account    -> claim accumulated creator fees (client-signed)
//   POST /api/claim-distribute -> distribute fee-sharing payouts (client-signed; mint required)
//   POST /api/trade-local      -> bonding-curve buy/sell (client-signed)
//
// Notes:
// - `/api/create` returns JSON `{ mint, mintSecretKey, transaction }` where
//   `transaction` is a base58-encoded VersionedTransaction. Caller signs with
//   the creator wallet + the returned mint keypair, then sends via RPC.
// - `/api/claim-account` returns a raw serialized VersionedTransaction in the
//   response body (Uint8Array via arrayBuffer()). Caller signs with the creator
//   wallet and sends.
// - `/api/claim-distribute` returns a raw serialized VersionedTransaction (same as claim-account).
//   Body requires `publicKey` + `mint` for fee-sharing distribution. See https://pumpdev.io/claim-distribute
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
  publicKey,         // base58 pubkey of wallet that signs + pays the create tx
  name,
  symbol,
  uri,               // pre-uploaded metadata URI
  buyAmountSol = 0,  // optional dev buy in SOL
  slippage = 30,
  jitoTip,
  cashbackEnabled,
  /** Optional: base58-encoded mint secret key (64 bytes). PumpDev field `mintKeypair`. */
  mintKeypairSecretB58 = null,
}) {
  if (!publicKey) throw new Error('buildCreateTokenTx: publicKey required');
  if (!name || !symbol) throw new Error('buildCreateTokenTx: name + symbol required');
  if (!uri) throw new Error('buildCreateTokenTx: uri required (upload metadata first)');

  const body = {
    ...config.pumpdev.createExtra,
    publicKey,
    name,
    symbol,
    uri,
    buyAmountSol: Number(buyAmountSol) || 0,
    slippage: Number(slippage) || 30,
  };
  if (mintKeypairSecretB58) body.mintKeypair = mintKeypairSecretB58;
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
  if (!json.transaction) {
    throw new Error(`PumpDev /api/create missing fields: ${text.slice(0, 200)}`);
  }
  // PumpDev only returns `mint`/`mintSecretKey` when it generated the mint
  // itself. When we pass our own `mintKeypair` (vanity/ephemeral), the
  // response shrinks to `{ transaction }` — we already know the keypair, so
  // reconstruct it locally instead of requiring the echo.
  let mintKeypair;
  let mint = json.mint || null;
  if (mintKeypairSecretB58) {
    mintKeypair = Keypair.fromSecretKey(bs58.decode(mintKeypairSecretB58));
    const localMint = mintKeypair.publicKey.toBase58();
    if (mint && mint !== localMint) {
      throw new Error(
        `PumpDev /api/create mint mismatch: server=${mint} local=${localMint}`,
      );
    }
    mint = localMint;
  } else {
    if (!json.mint || !json.mintSecretKey) {
      throw new Error(`PumpDev /api/create missing mint fields: ${text.slice(0, 200)}`);
    }
    mintKeypair = Keypair.fromSecretKey(bs58.decode(json.mintSecretKey));
  }
  const tx = VersionedTransaction.deserialize(bs58.decode(json.transaction));
  return { tx, mint, mintKeypair };
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
  // PumpDev accepts amount as either:
  //   • a number (SOL when denominatedInSol=true, RAW token units otherwise)
  //   • a percentage string like "100%" (sell-all when balance is unknown
  //     client-side; pump's server resolves the bag and sells that share)
  // Preserve string amounts as-is, coerce numerics to Number for safety.
  const isPercentString = typeof amount === 'string' && /%\s*$/.test(amount);
  const body = {
    publicKey,
    action,
    mint,
    amount: isPercentString ? amount.trim() : Number(amount),
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
 * Build a **claim-distribute** transaction — settles Pump fee-sharing: distributes
 * accumulated creator fees to all shareholders. Permissionless on-chain; the
 * returned tx is still signed by `publicKey` as PumpDev builds it.
 *
 * See: https://pumpdev.io/claim-distribute
 *
 * @returns {Promise<VersionedTransaction>}
 */
export async function buildClaimDistributeTx({ publicKey, mint }) {
  if (!publicKey) throw new Error('buildClaimDistributeTx: publicKey required');
  if (!mint) throw new Error('buildClaimDistributeTx: mint required (stake mint / pump token)');
  const mintStr = typeof mint === 'string' ? mint : mint.toBase58();
  const body = { publicKey, mint: mintStr };

  const res = await fetch(endpoint('/api/claim-distribute'), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PumpDev /api/claim-distribute HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(buf);
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
