// Launch choreography — the "dev rug + absorber wall" anti-sniper play.
//
// Timing model (block-relative, NOT millisecond-relative):
//   Solana slots are ~400ms but jitter (350-500ms in practice). We schedule
//   every phase against the `launchSlot` we capture from the bundle confirm
//   so the choreography lands in the right block regardless of network
//   conditions. Snipers race in slots launchSlot+1..3 (the "sniper window");
//   we want the dev rug + absorber wave to land in launchSlot+3..5 so
//   panic-sells from snipers are immediately absorbed.
//
//   The orchestrator fires runDumpAndAbsorb in PARALLEL with the post-bundle
//   setup (lock-fees + pool-init), so we don't wait for those ~10s/~25 slots
//   before the dev rug. That's the only way "block 4" is physically achievable
//   from the worker's perspective.
//
// Sequence:
//
//   slot launchSlot+devSellDelayBlocks (default 3)
//     Phase 0: optional dev stake_for_self of X% of dev bag (only when
//              devStakePct > 0; polls for pool existence since pool-init
//              is racing this in parallel)
//     Phase 1: dev sells 100% of remaining (unstaked) bag
//              → fires "dev sold" alerts on Photon / BullX / Trojan
//              → snipers panic-exit, copy-trader bots auto-sell
//
//   slot launchSlot+absorberWaveDelayBlocks (default 4)
//     Phase 2: first absorber wave — 3-5 absorber wallets buy in parallel
//              (different funded wallets, no shared lineage with the
//              in-bundle snipers, terminals don't tag them as snipers
//              because they bought outside the launch block)
//
//   over dripWindowSec seconds after the wave
//     Phase 3: drip — remaining absorbers buy sequentially with jittered
//              amounts / slippage / priority fees / intervals so terminals
//              can't fingerprint them as a bundle
//
//   inline after each absorber buy
//     Phase 4: optional auto-stake of each absorber's bag to itself
//              (locks supply, earns creator fees, tags wallet as "staker"
//              not "sniper" on terminals — dual-benefit). Polls for pool
//              existence with a short timeout, skips with reason if not
//              ready (pool-init may still be racing).
//
// All on-chain side effects use vault-decrypted keypairs server-side; no
// Phantom prompts. Errors at any phase are non-fatal — the choreography
// records partial completion on the snipe row and returns. Admin can
// re-trigger remaining phases manually via the API.

import {
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import BN from 'bn.js';
import { getConnection } from '../config.js';
import { sendAndPollConfirm, signAndPollConfirm } from '../confirm.js';
import { buildTradeTx } from '../pumpdev.js';
import { stakeForIx, fetchPool } from '../stake-program.js';
import { getKeypairById, listWallets } from './wallet-vault.js';
import { updateSnipe } from './snipe-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), tag: 'choreography', message, ...extra }));
}

// ── Slot helpers ─────────────────────────────────────────────────────────────
// Solana slots tick ~400ms. Polling getSlot('confirmed') is the cheapest way
// to anchor against on-chain block progression rather than wall-clock.

const SLOT_POLL_MS = 120;

/**
 * Block until the on-chain slot reaches `targetSlot`. If the worker is
 * already past the target (which happens when bundle confirmation comes
 * back late), returns immediately. Falls back to wall-clock estimation if
 * RPC is unhappy so the choreography never deadlocks.
 *
 * @param {Connection} connection
 * @param {number} targetSlot           - absolute slot to wait for
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=30000]
 * @returns {Promise<{ currentSlot: number|null, waitedMs: number, viaFallback: boolean }>}
 */
