// Stakrr backend API. Exposes a tiny JSON surface for the frontend:
//
//   POST /api/launch/prepare          -> metadata + partial-signed Pump create tx
//                                        + unsigned pump_fees lock-fees tx
//                                        + unsigned pool init + reward tx
//                                        (all three intended for one
//                                         signAllTransactions Phantom prompt)
//   POST /api/launch/lock-fees-tx     -> standalone unsigned pump_fees lock tx
//                                        (used to retro-lock previously launched
//                                         tokens that skipped the fee lock)
//   POST /api/launch/pool-tx          -> standalone unsigned pool init + reward tx
//                                        (kept for parity / debugging)
//   POST /api/launch/auto-stake-tx    -> optional unsigned auto-stake tx (separate
//                                        prompt because the amount depends on the
//                                        actual ATA balance after the dev buy lands)
//   POST /api/launch/finalize         -> verify on-chain + registry (JSON)
//   GET  /api/tokens                  -> list active tokens (registry; preferred)
//   GET  /api/tokens/:mint            -> single token (registry)
//   GET  /api/tokens/:mint/public     -> merged registry + on-chain view (preferred)
//   GET  /api/pools                   -> legacy alias of /api/tokens (returns `pools`)
//   GET  /api/pools/:mint             -> legacy registry detail (`pool` key)
//   GET  /api/pools/:mint/public      -> legacy public payload (`pool` key)
//   GET  /api/wallet/:pubkey/summary  -> launched tokens + stake positions + activity
//   GET  /api/health                  -> simple liveness
//
// CORS-enabled because partners (and our own static frontend) read these.

import express from 'express';
import multer from 'multer';
import { PublicKey } from '@solana/web3.js';
import { config, authoritySigner, getConnection } from './config.js';
import { getPool, listPools } from './registry.js';
import { fetchPool, fetchRewardMint, fetchActivePositions, fetchStakersLeaderboard } from './stake-program.js';
import {
  prepareCreatorLaunch,
  buildLockFeesTxBase64,
  buildUnsignedPoolRewardTxBase64,
  buildCreatorAutoStakeTxBase64,
  finalizeCreatorLaunch,
  finalizeLockFeesOnly,
} from './launch.js';
import { buildWalletSummary } from './wallet-summary.js';
import { getVanityPoolStats } from './vanity-mints.js';
import { scanPresaleContributions } from './presale-scan.js';
import { buildPresaleAutoStakeBatches } from './presale-autostake.js';
import {
  vaultEnabled,
  vaultStats,
  listWalletsWithBalances,
  generateWallet as generateSnipeWallet,
  importWallet as importSnipeWallet,
  removeWallet as removeSnipeWallet,
  updateWallet as updateSnipeWallet,
  exportWalletSecret as exportSnipeWalletSecret,
  getWallet as getSnipeWallet,
} from './snipe/wallet-vault.js';
import { stealthLaunch, quoteStealthLaunch, ensureEphemeralWallets } from './snipe/orchestrator.js';
import {
  parseTextWalletList,
  normalizeJsonWalletList,
  fetchKolScanLeaderboard,
  listKolScanCategories,
} from './snipe/kol-list.js';
import { runKolAirdrop, previewKolAirdrop } from './snipe/kol-airdrop.js';
import { listSnipes, getSnipe, updateSnipe } from './snipe/snipe-store.js';
import {
  readSniperHoldings,
  sellSniperBag,
  buyMoreFromSniper,
  transferSniperTokens,
  sweepSniperSol,
  markSniperResolved,
} from './snipe/post-ops.js';

const app = express();
app.use(express.json({ limit: '32kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB image cap
});

/** When the browser pins metadata to Pump.fun first, it passes this + optional image URL. */
function validateExternalMetadataUri(raw) {
  const s = (raw || '').trim();
  if (!s) return null;
  if (s.length > 600) throw new Error('metadataUri too long');
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('invalid metadataUri');
  }
  if (u.protocol !== 'https:') throw new Error('metadataUri must use https');
  const h = u.hostname.toLowerCase();
  const blocked =
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h === '[::1]' ||
    h === '169.254.169.254' ||
    h.endsWith('.local');
  if (blocked) throw new Error('invalid metadataUri host');
  return s;
}

app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

/**
 * Public, read-only configuration surface for docs / status pages.
 *
 * Exposes the on-chain identifiers users need to verify Stakrr's
 * non-custodial claims for themselves (treasury wallet, stake program,
 * pump_fees program) plus the fee-economics parameters. We deliberately
 * avoid leaking anything secret.
 */
