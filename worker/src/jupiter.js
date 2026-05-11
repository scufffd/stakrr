/**
 * Jupiter swap-aggregator helper.
 *
 * Used by the cycle worker to convert claimed creator-fee wSOL into the
 * specific reward tokens a pool wants to distribute (e.g. GMEx, USDC).
 * The pool program does NOT swap on-chain — every reward line that isn't
 * wSOL needs an off-chain swap before `deposit_rewards` can run on it.
 *
 * Endpoint: Jupiter v1 Swap API (`https://api.jup.ag/swap/v1`).
 * The legacy `quote-api.jup.ag/v6` endpoint was deprecated; we hit the
 * current path. v2 (`/swap/v2`) exists too but is RFQ-routed and overkill
 * for our small-ticket cycle swaps — Metis routing on /v1 is plenty.
 *
 * Why this lives in worker/src and not as a generic library:
 *   - We pin the exact API path + slippage envelope to match our cycle
 *     economics (sub-cent tx fees, ≤ 1 SOL swap sizes).
 *   - We thread `config.priorityFeeMicroLamports` and the worker's
 *     existing `getConnection` so retries stay consistent with the rest
 *     of the cycle code.
 *
 * All swap dollar amounts in this module are tiny (per-cycle fee skim).
 * If the swap fails for any reason, the caller MUST treat that reward
 * line as "skipped this cycle" and continue with the others — never let
 * one bad route block the whole pool's payout.
 */

import {
  VersionedTransaction,
  ComputeBudgetProgram,
  PublicKey,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { detectTokenProgram } from './stake-program.js';

const JUPITER_BASE = process.env.JUPITER_API_BASE || 'https://api.jup.ag/swap/v1';
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BACKOFF_MS = [400, 900, 2_500];

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), source: 'jupiter', message, ...extra }));
}

async function fetchJson(url, init = {}, attempts = DEFAULT_RETRY_ATTEMPTS) {
  let lastErr = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const resp = await fetch(url, {
        ...init,
        headers: { accept: 'application/json', ...(init.headers || {}) },
      });
      const text = await resp.text();
      let body;
      try { body = JSON.parse(text); } catch { body = { _raw: text }; }
      if (!resp.ok) {
        // Surface the API error message — Jupiter returns helpful diagnostic
        // strings (e.g. "No routes found") that callers need.
        const msg = body?.error || body?.message || body?._raw || `HTTP ${resp.status}`;
        const err = new Error(`jupiter ${resp.status}: ${msg}`);
        err.status = resp.status;
        err.body = body;
        // Don't retry on 4xx (bad input, route not found) — only on 5xx + network.
        if (resp.status >= 400 && resp.status < 500) throw err;
        lastErr = err;
      } else {
        return body;
      }
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, DEFAULT_RETRY_BACKOFF_MS[i] || 2_000));
    }
  }
  throw lastErr || new Error('jupiter: exhausted retries');
}

/**
 * GET /swap/v1/quote — returns a routePlan for the given (in, out, amount).
 *
 * `amount` is the EXACT input amount in the inputMint's smallest unit
 * (lamports for SOL/wSOL). `swapMode` defaults to 'ExactIn'.
 *
 * `restrictIntermediateTokens=true` constrains intermediate hops to
 * Jupiter's whitelisted "blue chip" set (USDC, USDT, SOL, ...). Highly
 * recommended — without it, malicious tokens with manipulated price
 * curves can sneak into the route and produce horrendous executions.
 */
