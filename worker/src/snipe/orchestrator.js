// Stealth-launch orchestrator (admin-only).
//
// Wires together:
//   1. Pre-flight balance checks (dev wallet has enough for create+fees+post-bundle txs;
//      each sniper has enough for their buy+gas).
//   2. Vanity mint reservation (pool, falling back to fresh keygen).
//   3. Metadata upload (pumpfun-ipfs / pinata).
//   4. Jito bundle (create + dev buy + N sniper buys, atomic).
//   5. Lock fees tx (signed locally by the deployer vault keypair).
//   6. Pool init + reward registration tx (also locally signed).
//   7. Optional overflow sniper buys (any beyond Jito's 5-slot bundle limit),
//      sent staggered after the bundle confirms.
//   8. Public registry insert via finalizeCreatorLaunch — same row shape that
//      a normal stakrr launch produces, so the token shows on the public site.
//   9. Snipe store row persistence so the admin UI can display + manage the bag
//      from each sniper wallet.

import { Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } from '@solana/web3.js';
import { config, getConnection } from '../config.js';
import { uploadMetadata } from '../pumpfun-ipfs.js';
import { popUnusedMintKeypairFromPool } from '../vanity-mints.js';
import {
  buildLockFeesTxBase64,
  buildUnsignedPoolRewardTxBase64,
  finalizeCreatorLaunch,
} from '../launch.js';
import { sendAndPollConfirm, signAndPollConfirm } from '../confirm.js';
import { buildBuyTokenTx } from '../pumpdev.js';
import { launchBundle, MAX_BUNDLE_TXS } from './jito-bundle.js';
import { getKeypairById, listWallets, generateWallet, updateWallet } from './wallet-vault.js';
import { createSnipe, updateSnipe, getSnipe } from './snipe-store.js';
import { runKolAirdrop, readDevTokenBalance } from './kol-airdrop.js';
import { runPresaleAutoStake } from './presale-airdrop.js';
import { upsertToken as upsertMmToken } from '../mm/store.js';
import { runDumpAndAbsorb, deriveLaunchSlot } from './choreography.js';

// Buffer: lock-fees + pool init + reward registration + 1 ATA rent + a small
// safety margin. Empirically ~0.045 SOL covers it; use 0.06 to be safe.
const DEV_POST_BUNDLE_OVERHEAD_SOL = 0.06;
// Sniper wallets only need enough for their snipe + 1 ATA rent + a tx fee or two.
const SNIPER_GAS_RESERVE_SOL = 0.01;

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), tag: 'snipe', message, ...extra }));
}

async function getSolBalance(connection, pubkey) {
  const lamports = await connection.getBalance(pubkey, 'confirmed');
  return { lamports, sol: lamports / LAMPORTS_PER_SOL };
}

/**
 * Pre-flight: ensure every wallet has enough SOL for what it's about to do.
 * Throws a single descriptive error listing all underfunded wallets.
 */
async function preflight({ connection, devKeypair, devBuySol, jitoTipSol, snipers, sniperSolPerWallet, mm = null }) {
  const issues = [];
  const devNeed = devBuySol + jitoTipSol + DEV_POST_BUNDLE_OVERHEAD_SOL;
  const devBal = await getSolBalance(connection, devKeypair.publicKey);
  if (devBal.sol < devNeed) {
    issues.push(
      `dev wallet ${devKeypair.publicKey.toBase58()} has ${devBal.sol.toFixed(4)} SOL, ` +
      `needs ≥ ${devNeed.toFixed(4)} SOL (devBuy ${devBuySol} + tip ${jitoTipSol} + ${DEV_POST_BUNDLE_OVERHEAD_SOL} overhead)`,
    );
  }
  const sniperNeed = sniperSolPerWallet + SNIPER_GAS_RESERVE_SOL;
  for (const s of snipers) {
    const bal = await getSolBalance(connection, s.keypair.publicKey);
    if (bal.sol < sniperNeed) {
      issues.push(
        `sniper ${s.label} (${s.keypair.publicKey.toBase58()}) has ${bal.sol.toFixed(4)} SOL, ` +
        `needs ≥ ${sniperNeed.toFixed(4)} SOL`,
      );
    }
  }
  if (mm) {
    // MM seed wallet needs its entry SOL + gas reserve (it'll keep cycling
    // post-launch so we leave the rest of the bankroll for the daemon).
    const mmNeed = (Number(mm.entrySol) || 0) + SNIPER_GAS_RESERVE_SOL;
    const bal = await getSolBalance(connection, mm.keypair.publicKey);
    if (bal.sol < mmNeed) {
      issues.push(
        `mm wallet (${mm.keypair.publicKey.toBase58()}) has ${bal.sol.toFixed(4)} SOL, ` +
        `needs ≥ ${mmNeed.toFixed(4)} SOL (entrySol ${mm.entrySol} + gas reserve)`,
      );
    }
  }
  if (issues.length > 0) {
    throw new Error(`pre-flight failed:\n  - ${issues.join('\n  - ')}`);
  }
}

