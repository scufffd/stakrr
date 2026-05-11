/**
 * Bread CLIMP presale refund runbook.
 *
 * The CLIMP launch was decommissioned (vaults swept to backup treasury). The
 * presale wallet AVhaEWooja5nUuihbYNs1oVDHFb2Y3oAZ3bu6SZApAS4 took 20.747 SOL
 * across 16 contributors (≥ 0.01 SOL each, scanned from cutoff signature
 * 3iBDAjd4… inclusive — exactly what `presaleAirdrop.scan` recorded). KOL
 * wallets are NOT in this list (they were a separate top-of-bag carve and got
 * tokens for free, no SOL contributed).
 *
 * The dev wallet 6X2XzYnKbVgprqcQZSTd4yoTzQGDGwhfbnJ5GKhxhVqu currently holds
 * ~15.46 SOL (rest of the launch SOL went to Pump fees, sniper bundle, etc).
 * We refund every contributor proportionally:
 *
 *     refund_i = floor(alloc_i.lamports * refundable / total_presale_lamports)
 *
 * where `refundable = devBalance - reserve`. `reserve` covers tx fees + a
 * small safety buffer so the dev wallet doesn't go below rent-exempt.
 *
 * Largest-remainder method is used to allocate any rounding dust to the
 * largest contributors so the sum of refunds matches `refundable` exactly.
 *
 * Refunds go out as a SINGLE atomic SystemProgram.transfer-batch tx where
 * possible (16 transfers fits comfortably in 1232 bytes). If the tx is too
 * large (defensive guard) we fall back to chunks of 12.
 *
 * Usage:
 *   node scripts/refund_climp_presale.mjs                # dry-run (default)
 *   node scripts/refund_climp_presale.mjs --execute      # actually send
 */

import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getKeypairById } from '../src/snipe/wallet-vault.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNIPES_PATH = resolve(__dirname, '../data/snipes.json');

const CLIMP_MINT = 'qQ3ozw2gsZ37r5shavwNNd8t7QQBJvFh1qqZSGZpump';
const EXPECTED_DEV = '6X2XzYnKbVgprqcQZSTd4yoTzQGDGwhfbnJ5GKhxhVqu';
const EXPECTED_PRESALE_WALLET = 'AVhaEWooja5nUuihbYNs1oVDHFb2Y3oAZ3bu6SZApAS4';
const EXPECTED_CUTOFF_SIG = '3iBDAjd4jBu3RDty38kNWnHT2zGjJXUt1oFLizSrkbNV1qX7gsPFpS3MnXetkDpXHYvuAYfoYa5bRCMA8EVV5HrD';
const MIN_TRANSFER_LAMPORTS = 10_000_000n; // 0.01 SOL
const RESERVE_LAMPORTS = 1_500_000n;       // 0.0015 SOL — generous buffer for tx fees + retries

/**
 * Per-contributor redirect overrides. Map<sourceWallet, destinationWallet>.
 * The contributor's share is computed normally based on their original
 * contribution, but the refund payment is sent to `destinationWallet`
 * instead of the source. Useful when a contributor explicitly requests
 * their refund be routed to a different wallet.
 *
 * If the destination is also a recipient in the refund table, refunds are
 * coalesced into a single transfer so we don't send two separate txs to
 * the same address.
 */
const REDIRECTS = new Map([
  ['yGrBsck53t9MeBqz2WNvRynhtfFhisHVt9UQbH4ddxp', 'GE9JWdzQZSNEiqn336R9WWWNAcktZNzebtbNHpC65qhC'],
]);

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

function fmtSol(lamports) {
  return (Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 9 });
}

