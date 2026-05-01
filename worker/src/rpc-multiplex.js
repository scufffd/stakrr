// Resilient RPC connection that fails over from a primary endpoint (e.g. Helius)
// to one or more fallback endpoints (public Solana RPCs) on retryable errors.
//
// Every Solana JSON-RPC method we use in the worker is generic — getAccountInfo,
// getMultipleAccountsInfo, getProgramAccounts, getLatestBlockhash, getTransaction,
// simulateTransaction, sendRawTransaction, getSignaturesForAddress. None of them
// are Helius-only, so they all work on api.mainnet-beta.solana.com or any other
// public RPC. We don't use any Helius Enhanced API endpoints.
//
// We achieve failover by passing a custom `fetch` to web3.js Connection. The
// custom fetch retargets the request URL across the endpoint list whenever the
// primary returns 429 (rate limit), 401/403 (auth/quota), 5xx, or throws a
// network error.
//
// Env: RPC_URL=primary, RPC_URL_FALLBACKS=comma-separated.

import { Connection } from '@solana/web3.js';

/** HTTP statuses we consider "try the next RPC". */
const FALLBACK_STATUSES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/** Error message fragments that signal "rate limited / quota" (case-insensitive). */
const FALLBACK_MESSAGE_FRAGMENTS = [
  'rate limit',
  'too many requests',
  'quota',
  'forbidden',
  'unauthorized',
  'service unavailable',
  'gateway timeout',
];

function shouldFallbackOnError(err) {
  if (!err) return false;
  const msg = String(err.message || err).toLowerCase();
  return FALLBACK_MESSAGE_FRAGMENTS.some((f) => msg.includes(f))
    || err.code === 'ECONNRESET'
    || err.code === 'ECONNREFUSED'
    || err.code === 'ETIMEDOUT'
    || err.code === 'EAI_AGAIN';
}

/**
 * Build a Connection that transparently fails over across `[primary, ...fallbacks]`.
 *
 * @param {string} primary  — Helius (or whatever your paid endpoint is)
 * @param {string[]} fallbacks  — public RPCs in priority order
 * @param {object} opts  — passed to `new Connection`. `commitment` recommended.
 * @returns {Connection}
 */
export function buildResilientConnection(primary, fallbacks = [], opts = {}) {
  if (!primary) throw new Error('buildResilientConnection: primary URL required');
  const cleaned = [primary, ...fallbacks].map((u) => String(u || '').trim()).filter(Boolean);
  // Single endpoint → plain Connection (no overhead).
  if (cleaned.length === 1) {
    return new Connection(cleaned[0], opts);
  }

  const baseFetch = globalThis.fetch;
  if (typeof baseFetch !== 'function') {
    throw new Error('buildResilientConnection: global fetch unavailable (Node 18+ required)');
  }

  const resilientFetch = async (input, init) => {
    // web3.js always calls fetch with the endpoint URL string we passed to
    // `new Connection`, but be defensive: support Request objects too.
    const requestedUrl = typeof input === 'string' ? input : input?.url || cleaned[0];
    let lastErr = null;
    for (let i = 0; i < cleaned.length; i++) {
      // Replace the primary host with the i-th endpoint while preserving any
      // suffix path (Helius URLs include ?api-key=…, public RPCs don't).
      // The simplest correct rule: if the requested URL starts with cleaned[0]
      // (the primary), replace that prefix with cleaned[i]. Otherwise just
      // hit the i-th endpoint as-is.
      const target = requestedUrl.startsWith(cleaned[0])
        ? cleaned[i] + requestedUrl.slice(cleaned[0].length)
        : cleaned[i];
      try {
        const res = await baseFetch(target, init);
        if (!FALLBACK_STATUSES.has(res.status)) {
          return res;
        }
        if (i === cleaned.length - 1) {
          // Last attempt — return the error response so the caller sees a
          // real HTTP code instead of a generic network error.
          return res;
        }
        try {
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            message: 'rpc fallback',
            from: hostOnly(target),
            to: hostOnly(cleaned[i + 1]),
            status: res.status,
          }));
        } catch { /* logging best-effort */ }
        // Drain the body so the underlying socket is reused cleanly.
        try { await res.arrayBuffer(); } catch { /* ignore */ }
      } catch (err) {
        lastErr = err;
        if (i === cleaned.length - 1 || !shouldFallbackOnError(err)) {
          throw err;
        }
        try {
          console.warn(JSON.stringify({
            ts: new Date().toISOString(),
            message: 'rpc fallback (network error)',
            from: hostOnly(target),
            to: hostOnly(cleaned[i + 1]),
            error: err.message || String(err),
          }));
        } catch { /* logging best-effort */ }
      }
    }
    throw lastErr || new Error('all RPC endpoints exhausted');
  };

  return new Connection(cleaned[0], { ...opts, fetch: resilientFetch });
}

function hostOnly(u) {
  try {
    return new URL(u).host;
  } catch {
    return String(u).slice(0, 40);
  }
}