/**
 * Resolve a vanity-mint keypair. Tries the on-disk vanity pool first
 * (so admin tools share the inventory the public launch flow uses),
 * falling back to in-memory generation otherwise.
 *
 * Note: pumpdev's create-bundle endpoint accepts the `mintKeypair` field so
 * we always pre-supply it — this lets us pre-publish the mint URL etc.
 */
async function resolveMintKeypair() {
  if (config.vanityMintPoolFile) {
    try {
      const connection = getConnection();
      const popped = await popUnusedMintKeypairFromPool(
        config.vanityMintPoolFile,
        config.vanityMintSuffix,
        connection,
        { perCallScan: 24 },
      );
      if (popped?.keypair) {
        return { keypair: popped.keypair, source: 'vanity-pool', suffix: config.vanityMintSuffix };
      }
    } catch (e) {
      log('vanity pool pop failed, generating fresh keypair', { error: e.message });
    }
  }
  return { keypair: Keypair.generate(), source: 'random' };
}

/**
 * Send the lock-fees + pool tx legs that follow the bundle. Each is
 * locally signed by the deployer vault keypair (no Phantom prompt).
 */
async function postBundleSetup({ connection, devKeypair, mint, rewardMode, rewardLines = null, snipeId }) {
  const out = { lockFeesSig: null, poolRewardSig: null };

  // 1. Lock fees (idempotent on the worker side; if already locked we get
  //    `{ ok: true, locked: false }` and skip).
  const lockOut = await buildLockFeesTxBase64({
    creatorWallet: devKeypair.publicKey.toBase58(),
    mint,
  });
  if (lockOut.locked && lockOut.lockFeesTxBase64) {
    const tx = Transaction.from(Buffer.from(lockOut.lockFeesTxBase64, 'base64'));
    out.lockFeesSig = await signAndPollConfirm(connection, tx, [devKeypair], {
      label: 'snipe:lock-fees',
      timeoutMs: 90_000,
    });
    log('lock-fees confirmed', { mint, sig: out.lockFeesSig });
    if (snipeId) updateSnipe(snipeId, { lockFeesSig: out.lockFeesSig });
  } else {
    log('lock-fees skipped', { mint, reason: lockOut.reason || 'unknown' });
  }

  // 2. Pool + reward registration.
  const poolOut = await buildUnsignedPoolRewardTxBase64({
    creatorWallet: devKeypair.publicKey.toBase58(),
    mint,
    rewardMode,
    rewardLines,
  });
  const poolTx = Transaction.from(Buffer.from(poolOut.poolRewardTxBase64, 'base64'));
  out.poolRewardSig = await signAndPollConfirm(connection, poolTx, [devKeypair], {
    label: 'snipe:pool-reward',
    timeoutMs: 90_000,
  });
  log('pool+reward confirmed', { mint, sig: out.poolRewardSig });
  if (snipeId) updateSnipe(snipeId, { poolRewardSig: out.poolRewardSig });

  return out;
}

/**
 * Send the overflow sniper buys (those that didn't fit in the Jito bundle).
 * These run staggered after the bundle confirms — they're not first-block but
 * they still get in within seconds.
 */