async function waitUntilSlot(connection, targetSlot, opts = {}) {
  const { timeoutMs = 30_000 } = opts;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let lastSlot = null;
  let consecutiveErrs = 0;
  while (Date.now() < deadline) {
    try {
      const cur = await connection.getSlot('confirmed');
      consecutiveErrs = 0;
      lastSlot = cur;
      if (cur >= targetSlot) {
        return { currentSlot: cur, waitedMs: Date.now() - startedAt, viaFallback: false };
      }
      // Convert remaining slots to wall-clock so we don't hammer RPC for
      // a long wait. We sleep up to half the estimated remaining time.
      const remainingSlots = targetSlot - cur;
      const estMs = Math.min(2_000, Math.max(SLOT_POLL_MS, remainingSlots * 200));
      await sleep(estMs);
    } catch (e) {
      consecutiveErrs += 1;
      if (consecutiveErrs > 5) {
        // RPC down — fall back to a simple wall-clock estimate so we make
        // forward progress. 400ms per slot is the protocol target.
        const elapsedMs = Date.now() - startedAt;
        const expectedMs = (lastSlot != null ? Math.max(0, targetSlot - lastSlot) : 0) * 400;
        const remainingMs = Math.max(0, expectedMs - elapsedMs);
        await sleep(remainingMs);
        return { currentSlot: lastSlot, waitedMs: Date.now() - startedAt, viaFallback: true };
      }
      await sleep(SLOT_POLL_MS);
    }
  }
  // Timed out — return what we know so the caller can proceed anyway. We
  // never throw here; missing the perfect slot is much less bad than
  // skipping the phase entirely.
  return { currentSlot: lastSlot, waitedMs: Date.now() - startedAt, viaFallback: false };
}

/**
 * Try to obtain the slot at which the launch bundle landed. Prefers data
 * from the bundle confirmation envelope, falls back to a fresh getSlot()
 * (which will be a few slots ahead of the actual landing slot — that's
 * fine because waitUntilSlot returns immediately when we're already past).
 */
export async function deriveLaunchSlot(connection, confirmation) {
  try {
    const txEntry = confirmation?.status?.transactions?.[0];
    if (txEntry?.slot != null) return Number(txEntry.slot);
    if (confirmation?.status?.slot != null) return Number(confirmation.status.slot);
  } catch { /* fall through */ }
  try {
    return await connection.getSlot('confirmed');
  } catch {
    return null;
  }
}

/**
 * Wait for the staking pool to exist (pool-init may be racing the choreography
 * in parallel). Returns the pool object or null if it doesn't materialize
 * within the timeout. The caller decides whether to skip the dependent step.
 */
async function ensurePoolExists(connection, mintPk, { timeoutMs = 30_000, pollMs = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const pool = await fetchPool({ connection, stakeMint: mintPk });
      if (pool) return pool;
    } catch { /* keep polling */ }
    await sleep(pollMs);
  }
  return null;
}

// ── Anti-cluster randomization helpers ───────────────────────────────────────
// The whole point of the absorber wave is for terminals NOT to recognise it
// as a coordinated bundle. Round-number SOL amounts, identical slippage,
// identical priority fees, exact-interval timing — all of these are
// fingerprints terminals (Photon, BullX, Trojan, Axiom) actively look for.
// Every parameter we send to pumpdev gets jittered.

function randIn(min, max) {
  return min + Math.random() * (max - min);
}

function jitterSol(min, max) {
  // Pick a non-round amount in the range. We deliberately avoid divisions
  // that produce 0.05 / 0.1 / 0.25 etc. by adding a tiny perturbation.
  const base = randIn(min, max);
  const perturb = (Math.random() - 0.5) * 0.0021;
  return Math.max(0.0005, +(base + perturb).toFixed(5));
}

function jitterPct(base, range) {
  const v = Math.round(base + (Math.random() * 2 - 1) * range);
  return Math.max(1, Math.min(99, v));
}

