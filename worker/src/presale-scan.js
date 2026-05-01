// Presale scanner: walks `getSignaturesForAddress` on a presale wallet,
// pulls inbound system-program SOL transfers since a cutoff signature
// (inclusive), and aggregates by source wallet. Used by the admin
// presale-auto-stake flow to compute pro-rata token allocations.
//
// Adapted from POBINDEX's pobindex-worker/src/presale.js + scripts/presale-scan.js
// but trimmed for the on-the-fly admin use case (no persistent state file —
// the admin always passes an explicit cutoff signature, so re-runs are
// deterministic).

import { PublicKey } from '@solana/web3.js';
import { getConnection } from './config.js';

const PAGE_LIMIT = 1000;

/**
 * Pull only system-program transfer / transferWithSeed ixs targeting the
 * presale wallet from a parsed transaction. Inner ixs are scanned too so
 * CPI'd transfers (e.g. wallet routers, smart wallets) are captured.
 *
 * Deliberately does NOT fall back to raw balance deltas — those leak rent
 * payments, fee deductions, and ATA-creation side-effects that aren't real
 * contributions.
 */
function extractInboundTransfers(parsedTx, destinationBase58) {
  if (!parsedTx?.transaction || !parsedTx.meta) return [];
  if (parsedTx.meta.err) return [];
  const out = [];
  const top = parsedTx.transaction.message.instructions || [];
  const inner = (parsedTx.meta.innerInstructions || []).flatMap((g) => g.instructions || []);
  for (const ix of [...top, ...inner]) {
    if (!ix || ix.program !== 'system' || !ix.parsed) continue;
    const t = ix.parsed.type;
    if (t !== 'transfer' && t !== 'transferWithSeed') continue;
    const info = ix.parsed.info || {};
    if (info.destination !== destinationBase58) continue;
    const lamports = BigInt(info.lamports || 0);
    if (!info.source || lamports === 0n) continue;
    out.push({ source: info.source, lamports });
  }
  return out;
}

/**
 * Walk getSignaturesForAddress newest → oldest, stopping once we've passed
 * the cutoff signature (inclusive — the cutoff tx itself counts). Returns
 * raw `{ signature, blockTime, source, lamports }` rows.
 *
 * @param {string} presaleWallet  base58 pubkey
 * @param {string} cutoffSignature inclusive cutoff — the boundary tx that
 *                                 marks "presale starts here"
 */
async function fetchPresaleTransfers({ connection, presaleWallet, cutoffSignature }) {
  const presaleStr = presaleWallet.toBase58 ? presaleWallet.toBase58() : String(presaleWallet);

  // 1) Find the cutoff tx so we know when to stop paging. We need its slot
  //    AND signature so we can break correctly when the cutoff appears in
  //    a page (we keep it; we drop everything older).
  const cutoffTx = await connection.getTransaction(cutoffSignature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!cutoffTx) {
    throw new Error(`cutoff tx not found on chain: ${cutoffSignature}`);
  }
  const cutoffSlot = cutoffTx.slot;

  // 2) Page newest → oldest until we hit a tx older than the cutoff slot.
  const sigsToFetch = [];
  let before;
  let foundCutoff = false;
  while (true) {
    const opts = { limit: PAGE_LIMIT };
    if (before) opts.before = before;
    const page = await connection.getSignaturesForAddress(new PublicKey(presaleStr), opts);
    if (!page.length) break;
    for (const s of page) {
      if (s.slot < cutoffSlot) {
        // Strictly older than the cutoff slot — stop. The cutoff itself is
        // included if we pass it inside the same page.
        foundCutoff = true;
        break;
      }
      sigsToFetch.push(s);
      if (s.signature === cutoffSignature) {
        foundCutoff = true;
        break;
      }
    }
    if (foundCutoff) break;
    if (page.length < PAGE_LIMIT) break; // exhausted history
    before = page[page.length - 1].signature;
  }

  if (!sigsToFetch.length) return { transfers: [], scanned: 0, cutoffSlot };

  // 3) Parse with bounded concurrency. We don't use `getParsedTransactions`
  //    because most public Solana RPCs (including our fallbacks like
  //    publicnode.com) cap JSON-RPC batches at 1 call per request — this
  //    triggers a `-32600 Maximum number of 'getTransaction' calls in a batch`
  //    error. Individual calls go through the multiplexer normally and
  //    respect per-RPC rate limits.
  const CONCURRENCY = 4;
  const transfers = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= sigsToFetch.length) return;
      const meta = sigsToFetch[i];
      try {
        const tx = await connection.getParsedTransaction(meta.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx) return;
        const inbound = extractInboundTransfers(tx, presaleStr);
        for (const t of inbound) {
          transfers.push({
            signature: meta.signature,
            blockTime: meta.blockTime || tx.blockTime || null,
            source: t.source,
            lamports: t.lamports,
          });
        }
      } catch (e) {
        // Individual tx failures don't tank the whole scan; log and skip.
        // The contributor list is best-effort if RPC is flaky — admin can
        // re-run with the same cutoff to retry.
        // eslint-disable-next-line no-console
        console.warn(JSON.stringify({ ts: new Date().toISOString(), message: 'presale-scan: tx fetch failed', signature: meta.signature, error: e.message }));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return { transfers, scanned: sigsToFetch.length, cutoffSlot };
}

