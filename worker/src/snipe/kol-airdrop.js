// KOL airdrop orchestration — server-side stake_for batches signed with the
// dev wallet's vault keypair. Runs as the final step of stealthLaunch when
// kolAirdrop config is present, AND is also exposed as a standalone admin
// endpoint for retroactive airdrops on already-launched tokens.
//
// Why server-signed: the dev wallet lives in the vault (encrypted on disk).
// We have its keypair and admin auth, so there's no reason to round-trip
// through a browser wallet — we just build, sign, and confirm each batch
// locally. This is the same pattern the rest of the snipe orchestrator uses.

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { config, getConnection } from '../config.js';
import {
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  primeCheckpointIx,
  stakeForIx,
} from '../stake-program.js';
import { signAndPollConfirm } from '../confirm.js';
import { getKeypairById } from './wallet-vault.js';
import { ensureAutoPushDefault } from '../user-prefs.js';

// Fits 2 (stake_for + prime_checkpoint × N rewardMints) per tx safely under
// the 1232 byte versioned-tx ceiling, with compute-budget ix overhead.
const BENEFICIARIES_PER_TX = 2;

function priorityFeeIx() {
  const micro = config.priorityFeeMicroLamports;
  if (!micro || micro <= 0) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro });
}

function uniqueNonce(seed, i) {
  // Same construction as presale-autostake. (now-ms × 1000) + (seed × 1000 + i)
  // gives plenty of headroom against (pool, beneficiary, nonce) collisions
  // across consecutive launches.
  return new BN(BigInt(Date.now()) * 1000n + BigInt(seed * 1000 + i));
}

async function listPoolRewardMints({ connection, stakeMint, pool }) {
  // wSOL is registered as a reward on every Stakrr SOL-mode pool. Token-mode
  // pools reuse the stake mint as their reward; the registry's `rewardMint`
  // captures whichever is canonical.
  const candidates = new Set([config.wsolMint.toBase58()]);
  if (pool?.rewardMint) candidates.add(pool.rewardMint);
  // For token-reward pools the stake mint is also the reward line — caller
  // passes it in as part of the pool registry, but be defensive.
  const out = [];
  for (const m of candidates) {
    const mintPk = new PublicKey(m);
    const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: mintPk });
    if (rm) out.push(mintPk);
  }
  return out;
}

/**
 * Allocate `tokenTotalRaw` raw tokens across `wallets` weighted by their
 * `weight` field. Largest-remainder method to keep the sum exact and avoid
 * pennies of dust drifting out of the bag.
 */
function allocateByWeight(wallets, tokenTotalRaw) {
  const total = BigInt(tokenTotalRaw);
  if (total <= 0n || wallets.length === 0) return [];
  const weights = wallets.map((w) => Number(w.weight) || 1);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum <= 0) return [];

  const SCALE = 10n ** 9n; // 9-digit precision for fractional weights
  const scaledShares = weights.map((w) => (BigInt(Math.round((w / weightSum) * Number(SCALE))) * total) / SCALE);
  let assigned = scaledShares.reduce((a, b) => a + b, 0n);
  let remainder = total - assigned;

  // Distribute the remainder one raw unit at a time to the largest weights.
  const order = weights
    .map((w, i) => ({ i, w }))
    .sort((a, b) => b.w - a.w);
  let oi = 0;
  while (remainder > 0n) {
    scaledShares[order[oi % order.length].i] += 1n;
    remainder -= 1n;
    oi += 1;
  }
  return wallets.map((w, i) => ({
    wallet: w.wallet,
    weight: weights[i],
    label: w.label || null,
    tokensRaw: scaledShares[i],
    shareBps: Number((scaledShares[i] * 10_000n) / total),
  })).filter((r) => r.tokensRaw > 0n);
}

async function detectStakeMintProgram(connection, mintPk) {
  const acc = await connection.getAccountInfo(mintPk);
  if (!acc) throw new Error(`mint ${mintPk.toBase58()} not found on chain`);
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (acc.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`mint ${mintPk.toBase58()} is not SPL/Token-2022`);
}