function jitterPriorityFee(baseSol) {
  // ±50% jitter, never below half a microlamport effective.
  const v = baseSol * (0.5 + Math.random());
  return +Math.max(0.00001, v).toFixed(7);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function detectTokenProgram(connection, mintPk) {
  const acc = await connection.getAccountInfo(mintPk);
  if (!acc) return TOKEN_PROGRAM_ID;
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function readBag({ connection, owner, mintPk, programId }) {
  const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
  try {
    const acc = await getAccount(connection, ata, 'confirmed', programId);
    return { ata, amountRaw: acc.amount, ok: true };
  } catch {
    return { ata, amountRaw: 0n, ok: false };
  }
}

let stakeNonceCounter = 0;
function uniqueStakeNonce() {
  stakeNonceCounter = (stakeNonceCounter + 1) % 0xffff;
  // High bits for the timestamp so two staking ops in the same ms don't collide.
  const ms = Date.now() & 0xffffffff;
  return new BN(`${(ms >>> 16).toString(16).padStart(8, '0')}${(stakeNonceCounter & 0xffff).toString(16).padStart(4, '0')}`, 16);
}

// ── Phase 0: dev self-stake (optional) ───────────────────────────────────────

async function phaseDevStake({ connection, devKp, mintPk, devBagRaw, stakePct, lockDays, poolWaitMs = 30_000 }) {
  if (!(stakePct > 0)) return { skipped: true, reason: 'stakePct=0' };
  const stakeRaw = (devBagRaw * BigInt(stakePct)) / 100n;
  if (stakeRaw <= 0n) return { skipped: true, reason: 'computed stakeRaw=0' };

  // Pool init runs in parallel with the choreography — wait briefly for it.
  const pool = await ensurePoolExists(connection, mintPk, { timeoutMs: poolWaitMs });
  if (!pool) {
    return { skipped: true, reason: `pool not initialized within ${poolWaitMs}ms — skipping dev stake` };
  }

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const sf = await stakeForIx({
    connection,
    payer: devKp.publicKey,
    stakeMint: mintPk,
    beneficiary: devKp.publicKey, // dev stakes for self
    amountRaw: stakeRaw,
    lockDays: Number(lockDays) || 7,
    nonce: uniqueStakeNonce(),
  });
  tx.add(sf.ix);
  const sig = await signAndPollConfirm(connection, tx, [devKp], {
    label: 'choreography:dev-stake',
    timeoutMs: 60_000,
  });
  return {
    skipped: false,
    sig,
    stakedRaw: stakeRaw.toString(),
    remainingRaw: (devBagRaw - stakeRaw).toString(),
    lockDays: Number(lockDays) || 7,
  };
}

// ── Phase 1: dev rug — sells X% of remaining bag (X usually 100) ─────────────

async function phaseDevRug({ devKp, mintPk, sellAmountRaw, slippagePct, priorityFeeSol, pool = 'auto' }) {
  if (sellAmountRaw <= 0n) return { skipped: true, reason: 'sellAmountRaw<=0' };
  const tx = await buildTradeTx({
    publicKey: devKp.publicKey.toBase58(),
    action: 'sell',
    mint: mintPk.toBase58(),
    amount: Number(sellAmountRaw), // RAW token units — see post-ops note
    denominatedInSol: 'false',
    slippage: slippagePct,
    priorityFee: priorityFeeSol,
    pool,
  });
  tx.sign([devKp]);
  const connection = getConnection();
  const sig = await sendAndPollConfirm(connection, tx, {
    label: 'choreography:dev-rug',
    timeoutMs: 60_000,
  });
  return { skipped: false, sig, soldRaw: sellAmountRaw.toString() };
}

// ── Phase 2 & 3: absorber buys ───────────────────────────────────────────────

async function buildAbsorberBuy({ absorberKp, mintPk, solAmount, slippagePct, priorityFeeSol }) {
  const tx = await buildTradeTx({
    publicKey: absorberKp.publicKey.toBase58(),
    action: 'buy',
    mint: mintPk.toBase58(),
    amount: solAmount,
    denominatedInSol: 'true',
    slippage: slippagePct,
    priorityFee: priorityFeeSol,
    pool: 'auto',
  });
  tx.sign([absorberKp]);
  return tx;
}

async function executeAbsorberBuy({ absorberKp, mintPk, cfg, tag }) {
  const solAmount = jitterSol(cfg.absorberBuyMinSol, cfg.absorberBuyMaxSol);
  const slippage = jitterPct(cfg.slippagePct ?? 15, 5);
  const priorityFee = jitterPriorityFee(cfg.priorityFeeSol ?? 0.0005);
  const tx = await buildAbsorberBuy({ absorberKp, mintPk, solAmount, slippagePct: slippage, priorityFeeSol: priorityFee });
  const connection = getConnection();
  const sig = await sendAndPollConfirm(connection, tx, { label: tag, timeoutMs: 60_000 });
  return { sig, solAmount, slippage, priorityFee };
}

// ── Phase 4 (inline): per-absorber auto-stake ────────────────────────────────

async function autoStakeAbsorber({ connection, absorberKp, mintPk, programId, stakePct, lockDays, log: log2, poolWaitMs = 20_000 }) {
  if (!(stakePct > 0)) return { skipped: true, reason: 'stakePct=0' };
  // Re-read bag (the buy just settled — fresh balance).
  const bag = await readBag({ connection, owner: absorberKp.publicKey, mintPk, programId });
  if (bag.amountRaw <= 0n) return { skipped: true, reason: 'no bag to stake (buy may have slipped to 0?)' };
  const stakeRaw = (bag.amountRaw * BigInt(stakePct)) / 100n;
  if (stakeRaw <= 0n) return { skipped: true, reason: 'computed stakeRaw=0' };

  // Pool init may still be in flight — block briefly. By the time absorber
  // wave fires (slot launchSlot+4-ish) the pool is usually live; later drip
  // absorbers will basically never wait.
  const pool = await ensurePoolExists(connection, mintPk, { timeoutMs: poolWaitMs });
  if (!pool) return { skipped: true, reason: `pool not initialized within ${poolWaitMs}ms — skipping absorber stake` };

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  const sf = await stakeForIx({
    connection,
    payer: absorberKp.publicKey,
    stakeMint: mintPk,
    beneficiary: absorberKp.publicKey, // absorber stakes for itself
    amountRaw: stakeRaw,
    lockDays: Number(lockDays) || 7,
    nonce: uniqueStakeNonce(),
  });
  tx.add(sf.ix);
  const sig = await signAndPollConfirm(connection, tx, [absorberKp], {
    label: 'choreography:absorber-stake',
    timeoutMs: 60_000,
  });
  log2?.('absorber auto-staked', { wallet: absorberKp.publicKey.toBase58(), stakeRaw: stakeRaw.toString(), sig });
  return { skipped: false, sig, stakedRaw: stakeRaw.toString() };
}

// ── Public API ───────────────────────────────────────────────────────────────

export const DEFAULT_CHOREOGRAPHY_CONFIG = {
  devStakePct: 0,                // 0 = no dev stake (max scare on dev sell)
  devStakeLockDays: 7,
  devSellPct: 100,               // % of REMAINING (post-stake) dev bag

  // Block-relative scheduling, anchored to launchSlot (the slot the create
  // bundle landed in). The on-chain "sniper window" is launchSlot+1..3, so
  // defaults are tuned to fire the rug at the tail end of that window and
  // the absorber wave one block later — just as snipers' panic-sells land.
  devSellDelayBlocks: 3,         // dev rug at slot launchSlot+3
  absorberWaveDelayBlocks: 4,    // absorber wave at slot launchSlot+4

  absorberWaveSize: 4,           // parallel buys in the first wave
  absorberBuyMinSol: 0.02,
  absorberBuyMaxSol: 0.08,
  absorberAutoStakePct: 50,      // each absorber auto-stakes 50% of its bag
  absorberStakeLockDays: 7,
  dripWindowSec: 30,
  dripIntervalMinMs: 1500,
  dripIntervalMaxMs: 4000,
  slippagePct: 15,               // base — each tx jitters ±5
  priorityFeeSol: 0.0005,        // base — each tx jitters ±50%
};

// Approx wall-clock for UI estimation only (slots are ~400ms target).
export const APPROX_SLOT_MS = 400;

/**
 * Run the full dev-rug + absorber-wall choreography for an already-launched
 * mint. Designed to be invoked IMMEDIATELY after the launch bundle confirms,
 * IN PARALLEL with the lock-fees + pool-init txs — that's the only way the
 * dev rug + absorber wave can land in the early launchSlot+N blocks. The
 * absorber auto-stake phase polls for pool existence so it's safe even when
 * pool-init hasn't finished by the time the wave lands.
 *
 * @param {object} params
 * @param {string} params.snipeId           - persistence row id (so the UI can
 *                                            see live progress on past launches)
 * @param {string} params.mint
 * @param {string} params.devWalletId
 * @param {string[]} params.absorberWalletIds - vault ids, will be filtered to
 *                                              only those in `tier='absorber'`
 *                                              (or accepts any if filterTier=false)
 * @param {boolean} [params.filterTier=true]
 * @param {object} [params.config]          - overrides DEFAULT_CHOREOGRAPHY_CONFIG
 * @param {number|null} [params.launchSlot] - slot the launch bundle landed in.
 *                                            If null we'll call getSlot() now,
 *                                            but ideally the orchestrator passes
 *                                            this from the bundle confirmation.
 */
export async function runDumpAndAbsorb({
  snipeId,
  mint,
  devWalletId,
  absorberWalletIds = [],
  filterTier = true,
  config = {},
  launchSlot = null,
}) {
  if (!mint) throw new Error('mint required');
  if (!devWalletId) throw new Error('devWalletId required');

  const cfg = { ...DEFAULT_CHOREOGRAPHY_CONFIG, ...config };
  const connection = getConnection();
  const mintPk = new PublicKey(mint);
  const devKp = getKeypairById(devWalletId);
  const programId = await detectTokenProgram(connection, mintPk);

  // Establish the slot anchor. If the orchestrator didn't pass one, sample
  // the current slot — we'll be a few blocks behind real launch but that's
  // a much smaller error than guessing in milliseconds.
  let anchorSlot = Number.isFinite(launchSlot) ? Number(launchSlot) : null;
  if (anchorSlot == null) {
    try { anchorSlot = await connection.getSlot('confirmed'); }
    catch { anchorSlot = null; }
  }

  // Resolve absorber keypairs. Filter by tier so a misclick can't accidentally
  // use a sniper wallet (which would defeat the anti-sniper purpose entirely).
  const all = listWallets();
  const absMap = new Map(all.map((w) => [w.id, w]));
  const absorbers = [];
  const skippedAbsorbers = [];
  for (const id of absorberWalletIds) {
    const w = absMap.get(id);
    if (!w) { skippedAbsorbers.push({ id, reason: 'not in vault' }); continue; }
    if (filterTier && w.tier !== 'absorber') {
      skippedAbsorbers.push({ id, reason: `tier='${w.tier || 'none'}' (expected absorber)` });
      continue;
    }
    absorbers.push({ walletId: id, publicKey: w.publicKey, label: w.label, keypair: getKeypairById(id) });
  }

  log('starting choreography', {
    snipeId, mint, devWallet: devKp.publicKey.toBase58(),
    absorberCount: absorbers.length,
    skippedAbsorbers: skippedAbsorbers.length,
    anchorSlot,
    devSellTargetSlot: anchorSlot != null ? anchorSlot + (cfg.devSellDelayBlocks || 0) : null,
    waveTargetSlot: anchorSlot != null ? anchorSlot + (cfg.absorberWaveDelayBlocks || 0) : null,
    cfg,
  });

  const result = {
    ok: false,
    startedAt: new Date().toISOString(),
    config: cfg,
    anchorSlot,
    devStake: null,
    devRug: null,
    absorberWave: [],
    absorberDrip: [],
    absorberStakes: [],
    skippedAbsorbers,
    error: null,
  };

  if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'running' } });

  try {
    // ── Phase 0: dev stake (optional, preserves supply) ─────────────────────
    // Note: when devStakePct > 0, this BLOCKS the dev rug until pool-init
    // catches up. That's a deliberate trade-off — staked supply matters more
    // than precise rug timing when the user explicitly asked to preserve it.
    const devBag = await readBag({ connection, owner: devKp.publicKey, mintPk, programId });
    if (!devBag.ok || devBag.amountRaw <= 0n) {
      throw new Error(`dev wallet has no token bag (${devKp.publicKey.toBase58()}) — bundle may not have propagated`);
    }
    log('dev bag resolved', { devBagRaw: devBag.amountRaw.toString() });

    let remainingDevBagRaw = devBag.amountRaw;
    if (cfg.devStakePct > 0) {
      result.devStake = await phaseDevStake({
        connection, devKp, mintPk, devBagRaw: devBag.amountRaw,
        stakePct: cfg.devStakePct, lockDays: cfg.devStakeLockDays,
      });
      log('phase 0 (dev stake) complete', result.devStake);
      if (!result.devStake.skipped && result.devStake.remainingRaw) {
        remainingDevBagRaw = BigInt(result.devStake.remainingRaw);
      }
      if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'dev-stake-done' } });
    }

    // ── Phase 1: dev rug — wait until launchSlot+devSellDelayBlocks ─────────
    if (anchorSlot != null && cfg.devSellDelayBlocks > 0) {
      const target = anchorSlot + cfg.devSellDelayBlocks;
      const w = await waitUntilSlot(connection, target, { timeoutMs: 15_000 });
      log('phase 1 slot wait complete', { target, ...w });
    }
    const sellRaw = (remainingDevBagRaw * BigInt(Math.max(1, Math.min(100, cfg.devSellPct)))) / 100n;
    result.devRug = await phaseDevRug({
      devKp, mintPk, sellAmountRaw: sellRaw,
      slippagePct: jitterPct(cfg.slippagePct, 3),
      priorityFeeSol: jitterPriorityFee(cfg.priorityFeeSol),
    });
    try { result.devRug.landedSlot = await connection.getSlot('confirmed'); } catch { /* nice-to-have */ }
    log('phase 1 (dev rug) complete', result.devRug);
    if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'dev-rug-done' } });

    if (absorbers.length === 0) {
      result.ok = true;
      log('no absorbers configured — choreography ends after dev rug', {});
      if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'done', completedAt: new Date().toISOString() } });
      return result;
    }

    // ── Phase 2: first absorber wave (parallel) ─────────────────────────────
    // Wait until launchSlot+absorberWaveDelayBlocks. If we're already past
    // (e.g. dev rug took a while because pool-init was slow), fire immediately.
    if (anchorSlot != null) {
      const target = anchorSlot + cfg.absorberWaveDelayBlocks;
      const w = await waitUntilSlot(connection, target, { timeoutMs: 15_000 });
      log('phase 2 slot wait complete', { target, ...w });
    }
    const waveSize = Math.min(cfg.absorberWaveSize, absorbers.length);
    const waveAbsorbers = absorbers.slice(0, waveSize);
    const dripAbsorbers = absorbers.slice(waveSize);

    log('phase 2 (absorber wave) starting', { waveSize });
    const waveResults = await Promise.allSettled(
      waveAbsorbers.map((a) => executeAbsorberBuy({
        absorberKp: a.keypair, mintPk, cfg, tag: `choreography:wave-${a.label}`,
      })),
    );
    waveResults.forEach((r, i) => {
      const a = waveAbsorbers[i];
      if (r.status === 'fulfilled') {
        result.absorberWave.push({ walletId: a.walletId, publicKey: a.publicKey, ...r.value });
      } else {
        result.absorberWave.push({ walletId: a.walletId, publicKey: a.publicKey, error: r.reason?.message || String(r.reason) });
      }
    });
    log('phase 2 (absorber wave) complete', { ok: result.absorberWave.filter((r) => !r.error).length, total: result.absorberWave.length });
    if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'wave-done' } });

    // ── Inline: stake the wave absorbers' bags ──────────────────────────────
    if (cfg.absorberAutoStakePct > 0) {
      for (const a of waveAbsorbers) {
        const waveResult = result.absorberWave.find((r) => r.walletId === a.walletId);
        if (!waveResult || waveResult.error) continue;
        try {
          // brief settle so the ATA reads non-zero before the stake_for tries
          await sleep(800);
          const stakeOut = await autoStakeAbsorber({
            connection, absorberKp: a.keypair, mintPk, programId,
            stakePct: cfg.absorberAutoStakePct, lockDays: cfg.absorberStakeLockDays,
            log,
          });
          result.absorberStakes.push({ walletId: a.walletId, publicKey: a.publicKey, ...stakeOut });
        } catch (e) {
          result.absorberStakes.push({ walletId: a.walletId, publicKey: a.publicKey, error: e.message });
          log('absorber stake failed (non-fatal)', { walletId: a.walletId, error: e.message });
        }
      }
      if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'wave-staked' } });
    }

    // ── Phase 3: drip (sequential, jittered) ────────────────────────────────
    if (dripAbsorbers.length > 0) {
      const dripDeadline = Date.now() + (cfg.dripWindowSec * 1000);
      log('phase 3 (drip) starting', { dripCount: dripAbsorbers.length, dripWindowSec: cfg.dripWindowSec });
      for (let i = 0; i < dripAbsorbers.length; i += 1) {
        const a = dripAbsorbers[i];
        // Sleep a jittered interval before each drip buy. If we've blown
        // past the drip window, send the rest back-to-back (still jittered
        // amount/slippage/priority fee).
        if (Date.now() < dripDeadline) {
          await sleep(Math.round(randIn(cfg.dripIntervalMinMs, cfg.dripIntervalMaxMs)));
        }
        try {
          const r = await executeAbsorberBuy({
            absorberKp: a.keypair, mintPk, cfg, tag: `choreography:drip-${a.label}`,
          });
          result.absorberDrip.push({ walletId: a.walletId, publicKey: a.publicKey, ...r });
          if (cfg.absorberAutoStakePct > 0) {
            try {
              await sleep(800);
              const stakeOut = await autoStakeAbsorber({
                connection, absorberKp: a.keypair, mintPk, programId,
                stakePct: cfg.absorberAutoStakePct, lockDays: cfg.absorberStakeLockDays,
                log,
              });
              result.absorberStakes.push({ walletId: a.walletId, publicKey: a.publicKey, ...stakeOut });
            } catch (e) {
              result.absorberStakes.push({ walletId: a.walletId, publicKey: a.publicKey, error: e.message });
            }
          }
        } catch (e) {
          result.absorberDrip.push({ walletId: a.walletId, publicKey: a.publicKey, error: e.message });
          log('drip buy failed (non-fatal)', { walletId: a.walletId, error: e.message });
        }
        if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: `drip-${i + 1}/${dripAbsorbers.length}` } });
      }
    }

    result.ok = true;
    result.completedAt = new Date().toISOString();
    if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'done' } });
    log('choreography complete', {
      snipeId, mint,
      devStake: result.devStake?.skipped ? 'skipped' : 'ok',
      devRug: result.devRug?.skipped ? 'skipped' : 'ok',
      waveOk: result.absorberWave.filter((r) => !r.error).length,
      dripOk: result.absorberDrip.filter((r) => !r.error).length,
      stakesOk: result.absorberStakes.filter((r) => !r.error && !r.skipped).length,
    });
    return result;
  } catch (e) {
    result.ok = false;
    result.error = e.message;
    result.failedAt = new Date().toISOString();
    if (snipeId) updateSnipe(snipeId, { choreography: { ...result, status: 'failed' } });
    log('choreography failed', { snipeId, mint, error: e.message });
    throw e;
  }
}