async function sendOverflowSnipes({
  connection, snipeId, mint, snipers, sniperSolPerWallet, slippageBps, staggerMs = 800,
}) {
  if (snipers.length === 0) return;
  log(`overflow snipers: sending ${snipers.length} staggered buys`, { mint });
  for (let i = 0; i < snipers.length; i += 1) {
    const s = snipers[i];
    if (i > 0 && staggerMs > 0) {
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    try {
      const tx = await buildBuyTokenTx({
        publicKey: s.keypair.publicKey.toBase58(),
        mint,
        solAmount: sniperSolPerWallet,
        slippage: Math.max(1, Math.min(99, Math.round(slippageBps / 100))),
        pool: 'pump',
      });
      tx.sign([s.keypair]);
      const sig = await sendAndPollConfirm(connection, tx, {
        label: `snipe:overflow-${i + 1}`,
        timeoutMs: 60_000,
      });
      log('overflow buy confirmed', { mint, wallet: s.keypair.publicKey.toBase58(), sig });
      updateSnipe(snipeId, {});
      // Mark in store
      const snipe = getSnipe(snipeId);
      if (snipe) {
        const idx = snipe.snipers.findIndex((w) => w.publicKey === s.keypair.publicKey.toBase58());
        if (idx >= 0) {
          snipe.snipers[idx] = {
            ...snipe.snipers[idx],
            buySig: sig,
            solSpent: sniperSolPerWallet,
            error: null,
          };
          updateSnipe(snipeId, { snipers: snipe.snipers });
        }
      }
    } catch (e) {
      log('overflow buy failed', { mint, wallet: s.keypair.publicKey.toBase58(), error: e.message });
      const snipe = getSnipe(snipeId);
      if (snipe) {
        const idx = snipe.snipers.findIndex((w) => w.publicKey === s.keypair.publicKey.toBase58());
        if (idx >= 0) {
          snipe.snipers[idx] = {
            ...snipe.snipers[idx],
            buySig: null,
            solSpent: 0,
            error: e.message,
          };
          updateSnipe(snipeId, { snipers: snipe.snipers });
        }
      }
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Cheap quote (no on-chain calls beyond getMultipleAccounts) — used by the UI
 * to preview "you'll need ~X SOL across these wallets" before submitting.
 */
export async function quoteStealthLaunch({ devWalletId, sniperWalletIds, devBuySol, sniperSolPerWallet, jitoTipSol, mm = null }) {
  const all = listWallets();
  const wmap = new Map(all.map((w) => [w.id, w]));
  const dev = wmap.get(devWalletId);
  if (!dev) throw new Error(`dev wallet not in vault: ${devWalletId}`);
  const snipers = (sniperWalletIds || []).map((id) => {
    const w = wmap.get(id);
    if (!w) throw new Error(`sniper wallet not in vault: ${id}`);
    return w;
  });
  const tip = jitoTipSol == null ? parseFloat(process.env.JITO_TIP_SOL || '0.005') : Number(jitoTipSol);
  const totalBuyerSlots = MAX_BUNDLE_TXS - 1 - (devBuySol > 0 ? 1 : 0);
  // MM seed (if present) takes a slot first; remaining go to snipers.
  let mmWallet = null;
  let mmInBundle = false;
  if (mm && mm.walletId) {
    mmWallet = wmap.get(mm.walletId);
    if (!mmWallet) throw new Error(`mm wallet not in vault: ${mm.walletId}`);
    mmInBundle = totalBuyerSlots > 0;
  }
  const sniperSlots = totalBuyerSlots - (mmInBundle ? 1 : 0);
  const inBundleCount = Math.min(snipers.length, sniperSlots);
  const overflowCount = snipers.length - inBundleCount;
  return {
    devWallet: dev,
    snipers,
    devBuySol: Number(devBuySol) || 0,
    sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
    jitoTipSol: tip,
    inBundleCount,
    overflowCount,
    estDevSpend: (Number(devBuySol) || 0) + tip + DEV_POST_BUNDLE_OVERHEAD_SOL,
    estSniperSpend: (Number(sniperSolPerWallet) || 0) + SNIPER_GAS_RESERVE_SOL,
    bundleCap: MAX_BUNDLE_TXS,
    mm: mmWallet ? {
      wallet: mmWallet,
      entrySol: Number(mm.entrySol) || 0,
      estSpend: (Number(mm.entrySol) || 0) + SNIPER_GAS_RESERVE_SOL,
      inBundle: mmInBundle,
    } : null,
  };
}

/**
 * One-shot stealth launch.
 *
 * @param {object} params
 * @param {string}  params.devWalletId       - vault id of the deployer/creator wallet
 * @param {string[]} params.sniperWalletIds  - vault ids of sniper wallets (any 'pool' or 'ephemeral')
 * @param {number}  params.devBuySol         - SOL for the deployer's first buy (0 = no dev buy)
 * @param {number}  params.sniperSolPerWallet - SOL per sniper wallet (uniform for v1)
 * @param {number}  [params.jitoTipSol]
 * @param {number}  [params.slippageBps=5000] - 50% default; safe for first-buy
 * @param {string}  [params.rewardMode='sol'] - 'sol' (wsol rewards) or 'token' (self-rewards)
 * @param {object}  params.metadata          - { name, symbol, description, twitter, telegram, website }
 * @param {Buffer|null} [params.fileBuffer]
 * @param {string|null} [params.fileContentType]
 * @param {string|null} [params.imageUrl]    - if no file, server fetches the image
 * @param {string|null} [params.metadataUri] - if pre-uploaded (browser pin), use directly
 * @param {string|null} [params.metadataImageUrl]
 */
export async function stealthLaunch(params) {
  const {
    devWalletId,
    sniperWalletIds = [],
    devBuySol = 0,
    sniperSolPerWallet = 0,
    jitoTipSol,
    slippageBps = 5000,
    rewardMode = 'sol',
    rewardLines = null,
    metadata,
    fileBuffer = null,
    fileContentType = null,
    imageUrl = null,
    metadataUri: preMetadataUri = null,
    metadataImageUrl = null,
    initiatedBy = null,
    // Optional MM seed: { walletId, entrySol, config? } — wallet buys at
    // creator price as part of the bundle, then the MM daemon picks the
    // mint up on its next tick (every ~10s) and starts cycling buys/sells.
    // The early-entry bag gives the strategy a real edge vs. starting cold.
    mm = null,
    // Optional choreography: { absorberWalletIds: [...], config: {...} }.
    // When present, runs the dev-rug + absorber-wall sequence after pool
    // init confirms. Failure here is non-fatal — admin can re-run from the
    // /api/admin/snipe/choreography/run endpoint.
    choreography = null,
  } = params;

  if (!devWalletId) throw new Error('devWalletId required');
  if (!metadata?.name || !metadata?.symbol) throw new Error('metadata.name and metadata.symbol required');
  if (sniperWalletIds.length > 0 && !(sniperSolPerWallet > 0)) {
    throw new Error('sniperSolPerWallet must be > 0 when sniperWalletIds given');
  }

  const connection = getConnection();
  const devKeypair = getKeypairById(devWalletId);
  const sniperKeypairs = sniperWalletIds.map((id) => ({
    walletId: id,
    keypair: getKeypairById(id),
    label: listWallets().find((w) => w.id === id)?.label || id,
  }));

  // Resolve MM seed wallet (if requested). It must be in the vault — same
  // requirement as snipers — so the worker can sign the bundle's buy tx.
  let mmCtx = null;
  if (mm && mm.walletId && Number(mm.entrySol) > 0) {
    mmCtx = {
      walletId: mm.walletId,
      entrySol: Number(mm.entrySol),
      config: mm.config || {},
      keypair: getKeypairById(mm.walletId),
      label: listWallets().find((w) => w.id === mm.walletId)?.label || mm.walletId,
    };
  }

  const tipSol = jitoTipSol == null
    ? parseFloat(process.env.JITO_TIP_SOL || '0.005')
    : Number(jitoTipSol);

  await preflight({
    connection,
    devKeypair,
    devBuySol: Number(devBuySol) || 0,
    jitoTipSol: tipSol,
    snipers: sniperKeypairs,
    sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
    mm: mmCtx,
  });

  // Reserve a vanity mint keypair (pump-suffix preferred).
  const { keypair: mintKeypair, source: mintSource } = await resolveMintKeypair();

  // Upload metadata (skip if caller already pinned).
  let metadataUri = preMetadataUri;
  let metadataSource = preMetadataUri ? 'caller' : null;
  let resolvedImageUrl = metadataImageUrl || null;
  if (!metadataUri) {
    const up = await uploadMetadata({
      name: metadata.name,
      symbol: metadata.symbol,
      description: metadata.description || '',
      twitter: metadata.twitter || undefined,
      telegram: metadata.telegram || undefined,
      website: metadata.website || `${config.publicBaseUrl}/token/${mintKeypair.publicKey.toBase58()}`,
      fileBuffer,
      fileContentType,
      imageUrl,
    });
    metadataUri = up.metadataUri;
    metadataSource = up.source;
    resolvedImageUrl = up.imageUri || resolvedImageUrl;
  }

  // Persist a draft snipe row right away — even if the bundle fails we want
  // the admin UI to see the attempt + (encrypted) wallet ids involved.
  const snipeRow = createSnipe({
    mint: mintKeypair.publicKey.toBase58(),
    name: metadata.name,
    symbol: metadata.symbol.toUpperCase(),
    devWalletId,
    devWallet: devKeypair.publicKey.toBase58(),
    metadataUri,
    metadataSource,
    metadataImageUrl: resolvedImageUrl,
    devBuySol: Number(devBuySol) || 0,
    sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
    jitoTipSol: tipSol,
    rewardMode,
    initiatedBy,
    snipers: sniperKeypairs.map((s) => ({
      walletId: s.walletId,
      publicKey: s.keypair.publicKey.toBase58(),
      kind: 'pending',
      solSpent: 0,
      buySig: null,
      error: null,
    })),
    status: 'pending',
    statusError: null,
  });

  let bundle;
  try {
    bundle = await launchBundle({
      devKeypair,
      mintKeypair,
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadataUri,
      devBuySol: Number(devBuySol) || 0,
      slippageBps,
      sniperKeypairs: sniperKeypairs.map((s) => s.keypair),
      sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
      extraBuyers: mmCtx ? [{ keypair: mmCtx.keypair, solAmount: mmCtx.entrySol }] : [],
      jitoTipSol: tipSol,
    });
    log('bundle confirmed', {
      snipeId: snipeRow.id,
      mint: bundle.mint,
      bundleId: bundle.bundleId,
      via: bundle.confirmation.via,
    });
  } catch (e) {
    // Bundle failure: the Jito bundle is atomic — if any tx fails, all revert.
    // No SOL has left dev or sniper wallets. We deliberately do NOT auto-sweep
    // anywhere here; the admin can decide what to do with the funded wallets
    // (re-attempt with a different mint, top-up more, or manually sweep later).
    //
    // Most common cause of "bundle confirmation timed out" with all three
    // pollers (jito/rpc/mint) timing out is an inadequate Jito tip — Jito
    // silently drops bundles below the current floor. Annotate the error
    // with that hint so the user knows what knob to turn.
    let hint = null;
    if (/bundle confirmation timed out/i.test(e.message) && tipSol < 0.005) {
      hint = `tip ${tipSol} SOL is below Jito's typical floor (0.001-0.005). Bumping to ≥0.005 SOL usually fixes "all 3 pollers timed out" errors.`;
    }
    const finalMsg = hint ? `${e.message}\n  hint: ${hint}` : e.message;
    updateSnipe(snipeRow.id, { status: 'failed', statusError: `bundle: ${finalMsg}` });
    throw new Error(finalMsg);
  }

  // Record per-sniper kind (in-bundle vs overflow) on the persisted snipe row.
  const inBundleSet = new Set(bundle.inBundleSnipers);
  const overflowList = [];
  const updatedSnipers = sniperKeypairs.map((s) => {
    const pk = s.keypair.publicKey.toBase58();
    const kind = inBundleSet.has(pk) ? 'in-bundle' : 'overflow';
    if (kind === 'overflow') overflowList.push(s);
    return {
      walletId: s.walletId,
      publicKey: pk,
      kind,
      solSpent: kind === 'in-bundle' ? Number(sniperSolPerWallet) || 0 : 0,
      buySig: null,
      error: null,
    };
  });
  updateSnipe(snipeRow.id, {
    status: 'bundle-ok',
    snipers: updatedSnipers,
    bundleId: bundle.bundleId,
    bundleEndpoint: bundle.bundleEndpoint,
    txSignatures: bundle.txSignatures,
    mintSource,
    confirmation: bundle.confirmation,
  });

  // Pin ephemeral sniper wallets to the launched mint so the UI groups them.
  for (const s of sniperKeypairs) {
    const w = listWallets().find((row) => row.id === s.walletId);
    if (w?.source === 'ephemeral' && !w.launchMint) {
      try { updateWallet(s.walletId, { launchMint: bundle.mint }); } catch { /* ignore */ }
    }
  }
  // Pin MM wallet too if it's ephemeral (so it shows under the mint in the
  // vault list rather than floating in the unassigned pool).
  if (mmCtx) {
    const w = listWallets().find((row) => row.id === mmCtx.walletId);
    if (w?.source === 'ephemeral' && !w.launchMint) {
      try { updateWallet(mmCtx.walletId, { launchMint: bundle.mint }); } catch { /* ignore */ }
    }
  }

  // ── PARALLEL launch tail ────────────────────────────────────────────────
  // Capture the slot the bundle landed in (derived from the confirmation
  // envelope when possible, fresh getSlot otherwise — that's a few slots
  // ahead of real launch but waitUntilSlot returns immediately when we're
  // already past the target, so it's safe).
  //
  // Then fire the choreography (dev rug + absorber wave + drip) IN PARALLEL
  // with postBundleSetup (lock-fees + pool-init). Without this parallelism
  // the dev rug couldn't possibly land in launchSlot+3 because pool-init
  // alone takes ~25 slots — choreography would always be 25+ blocks late.
  //
  // Dev wallet signs in both branches but each tx has its own blockhash, so
  // there's no nonce conflict. Lock-fees and pool-init don't touch the dev's
  // token bag, only the SOL balance + admin instructions.
  const launchSlot = await deriveLaunchSlot(connection, bundle.confirmation);
  log('launchSlot resolved', { snipeId: snipeRow.id, launchSlot });

  const wantsChoreography = !!(choreography && (
    choreography.absorberWalletIds?.length > 0
    || (choreography.config?.devSellPct ?? 100) > 0
  ));

  const choreographyPromise = wantsChoreography
    ? runDumpAndAbsorb({
        snipeId: snipeRow.id,
        mint: bundle.mint,
        devWalletId,
        absorberWalletIds: choreography.absorberWalletIds || [],
        filterTier: choreography.filterTier !== false,
        config: choreography.config || {},
        launchSlot,
      }).then((r) => {
        log('choreography complete', {
          snipeId: snipeRow.id,
          mint: bundle.mint,
          ok: r.ok,
          waveOk: r.absorberWave?.filter((x) => !x.error).length || 0,
          dripOk: r.absorberDrip?.filter((x) => !x.error).length || 0,
        });
        return r;
      }).catch((e) => {
        // Non-fatal — record on snipe row, return a failure stub.
        log('choreography failed (non-fatal)', { snipeId: snipeRow.id, error: e.message });
        const stub = { ok: false, error: e.message };
        try { updateSnipe(snipeRow.id, { choreography: stub }); } catch { /* ignore */ }
        return stub;
      })
    : Promise.resolve(null);

  let lockFeesSig = null;
  let poolRewardSig = null;
  try {
    const post = await postBundleSetup({
      connection,
      devKeypair,
      mint: bundle.mint,
      rewardMode,
      rewardLines,
      snipeId: snipeRow.id,
    });
    lockFeesSig = post.lockFeesSig;
    poolRewardSig = post.poolRewardSig;
    updateSnipe(snipeRow.id, { status: 'pool-ok' });
  } catch (e) {
    // Post-bundle failure (lock-fees or pool-init): the bundle already landed,
    // so the dev's tokens + each sniper's bag are sitting in their wallets.
    // We do NOT auto-sweep — the snipers keep their tokens AND any leftover
    // SOL. Admin can retry lock/pool manually or dispose via the Snipes tab.
    // Note: choreographyPromise may still be running — we let it complete in
    // the background since its early phases (dev rug, absorber wave) don't
    // depend on lock-fees/pool-init. We don't await it on this error path.
    updateSnipe(snipeRow.id, { status: 'failed', statusError: `post-bundle: ${e.message}` });
    throw e;
  }

  // Overflow snipers (any beyond bundle limit) — fire-and-forget, but await
  // here so the API response is complete by the time it returns.
  if (overflowList.length > 0) {
    await sendOverflowSnipes({
      connection,
      snipeId: snipeRow.id,
      mint: bundle.mint,
      snipers: overflowList,
      sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
      slippageBps,
    });
  }

  // Optional MM bootstrap — register this mint with the MM daemon so it
  // starts cycling buys/sells on the next 10s tick. The seed wallet's bag
  // (acquired in the create bundle at near-zero price) gives the strategy
  // a structural edge: every sell now realises real profit vs. spread.
  // We don't *spend* anything here — just persist the config & mark it
  // enabled. The daemon (stakrr-mm) takes over from here.
  let mmBootstrap = null;
  if (mmCtx) {
    try {
      const t = upsertMmToken({
        mint: bundle.mint,
        symbol: metadata.symbol.toUpperCase(),
        walletId: mmCtx.walletId,
        config: mmCtx.config,
        enabled: true,
      });
      mmBootstrap = {
        ok: true,
        walletId: mmCtx.walletId,
        wallet: mmCtx.keypair.publicKey.toBase58(),
        entrySol: mmCtx.entrySol,
        config: t.config,
      };
      updateSnipe(snipeRow.id, { mmBootstrap });
      log('mm bootstrap registered', { snipeId: snipeRow.id, mint: bundle.mint, walletId: mmCtx.walletId });
    } catch (e) {
      // Non-fatal — admin can configure the MM token by hand from /admin/mm.
      log('mm bootstrap failed (non-fatal)', { snipeId: snipeRow.id, error: e.message });
      mmBootstrap = { ok: false, error: e.message };
      updateSnipe(snipeRow.id, { mmBootstrap });
    }
  }

  // ── Optional KOL airdrop + presale auto-stake ─────────────────────────
  //
  // Both run AFTER pool init confirms so the on-chain pool exists. To keep
  // the carve deterministic (and avoid an ATA re-read race between steps)
  // we snapshot the dev-buy bag ONCE, compute KOL + presale shares from
  // the same number, then fire each runner with its pre-allocated raw
  // amount. KOL gets % off the top, presale gets the remainder pro-rata
  // to SOL contributed.
  //
  // Either step is optional; the snapshot is only taken if at least one
  // is enabled (avoids a needless RPC for plain "snipe-only" launches).
  // Both steps are non-fatal — a failure here logs + persists the error
  // but doesn't roll back the launch, since the on-chain mint + pool are
  // already live and the admin can retry via the standalone runners.

  const kolEnabled = !!(
    params.kolAirdrop
    && Array.isArray(params.kolAirdrop.wallets)
    && params.kolAirdrop.wallets.length > 0
  );
  const presaleEnabled = !!(
    params.presale
    && params.presale.presaleWallet
    && params.presale.cutoffSignature
  );

  let kolResult = null;
  let presaleResult = null;
  let bagCarve = null;

  if (kolEnabled || presaleEnabled) {
    try {
      const connection = getConnection();
      const stakeMintPk = new PublicKey(bundle.mint);
      const devPk = devKeypair.publicKey;
      const bag = await readDevTokenBalance({ connection, devPubkey: devPk, mintPk: stakeMintPk });
      const bagRaw = BigInt(bag.amountRaw);
      if (bagRaw <= 0n) {
        throw new Error(
          `dev wallet ${devPk.toBase58()} has 0 tokens of ${bundle.mint} — bundle may not have propagated yet`,
        );
      }

      // KOL carve: percent-of-bag off the top. tokenAllocationRaw, if the
      // caller supplied it, wins over the pct (lets the admin pin an exact
      // raw amount for testing). Both = 0 → no KOL carve, presale gets the
      // whole bag.
      let kolRaw = 0n;
      if (kolEnabled) {
        if (params.kolAirdrop.tokenAllocationRaw != null) {
          kolRaw = BigInt(params.kolAirdrop.tokenAllocationRaw);
          if (kolRaw > bagRaw) kolRaw = bagRaw;
        } else {
          const pct = Math.max(0, Math.min(100, Number(params.kolAirdrop.tokenAllocationPct ?? 25)));
          kolRaw = (bagRaw * BigInt(pct)) / 100n;
        }
      }
      const presaleRaw = bagRaw - kolRaw;

      bagCarve = {
        bagRaw: bagRaw.toString(),
        kolRaw: kolRaw.toString(),
        presaleRaw: presaleRaw.toString(),
      };
      log('bag carve computed', {
        snipeId: snipeRow.id,
        mint: bundle.mint,
        bagRaw: bagCarve.bagRaw,
        kolRaw: bagCarve.kolRaw,
        presaleRaw: bagCarve.presaleRaw,
      });
      updateSnipe(snipeRow.id, { bagCarve });

      // ── KOL airdrop ───────────────────────────────────────────────────
      if (kolEnabled && kolRaw > 0n) {
        try {
          const kolMode = params.kolAirdrop.mode || 'push';
          const kolEqualSplit = params.kolAirdrop.equalSplit !== false;
          log('kol airdrop starting', {
            snipeId: snipeRow.id,
            mint: bundle.mint,
            walletCount: params.kolAirdrop.wallets.length,
            lockDays: params.kolAirdrop.lockDays,
            allocationPct: params.kolAirdrop.tokenAllocationPct,
            allocationRaw: kolRaw.toString(),
            mode: kolMode,
            equalSplit: kolEqualSplit,
            claimWindowDays: params.kolAirdrop.claimWindowDays,
          });
          kolResult = await runKolAirdrop({
            mint: bundle.mint,
            symbol: metadata.symbol,
            devWalletId,
            wallets: params.kolAirdrop.wallets,
            lockDays: params.kolAirdrop.lockDays || 30,
            // Always pin the pre-computed raw amount so the carve maths
            // line up with what we just wrote to bagCarve. The pct is
            // only used as a fallback when the orchestrator wasn't run
            // (i.e. someone hits /api/admin/snipe/kol/run directly).
            tokenAllocationRaw: kolRaw.toString(),
            mode: kolMode,
            equalSplit: kolEqualSplit,
            claimWindowDays: params.kolAirdrop.claimWindowDays || 30,
            excludeWallets: Array.isArray(params.kolAirdrop.excludeWallets) ? params.kolAirdrop.excludeWallets : [],
            // v4 per-position early-unstake penalty override (0..9000). Strong
            // anti-dump knob for KOLs whose tokens were free — typical config
            // is 5000-9000 bps. 0 means "use the pool default of 10%".
            earlyUnstakeBps: Number(params.kolAirdrop.earlyUnstakeBps || 0),
            launchSnipeId: snipeRow.id,
            log: (msg, extra) => log(`kol-airdrop: ${msg}`, { snipeId: snipeRow.id, ...extra }),
          });
          updateSnipe(snipeRow.id, { kolAirdrop: kolResult });
          log('kol airdrop complete', {
            snipeId: snipeRow.id,
            mint: bundle.mint,
            ok: kolResult.ok,
            mode: kolResult.mode,
            batches: kolResult.totals.batchCount,
            wallets: kolResult.totals.walletCount,
            pendingClaims: kolResult.pendingClaims?.length || 0,
          });
        } catch (e) {
          log('kol airdrop failed (non-fatal)', { snipeId: snipeRow.id, error: e.message });
          updateSnipe(snipeRow.id, { kolAirdrop: { ok: false, error: e.message } });
        }
      }

      // ── Presale auto-stake ────────────────────────────────────────────
      // Runs after KOL so any KOL transfers have already left the dev's
      // ATA. We pre-computed presaleRaw against the snapshot, but we
      // never want to attempt to stake more than the dev currently holds
      // (e.g. if a lingering manual transfer drained part of the bag);
      // re-cap against the live balance just before submitting.
      if (presaleEnabled && presaleRaw > 0n) {
        try {
          const presaleNow = await readDevTokenBalance({
            connection,
            devPubkey: devPk,
            mintPk: stakeMintPk,
          });
          let usableRaw = presaleRaw;
          const liveRaw = BigInt(presaleNow.amountRaw);
          if (liveRaw < usableRaw) {
            log('presale-autostake: capped to live balance', {
              snipeId: snipeRow.id,
              wantedRaw: usableRaw.toString(),
              liveRaw: liveRaw.toString(),
            });
            usableRaw = liveRaw;
          }
          if (usableRaw <= 0n) {
            log('presale-autostake skipped (live bag empty)', { snipeId: snipeRow.id });
            presaleResult = { ok: true, skipped: 'empty_after_kol', mode: 'push', totals: {} };
          } else {
            log('presale auto-stake starting', {
              snipeId: snipeRow.id,
              mint: bundle.mint,
              presaleWallet: params.presale.presaleWallet,
              cutoffSignature: params.presale.cutoffSignature,
              tokenTotalRaw: usableRaw.toString(),
              lockDays: params.presale.lockDays,
            });
            presaleResult = await runPresaleAutoStake({
              mint: bundle.mint,
              devWalletId,
              presaleWallet: params.presale.presaleWallet,
              cutoffSignature: params.presale.cutoffSignature,
              lockDays: params.presale.lockDays || 7,
              tokenTotalRaw: usableRaw.toString(),
              excludeWallets: Array.isArray(params.presale.excludeWallets) ? params.presale.excludeWallets : [],
              minTransferLamports: params.presale.minTransferLamports || 10_000_000n,
              earlyUnstakeBps: Number(params.presale.earlyUnstakeBps || 0),
              log: (msg, extra) => log(`presale-autostake: ${msg}`, { snipeId: snipeRow.id, ...extra }),
            });
            updateSnipe(snipeRow.id, { presaleAirdrop: presaleResult });
            log('presale auto-stake complete', {
              snipeId: snipeRow.id,
              mint: bundle.mint,
              ok: presaleResult.ok,
              skipped: presaleResult.skipped || null,
              contributors: presaleResult.totals?.contributorCount || 0,
              batches: presaleResult.totals?.batchCount || 0,
              sentBatches: presaleResult.totals?.sentCount || 0,
            });
          }
        } catch (e) {
          log('presale auto-stake failed (non-fatal)', { snipeId: snipeRow.id, error: e.message });
          presaleResult = { ok: false, error: e.message };
          updateSnipe(snipeRow.id, { presaleAirdrop: presaleResult });
        }
      }
    } catch (e) {
      // Snapshot-level failure (couldn't read the dev bag at all). Still
      // non-fatal — the on-chain launch already succeeded.
      log('bag carve failed (non-fatal)', { snipeId: snipeRow.id, error: e.message });
    }
  }

  // Add to public registry via the existing finalize path so the new mint
  // shows up on /token/<mint>, in /api/tokens, etc.
  let finalizeOut = null;
  try {
    finalizeOut = await finalizeCreatorLaunch({
      createSig: bundle.txSignatures[0],
      lockFeesSig,
      poolRewardSig,
      autoStakeSig: null,
      mint: bundle.mint,
      creatorWallet: devKeypair.publicKey.toBase58(),
      rewardMode,
      rewardLines,
      persistedMetadata: {
        name: metadata.name,
        symbol: metadata.symbol.toUpperCase(),
        description: metadata.description || '',
        image: resolvedImageUrl || metadata.image || null,
        twitter: metadata.twitter || null,
        telegram: metadata.telegram || null,
        website: metadata.website || null,
      },
      metadataUri,
      metadataSource: metadataSource || 'snipe',
      initialBuySol: Number(devBuySol) || 0,
      autoStake: false,
      lockDays: 7,
    });
    updateSnipe(snipeRow.id, {
      status: 'finalized',
      finalizedAt: new Date().toISOString(),
      registry: finalizeOut?.pool ? { added: true } : { added: false },
    });
  } catch (e) {
    // Registry insertion is best-effort — the on-chain state is already correct.
    log('finalize failed (non-fatal)', { snipeId: snipeRow.id, mint: bundle.mint, error: e.message });
    updateSnipe(snipeRow.id, {
      status: 'pool-ok',
      statusError: `finalize: ${e.message}`,
    });
  }

  // Choreography runs in the background — we DON'T await it for the
  // response. The launch is functionally complete once finalize succeeds
  // (mint exists, bag is in dev wallet, pool is live, public registry has
  // the row). The drip window can take 30s+ which would push the total
  // request past nginx's proxy_read_timeout and give the user a 504 even
  // though everything succeeded on-chain. UI polls /api/admin/snipe/:id
  // to render live choreography status (updated via updateSnipe inside
  // runDumpAndAbsorb every phase transition).
  //
  // If choreography finished fast (no absorbers, no drip), we include the
  // result for free — Promise.race wins immediately.
  let choreographyResult = null;
  if (wantsChoreography) {
    try {
      choreographyResult = await Promise.race([
        choreographyPromise,
        new Promise((resolve) => setTimeout(() => resolve({ ok: null, status: 'running-in-background', message: 'choreography continues in background; poll /api/admin/snipe/:id for live status' }), 1500)),
      ]);
    } catch { /* swallow — choreographyPromise has its own .catch */ }
  }

  return {
    ok: true,
    snipeId: snipeRow.id,
    mint: bundle.mint,
    bundleId: bundle.bundleId,
    bundleEndpoint: bundle.bundleEndpoint,
    txSignatures: bundle.txSignatures,
    lockFeesSig,
    poolRewardSig,
    inBundleSnipers: bundle.inBundleSnipers,
    overflowSnipers: bundle.overflowSnipers,
    metadataUri,
    metadataSource,
    metadataImageUrl: resolvedImageUrl,
    finalize: finalizeOut,
    kolAirdrop: kolResult,
    presaleAirdrop: presaleResult,
    bagCarve,
    mmBootstrap,
    choreography: choreographyResult,
  };
}

/**
 * Convenience: ensure N ephemeral sniper wallets exist for a fresh launch.
 * Used by the admin UI's "generate new ephemeral wallets" button before the
 * launch happens, so the admin has time to fund them.
 */
export function ensureEphemeralWallets(count, { labelPrefix = 'ephemeral', tier = null } = {}) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const w = generateWallet({
      label: `${labelPrefix}-${Date.now().toString(36)}-${i + 1}`,
      source: 'ephemeral',
      launchMint: null, // pinned later by stealthLaunch after bundle confirms
      tier,
    });
    created.push(w);
  }
  return created;
}

export { DEV_POST_BUNDLE_OVERHEAD_SOL, SNIPER_GAS_RESERVE_SOL, MAX_BUNDLE_TXS };
