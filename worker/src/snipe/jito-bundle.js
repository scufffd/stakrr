// Jito bundle launcher (ported from refi-live for STAKRR's stealth-launch admin tool).
//
// PumpDev's /api/create-bundle endpoint builds the full set of versioned
// transactions for us (create + optional dev buy + N sniper buys) with all
// the address-lookup-table juggling already baked in. We just sign each tx
// locally and submit the whole thing to a Jito block engine for same-block
// execution.
//
// Bundle layout (Jito caps at 5 txs per bundle):
//   [0]  Create tx        — signed by [creator, mint]
//   [1]  Dev buy tx       — signed by [creator]                 (only if devBuySol > 0)
//   [2…] Sniper buy txs   — each signed by one sniper keypair
//
// If devBuySol > 0 we have 3 slots free for snipers; if no dev buy, 4 slots.
// Anything beyond that comes back as `overflow` and the caller can send those
// staggered after the bundle confirms (still profitable, just not first-block).
//
// Confirmation strategy: race three pollers and take the first to succeed —
//   1. Jito getBundleStatuses (definitive but rate-limited)
//   2. RPC getSignatureStatuses on the create tx (slower but reliable)
//   3. RPC getAccountInfo on the new mint (fastest signal of "it landed")

import { VersionedTransaction, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { config, getConnection } from '../config.js';

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.wtf/api/v1/bundles',
  'https://tokyo.mainnet.block-engine.jito.wtf/api/v1/bundles',
];

/** Jito allows 5 txs per bundle. We always use slot 0 for create. */
export const MAX_BUNDLE_TXS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultJitoTipSol() {
  // 0.005 SOL is a safe default — Jito's effective tip floor moved up from
  // ~0.001 in early 2026 as bundle competition grew. Tips below ~0.001 are
  // silently dropped (bundle never lands → "bundle confirmation timed out").
  const v = parseFloat(process.env.JITO_TIP_SOL || '0.005');
  return Number.isFinite(v) && v > 0 ? v : 0.001;
}

function pumpdevCreateBundleUrl() {
  return `${config.pumpdev.base.replace(/\/$/, '')}/api/create-bundle`;
}

function pumpdevHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (config.pumpdev.apiKey) h.Authorization = `Bearer ${config.pumpdev.apiKey}`;
  return h;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Build via pumpdev /api/create-bundle ──────────────────────────────────────

/**
 * Ask pumpdev.io to build the full set of bundle txs, then sign each one
 * locally with the relevant keypair(s).
 *
 * `additionalBuyers` MUST be parallel to `sniperKeypairs` — pumpdev returns
 * `signers: ['creator'|'mint'|'buyer1'|'buyer2'|…]` per tx and we resolve those
 * labels against the wallet map below.
 */
