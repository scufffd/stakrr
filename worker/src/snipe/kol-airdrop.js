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
import { authoritySigner, config, getConnection } from '../config.js';
import {
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  primeCheckpointIx,
  setPositionEarlyUnstakeBpsIx,
  stakeForIx,
} from '../stake-program.js';
import { signAndPollConfirm } from '../confirm.js';
import { getKeypairById } from './wallet-vault.js';
import { ensureAutoPushDefault } from '../user-prefs.js';
import { createPendingClaims } from '../kol-claims.js';

// Fits 2 (stake_for + prime_checkpoint × N rewardMints) per tx safely under
// the 1232 byte versioned-tx ceiling, with compute-budget ix overhead.
// When a per-position early-unstake bps override is also being written, each
// beneficiary adds an extra `set_position_early_unstake_bps` ix (~120 bytes,
// 3 accounts) — we drop the batch size to 1 in that case via
// `BENEFICIARIES_PER_TX_WITH_OVERRIDE` to stay safely under the ceiling.
const BENEFICIARIES_PER_TX = 2;
const BENEFICIARIES_PER_TX_WITH_OVERRIDE = 1;

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
 * Equal-split convenience: every KOL gets `floor(total / N)`, with the
 * remainder (≤ N − 1 raw units) distributed deterministically to the first
 * wallets in the input order. Use when the caller wants strict equal share
 * rather than per-wallet weights.
 *
 * Returns the same shape as `allocateByWeight` so the rest of the pipeline
 * doesn't have to branch.
 */
function allocateEqual(wallets, tokenTotalRaw) {
  const total = BigInt(tokenTotalRaw);
  if (total <= 0n || wallets.length === 0) return [];
  const n = BigInt(wallets.length);
  const base = total / n;
  let remainder = total - base * n;
  return wallets.map((w, i) => {
    let share = base;
    if (remainder > 0n) {
      share += 1n;
      remainder -= 1n;
    }
    return {
      wallet: w.wallet,
      weight: 1,
      label: w.label || null,
      tokensRaw: share,
      shareBps: share > 0n ? Number((share * 10_000n) / total) : 0,
    };
  }).filter((r) => r.tokensRaw > 0n);
}

/**
 * De-duplicate by wallet (case-sensitive base58). When the same wallet
 * appears multiple times in the input list (typo / paste-twice / curated
 * list overlap), the first occurrence wins and subsequent rows are dropped
 * with a `_duplicateDropped` log entry. Returns `{ unique, duplicates }`.
 */
