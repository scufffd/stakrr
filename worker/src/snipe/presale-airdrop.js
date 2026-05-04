// Server-side presale auto-stake runner. Mirrors the kol-airdrop pattern:
// load the dev wallet's vault keypair, build the unsigned batches via the
// existing buildPresaleAutoStakeBatches helper, then sign + submit each
// batch locally rather than round-tripping through the browser.
//
// Why this exists separately from the standalone /admin/presale page (which
// chains client-side after the launch finalises): the unified admin/snipe
// flow needs a one-click "launch + KOL + presale" experience. The dev
// wallet's keypair already lives in the snipe vault, so we don't need the
// browser in the loop at all.
//
// Carve order (matches what the user explicitly approved):
//   bag = devBuy raw tokens credited to dev's ATA
//   ├─ KOL slice  (tokenAllocationPct of bag)         → equal split to KOL list
//   └─ remainder  (bag − KOL slice)                   → pro-rata to presale
//                                                       contributors by SOL weight
// Both slices are computed from the SAME devBag snapshot taken before any
// transfer fires, so the maths is deterministic and order-independent — KOL
// can fail without throwing the presale share off (and vice versa).

import { Buffer } from 'buffer';
import { Transaction } from '@solana/web3.js';
import { getConnection } from '../config.js';
import { signAndPollConfirm } from '../confirm.js';
import { buildPresaleAutoStakeBatches } from '../presale-autostake.js';
import { getKeypairById } from './wallet-vault.js';

/**
 * Run the full presale auto-stake server-side. Returns a result shape that
 * mirrors `runKolAirdrop` so the orchestrator can persist it to the snipe
 * row uniformly.
 *
 *   {
 *     ok: bool,                      // every batch confirmed
 *     mode: 'push',                  // future-proofing if we ever add
 *                                    // a pending-claim variant
 *     skipped?: 'no_contributors',   // present when the scan came back empty
 *     allocations: [{wallet, lamports, tokensRaw, shareBps}],
 *     batches: [{index, sig, error, beneficiaries}],
 *     totals: {
 *       lamports, tokensRaw, contributorCount, batchCount,
 *       sentCount, failedCount, lockDays, earlyUnstakeBps, rewardMints,
 *     },
 *     scan: { contributorCount, totalLamports, scannedTxs, ... },
 *   }
 *
 * Failure semantics: on the first batch that doesn't confirm we stop the
 * loop (same as runKolAirdrop), so partial completion is possible. The
 * snipe row stores the per-batch result so an admin can see exactly which
 * contributors got staked and which need a manual retry.
 */
export async function runPresaleAutoStake({
  mint,
  devWalletId,
  presaleWallet,
  cutoffSignature,
  lockDays = 7,
  tokenTotalRaw,             // already-carved bag size in raw units (BigInt | string)
  excludeWallets = [],
  minTransferLamports = 10_000_000n,
  earlyUnstakeBps = 0,       // v4 per-position penalty override, 0..9000
  log = () => {},
}) {
  if (!mint) throw new Error('mint required');
  if (!devWalletId) throw new Error('devWalletId required');
  if (!presaleWallet) throw new Error('presaleWallet required');
  if (!cutoffSignature) throw new Error('cutoffSignature required');
  const totalRaw = BigInt(tokenTotalRaw || 0);
  if (totalRaw <= 0n) throw new Error('tokenTotalRaw must be > 0');

  const devKp = getKeypairById(devWalletId);
  const devPk = devKp.publicKey;
  const bpsOverride = Math.max(0, Math.min(9000, Number(earlyUnstakeBps || 0)));

  log('presale-autostake: building batches', {
    mint,
    presaleWallet,
    cutoffSignature,
    tokenTotalRaw: totalRaw.toString(),
    lockDays: Number(lockDays),
    earlyUnstakeBps: bpsOverride,
  });

  // buildPresaleAutoStakeBatches handles the scan + alloc + tx-build itself.
  // We pass the dev's pubkey (not the keypair) — the helper builds unsigned
  // txs with feePayer=devPk; we'll sign locally below.
  const built = await buildPresaleAutoStakeBatches({
    mint,
    devWallet: devPk.toBase58(),
    presaleWallet,
    cutoffSignature,
    lockDays: Number(lockDays),
    tokenTotalRaw: totalRaw.toString(),
    excludeWallets,
    minTransferLamports: typeof minTransferLamports === 'bigint'
      ? minTransferLamports.toString()
      : String(minTransferLamports),
    earlyUnstakeBps: bpsOverride,
  });

  if (!built.batches.length) {
    log('presale-autostake: no contributors after scan/dust filter', built.totals);
    return {
      ok: true,
      mode: 'push',
      skipped: 'no_contributors',
      allocations: built.allocations,
      batches: [],
      totals: {
        ...built.totals,
        sentCount: 0,
        failedCount: 0,
        earlyUnstakeBps: bpsOverride,
      },
      scan: built.scan,
    };
  }

  const connection = getConnection();
  const sentBatches = [];
  for (const batch of built.batches) {
    const tx = Transaction.from(Buffer.from(batch.base64, 'base64'));
    let sig = null;
    let err = null;
    try {
      sig = await signAndPollConfirm(connection, tx, [devKp], {
        label: 'presale-autostake:batch',
        timeoutMs: 60_000,
      });
      log('presale-autostake: batch confirmed', {
        index: batch.index,
        sig,
        beneficiaries: batch.beneficiaries.length,
      });
    } catch (e) {
      err = e.message || String(e);
      log('presale-autostake: batch failed', { index: batch.index, error: err });
    }
    sentBatches.push({
      index: batch.index,
      sig,
      error: err,
      beneficiaries: batch.beneficiaries,
    });
    if (err) {
      // Stop on first failure — re-run only the unfilled survivors via the
      // standalone /admin/presale UI rather than re-airdropping the whole
      // bag.
      break;
    }
  }

  const sentCount = sentBatches.filter((b) => b.sig).length;
  const failedCount = sentBatches.filter((b) => b.error).length;
  const tokensActuallySentRaw = sentBatches
    .filter((b) => b.sig)
    .flatMap((b) => b.beneficiaries)
    .reduce((acc, m) => acc + BigInt(m.tokensRaw), 0n);

  return {
    ok: sentBatches.every((b) => b.sig),
    mode: 'push',
    allocations: built.allocations,
    batches: sentBatches,
    totals: {
      ...built.totals,
      tokensSentRaw: tokensActuallySentRaw.toString(),
      sentCount,
      failedCount,
      earlyUnstakeBps: bpsOverride,
    },
    scan: built.scan,
  };
}