async function buildAndSignBundle({
  devKeypair,
  mintKeypair,
  name,
  symbol,
  uri,
  devBuySol = 0,
  slippagePct = 50,
  jitoTipSol,
  sniperKeypairs = [],
  sniperSolPerWallet = 0,
  extraBuyers = [],          // [{ keypair, solAmount }] — custom-SOL buyers
                              // (e.g. MM seed wallet); appended after snipers
                              // and counted toward the bundle slot limit
}) {
  const additionalBuyers = [
    ...sniperKeypairs.map((kp) => ({
      publicKey: kp.publicKey.toBase58(),
      amountSol: sniperSolPerWallet,
    })),
    ...extraBuyers.map((b) => ({
      publicKey: b.keypair.publicKey.toBase58(),
      amountSol: Number(b.solAmount) || 0,
    })),
  ];

  const body = {
    publicKey: devKeypair.publicKey.toBase58(),
    name,
    symbol,
    uri,
    slippage: slippagePct,
    jitoTip: jitoTipSol,
    ...(config.pumpdev.createExtra || {}),
  };
  if (devBuySol > 0) body.buyAmountSol = Number(devBuySol);
  if (additionalBuyers.length > 0) body.additionalBuyers = additionalBuyers;
  if (mintKeypair) body.mintKeypair = bs58.encode(mintKeypair.secretKey);

  const res = await withTimeout(
    fetch(pumpdevCreateBundleUrl(), {
      method: 'POST',
      headers: pumpdevHeaders(),
      body: JSON.stringify(body),
    }),
    30_000,
    'pumpdev /api/create-bundle',
  );

  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`pumpdev create-bundle non-JSON HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  if (!res.ok) {
    throw new Error(
      `pumpdev create-bundle HTTP ${res.status}: ${parsed.error || parsed.message || text.slice(0, 240)}`,
    );
  }
  if (parsed.error) {
    throw new Error(`pumpdev create-bundle error: ${parsed.error}`);
  }
  if (!Array.isArray(parsed.transactions)) {
    throw new Error(`pumpdev create-bundle missing transactions array: ${JSON.stringify(parsed).slice(0, 240)}`);
  }

  // pumpdev may have generated the mint keypair if we didn't supply one
  const usedMintKeypair = mintKeypair
    || (parsed.mintSecretKey ? Keypair.fromSecretKey(bs58.decode(parsed.mintSecretKey)) : null);
  if (!usedMintKeypair) {
    throw new Error('pumpdev create-bundle: no mint keypair returned and none supplied');
  }
  const mintAddress = parsed.mint || usedMintKeypair.publicKey.toBase58();

  // Build the signer label → keypair map pumpdev expects. The labels are
  // hard-coded by pumpdev: 'creator', 'mint', 'buyer1' … 'buyerN'. The order
  // here MUST match how we assembled `additionalBuyers` above (snipers first,
  // then extraBuyers) so the buyerN indices line up.
  const walletMap = {
    creator: devKeypair,
    mint: usedMintKeypair,
  };
  let buyerIdx = 0;
  for (const kp of sniperKeypairs) {
    buyerIdx += 1;
    walletMap[`buyer${buyerIdx}`] = kp;
  }
  for (const b of extraBuyers) {
    buyerIdx += 1;
    walletMap[`buyer${buyerIdx}`] = b.keypair;
  }

  const encodedSignedTxs = [];
  const txSignatures = [];
  for (const txInfo of parsed.transactions) {
    const tx = VersionedTransaction.deserialize(bs58.decode(txInfo.transaction));
    const signers = (txInfo.signers || [])
      .map((label) => walletMap[label])
      .filter(Boolean);
    if (signers.length === 0) {
      throw new Error(`pumpdev tx requested unknown signers: ${(txInfo.signers || []).join(',')}`);
    }
    tx.sign(signers);
    encodedSignedTxs.push(bs58.encode(tx.serialize()));
    txSignatures.push(bs58.encode(tx.signatures[0]));
  }

  return {
    encodedSignedTxs,
    txSignatures,
    mint: mintAddress,
    mintKeypair: usedMintKeypair,
    mintSecretB58: bs58.encode(usedMintKeypair.secretKey),
  };
}

// ── Submit to Jito (race all 5 endpoints, take first success) ─────────────────

async function submitBundle(encodedSignedTxs, { maxAttempts = 4 } = {}) {
  const sendTo = (endpoint) =>
    withTimeout(
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'sendBundle',
          params: [encodedSignedTxs],
        }),
      }),
      15_000,
      `jito ${endpoint}`,
    ).then(async (res) => {
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch {
        const err = new Error(`jito ${endpoint} non-JSON HTTP ${res.status}: ${text.slice(0, 160)}`);
        err.isRateLimit = res.status === 429;
        throw err;
      }
      if (json.error) {
        const err = new Error(`jito ${endpoint} error ${JSON.stringify(json.error)}`);
        err.isRateLimit = json.error.code === -32097;
        throw err;
      }
      return { endpoint, bundleId: json.result };
    });

  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const results = await Promise.allSettled(JITO_ENDPOINTS.map(sendTo));
    const winners = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    const failures = results.filter((r) => r.status === 'rejected').map((r) => r.reason);
    if (winners.length > 0) {
      return { bundleId: winners[0].bundleId, endpoint: winners[0].endpoint, acceptedBy: winners.length };
    }
    const allRateLimited = failures.length > 0 && failures.every((e) => e.isRateLimit);
    if (allRateLimited && attempt < maxAttempts) {
      await sleep(5000 * attempt);
      continue;
    }
    lastErr = new Error(`jito submit failed: ${failures.map((e) => e.message).join(' | ')}`);
    break;
  }
  throw lastErr;
}

// ── Confirmation: race three pollers ──────────────────────────────────────────

async function waitForBundle({
  bundleId,
  createTxSignature,
  mint,
  // 45s gives Jito + RPC ~3 finality cycles (12-15s each) before we give up
  // and retry the bundle. 30s was occasionally too tight when Helius was
  // rate-limited and we had to fall back to public RPC.
  timeoutMs = 45_000,
  pollIntervalMs = 1500,
}) {
  const deadline = Date.now() + timeoutMs;
  const connection = getConnection();
  const mintPk = mint ? new PublicKey(mint) : null;

  const jitoPoller = async () => {
    let i = 0;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const endpoint = JITO_ENDPOINTS[i % JITO_ENDPOINTS.length];
      i += 1;
      try {
        const res = await withTimeout(
          fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'getBundleStatuses',
              params: [[bundleId]],
            }),
          }),
          8000,
          `jito getBundleStatuses ${endpoint}`,
        );
        const json = await res.json().catch(() => null);
        const status = (json?.result?.value || []).find((s) => s.bundle_id === bundleId);
        if (!status) continue;
        if (status.err && Object.keys(status.err).length > 0) {
          throw new Error(`bundle failed on-chain: ${JSON.stringify(status.err)}`);
        }
        if (status.confirmation_status === 'confirmed' || status.confirmation_status === 'finalized') {
          return { via: 'jito', bundleId, status, transactions: status.transactions };
        }
      } catch (e) {
        if (/failed on-chain/.test(e.message)) throw e;
        // transient, keep racing
      }
    }
    throw new Error(`jito poller timed out`);
  };

  const rpcPoller = async () => {
    if (!createTxSignature) {
      await sleep(timeoutMs + 500);
      throw new Error('no createTxSignature for rpc poller');
    }
    await sleep(pollIntervalMs * 2);
    while (Date.now() < deadline) {
      const r = await connection
        .getSignatureStatuses([createTxSignature], { searchTransactionHistory: true })
        .catch(() => null);
      const status = r?.value?.[0];
      if (status) {
        if (status.err) throw new Error(`create tx failed: ${JSON.stringify(status.err)}`);
        if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
          return { via: 'rpc', bundleId, transactions: [createTxSignature], status };
        }
      }
      await sleep(pollIntervalMs);
    }
    throw new Error('rpc poller timed out');
  };

  const mintPoller = async () => {
    if (!mintPk) {
      await sleep(timeoutMs + 500);
      throw new Error('no mint for mint poller');
    }
    await sleep(pollIntervalMs * 2);
    while (Date.now() < deadline) {
      const info = await connection.getAccountInfo(mintPk).catch(() => null);
      if (info != null) {
        return { via: 'mint', bundleId, transactions: createTxSignature ? [createTxSignature] : [], mint };
      }
      await sleep(pollIntervalMs);
    }
    throw new Error('mint poller timed out');
  };

  return Promise.any([jitoPoller(), rpcPoller(), mintPoller()]).catch((agg) => {
    const msgs = agg?.errors ? agg.errors.map((e) => e.message).join(' | ') : String(agg);
    throw new Error(`bundle confirmation timed out (${bundleId}): ${msgs}`);
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build, sign, and submit a same-block create + dev buy + sniper buys bundle
 * to Jito. Returns once the bundle is confirmed (one of the pollers wins).
 *
 * @param {object} opts
 * @param {Keypair} opts.devKeypair
 * @param {Keypair} opts.mintKeypair        - vanity mint keypair (must end in 'pump')
 * @param {string}  opts.name
 * @param {string}  opts.symbol
 * @param {string}  opts.uri                - pre-uploaded metadata URI
 * @param {number}  [opts.devBuySol=0]
 * @param {number}  [opts.slippageBps=50]   - converted to %
 * @param {Keypair[]} [opts.sniperKeypairs] - all snipers; first N fit in the bundle
 * @param {number}  [opts.sniperSolPerWallet=0]
 * @param {number}  [opts.jitoTipSol]
 * @param {number}  [opts.maxBundleAttempts=4]
 */
export async function launchBundle({
  devKeypair,
  mintKeypair,
  name,
  symbol,
  uri,
  devBuySol = 0,
  slippageBps = 50,
  sniperKeypairs = [],
  sniperSolPerWallet = 0,
  extraBuyers = [],          // [{ keypair, solAmount }] — e.g. MM seed wallet
                              // with its own SOL amount. These take priority
                              // over snipers for in-bundle slots so the MM
                              // seed always lands in the create block.
  jitoTipSol,
  // 3 × 45s = ~135s worst case before we give up. Keeps the launch
  // request comfortably under nginx's proxy_read_timeout (180s).
  maxBundleAttempts = 3,
}) {
  if (!devKeypair) throw new Error('launchBundle: devKeypair required');
  if (!mintKeypair) throw new Error('launchBundle: mintKeypair required');
  if (!name || !symbol || !uri) throw new Error('launchBundle: name/symbol/uri required');

  const tipSol = jitoTipSol != null ? Number(jitoTipSol) : defaultJitoTipSol();
  // Slippage as percent (pumpdev expects 1–99). 50 is safe for first-buy as
  // we know the exact reserves.
  const slippagePct = Math.max(1, Math.min(99, Math.round(slippageBps / 100)));

  const totalBuyerSlots = MAX_BUNDLE_TXS - 1 - (devBuySol > 0 ? 1 : 0);
  // extraBuyers are mission-critical (MM seed) — give them slots first.
  const inBundleExtras = extraBuyers.slice(0, totalBuyerSlots);
  const remainingSlots = totalBuyerSlots - inBundleExtras.length;
  const inBundleSnipers = sniperKeypairs.slice(0, remainingSlots);
  const overflowSnipers = sniperKeypairs.slice(remainingSlots);

  let lastErr;
  for (let attempt = 1; attempt <= maxBundleAttempts; attempt += 1) {
    try {
      const built = await buildAndSignBundle({
        devKeypair,
        mintKeypair,
        name,
        symbol,
        uri,
        devBuySol,
        slippagePct,
        jitoTipSol: tipSol,
        sniperKeypairs: inBundleSnipers,
        sniperSolPerWallet,
        extraBuyers: inBundleExtras,
      });

      const submission = await submitBundle(built.encodedSignedTxs);

      const confirmation = await waitForBundle({
        bundleId: submission.bundleId,
        createTxSignature: built.txSignatures[0] || null,
        mint: built.mint,
      });

      return {
        ok: true,
        attempt,
        mint: built.mint,
        mintSecretB58: built.mintSecretB58,
        bundleId: submission.bundleId,
        bundleEndpoint: submission.endpoint,
        confirmation,
        txSignatures: built.txSignatures,
        inBundleSnipers: inBundleSnipers.map((kp) => kp.publicKey.toBase58()),
        overflowSnipers: overflowSnipers.map((kp) => kp.publicKey.toBase58()),
        inBundleExtras: inBundleExtras.map((b) => ({
          publicKey: b.keypair.publicKey.toBase58(),
          solAmount: Number(b.solAmount) || 0,
        })),
        jitoTipSol: tipSol,
        slippagePct,
        devBuySol,
        sniperSolPerWallet,
      };
    } catch (e) {
      lastErr = e;
      const transient = /timed out|rate limited|-32097/i.test(e.message);
      if (transient && attempt < maxBundleAttempts) {
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