/**
 * Read the dev wallet's available token balance for a mint. Used to size
 * the airdrop bag (and to flag if dev hasn't received tokens yet — happens
 * if the bundle is still propagating when this runs).
 */
async function readDevTokenBalance({ connection, devPubkey, mintPk }) {
  const programId = await detectStakeMintProgram(connection, mintPk);
  const ata = getAssociatedTokenAddressSync(mintPk, devPubkey, false, programId);
  try {
    const acc = await getAccount(connection, ata, 'confirmed', programId);
    return { ata: ata.toBase58(), amountRaw: acc.amount.toString(), programId: programId.toBase58() };
  } catch {
    return { ata: ata.toBase58(), amountRaw: '0', programId: programId.toBase58() };
  }
}

/**
 * Build + sign + send stake_for batches for a KOL airdrop. The dev wallet's
 * vault keypair is the payer AND the source of tokens (since after the
 * bundle, the dev wallet's ATA holds the entire dev-buy bag).
 *
 * Returns:
 *   { allocations, batches: [{ index, sig, beneficiaries }],
 *     totals: { tokensRaw, walletCount, batchCount } }
 *
 * On error mid-flight: returns the batches that DID land plus an `error`
 * field with the failure cause. Caller is expected to surface this in the
 * snipe-store row so an admin can see partial completion.
 */
export async function runKolAirdrop({
  mint,
  devWalletId,
  wallets,
  lockDays = 7,
  tokenAllocationRaw,    // optional — defaults to entire dev-buy bag
  tokenAllocationPct,    // optional — % of dev bag (1-100), used if tokenAllocationRaw omitted
  log = () => {},
}) {
  if (!mint) throw new Error('mint required');
  if (!devWalletId) throw new Error('devWalletId required');
  if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('wallets list is empty');

  const connection = getConnection();
  const stakeMint = new PublicKey(mint);
  const devKp = getKeypairById(devWalletId);
  const devPk = devKp.publicKey;

  // Resolve the pool — if it doesn't exist yet we can't airdrop. Caller
  // should ensure pool init has confirmed before invoking us.
  const pool = await fetchPool({ connection, stakeMint });
  if (!pool) throw new Error(`stake pool not yet initialized for ${mint}`);
  await detectTokenProgram(connection, stakeMint);

  const devBag = await readDevTokenBalance({ connection, devPubkey: devPk, mintPk: stakeMint });
  const devBagRaw = BigInt(devBag.amountRaw);
  if (devBagRaw <= 0n) {
    throw new Error(`dev wallet ${devPk.toBase58()} has 0 tokens of ${mint} — bundle may not have propagated yet`);
  }

  // Resolve the bag size.
  let allocRaw;
  if (tokenAllocationRaw != null) {
    allocRaw = BigInt(tokenAllocationRaw);
    if (allocRaw <= 0n) throw new Error('tokenAllocationRaw must be > 0');
    if (allocRaw > devBagRaw) {
      throw new Error(`tokenAllocationRaw ${allocRaw} exceeds dev bag ${devBagRaw}`);
    }
  } else {
    const pct = Math.max(1, Math.min(100, Number(tokenAllocationPct ?? 50)));
    allocRaw = (devBagRaw * BigInt(pct)) / 100n;
  }

  const allocations = allocateByWeight(wallets, allocRaw);
  if (allocations.length === 0) {
    throw new Error('allocateByWeight produced 0 allocations (check weights)');
  }

  const rewardMints = await listPoolRewardMints({ connection, stakeMint, pool });
  if (rewardMints.length === 0) {
    throw new Error(`no reward mint registered for pool ${stakeMint.toBase58()}`);
  }

  const batches = [];
  for (let bi = 0; bi < allocations.length; bi += BENEFICIARIES_PER_TX) {
    const slice = allocations.slice(bi, bi + BENEFICIARIES_PER_TX);
    const tx = new Transaction();
    const fee = priorityFeeIx();
    if (fee) tx.add(fee);
    // Bump compute since each beneficiary adds 2-3 invokes.
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));

    const meta = [];
    for (let i = 0; i < slice.length; i += 1) {
      const a = slice[i];
      const beneficiary = new PublicKey(a.wallet);
      const nonce = uniqueNonce(bi, i);
      const sf = await stakeForIx({
        connection,
        payer: devPk,
        stakeMint,
        beneficiary,
        amountRaw: a.tokensRaw,
        lockDays: Number(lockDays),
        nonce,
      });
      tx.add(sf.ix);
      for (const rewardMint of rewardMints) {
        const pc = await primeCheckpointIx({
          connection,
          payer: devPk,
          stakeMint,
          position: sf.position,
          rewardTokenMint: rewardMint,
        });
        tx.add(pc.ix);
      }
      meta.push({
        wallet: a.wallet,
        label: a.label,
        tokensRaw: a.tokensRaw.toString(),
        shareBps: a.shareBps,
        weight: a.weight,
        nonce: nonce.toString(),
        position: sf.position.toBase58(),
      });

      // KOL airdrop recipients didn't visit our UI — default to auto-push so
      // their rewards land automatically. They can flip to manual via
      // Settings if they prefer.
      ensureAutoPushDefault(a.wallet);
    }

    let sig = null;
    let err = null;
    try {
      sig = await signAndPollConfirm(connection, tx, [devKp], {
        label: 'kol-airdrop:batch',
        timeoutMs: 60_000,
      });
      log('batch confirmed', { index: batches.length, sig, beneficiaries: meta.length });
    } catch (e) {
      err = e.message || String(e);
      log('batch failed', { index: batches.length, error: err });
    }
    batches.push({ index: batches.length, sig, error: err, beneficiaries: meta });
    if (err) {
      // Stop on first failure — the admin can re-run only the unfilled
      // wallets with a fresh CSV of survivors.
      break;
    }
  }

  const tokensTotalSent = batches
    .filter((b) => b.sig)
    .flatMap((b) => b.beneficiaries)
    .reduce((acc, m) => acc + BigInt(m.tokensRaw), 0n);

  return {
    ok: batches.every((b) => b.sig),
    allocations: allocations.map((a) => ({
      wallet: a.wallet,
      label: a.label,
      weight: a.weight,
      tokensRaw: a.tokensRaw.toString(),
      shareBps: a.shareBps,
    })),
    batches,
    totals: {
      walletCount: allocations.length,
      batchCount: batches.length,
      tokensAllocatedRaw: allocRaw.toString(),
      tokensSentRaw: tokensTotalSent.toString(),
      lockDays: Number(lockDays),
      rewardMints: rewardMints.map((m) => m.toBase58()),
    },
  };
}