function dedupeWallets(wallets) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const w of wallets) {
    if (!w || !w.wallet) continue;
    if (seen.has(w.wallet)) {
      duplicates.push(w);
      continue;
    }
    seen.add(w.wallet);
    unique.push(w);
  }
  return { unique, duplicates };
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
// Exported so the orchestrator can take a single bag snapshot before
// running both KOL airdrop AND presale auto-stake — letting the carve be
// computed deterministically from one number rather than re-reading the
// ATA between steps (which could race against any concurrent transfer).
export async function readDevTokenBalance({ connection, devPubkey, mintPk }) {
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
  symbol,                 // optional — included in pending-claim records for UI
  devWalletId,
  wallets,
  lockDays = 7,
  tokenAllocationRaw,    // optional — defaults to entire dev-buy bag
  tokenAllocationPct,    // optional — % of dev bag (1-100), used if tokenAllocationRaw omitted
  mode = 'push',          // 'push' (default) | 'pending-claim'.
                          // push: stake_for runs at launch, position is
                          //   on-chain immediately and visible on the
                          //   staking leaderboard / token page.
                          // pending-claim: tokens stay in dev wallet,
                          //   KOL signs to materialise; sweepable on
                          //   expiry. Kept for explicit-consent flows.
  equalSplit = true,     // when true: split equally regardless of weights.
  claimWindowDays = 30,  // pending-claim: how long the KOL has to accept.
  excludeWallets = [],   // strip wallets that are also presale contributors
                         // (or any other dedupe upstream wants to apply)
  earlyUnstakeBps = 0,   // v4 per-position penalty override (0..9000).
                         // 0 = use pool default (10%).
                         // - push mode: appended via set_position_early_unstake_bps
                         //   ix immediately after each stake_for in the same tx.
                         // - pending-claim mode: persisted on the pending row;
                         //   applied at accept-time by the API handler.
                         // The dev wallet's vault keypair must be the pool
                         //   authority (in stealth-launch flow it always is —
                         //   initialize_pool was signed by the same vault).
  launchSnipeId = null,  // back-link for admin reporting on pending claims
  log = () => {},
}) {
  if (!mint) throw new Error('mint required');
  if (!devWalletId) throw new Error('devWalletId required');
  if (!Array.isArray(wallets) || wallets.length === 0) throw new Error('wallets list is empty');
  if (mode !== 'push' && mode !== 'pending-claim') {
    throw new Error(`runKolAirdrop: invalid mode ${mode} (expected 'push' or 'pending-claim')`);
  }
  const bpsOverride = Math.max(0, Math.min(9000, Number(earlyUnstakeBps || 0)));

  // Dedupe within the KOL list itself, then drop any wallet that's already
  // a presale contributor (caller passes `excludeWallets`). Empty result
  // is a no-op rather than an error so the unified launch flow can route
  // 100% to contributors when every KOL was a contributor too.
  const excludeSet = new Set(excludeWallets);
  const { unique, duplicates } = dedupeWallets(wallets);
  const filtered = unique.filter((w) => !excludeSet.has(w.wallet));
  const collisions = unique.filter((w) => excludeSet.has(w.wallet));
  if (filtered.length === 0) {
    log('no eligible KOL wallets after dedupe', {
      inputCount: wallets.length,
      duplicates: duplicates.length,
      collisionsWithExclude: collisions.length,
    });
    return {
      ok: true,
      mode,
      skipped: 'no_eligible_wallets',
      duplicates: duplicates.map((w) => w.wallet),
      collisionsWithExclude: collisions.map((w) => w.wallet),
      allocations: [],
      batches: [],
      pendingClaims: [],
      totals: { walletCount: 0, batchCount: 0, tokensAllocatedRaw: '0', tokensSentRaw: '0', lockDays: Number(lockDays), rewardMints: [] },
    };
  }

  const connection = getConnection();
  const stakeMint = new PublicKey(mint);
  const devKp = getKeypairById(devWalletId);
  const devPk = devKp.publicKey;

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

  const allocations = equalSplit
    ? allocateEqual(filtered, allocRaw)
    : allocateByWeight(filtered, allocRaw);
  if (allocations.length === 0) {
    throw new Error('allocation produced 0 entries (check weights / wallet list)');
  }

  // === pending-claim mode: don't touch the chain. Just earmark the bag. ===
  //
  // The dev wallet keeps the carved tokens until the KOL accepts. If they
  // never do, the daily sweep cron flips the entries to `expired` and the
  // dev keeps the tokens — no on-chain reclaim needed since they never
  // moved. The pool DOESN'T need to exist yet for this branch (we don't
  // call stake_for here), so this is safe to invoke immediately after the
  // launch bundle confirms, even before pool init.
  if (mode === 'pending-claim') {
    const pendingRows = allocations.map((a) => ({
      wallet: a.wallet,
      mint,
      symbol: symbol || null,
      tokensRaw: a.tokensRaw.toString(),
      devWalletId,
      stakeLockDays: Number(lockDays),
      claimWindowDays: Number(claimWindowDays),
      earlyUnstakeBps: bpsOverride,
      launchSnipeId,
      label: a.label || null,
    }));
    const inserted = createPendingClaims(pendingRows);
    log('pending-claim entries created', {
      count: inserted.length,
      claimWindowDays,
      stakeLockDays: Number(lockDays),
    });
    const tokensTotalEarmarked = allocations.reduce((acc, a) => acc + a.tokensRaw, 0n);
    return {
      ok: true,
      mode,
      duplicates: duplicates.map((w) => w.wallet),
      collisionsWithExclude: collisions.map((w) => w.wallet),
      allocations: allocations.map((a) => ({
        wallet: a.wallet,
        label: a.label,
        weight: a.weight,
        tokensRaw: a.tokensRaw.toString(),
        shareBps: a.shareBps,
      })),
      batches: [],
      pendingClaims: inserted.map((r) => ({
        id: r.id,
        wallet: r.wallet,
        tokensRaw: r.tokensRaw,
        expiresAt: r.expiresAt,
        stakeLockDays: r.stakeLockDays,
      })),
      totals: {
        walletCount: allocations.length,
        batchCount: 0,
        tokensAllocatedRaw: allocRaw.toString(),
        tokensSentRaw: '0',
        tokensEarmarkedRaw: tokensTotalEarmarked.toString(),
        lockDays: Number(lockDays),
        claimWindowDays: Number(claimWindowDays),
        earlyUnstakeBps: bpsOverride,
        rewardMints: [],
      },
    };
  }

  // === push mode: original behaviour — stake_for on-chain immediately. ===
  // Resolve the pool — required since stake_for needs it to exist.
  const pool = await fetchPool({ connection, stakeMint });
  if (!pool) throw new Error(`stake pool not yet initialized for ${mint}`);

  const rewardMints = await listPoolRewardMints({ connection, stakeMint, pool });
  if (rewardMints.length === 0) {
    throw new Error(`no reward mint registered for pool ${stakeMint.toBase58()}`);
  }

  // When we're going to append a `set_position_early_unstake_bps` ix per
  // beneficiary, drop the batch size so we stay safely under 1232 bytes.
  const beneficiariesPerTx = bpsOverride > 0
    ? BENEFICIARIES_PER_TX_WITH_OVERRIDE
    : BENEFICIARIES_PER_TX;

  // Pool-authority keypair for the optional set_position_early_unstake_bps
  // ix. Resolved once outside the loop since it never changes per-batch.
  // After the 85cc74b anti-rug rotation, pool.authority is the platform
  // key, NOT the dev keypair signing the rest of the batch — so without
  // this signer the override ix returns NotAuthority (0x177c).
  const platformAuthKp = bpsOverride > 0 ? authoritySigner() : null;
  const needsPlatformSigner = bpsOverride > 0
    && !platformAuthKp.publicKey.equals(devPk);

  const batches = [];
  for (let bi = 0; bi < allocations.length; bi += beneficiariesPerTx) {
    const slice = allocations.slice(bi, bi + beneficiariesPerTx);
    const tx = new Transaction();
    const fee = priorityFeeIx();
    if (fee) tx.add(fee);
    // Bump compute since each beneficiary adds 2-3 invokes (plus +1 ix when
    // a per-position bps override is being written).
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

      // v4: optional per-position early-unstake penalty override. Bundled
      // in the SAME tx as stake_for so the override is atomic with the
      // position creation — if either ix fails, neither lands.
      //
      // Authority must be pool.authority. Since commit 85cc74b every
      // Stakrr-launched pool rotates pool.authority from the deployer to
      // PLATFORM_AUTHORITY in the same tx initialize_pool runs in, so the
      // dev keypair we use to sign the rest of the batch is NOT a valid
      // signer for this ix. We pull the platform keypair (or treasury
      // fallback) from config and add it to the signer set below.
      if (bpsOverride > 0) {
        const sb = await setPositionEarlyUnstakeBpsIx({
          connection,
          authority: platformAuthKp.publicKey,
          stakeMint,
          position: sf.position,
          bps: bpsOverride,
        });
        tx.add(sb.ix);
      }

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
        earlyUnstakeBps: bpsOverride,
      });

      // KOL airdrop recipients didn't visit our UI — default to auto-push so
      // their rewards land automatically. They can flip to manual via
      // Settings if they prefer.
      ensureAutoPushDefault(a.wallet);
    }

    let sig = null;
    let err = null;
    try {
      const signers = needsPlatformSigner ? [devKp, platformAuthKp] : [devKp];
      sig = await signAndPollConfirm(connection, tx, signers, {
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
      earlyUnstakeBps: bpsOverride,
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