app.get('/api/info', (req, res) => {
  res.json({
    ok: true,
    network: 'mainnet-beta',
    programs: {
      stake: config.programId.toBase58(),
      pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
      pumpBondingCurve: '6EF8rrecthR5Dkzon8NwuZ78hRvfCKubJ14M5uBEwF6P',
    },
    treasury: config.treasuryKeypair.publicKey.toBase58(),
    feeRecipient: config.lockFees.recipient || config.treasuryKeypair.publicKey.toBase58(),
    platformFeeVault: config.platformFeeVault?.toBase58() || null,
    adminWallet: config.adminWallet?.toBase58() || null,
    adminWallets: config.adminWallets.map((p) => p.toBase58()),
    lockFeesEnabled: config.lockFees.enabled,
    platformFeeBps: config.platformFeeBps,
    minDistributeLamports: config.minDistributeLamports,
    loopIntervalMs: config.loopIntervalMs,
    repo: process.env.PUBLIC_REPO_URL || 'https://github.com/scufffd/stakrr',
  });
});

/**
 * Admin gate. Endpoints under /api/admin/* require:
 *   - ADMIN_WALLET configured on the server
 *   - x-admin-wallet header == ADMIN_WALLET pubkey (base58)
 *
 * The header is a soft gate — the actual on-chain authority is enforced by
 * Solana itself (the tx still needs the dev wallet's signature). The
 * header just stops random scrapers from hitting the prepare endpoint and
 * scanning for presale contributors via our infra.
 */
function requireAdmin(req, res, next) {
  if (config.adminWallets.length === 0) {
    return res.status(503).json({ ok: false, error: 'admin endpoints disabled (ADMIN_WALLET unset)' });
  }
  const header = (req.get('x-admin-wallet') || '').trim();
  const allowed = new Set(config.adminWallets.map((p) => p.toBase58()));
  if (!header || !allowed.has(header)) {
    return res.status(403).json({ ok: false, error: 'admin auth required' });
  }
  return next();
}

/**
 * Read-only: scan a presale wallet for inbound SOL transfers since a
 * cutoff signature (inclusive). Returns aggregated contributors sorted
 * by SOL contributed.
 *
 * Body:
 *   { presaleWallet, cutoffSignature, excludeWallets?: [pubkey] }
 */