/**
 * Pre-flight estimate without sending anything. Used by the launch UI to
 * show "this airdrop will create N positions across M batches and consume
 * roughly X tokens of the dev buy bag" before the user clicks go.
 */
export function previewKolAirdrop({ wallets, tokenAllocationRaw, devBagRaw }) {
  if (!Array.isArray(wallets) || wallets.length === 0) {
    return { ok: false, error: 'wallets list is empty' };
  }
  let allocRaw;
  if (tokenAllocationRaw != null) {
    allocRaw = BigInt(tokenAllocationRaw);
  } else if (devBagRaw != null) {
    allocRaw = BigInt(devBagRaw);
  } else {
    return { ok: false, error: 'tokenAllocationRaw or devBagRaw required' };
  }
  if (allocRaw <= 0n) return { ok: false, error: 'allocation must be > 0' };
  const allocations = allocateByWeight(wallets, allocRaw);
  return {
    ok: true,
    walletCount: allocations.length,
    batchCount: Math.ceil(allocations.length / BENEFICIARIES_PER_TX),
    tokensAllocatedRaw: allocRaw.toString(),
    perWallet: allocations.slice(0, 50).map((a) => ({
      wallet: a.wallet,
      label: a.label,
      weight: a.weight,
      tokensRaw: a.tokensRaw.toString(),
      shareBps: a.shareBps,
    })),
    truncated: allocations.length > 50,
  };
}