function loadPresaleAllocations() {
  const raw = JSON.parse(readFileSync(SNIPES_PATH, 'utf8'));
  const items = Array.isArray(raw) ? raw : raw.snipes || [];
  const snipe = items.find((s) => (s.mint || '') === CLIMP_MINT);
  if (!snipe) throw new Error('CLIMP snipe entry not found in snipes.json');

  const dev = snipe.devWallet;
  if (dev !== EXPECTED_DEV) {
    throw new Error(`Dev wallet mismatch: snipe.devWallet=${dev} expected=${EXPECTED_DEV}`);
  }

  const pa = snipe.presaleAirdrop;
  if (!pa) throw new Error('No presaleAirdrop block on CLIMP snipe');
  const scan = pa.scan || {};
  const presaleWallet = scan.presaleWallet;
  const cutoff = scan.cutoffSignature;
  const minLp = BigInt(scan.minTransferLamports || 0);

  if (presaleWallet !== EXPECTED_PRESALE_WALLET) {
    throw new Error(`presaleWallet mismatch: ${presaleWallet} vs expected ${EXPECTED_PRESALE_WALLET}`);
  }
  if (cutoff !== EXPECTED_CUTOFF_SIG) {
    throw new Error(`cutoffSignature mismatch: ${cutoff} vs expected ${EXPECTED_CUTOFF_SIG}`);
  }
  if (minLp !== MIN_TRANSFER_LAMPORTS) {
    throw new Error(`minTransferLamports mismatch: ${minLp} vs expected ${MIN_TRANSFER_LAMPORTS}`);
  }

  const allocations = (pa.allocations || []).map((a) => ({
    wallet: a.wallet,
    lamports: BigInt(a.lamports),
    shareBps: a.shareBps,
  }));
  if (allocations.length === 0) throw new Error('No presale allocations recorded');
  for (const a of allocations) {
    if (a.lamports < MIN_TRANSFER_LAMPORTS) {
      throw new Error(`Allocation ${a.wallet} below 0.01 SOL filter (${a.lamports}) — should never happen`);
    }
  }
  return { devWallet: snipe.devWalletId, devPubkey: snipe.devWallet, presaleWallet, cutoff, allocations };
}

/**
 * Largest-remainder distribution of `refundable` across allocations
 * weighted by their original `lamports`. Returns Map<wallet, BigInt lamports>.
 */
function distribute(allocations, refundable) {
  const total = allocations.reduce((acc, a) => acc + a.lamports, 0n);
  if (total === 0n) return new Map();
  const SCALE = 1_000_000_000_000n; // micro-rounding precision
  // exactShare = a.lamports * refundable / total  (in lamports)
  // floorShare = floor(a.lamports * refundable / total)
  // remainder  = (a.lamports * refundable) mod total
  const rows = allocations.map((a) => {
    const num = a.lamports * refundable;
    const floor = num / total;
    const remainder = num - floor * total;
    return { wallet: a.wallet, floor, remainder };
  });
  let assigned = rows.reduce((acc, r) => acc + r.floor, 0n);
  let dust = refundable - assigned; // how many lamports left to distribute
  // Sort by remainder DESC; give one extra lamport to top `dust` rows
  rows.sort((a, b) => (a.remainder < b.remainder ? 1 : a.remainder > b.remainder ? -1 : 0));
  for (let i = 0; i < rows.length && dust > 0n; i += 1) {
    rows[i].floor += 1n;
    dust -= 1n;
  }
  const out = new Map();
  for (const r of rows) out.set(r.wallet, r.floor);
  return out;
}