export async function quoteSwap({
  inputMint,
  outputMint,
  amountLamports,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  restrictIntermediateTokens = true,
  swapMode = 'ExactIn',
}) {
  if (!inputMint || !outputMint) throw new Error('quoteSwap: inputMint and outputMint required');
  if (amountLamports == null || BigInt(amountLamports) <= 0n) {
    throw new Error('quoteSwap: amountLamports must be a positive integer');
  }
  const params = new URLSearchParams({
    inputMint: typeof inputMint === 'string' ? inputMint : inputMint.toBase58(),
    outputMint: typeof outputMint === 'string' ? outputMint : outputMint.toBase58(),
    amount: BigInt(amountLamports).toString(),
    slippageBps: String(Math.max(1, Math.min(10_000, Math.floor(slippageBps)))),
    swapMode,
  });
  if (restrictIntermediateTokens) params.set('restrictIntermediateTokens', 'true');

  const url = `${JUPITER_BASE}/quote?${params.toString()}`;
  const quote = await fetchJson(url);
  if (!quote || !quote.outAmount) {
    throw new Error('quoteSwap: malformed quote response');
  }
  log('quote', {
    inputMint: params.get('inputMint'),
    outputMint: params.get('outputMint'),
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
    otherAmountThreshold: quote.otherAmountThreshold,
    priceImpactPct: quote.priceImpactPct,
    hops: (quote.routePlan || []).length,
  });
  return quote;
}

/**
 * POST /swap/v1/swap — turns a quote into a serialized VersionedTransaction
 * ready to sign. We always set:
 *   - `wrapAndUnwrapSol: true`  → if either side is SOL/wSOL, Jupiter
 *      adds the wrap/unwrap ixs so we don't have to manage the wSOL ATA
 *      lifecycle here.
 *   - `dynamicComputeUnitLimit: true` → the API simulates and sets a
 *      tight CU limit; otherwise we'd waste fees on the default 1.4M.
 *   - `prioritizationFeeLamports: 'auto'` → Jupiter computes a sensible
 *      priority fee from recent network conditions. Beats hard-coding.
 *      Override via `prioritizationFeeLamports` arg if you want a fixed
 *      fee or 'autoMultiplier' style.
 */