/**
 * Aggregate raw transfer rows by source wallet. Drops the presale wallet
 * itself (idempotent self-rebalances) and any pubkey in `excludeWallets`.
 */
function aggregateContributions(transfers, { excludeWallets = new Set(), presaleWallet } = {}) {
  const presaleStr = presaleWallet?.toBase58 ? presaleWallet.toBase58() : presaleWallet;
  const byWallet = new Map();
  for (const row of transfers) {
    if (row.source === presaleStr) continue;
    if (excludeWallets.has(row.source)) continue;
    if (!byWallet.has(row.source)) {
      byWallet.set(row.source, {
        wallet: row.source,
        totalLamports: 0n,
        txCount: 0,
        firstSeenAt: row.blockTime || null,
        lastSeenAt: row.blockTime || null,
        signatures: [],
      });
    }
    const agg = byWallet.get(row.source);
    agg.totalLamports += row.lamports;
    agg.txCount += 1;
    if (row.blockTime) {
      if (!agg.firstSeenAt || row.blockTime < agg.firstSeenAt) agg.firstSeenAt = row.blockTime;
      if (!agg.lastSeenAt || row.blockTime > agg.lastSeenAt) agg.lastSeenAt = row.blockTime;
    }
    agg.signatures.push(row.signature);
  }
  const rows = Array.from(byWallet.values()).map((a) => ({
    wallet: a.wallet,
    totalLamports: a.totalLamports.toString(),
    txCount: a.txCount,
    firstSeenAt: a.firstSeenAt,
    lastSeenAt: a.lastSeenAt,
    signatures: a.signatures,
  }));
  rows.sort((a, b) => {
    const d = BigInt(b.totalLamports) - BigInt(a.totalLamports);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  });
  return rows;
}

/**
 * Pro-rata allocate `tokenTotalRaw` across contributors, weighted by SOL
 * contributed. Floor allocations + remainder distributed to the largest
 * contributors so totals match `tokenTotalRaw` exactly.
 *
 * @param {Array<{wallet:string,totalLamports:string}>} contributions
 * @param {bigint} tokenTotalRaw  raw mint units to distribute
 */
export function allocateAllocations(contributions, tokenTotalRaw) {
  if (!contributions.length) return [];
  let sum = 0n;
  const rows = contributions.map((c) => {
    const lamports = BigInt(c.totalLamports);
    sum += lamports;
    return { wallet: c.wallet, lamports, tokens: 0n, shareBps: 0 };
  });
  if (sum === 0n) return rows;

  let allocated = 0n;
  for (const r of rows) {
    r.tokens = (r.lamports * tokenTotalRaw) / sum;
    r.shareBps = Number((r.lamports * 10_000n) / sum);
    allocated += r.tokens;
  }
  let remainder = tokenTotalRaw - allocated;
  const sorted = [...rows].sort((a, b) => {
    if (b.lamports === a.lamports) return 0;
    return b.lamports > a.lamports ? 1 : -1;
  });
  let i = 0;
  while (remainder > 0n && i < sorted.length) {
    sorted[i].tokens += 1n;
    remainder -= 1n;
    i = (i + 1) % sorted.length;
  }
  return rows;
}

/**
 * High-level: scan + aggregate. Returns `{ contributors, totalLamports,
 * scanned, cutoffSlot }`.
 */
export async function scanPresaleContributions({
  presaleWallet,
  cutoffSignature,
  excludeWallets = [],
  connection,
}) {
  const conn = connection || getConnection();
  const presalePk = presaleWallet instanceof PublicKey ? presaleWallet : new PublicKey(presaleWallet);
  const { transfers, scanned, cutoffSlot } = await fetchPresaleTransfers({
    connection: conn,
    presaleWallet: presalePk,
    cutoffSignature,
  });
  const excludeSet = new Set(excludeWallets);
  const contributors = aggregateContributions(transfers, {
    excludeWallets: excludeSet,
    presaleWallet: presalePk,
  });
  const totalLamports = contributors.reduce((acc, r) => acc + BigInt(r.totalLamports), 0n);
  return {
    presaleWallet: presalePk.toBase58(),
    cutoffSignature,
    cutoffSlot,
    scanned,
    totalLamports: totalLamports.toString(),
    contributorCount: contributors.length,
    contributors,
  };
}