async function main() {
  console.log('==============================================================');
  console.log(`CLIMP presale refund runbook  (${EXECUTE ? 'EXECUTE' : 'DRY-RUN'})`);
  console.log('==============================================================');

  const { devPubkey, presaleWallet, cutoff, allocations } = loadPresaleAllocations();
  console.log(`  Dev wallet:    ${devPubkey}`);
  console.log(`  Presale wallet: ${presaleWallet}`);
  console.log(`  Cutoff sig:    ${cutoff}`);
  console.log(`  Min transfer:  0.01 SOL`);
  console.log(`  Recipients:    ${allocations.length} contributors`);

  const totalPresale = allocations.reduce((acc, a) => acc + a.lamports, 0n);
  console.log(`  Total presale (>= 0.01 SOL): ${fmtSol(totalPresale)} SOL`);

  const devBalance = BigInt(await connection.getBalance(new PublicKey(devPubkey)));
  console.log(`  Dev wallet balance:           ${fmtSol(devBalance)} SOL`);
  console.log(`  Reserve (fees + buffer):      ${fmtSol(RESERVE_LAMPORTS)} SOL`);

  if (devBalance <= RESERVE_LAMPORTS) {
    throw new Error('Dev wallet balance is at or below reserve threshold — nothing to refund');
  }
  const refundable = devBalance - RESERVE_LAMPORTS;
  console.log(`  Refundable pool:              ${fmtSol(refundable)} SOL`);
  const recoveryRate = Number(refundable * 10000n / totalPresale) / 100;
  console.log(`  Recovery rate vs original:    ${recoveryRate.toFixed(2)}%`);

  const refunds = distribute(allocations, refundable);

  // Sanity: sum equals refundable
  const sum = Array.from(refunds.values()).reduce((a, b) => a + b, 0n);
  if (sum !== refundable) {
    throw new Error(`Distribution mismatch: sum=${sum} refundable=${refundable}`);
  }

  console.log('\n--------------------------------------------------------------');
  console.log('Refund table (proportional to original contribution):');
  console.log('--------------------------------------------------------------');
  console.log('  wallet                                          original →     refund        %recovered  payTo');
  for (const a of allocations) {
    const r = refunds.get(a.wallet) ?? 0n;
    const rec = Number(r * 10000n / a.lamports) / 100;
    const dest = REDIRECTS.get(a.wallet);
    const tag = dest ? `→ ${dest.slice(0, 8)}…` : '';
    console.log(
      `  ${a.wallet}  ${fmtSol(a.lamports).padStart(11)} SOL → ${fmtSol(r).padStart(11)} SOL   ${rec.toFixed(2)}%   ${tag}`,
    );
  }
  console.log(`  TOTAL                                           ${fmtSol(totalPresale).padStart(11)} SOL → ${fmtSol(refundable).padStart(11)} SOL`);

  // Apply redirects + coalesce duplicates so a destination wallet only
  // receives one transfer (sum of all refunds routed to it).
  const payouts = new Map();
  for (const [src, lamports] of refunds.entries()) {
    if (lamports <= 0n) continue;
    const dest = REDIRECTS.get(src) || src;
    payouts.set(dest, (payouts.get(dest) || 0n) + lamports);
  }

  if (REDIRECTS.size > 0) {
    console.log('\n--------------------------------------------------------------');
    console.log('Effective payouts (after redirects + coalescing):');
    console.log('--------------------------------------------------------------');
    for (const [dest, lp] of payouts.entries()) {
      console.log(`  ${dest}  ${fmtSol(lp).padStart(11)} SOL`);
    }
  }

  const nonZero = Array.from(payouts.entries()).filter(([, lp]) => lp > 0n);
  if (nonZero.length === 0) {
    throw new Error('No non-zero refunds computed');
  }
  // Final sanity: sum of payouts must equal refundable
  const payoutSum = nonZero.reduce((acc, [, lp]) => acc + lp, 0n);
  if (payoutSum !== refundable) {
    throw new Error(`Payout sum ${payoutSum} != refundable ${refundable} after redirects`);
  }

  if (!EXECUTE) {
    console.log('\nDRY-RUN complete. Re-run with --execute to send refunds.');
    return;
  }

  console.log('\n--------------------------------------------------------------');
  console.log('Executing …');
  console.log('--------------------------------------------------------------');

  // Load dev wallet keypair from vault
  const devKp = getKeypairById('wlt_496beac69391');
  if (devKp.publicKey.toBase58() !== devPubkey) {
    throw new Error(`Dev wallet keypair mismatch: ${devKp.publicKey.toBase58()} vs ${devPubkey}`);
  }

  // Batch transfers into a single tx where possible (16 transfers fit 1232b)
  const CHUNK_SIZE = 12;
  for (let i = 0; i < nonZero.length; i += CHUNK_SIZE) {
    const chunk = nonZero.slice(i, i + CHUNK_SIZE);
    const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
    const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
    const tx = new Transaction().add(cuPriceIx, cuLimitIx);
    for (const [wallet, lamports] of chunk) {
      tx.add(SystemProgram.transfer({
        fromPubkey: devKp.publicKey,
        toPubkey: new PublicKey(wallet),
        lamports: Number(lamports),
      }));
    }
    tx.feePayer = devKp.publicKey;
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    const labels = chunk.map(([w, l]) => `${w.slice(0, 8)}…=${fmtSol(l)}`).join(', ');
    console.log(`  Sending batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${chunk.length} transfers — ${labels}`);
    const sig = await sendAndConfirmTransaction(connection, tx, [devKp], {
      commitment: 'confirmed',
      skipPreflight: false,
    });
    console.log(`    ✓ sig=${sig}`);
  }

  console.log('\n--------------------------------------------------------------');
  console.log('Done. Verifying …');
  console.log('--------------------------------------------------------------');
  const after = BigInt(await connection.getBalance(new PublicKey(devPubkey)));
  console.log(`  Dev wallet after: ${fmtSol(after)} SOL`);
  console.log(`  Total refunded:   ${fmtSol(devBalance - after)} SOL`);
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e.message || e);
  if (e.logs) console.error('logs:', e.logs);
  process.exit(1);
});