export async function buildSwap({
  quoteResponse,
  userPublicKey,
  wrapAndUnwrapSol = true,
  prioritizationFeeLamports = 'auto',
  dynamicComputeUnitLimit = true,
}) {
  if (!quoteResponse) throw new Error('buildSwap: quoteResponse required');
  if (!userPublicKey) throw new Error('buildSwap: userPublicKey required');
  const userPk = typeof userPublicKey === 'string' ? userPublicKey : userPublicKey.toBase58();

  const body = {
    quoteResponse,
    userPublicKey: userPk,
    wrapAndUnwrapSol,
    dynamicComputeUnitLimit,
    prioritizationFeeLamports,
    asLegacyTransaction: false,
  };
  const resp = await fetchJson(`${JUPITER_BASE}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.swapTransaction) {
    throw new Error('buildSwap: no swapTransaction in response');
  }
  return resp;
}

/**
 * End-to-end: quote → build → sign → submit → confirm → measure delta.
 *
 * Returns `{ ok, sig, acquiredRaw, quote, swapResp, error }`. On any
 * failure we resolve (not reject) so the caller can keep iterating
 * other reward lines without try/catch on every one. Caller decides
 * what to do with `ok: false`.
 *
 * `acquiredRaw` is the **on-chain** delta of `outputMint` in the
 * signer's ATA between before and after the swap, NOT the quote's
 * `outAmount`. This is more accurate (covers slippage between quote
 * and execution) and is the authoritative number to feed into
 * `deposit_rewards`.
 */
export async function executeSwap({
  connection,
  signer,
  inputMint,
  outputMint,
  amountLamports,
  slippageBps = DEFAULT_SLIPPAGE_BPS,
  prioritizationFeeLamports = 'auto',
  label = 'swap',
}) {
  const inMintStr = typeof inputMint === 'string' ? inputMint : inputMint.toBase58();
  const outMintStr = typeof outputMint === 'string' ? outputMint : outputMint.toBase58();
  if (inMintStr === outMintStr) {
    throw new Error(`executeSwap: input == output (${inMintStr})`);
  }
  // detectTokenProgram requires a PublicKey, NOT a string — passing a
  // string throws inside web3.js and the resulting null tokenProgram
  // causes the post-swap balance read to be skipped, so we'd report
  // acquiredRaw=0 even when the swap actually delivered tokens. Always
  // normalise to PublicKey before any RPC calls.
  const outMintPk = typeof outputMint === 'string' ? new PublicKey(outputMint) : outputMint;

  // Read the signer's output-mint ATA balance BEFORE the swap so we can
  // compute the acquired delta after confirmation. If the ATA doesn't
  // exist yet, Jupiter's wrap/unwrap helper will create it as part of
  // the swap tx (no extra rent calc needed on our side).
  const tokenProgram = await detectTokenProgram(connection, outMintPk).catch(() => null);
  let beforeRaw = 0n;
  let outAta = null;
  if (tokenProgram) {
    try {
      outAta = getAssociatedTokenAddressSync(outMintPk, signer.publicKey, false, tokenProgram);
      const acc = await getAccount(connection, outAta, 'confirmed', tokenProgram);
      beforeRaw = acc.amount;
    } catch {
      beforeRaw = 0n; // ATA doesn't exist yet — fine, swap will create it
    }
  }

  let quote;
  try {
    quote = await quoteSwap({
      inputMint: inMintStr,
      outputMint: outMintStr,
      amountLamports,
      slippageBps,
    });
  } catch (e) {
    log('quote-failed', { label, error: e.message });
    return { ok: false, error: `quote: ${e.message}`, sig: null, acquiredRaw: 0n, quote: null };
  }

  let swapResp;
  try {
    swapResp = await buildSwap({
      quoteResponse: quote,
      userPublicKey: signer.publicKey,
      prioritizationFeeLamports,
    });
  } catch (e) {
    log('build-failed', { label, error: e.message });
    return { ok: false, error: `build: ${e.message}`, sig: null, acquiredRaw: 0n, quote };
  }

  let sig;
  try {
    const buf = Buffer.from(swapResp.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    tx.sign([signer]);
    sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
    });
    log('submitted', { label, sig });

    const lastValidBlockHeight = swapResp.lastValidBlockHeight || (await connection.getBlockHeight('confirmed')) + 150;
    const blockhash = tx.message.recentBlockhash;
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight },
      'confirmed',
    );
  } catch (e) {
    log('submit-failed', { label, error: e.message, sig: sig || null });
    return { ok: false, error: `submit: ${e.message}`, sig: sig || null, acquiredRaw: 0n, quote };
  }

  // Read the post-swap balance with a tiny retry (RPC catch-up).
  let acquiredRaw = 0n;
  if (tokenProgram && outAta) {
    for (let i = 0; i < 5; i += 1) {
      try {
        const acc = await getAccount(connection, outAta, 'confirmed', tokenProgram);
        const delta = acc.amount - beforeRaw;
        if (delta > 0n) { acquiredRaw = delta; break; }
      } catch { /* ATA not visible yet */ }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  log('confirmed', { label, sig, acquiredRaw: acquiredRaw.toString() });
  return { ok: true, sig, acquiredRaw, quote, swapResp };
}

/** Jupiter route-availability probe — used at launch time to validate that a
 *  proposed reward token is actually reachable from wSOL. Cheap (single quote
 *  for 0.01 SOL). Returns `{ ok, reason, priceImpactPct, hops }`. */
export async function probeRoute({ outputMint, slippageBps = 100 }) {
  const WSOL = 'So11111111111111111111111111111111111111112';
  if (typeof outputMint !== 'string') outputMint = outputMint.toBase58();
  if (outputMint === WSOL) return { ok: true, reason: 'wsol-direct', hops: 0, priceImpactPct: '0' };
  try {
    const q = await quoteSwap({
      inputMint: WSOL,
      outputMint,
      amountLamports: 10_000_000n, // 0.01 SOL probe
      slippageBps,
    });
    return {
      ok: true,
      hops: (q.routePlan || []).length,
      priceImpactPct: q.priceImpactPct,
      outAmount: q.outAmount,
      labels: (q.routePlan || []).map((h) => h.swapInfo?.label).filter(Boolean),
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
