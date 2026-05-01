/**
 * Worker-side resilient confirmation. Mirror of frontend/src/lib/confirm.js.
 *
 * Why this exists:
 *   `Connection.confirmTransaction(...)` opens a WebSocket subscription. On
 *   throttled providers (Helius free tier returns HTTP 429 on `signatureSubscribe`
 *   under load), the subscription never delivers a notification and we time out
 *   even though the tx already landed and finalized on chain.
 *
 * `confirmWithFallback` ignores the WS path entirely and relies on direct
 * HTTP `getSignatureStatuses` polling — exactly the same primitive the
 * built-in confirm uses internally as a fallback, just exposed cleanly here
 * so we have a single, predictable code path. Rate limits on `getSignatureStatuses`
 * are far more generous than on the WS endpoint, and our `rpc-multiplex.js`
 * already fans HTTP RPC calls across fallback endpoints.
 */

import { Connection } from '@solana/web3.js'; // eslint-disable-line no-unused-vars

const COMMITMENT_RANK = { processed: 0, confirmed: 1, finalized: 2 };

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

/**
 * Poll-only confirmation. Resolves when the signature reaches the requested
 * commitment, or when an on-chain failure is observed; rejects only on
 * timeout or unrecoverable RPC error.
 *
 * @param {Connection} connection
 * @param {string}     signature
 * @param {{
 *   commitment?: 'processed' | 'confirmed' | 'finalized',
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   label?: string,
 * }} [opts]
 * @returns {Promise<void>}
 */
export async function confirmSignature(connection, signature, opts = {}) {
  const commitment = opts.commitment || 'confirmed';
  const pollMs     = opts.pollMs     || 1500;
  const timeoutMs  = opts.timeoutMs  || 90_000;
  const label      = opts.label      || 'tx';
  const need       = COMMITMENT_RANK[commitment] ?? 1;
  const deadline   = Date.now() + timeoutMs;

  let attempts = 0;
  let lastErr  = null;
  while (Date.now() < deadline) {
    attempts++;
    try {
      const r = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
      const v = r?.value?.[0];
      if (v) {
        if (v.err) {
          const e = new Error(`${label}: tx failed on-chain ${signature}: ${JSON.stringify(v.err)}`);
          e.signature = signature;
          e.txErr = v.err;
          throw e;
        }
        const got = COMMITMENT_RANK[v.confirmationStatus] ?? -1;
        if (got >= need || (typeof v.confirmations === 'number' && v.confirmations >= 1)) {
          if (attempts > 1) log('confirm: settled after polling', { label, signature, attempts });
          return;
        }
      }
    } catch (e) {
      if (e?.txErr) throw e; // hard on-chain failure surfaces immediately
      lastErr = e;
      // Transient RPC failure — keep polling.
    }
    await sleep(pollMs);
  }
  const err = new Error(
    `${label}: confirmation timed out after ${timeoutMs}ms for ${signature}` +
    (lastErr ? ` (last polling error: ${lastErr.message})` : ''),
  );
  err.signature = signature;
  err.timedOut = true;
  throw err;
}

/**
 * Send a signed tx (Transaction or VersionedTransaction) and confirm by polling.
 * @param {Connection} connection
 * @param {{ serialize: () => Uint8Array }} signedTx
 * @param {Parameters<typeof confirmSignature>[2] & { skipPreflight?: boolean, maxRetries?: number }} [opts]
 * @returns {Promise<string>} signature
 */
export async function sendAndPollConfirm(connection, signedTx, opts = {}) {
  const sig = await connection.sendRawTransaction(signedTx.serialize(), {
    skipPreflight: !!opts.skipPreflight,
    maxRetries: opts.maxRetries ?? 3,
  });
  await confirmSignature(connection, sig, opts);
  return sig;
}

/**
 * Drop-in replacement for `@solana/web3.js`'s `sendAndConfirmTransaction`
 * that uses our poll-based confirmation instead of the WS subscription.
 *
 * Accepts a *legacy* `Transaction` plus signer keypairs; sets `feePayer` and
 * `recentBlockhash` if missing, signs, sends, and polls for confirmation.
 *
 * @param {Connection} connection
 * @param {import('@solana/web3.js').Transaction} tx
 * @param {Array<import('@solana/web3.js').Signer>} signers
 * @param {Parameters<typeof confirmSignature>[2] & { skipPreflight?: boolean, maxRetries?: number }} [opts]
 * @returns {Promise<string>} signature
 */
export async function signAndPollConfirm(connection, tx, signers, opts = {}) {
  if (!tx.feePayer && signers[0]) tx.feePayer = signers[0].publicKey;
  if (!tx.recentBlockhash) {
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
  }
  tx.sign(...signers);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: !!opts.skipPreflight,
    maxRetries: opts.maxRetries ?? 3,
  });
  await confirmSignature(connection, sig, opts);
  return sig;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