app.post('/api/admin/presale/scan', requireAdmin, async (req, res) => {
  try {
    const { presaleWallet, cutoffSignature, excludeWallets, minTransferLamports } = req.body || {};
    if (!presaleWallet || !cutoffSignature) {
      return res.status(400).json({ ok: false, error: 'presaleWallet and cutoffSignature required' });
    }
    const result = await scanPresaleContributions({
      presaleWallet,
      cutoffSignature,
      excludeWallets: Array.isArray(excludeWallets) ? excludeWallets : [],
      ...(minTransferLamports != null && { minTransferLamports: BigInt(minTransferLamports) }),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Build unsigned stake_for + prime_checkpoint batches. The dev wallet
 * must sign each tx in the browser (signAllTransactions) — the server
 * never holds the dev key.
 *
 * Body:
 *   {
 *     mint,                  // launched stake mint
 *     devWallet,             // pubkey that owns the dev-buy tokens (== signer)
 *     presaleWallet,
 *     cutoffSignature,
 *     lockDays,              // 1 | 3 | 7 | 14 | 21 | 30
 *     tokenTotalRaw,         // raw token units (string) to distribute
 *     excludeWallets?: [pubkey],
 *   }
 */
app.post('/api/admin/presale/auto-stake-prepare', requireAdmin, async (req, res) => {
  try {
    const {
      mint,
      devWallet,
      presaleWallet,
      cutoffSignature,
      lockDays,
      tokenTotalRaw,
      excludeWallets,
      minTransferLamports,
    } = req.body || {};
    if (!mint || !devWallet || !presaleWallet || !cutoffSignature || !lockDays || !tokenTotalRaw) {
      return res.status(400).json({
        ok: false,
        error: 'mint, devWallet, presaleWallet, cutoffSignature, lockDays, tokenTotalRaw required',
      });
    }
    const result = await buildPresaleAutoStakeBatches({
      mint,
      devWallet,
      presaleWallet,
      cutoffSignature,
      lockDays,
      tokenTotalRaw,
      excludeWallets: Array.isArray(excludeWallets) ? excludeWallets : [],
      ...(minTransferLamports != null && { minTransferLamports: BigInt(minTransferLamports) }),
    });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Stealth-launch / sniper bundle (admin only) ────────────────────────────
//
// Endpoints under /api/admin/snipe/* manage the off-public-nav bundling tool:
//   - vault: list/generate/import/export/remove sniper keypairs (encrypted at rest)
//   - launch: build a Jito bundle (create + dev buy + N sniper buys) atomically,
//     then locally finish the lock-fees + pool-init txs and add to the public registry
//   - snipes: list past launches initiated via this tool
//   - ops: sell/buy/transfer/sweep on a per-sniper basis
//
// All endpoints require x-admin-wallet (same gate as /admin/presale) and
// rely on SNIPE_VAULT_KEY (32-byte hex) being set on the server. If the
// vault key is missing every endpoint returns 503 with a clear error.

function requireVault(req, res, next) {
  if (!vaultEnabled()) {
    return res.status(503).json({
      ok: false,
      error: 'sniper vault disabled — set SNIPE_VAULT_KEY (32 byte hex) in worker .env',
    });
  }
  return next();
}

app.get('/api/admin/snipe/info', requireAdmin, (req, res) => {
  try {
    res.json({
      ok: true,
      vault: vaultStats(),
      bundle: {
        maxBundleTxs: 5,
        defaultJitoTipSol: parseFloat(process.env.JITO_TIP_SOL || '0.001'),
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/snipe/wallets', requireAdmin, requireVault, async (req, res) => {
  try {
    const filter = {};
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.launchMint) filter.launchMint = String(req.query.launchMint);
    const wallets = await listWalletsWithBalances(filter);
    res.json({ ok: true, wallets });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/wallets/generate', requireAdmin, requireVault, (req, res) => {
  try {
    const body = req.body || {};
    const count = Math.max(1, Math.min(20, Number(body.count) || 1));
    const source = body.source === 'ephemeral' ? 'ephemeral' : 'pool';
    if (source === 'ephemeral') {
      const created = ensureEphemeralWallets(count, { labelPrefix: body.labelPrefix || 'ephemeral' });
      return res.json({ ok: true, created });
    }
    const created = [];
    for (let i = 0; i < count; i += 1) {
      created.push(generateSnipeWallet({
        label: body.label ? `${body.label}-${i + 1}` : undefined,
        source: 'pool',
        tags: Array.isArray(body.tags) ? body.tags : [],
      }));
    }
    res.json({ ok: true, created });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/wallets/import', requireAdmin, requireVault, (req, res) => {
  try {
    const body = req.body || {};
    if (!body.secretKey) return res.status(400).json({ ok: false, error: 'secretKey required (base58 or JSON byte array)' });
    const wallet = importSnipeWallet({
      secretKey: body.secretKey,
      label: body.label,
      source: body.source === 'ephemeral' ? 'ephemeral' : 'pool',
      tags: Array.isArray(body.tags) ? body.tags : [],
      launchMint: body.launchMint || null,
    });
    res.json({ ok: true, wallet });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.patch('/api/admin/snipe/wallets/:id', requireAdmin, requireVault, (req, res) => {
  try {
    const updated = updateSnipeWallet(req.params.id, req.body || {});
    if (!updated) return res.status(404).json({ ok: false, error: 'wallet not found' });
    res.json({ ok: true, wallet: updated });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/snipe/wallets/:id', requireAdmin, requireVault, async (req, res) => {
  try {
    const w = getSnipeWallet(req.params.id);
    if (!w) return res.status(404).json({ ok: false, error: 'wallet not found' });
    const force = req.query.force === '1' || req.query.force === 'true';
    // Safety: refuse to delete a wallet that still has SOL — admin should
    // sweep first so funds aren't accidentally orphaned.
    if (!force) {
      const bal = await getConnection().getBalance(new PublicKey(w.publicKey), 'confirmed');
      if (bal > 5_000) {
        return res.status(409).json({
          ok: false,
          error: `wallet still has ${bal} lamports — sweep first or pass ?force=1 to override`,
        });
      }
    }
    if (!removeSnipeWallet(req.params.id)) {
      return res.status(404).json({ ok: false, error: 'wallet not found' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// SECRET KEY EXPORT — requires both admin gate AND an extra confirmation
// header to defend against an accidental click in the UI exposing private
// material.
app.post('/api/admin/snipe/wallets/:id/export', requireAdmin, requireVault, (req, res) => {
  try {
    const confirm = req.get('x-export-confirm');
    if (confirm !== 'I-UNDERSTAND-EXPORTING-PRIVATE-KEYS') {
      return res.status(403).json({
        ok: false,
        error: 'set header x-export-confirm: I-UNDERSTAND-EXPORTING-PRIVATE-KEYS to retrieve secret',
      });
    }
    const out = exportSnipeWalletSecret(req.params.id, { confirm: true });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Stealth launch ───────────────────────────────────────────────────────────

app.post('/api/admin/snipe/quote', requireAdmin, requireVault, async (req, res) => {
  try {
    const body = req.body || {};
    const out = await quoteStealthLaunch({
      devWalletId: body.devWalletId,
      sniperWalletIds: Array.isArray(body.sniperWalletIds) ? body.sniperWalletIds : [],
      devBuySol: Number(body.devBuySol) || 0,
      sniperSolPerWallet: Number(body.sniperSolPerWallet) || 0,
      jitoTipSol: body.jitoTipSol == null ? null : Number(body.jitoTipSol),
    });
    res.json({ ok: true, quote: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/launch', requireAdmin, requireVault, upload.single('image'), async (req, res) => {
  try {
    const body = req.body || {};

    // multipart sends sniperWalletIds as a JSON-encoded string; raw JSON sends an array
    let sniperWalletIds = [];
    if (Array.isArray(body.sniperWalletIds)) {
      sniperWalletIds = body.sniperWalletIds;
    } else if (typeof body.sniperWalletIds === 'string' && body.sniperWalletIds.trim()) {
      try { sniperWalletIds = JSON.parse(body.sniperWalletIds); }
      catch { sniperWalletIds = body.sniperWalletIds.split(',').map((s) => s.trim()).filter(Boolean); }
    }

    let metadataUri = null;
    try { metadataUri = validateExternalMetadataUri(body.metadataUri); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }

    const metadata = {
      name: body.name?.trim(),
      symbol: body.symbol?.trim()?.toUpperCase(),
      description: body.description || '',
      twitter: body.twitter || undefined,
      telegram: body.telegram || undefined,
      website: body.website || undefined,
      image: body.metadataImageUrl || body.imageUrl || undefined,
    };
    if (!metadata.name || !metadata.symbol) {
      return res.status(400).json({ ok: false, error: 'name and symbol required' });
    }
    if (!body.devWalletId) {
      return res.status(400).json({ ok: false, error: 'devWalletId required' });
    }
    if (!metadataUri && !req.file?.buffer && !body.imageUrl) {
      return res.status(400).json({ ok: false, error: 'image (file or imageUrl) or metadataUri required' });
    }
    const initiatorPk = req.get('x-admin-wallet') || null;

    // Optional KOL airdrop config — wallets list comes JSON-encoded just like
    // sniperWalletIds since this is a multipart request. Empty / missing
    // means "no airdrop, just launch".
    let kolAirdrop = null;
    if (body.kolAirdrop) {
      let parsed = body.kolAirdrop;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(400).json({ ok: false, error: 'kolAirdrop must be valid JSON' }); }
      }
      if (parsed && Array.isArray(parsed.wallets) && parsed.wallets.length > 0) {
        kolAirdrop = {
          wallets: parsed.wallets,
          lockDays: Number(parsed.lockDays) || 7,
          tokenAllocationPct: parsed.tokenAllocationPct != null ? Number(parsed.tokenAllocationPct) : undefined,
          tokenAllocationRaw: parsed.tokenAllocationRaw || undefined,
        };
      }
    }

    const result = await stealthLaunch({
      devWalletId: body.devWalletId,
      sniperWalletIds,
      devBuySol: Number(body.devBuySol) || 0,
      sniperSolPerWallet: Number(body.sniperSolPerWallet) || 0,
      jitoTipSol: body.jitoTipSol == null ? null : Number(body.jitoTipSol),
      slippageBps: Number(body.slippageBps) || 5000,
      rewardMode: body.rewardMode === 'token' ? 'token' : 'sol',
      metadata,
      fileBuffer: req.file?.buffer || null,
      fileContentType: req.file?.mimetype || null,
      imageUrl: body.imageUrl || null,
      metadataUri: metadataUri || null,
      metadataImageUrl: body.metadataImageUrl || null,
      initiatedBy: initiatorPk,
      kolAirdrop,
    });
    res.json(result);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'snipe launch failed',
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 8),
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Snipes (past launches) ──────────────────────────────────────────────────

app.get('/api/admin/snipe/snipes', requireAdmin, (req, res) => {
  try {
    const status = req.query.status ? String(req.query.status) : null;
    res.json({ ok: true, snipes: listSnipes({ status }) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/snipe/snipes/:id', requireAdmin, (req, res) => {
  try {
    const snipe = getSnipe(req.params.id);
    if (!snipe) return res.status(404).json({ ok: false, error: 'snipe not found' });
    res.json({ ok: true, snipe });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Post-launch ops on individual sniper wallets ─────────────────────────────

app.post('/api/admin/snipe/holdings', requireAdmin, requireVault, async (req, res) => {
  try {
    const { walletId, mint } = req.body || {};
    if (!walletId) return res.status(400).json({ ok: false, error: 'walletId required' });
    const out = await readSniperHoldings({ walletId, mint });
    res.json({ ok: true, holdings: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/sell', requireAdmin, requireVault, async (req, res) => {
  try {
    const { walletId, mint, sellPct, slippage, pool, snipeId } = req.body || {};
    if (!walletId || !mint) return res.status(400).json({ ok: false, error: 'walletId and mint required' });
    const out = await sellSniperBag({
      walletId, mint,
      sellPct: sellPct == null ? 100 : Number(sellPct),
      slippage: slippage == null ? 10 : Number(slippage),
      pool: pool || 'auto',
    });
    if (snipeId) {
      try { markSniperResolved({ snipeId, walletId, action: 'sold' }); }
      catch { /* bookkeeping; non-fatal */ }
    }
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/buy', requireAdmin, requireVault, async (req, res) => {
  try {
    const { walletId, mint, solAmount, slippage, pool } = req.body || {};
    if (!walletId || !mint || !solAmount) {
      return res.status(400).json({ ok: false, error: 'walletId, mint, solAmount required' });
    }
    const out = await buyMoreFromSniper({
      walletId, mint,
      solAmount: Number(solAmount),
      slippage: slippage == null ? 10 : Number(slippage),
      pool: pool || 'auto',
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/transfer', requireAdmin, requireVault, async (req, res) => {
  try {
    const { walletId, mint, toAddress, amountRaw, snipeId } = req.body || {};
    if (!walletId || !mint || !toAddress || !amountRaw) {
      return res.status(400).json({ ok: false, error: 'walletId, mint, toAddress, amountRaw required' });
    }
    const out = await transferSniperTokens({ walletId, mint, toAddress, amountRaw });
    if (snipeId) {
      try { markSniperResolved({ snipeId, walletId, action: 'transferred' }); }
      catch { /* non-fatal */ }
    }
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/snipe/sweep', requireAdmin, requireVault, async (req, res) => {
  try {
    const { walletId, toAddress, leaveLamports, snipeId } = req.body || {};
    if (!walletId) return res.status(400).json({ ok: false, error: 'walletId required' });
    const out = await sweepSniperSol({
      walletId,
      toAddress: toAddress || null,
      leaveLamports: leaveLamports == null ? undefined : Number(leaveLamports),
    });
    if (snipeId) {
      try { markSniperResolved({ snipeId, walletId, action: 'swept' }); }
      catch { /* non-fatal */ }
    }
    res.json(out);
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── KOL airdrop list management ──────────────────────────────────────────────

/**
 * Parse a free-form text/CSV blob into a validated wallet list. Used by the
 * launch UI as the user pastes/uploads — gives them immediate feedback on
 * bad pubkeys before they hit launch.
 */
app.post('/api/admin/snipe/kol/parse', requireAdmin, (req, res) => {
  try {
    const { text, json } = req.body || {};
    let wallets;
    if (Array.isArray(json)) {
      wallets = normalizeJsonWalletList(json);
    } else if (typeof text === 'string') {
      wallets = parseTextWalletList(text);
    } else {
      return res.status(400).json({ ok: false, error: 'pass either { text } or { json: [...] }' });
    }
    res.json({ ok: true, wallets, count: wallets.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * KolScan-style leaderboard fetch. Returns `[{ wallet, label, weight }]`.
 * Cached server-side for 60s per category to avoid hammering kolscan when
 * the admin clicks "fetch" repeatedly. If kolscan changes their API the
 * helper throws with a clear message and the UI falls back to CSV/paste.
 */
app.get('/api/admin/snipe/kol/scan', requireAdmin, async (req, res) => {
  try {
    const category = String(req.query.category || 'pnl-7d');
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
    const force = req.query.force === '1' || req.query.force === 'true';
    const wallets = await fetchKolScanLeaderboard(category, { limit, force });
    res.json({ ok: true, category, wallets, count: wallets.length });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/snipe/kol/scan/categories', requireAdmin, (req, res) => {
  res.json({ ok: true, categories: listKolScanCategories() });
});

/**
 * Pre-flight preview for an airdrop config — shows allocation per wallet,
 * batch count, total tokens consumed. Cheap, no chain calls. Powers the
 * launch UI's "preview KOL airdrop" pane.
 */
app.post('/api/admin/snipe/kol/preview', requireAdmin, (req, res) => {
  try {
    const { wallets, tokenAllocationRaw, devBagRaw } = req.body || {};
    const out = previewKolAirdrop({
      wallets,
      tokenAllocationRaw,
      devBagRaw,
    });
    res.json({ ok: true, preview: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * Standalone retroactive airdrop on an already-launched token. Required for
 * the case where the dev did a normal launch and only later wants to
 * airdrop to KOLs from the same dev wallet's bag. Uses the vault keypair to
 * sign — same as the in-launch flow.
 */
app.post('/api/admin/snipe/kol/run', requireAdmin, requireVault, async (req, res) => {
  try {
    const { mint, devWalletId, wallets, lockDays, tokenAllocationPct, tokenAllocationRaw, snipeId } = req.body || {};
    if (!mint || !devWalletId || !Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ ok: false, error: 'mint, devWalletId, wallets[] required' });
    }
    const out = await runKolAirdrop({
      mint,
      devWalletId,
      wallets,
      lockDays: Number(lockDays) || 7,
      tokenAllocationPct: tokenAllocationPct != null ? Number(tokenAllocationPct) : undefined,
      tokenAllocationRaw,
      log: (msg, extra) => console.log(JSON.stringify({
        ts: new Date().toISOString(), tag: 'kol-airdrop', message: msg, snipeId: snipeId || null, ...extra,
      })),
    });
    if (snipeId) {
      try {
        const snipe = getSnipe(snipeId);
        if (snipe) {
          updateSnipe(snipeId, {
            kolAirdrop: out,
            kolAirdropRetroactiveAt: new Date().toISOString(),
          });
        }
      } catch { /* non-fatal */ }
    }
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Pre-ground vanity mint pool inventory. Read-only. Used by the launch UI
 * (badge "✦ vanity 'pump' mint" when stock available) and by ops dashboards.
 *
 * `?onchain=1` performs an on-chain check against the first 50 candidates
 * to refine `knownAvailable` / `knownUsed`. Off by default (cheap call).
 */
app.get('/api/vanity-pool/stats', async (req, res) => {
  try {
    const wantsOnchain = req.query.onchain === '1' || req.query.onchain === 'true';
    const conn = wantsOnchain ? getConnection() : null;
    const stats = await getVanityPoolStats(
      config.vanityMintPoolFile,
      config.vanityMintSuffix,
      conn,
      wantsOnchain ? 50 : 0,
    );
    res.json({ ok: true, ...stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/wallet/:pubkey/summary', async (req, res) => {
  try {
    const data = await buildWalletSummary(req.params.pubkey);
    res.json({ ok: true, ...data });
  } catch (e) {
    if (e.message === 'invalid wallet') {
      return res.status(400).json({ ok: false, error: e.message });
    }
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'wallet summary failed',
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

function listActiveRegistryRows() {
  return listPools({ status: 'active' }).map(stripPrivate);
}

app.get('/api/tokens', (req, res) => {
  res.json({ ok: true, tokens: listActiveRegistryRows() });
});

app.get('/api/pools', (req, res) => {
  res.json({ ok: true, pools: listActiveRegistryRows() });
});

app.get('/api/tokens/:mint', (req, res) => {
  const row = getPool(req.params.mint);
  if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, token: stripPrivate(row) });
});

app.get('/api/pools/:mint', (req, res) => {
  const pool = getPool(req.params.mint);
  if (!pool) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, pool: stripPrivate(pool) });
});

/** Registry row + on-chain staking stats for one mint (same shape for `pool` and `token` routes). */
async function buildPublicTokenView(mint) {
  const pool = getPool(mint);
  if (!pool) return null;
  const stakeMint = new PublicKey(pool.stakeMint);
  const connection = getConnection();
  const authority = authoritySigner();
  const onchain = await fetchPool({ connection, signer: authority, stakeMint });
  if (!onchain) {
    return { ...stripPrivate(pool), initialized: false };
  }
  const rewardMode = pool.rewardMode || 'sol';
  const rewardMintPk = rewardMode === 'token'
    ? stakeMint
    : new PublicKey(pool.rewardMint || config.wsolMint.toBase58());
  const reward = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint: rewardMintPk,
  });
  const positions = await fetchActivePositions({ connection, signer: authority, stakeMint });
  const uniqueStakers = new Set(positions.map((p) => p.account.owner.toBase58())).size;
  const rewardData = reward
    ? {
        accPerShare: reward.accPerShare?.toString?.() || '0',
        totalDeposited: reward.totalDeposited?.toString?.() || '0',
        totalClaimed: reward.totalClaimed?.toString?.() || '0',
        lastDepositTs: reward.lastDepositTs?.toString?.() || '0',
      }
    : null;
  return {
    ...stripPrivate(pool),
    initialized: true,
    rewardMode,
    rewardMint: rewardMintPk.toBase58(),
    totalStaked: onchain.totalStaked?.toString?.() || '0',
    totalEffective: onchain.totalEffective?.toString?.() || '0',
    rewardMintCount: onchain.rewardMintCount ?? null,
    rewardWsol: rewardMode === 'sol' ? rewardData : null,
    rewardToken: rewardMode === 'token' ? rewardData : null,
    activePositions: positions.length,
    uniqueStakers,
    claimProbe: {
      lastClaimedAt: pool.lastClaimedAt || null,
      lastClaimAttemptAt: pool.lastClaimAttemptAt || null,
      lastClaimAttemptReason: pool.lastClaimAttemptReason || null,
      lastClaimAttemptEstimate: pool.lastClaimAttemptEstimate || null,
    },
    snapshotAt: new Date().toISOString(),
  };
}

async function sendPublicTokenView(req, res, key) {
  try {
    const merged = await buildPublicTokenView(req.params.mint);
    if (!merged) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, [key]: merged });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'token public failed',
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
}

app.get('/api/tokens/:mint/public', (req, res, next) => {
  sendPublicTokenView(req, res, 'token').catch(next);
});
app.get('/api/pools/:mint/public', (req, res, next) => {
  sendPublicTokenView(req, res, 'pool').catch(next);
});

/**
 * Public stakers leaderboard for a single mint. Returns each active
 * position's owner, staked amount, lock duration, and lifetime fees earned
 * (claimed + currently-claimable). Used by the token detail page's
 * "Stakers" tab — same shape we'd want for csv exports later.
 */
app.get('/api/tokens/:mint/stakers', async (req, res) => {
  try {
    const pool = getPool(req.params.mint);
    if (!pool) return res.status(404).json({ ok: false, error: 'not_found' });
    const connection = getConnection();
    const stakeMint = new PublicKey(pool.stakeMint);
    const rewardMode = pool.rewardMode || 'sol';
    const rewardMintPk = rewardMode === 'token'
      ? stakeMint
      : new PublicKey(pool.rewardMint || config.wsolMint.toBase58());
    const data = await fetchStakersLeaderboard({
      connection,
      stakeMint,
      rewardMint: rewardMintPk,
    });
    res.json({
      ok: true,
      mint: pool.stakeMint,
      symbol: pool?.metadata?.symbol || pool?.symbol || null,
      rewardMode,
      ...data,
    });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'stakers leaderboard failed',
      mint: req.params.mint,
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Launch ----
//
// Body (multipart):
//   name, symbol, description, twitter?, telegram?, website?, initialBuySol?, …
//   image: file — required unless the client already pinned metadata:
//   metadataUri: https URL from pump.fun/api/ipfs (browser upload) or any https IPFS URL
//   metadataImageUrl: optional resolved image URL for the registry when skipping `image`
//
// Creator wallet pays all launch SOL; treasury is not charged. Flow: prepare →
// signAllTransactions(create + lock + pool) in one Phantom prompt → send each in
// order with confirm-between → optional auto-stake-tx (separate prompt) → finalize.
app.post('/api/launch/prepare', upload.single('image'), async (req, res) => {
  try {
    const body = req.body || {};
    let metadataUri;
    try {
      metadataUri = validateExternalMetadataUri(body.metadataUri);
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const metadataImageUrl = (body.metadataImageUrl || '').trim() || undefined;
    const metadata = {
      name: body.name?.trim(),
      symbol: body.symbol?.trim()?.toUpperCase(),
      description: body.description || '',
      twitter: body.twitter || undefined,
      telegram: body.telegram || undefined,
      website: body.website || undefined,
      image: metadataImageUrl || body.imageUrl || undefined,
    };
    if (!metadata.name || !metadata.symbol) {
      return res.status(400).json({ ok: false, error: 'name and symbol required' });
    }
    if (!body.creatorWallet?.trim()) {
      return res.status(400).json({ ok: false, error: 'creatorWallet required (connect wallet)' });
    }
    if (!metadataUri && !req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'Token image required (or pin metadata from the browser / pass metadataUri).',
      });
    }
    const rewardMode = body.rewardMode === 'token' ? 'token' : 'sol';
    const out = await prepareCreatorLaunch({
      metadata,
      uri: metadataUri || undefined,
      initialBuySol: Number(body.initialBuySol || 0),
      creatorWallet: body.creatorWallet.trim(),
      fileBuffer: req.file?.buffer || null,
      fileContentType: req.file?.mimetype || null,
      rewardMode,
    });
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch prepare failed',
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 8),
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Pump fee lock — runs after /api/launch/prepare's create tx is confirmed.
// Migrates BondingCurve.creator from the deployer to a FeeSharingConfig PDA so
// 100% of creator royalties route to PLATFORM_TREASURY (or LOCK_FEES_RECIPIENT).
// Disabled-by-config returns `{ ok: true, locked: false }` and the client skips.
app.post('/api/launch/lock-fees-tx', async (req, res) => {
  try {
    const { creatorWallet, mint } = req.body || {};
    if (!creatorWallet?.trim() || !mint?.trim()) {
      return res.status(400).json({ ok: false, error: 'creatorWallet and mint required' });
    }
    const out = await buildLockFeesTxBase64({
      creatorWallet: creatorWallet.trim(),
      mint: mint.trim(),
    });
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch lock-fees failed',
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/launch/pool-tx', async (req, res) => {
  try {
    const { creatorWallet, mint, rewardMode } = req.body || {};
    if (!creatorWallet?.trim() || !mint?.trim()) {
      return res.status(400).json({ ok: false, error: 'creatorWallet and mint required' });
    }
    const rm = rewardMode === 'token' ? 'token' : 'sol';
    const out = await buildUnsignedPoolRewardTxBase64({
      creatorWallet: creatorWallet.trim(),
      mint: mint.trim(),
      rewardMode: rm,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/launch/auto-stake-tx', async (req, res) => {
  try {
    const { creatorWallet, mint, rewardMode, lockDays, nonce } = req.body || {};
    if (!creatorWallet?.trim() || !mint?.trim() || nonce == null || nonce === '') {
      return res.status(400).json({ ok: false, error: 'creatorWallet, mint, and nonce required' });
    }
    const rm = rewardMode === 'token' ? 'token' : 'sol';
    const out = await buildCreatorAutoStakeTxBase64({
      creatorWallet: creatorWallet.trim(),
      mint: mint.trim(),
      rewardMode: rm,
      lockDays: Number(lockDays) || 7,
      nonce,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Retro-lock recovery: client signs+sends the lock-fees tx for an already-
// launched mint, then calls this to update the registry. Used for tokens
// launched before the pump_fees account-ordering fix shipped (e.g. IDK).
app.post('/api/launch/lock-fees-finalize', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.mint?.trim() || !b.creatorWallet?.trim() || !b.lockFeesSig?.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'mint, creatorWallet, lockFeesSig required',
      });
    }
    const out = await finalizeLockFeesOnly({
      mint: b.mint.trim(),
      creatorWallet: b.creatorWallet.trim(),
      lockFeesSig: b.lockFeesSig.trim(),
    });
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch lock-fees-finalize failed',
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/launch/finalize', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.createSig || !b.poolRewardSig || !b.mint || !b.creatorWallet?.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'createSig, poolRewardSig, mint, creatorWallet required',
      });
    }
    const out = await finalizeCreatorLaunch({
      createSig: b.createSig,
      lockFeesSig: b.lockFeesSig || null,
      poolRewardSig: b.poolRewardSig,
      autoStakeSig: b.autoStakeSig || null,
      mint: b.mint.trim(),
      creatorWallet: b.creatorWallet.trim(),
      rewardMode: b.rewardMode === 'token' ? 'token' : 'sol',
      persistedMetadata: b.persistedMetadata || {},
      metadataUri: b.metadataUri || null,
      metadataSource: b.metadataSource || 'caller',
      initialBuySol: Number(b.initialBuySol || 0),
      autoStake: !!(b.autoStake === true || b.autoStake === 'true' || b.autoStake === '1'),
      lockDays: Number(b.lockDays || 7),
    });
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch finalize failed',
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 8),
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

function stripPrivate(pool) {
  const { ...rest } = pool;
  return rest;
}

const port = config.port;
const host = config.listenHost;
app.listen(port, host, () => {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    message: 'stakrr-api listening',
    host,
    port,
    programId: config.programId.toBase58(),
    treasury: config.treasuryKeypair.publicKey.toBase58(),
    authority: authoritySigner().publicKey.toBase58(),
    platformFeeBps: config.platformFeeBps,
  }));
});
