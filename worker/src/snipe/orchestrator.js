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
async function preflight({ connection, devKeypair, devBuySol, jitoTipSol, snipers, sniperSolPerWallet }) {
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
async function postBundleSetup({ connection, devKeypair, mint, rewardMode, snipeId }) {
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
export async function quoteStealthLaunch({ devWalletId, sniperWalletIds, devBuySol, sniperSolPerWallet, jitoTipSol }) {
  const all = listWallets();
  const wmap = new Map(all.map((w) => [w.id, w]));
  const dev = wmap.get(devWalletId);
  if (!dev) throw new Error(`dev wallet not in vault: ${devWalletId}`);
  const snipers = (sniperWalletIds || []).map((id) => {
    const w = wmap.get(id);
    if (!w) throw new Error(`sniper wallet not in vault: ${id}`);
    return w;
  });
  const tip = jitoTipSol == null ? parseFloat(process.env.JITO_TIP_SOL || '0.001') : Number(jitoTipSol);
  const slotsForSnipers = MAX_BUNDLE_TXS - 1 - (devBuySol > 0 ? 1 : 0);
  const inBundleCount = Math.min(snipers.length, slotsForSnipers);
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
    metadata,
    fileBuffer = null,
    fileContentType = null,
    imageUrl = null,
    metadataUri: preMetadataUri = null,
    metadataImageUrl = null,
    initiatedBy = null,
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

  const tipSol = jitoTipSol == null
    ? parseFloat(process.env.JITO_TIP_SOL || '0.001')
    : Number(jitoTipSol);

  await preflight({
    connection,
    devKeypair,
    devBuySol: Number(devBuySol) || 0,
    jitoTipSol: tipSol,
    snipers: sniperKeypairs,
    sniperSolPerWallet: Number(sniperSolPerWallet) || 0,
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
    updateSnipe(snipeRow.id, { status: 'failed', statusError: `bundle: ${e.message}` });
    throw e;
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

  let lockFeesSig = null;
  let poolRewardSig = null;
  try {
    const post = await postBundleSetup({
      connection,
      devKeypair,
      mint: bundle.mint,
      rewardMode,
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
  };
}

/**
 * Convenience: ensure N ephemeral sniper wallets exist for a fresh launch.
 * Used by the admin UI's "generate new ephemeral wallets" button before the
 * launch happens, so the admin has time to fund them.
 */
export function ensureEphemeralWallets(count, { labelPrefix = 'ephemeral' } = {}) {
  const created = [];
  for (let i = 0; i < count; i += 1) {
    const w = generateWallet({
      label: `${labelPrefix}-${Date.now().toString(36)}-${i + 1}`,
      source: 'ephemeral',
      launchMint: null, // pinned later by stealthLaunch after bundle confirms
    });
    created.push(w);
  }
  return created;
}

export { DEV_POST_BUNDLE_OVERHEAD_SOL, SNIPER_GAS_RESERVE_SOL, MAX_BUNDLE_TXS };
