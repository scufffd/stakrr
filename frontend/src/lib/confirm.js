/**
 * Resilient transaction send / confirm helpers.
 *
 * Why this file exists:
 *   `Connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight })`
 *   throws `TransactionExpiredBlockheightExceededError` the moment the chain
 *   passes `lastValidBlockHeight`. In practice the tx very often *did* land
 *   — Phantom delayed signing 15s, the RPC returned a stale blockhash, the
 *   public-RPC fallback added latency, etc. — but the user sees a hard error
 *   despite their position/launch being on-chain.
 *
 * `confirmWithFallback` wraps the standard confirmation with an on-chain
 * `getSignatureStatuses` probe: if the strict confirm throws but the chain
 * actually has the signature confirmed/finalized, we return success.
 * Only if the signature is genuinely missing after the polling window do
 * we surface the error.
 */

import { Connection } from '@solana/web3.js'; // eslint-disable-line no-unused-vars

/**
 * @param {Connection} connection
 * @param {string}     signature
 * @param {{ blockhash: string, lastValidBlockHeight: number }} ctx
 * @param {{ commitment?: 'processed'|'confirmed'|'finalized', pollMs?: number, pollWindowMs?: number }} [opts]
 * @returns {Promise<{ status: 'confirmed' | 'recovered', err: any | null }>}
 */
export async function confirmWithFallback(connection, signature, ctx, opts = {}) {
  const commitment   = opts.commitment   || 'confirmed';
  const pollMs       = opts.pollMs       || 1500;
  // 3 min: covers the worst-case path where Phantom holds the prompt for 30s,
  // RPC fan-out adds another 30s of latency, and the tx finalises only after
  // the original blockhash has expired.
  const pollWindowMs = opts.pollWindowMs || 180_000;

  try {
    const res = await connection.confirmTransaction(
      { signature, blockhash: ctx.blockhash, lastValidBlockHeight: ctx.lastValidBlockHeight },
      commitment,
    );
    if (res?.value?.err) {
      const e = new Error(`Transaction failed on-chain: ${JSON.stringify(res.value.err)}`);
      e.signature = signature;
      e.txErr = res.value.err;
      throw e;
    }
    return { status: 'confirmed', err: null };
  } catch (firstErr) {
    // If the failure is a hard on-chain error we already attached above, rethrow.
    if (firstErr?.txErr) throw firstErr;
    // Otherwise fall back to direct status polling: the tx may already have landed.
    const recovered = await pollSignatureStatus(connection, signature, { pollMs, pollWindowMs, commitment });
    if (recovered?.confirmed) {
      if (recovered.err) {
        const e = new Error(`Transaction failed on-chain: ${JSON.stringify(recovered.err)}`);
        e.signature = signature;
        e.txErr = recovered.err;
        throw e;
      }
      return { status: 'recovered', err: null };
    }
    // Genuinely not on-chain (or RPC blind) — surface the original error so
    // the user knows to retry. Keep the original message for stack-trace fidelity.
    if (firstErr instanceof Error) throw firstErr;
    throw new Error(String(firstErr));
  }
}

/**
 * Poll `getSignatureStatuses` until the sig appears with the desired commitment
 * or the window elapses.
 */
async function pollSignatureStatus(connection, signature, { pollMs, pollWindowMs, commitment }) {
  const ranks = { processed: 0, confirmed: 1, finalized: 2 };
  const need  = ranks[commitment] ?? 1;
  const deadline = Date.now() + pollWindowMs;
  while (Date.now() < deadline) {
    try {
      const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const v = r?.value?.[0];
      if (v) {
        const got = ranks[v.confirmationStatus] ?? -1;
        if (got >= need || (typeof v.confirmations === 'number' && v.confirmations >= 1)) {
          return { confirmed: true, err: v.err || null };
        }
      }
    } catch (_) {
      // Transient RPC failure — keep polling.
    }
    await sleep(pollMs);
  }
  return { confirmed: false, err: null };
}

/**
 * Small convenience wrapper: send + confirm with fallback, returning the sig.
 */
export async function sendAndConfirmResilient(connection, signedTx, ctx, opts) {
  const sig = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmWithFallback(connection, sig, ctx, opts);
  return sig;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