/**
 * Cheap quote — no on-chain calls, just resolves wallet metadata + computes
 * the expected SOL spend per absorber so the UI can show a pre-flight cost.
 */
export function quoteChoreography({ absorberWalletIds = [], config = {} }) {
  const cfg = { ...DEFAULT_CHOREOGRAPHY_CONFIG, ...config };
  const all = listWallets();
  const wmap = new Map(all.map((w) => [w.id, w]));
  const absorbers = absorberWalletIds.map((id) => wmap.get(id)).filter(Boolean);
  const eligible = absorbers.filter((w) => w.tier === 'absorber');
  const ineligible = absorbers.filter((w) => w.tier !== 'absorber');
  const avgBuy = (cfg.absorberBuyMinSol + cfg.absorberBuyMaxSol) / 2;
  const totalEstSpendSol = eligible.length * avgBuy;
  const waveSize = Math.min(cfg.absorberWaveSize, eligible.length);
  const dripCount = Math.max(0, eligible.length - waveSize);
  const waveDelaySec = (cfg.absorberWaveDelayBlocks || 0) * APPROX_SLOT_MS / 1000;
  return {
    cfg,
    absorberCount: eligible.length,
    waveSize,
    dripCount,
    avgBuySol: avgBuy,
    totalEstSpendSol,
    ineligible: ineligible.map((w) => ({ id: w.id, label: w.label, tier: w.tier || null })),
    devSellDelayBlocks: cfg.devSellDelayBlocks,
    absorberWaveDelayBlocks: cfg.absorberWaveDelayBlocks,
    devSellApproxMs: (cfg.devSellDelayBlocks || 0) * APPROX_SLOT_MS,
    absorberWaveApproxMs: (cfg.absorberWaveDelayBlocks || 0) * APPROX_SLOT_MS,
    expectedDurationSec: waveDelaySec + (dripCount > 0 ? cfg.dripWindowSec : 0),
  };
}
