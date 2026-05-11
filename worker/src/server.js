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
import { runPoolCycle } from './claim-and-distribute.js';
import { validateAndNormaliseRewardLines } from './reward-lines.js';
import { probeRoute as probeJupiterRoute } from './jupiter.js';
import { getUserPrefs, setUserPrefs } from './user-prefs.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { fetchPool, fetchRewardMint, fetchActivePositions, fetchStakersLeaderboard } from './stake-program.js';
import {
  prepareCreatorLaunch,
  buildLockFeesTxBase64,
  buildUnsignedPoolRewardTxBase64,
  buildCreatorAutoStakeTxBase64,
  finalizeCreatorLaunch,
  finalizeLockFeesOnly,
  recoverFinalizeLaunch,
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
import {
  getClaimById,
  listActivePendingForWallet,
  listClaimsForWallet,
  listAllClaims,
  sweepExpiredClaims,
  summariseClaimsForMint,
  updateClaim,
} from './kol-claims.js';
import {
  detectTokenProgram,
  primeCheckpointIx,
  setPositionEarlyUnstakeBpsIx,
  stakeForIx,
} from './stake-program.js';
import { signAndPollConfirm } from './confirm.js';
import { getKeypairById } from './snipe/wallet-vault.js';
import { ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import BN from 'bn.js';
import { runDumpAndAbsorb, quoteChoreography, DEFAULT_CHOREOGRAPHY_CONFIG } from './snipe/choreography.js';
import {
  listTokens as listMmTokens,
  getTokenInternal as getMmTokenInternal,
  upsertToken as upsertMmToken,
  pauseToken as pauseMmToken,
  resumeToken as resumeMmToken,
  deleteToken as deleteMmToken,
  DEFAULT_CONFIG as MM_DEFAULT_CONFIG,
} from './mm/store.js';
import { strategyStep as mmStrategyStep, scheduleNext as mmScheduleNext } from './mm/strategy.js';
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

/**
 * Parse + validate the optional `rewardLines` field from a launch request
 * body. Accepts either a parsed array (JSON body) or a JSON string
 * (multipart form-data). Returns `null` when the field is missing/empty —
 * the caller then falls back to the legacy `rewardMode` single-line behaviour.
 *
 * Throws a 400-friendly error message on bad shape or invalid content. The
 * error message is surfaced verbatim to the client so they can fix their
 * input.
 */
function parseRewardLinesFromBody(body, { stakeMint } = {}) {
  if (!body) return null;
  let raw = body.rewardLines;
  if (raw == null || raw === '') return null;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { throw new Error('rewardLines: invalid JSON'); }
  }
  if (!Array.isArray(raw)) throw new Error('rewardLines: must be an array');
  return validateAndNormaliseRewardLines(raw, { stakeMint });
}

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
 * GET /api/user-prefs/:wallet
 *
 * Public, read-only. Returns the saved preferences for a wallet, or null
 * fields when none exist yet (the frontend should treat null `autoPush` as
 * "auto-push enabled" — that's the resolver default in user-prefs.js).
 */
app.get('/api/user-prefs/:wallet', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
    try { new PublicKey(wallet); }
    catch { return res.status(400).json({ ok: false, error: 'invalid wallet pubkey' }); }
    const prefs = getUserPrefs(wallet);
    res.json({
      ok: true,
      wallet,
      prefs: prefs || null,
      // Resolver default — keeps the frontend from having to know the rule.
      effectiveAutoPush: prefs ? (prefs.autoPush !== false) : true,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/user-prefs/:wallet
 *
 * Update preferences. Authenticated by a fresh ed25519 signature from the
 * wallet's keypair over a canonical message:
 *   `stakrr-prefs:<wallet>:<signedAt>`
 * `signedAt` (ISO timestamp) must be within ±5 minutes of the server clock
 * to prevent replay. The frontend produces the signature via
 * `wallet.signMessage(...)` from solana-wallet-adapter.
 *
 * Body:
 *   {
 *     autoPush: boolean,   // the only mutable pref today
 *     signedAt: string,    // ISO-8601 (server side: ±300s window)
 *     signature: string,   // base58-encoded 64-byte ed25519 sig
 *   }
 */
app.post('/api/user-prefs/:wallet', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
    let walletPk;
    try { walletPk = new PublicKey(wallet); }
    catch { return res.status(400).json({ ok: false, error: 'invalid wallet pubkey' }); }

    const { autoPush, signedAt, signature } = req.body || {};
    if (typeof autoPush !== 'boolean') {
      return res.status(400).json({ ok: false, error: 'autoPush must be boolean' });
    }
    if (!signedAt || !signature) {
      return res.status(400).json({ ok: false, error: 'signedAt + signature required' });
    }
    const ts = Date.parse(signedAt);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'signedAt outside ±5 minute window' });
    }
    const message = `stakrr-prefs:${wallet}:${signedAt}`;
    let sigBytes;
    try { sigBytes = bs58.decode(signature); }
    catch { return res.status(400).json({ ok: false, error: 'signature is not base58' }); }
    if (sigBytes.length !== 64) {
      return res.status(400).json({ ok: false, error: 'signature must be 64 bytes' });
    }
    const ok = nacl.sign.detached.verify(
      Buffer.from(message, 'utf8'),
      sigBytes,
      walletPk.toBytes(),
    );
    if (!ok) return res.status(403).json({ ok: false, error: 'signature does not match wallet' });

    const updated = setUserPrefs(wallet, {
      autoPush,
      autoPushSource: 'user_set',
    });
    res.json({ ok: true, wallet, prefs: updated, effectiveAutoPush: updated.autoPush !== false });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── KOL claim endpoints ────────────────────────────────────────────────────
//
// Pending KOL claims are earmarked allocations of the dev-buy bag created
// during a launch. The KOL has `claimWindowDays` (default 30) to accept
// their slice by signing a message; on accept the worker materialises an
// on-chain stake_for position from the dev wallet's vault keypair (so the
// KOL never has to touch Solana — they just sign one offline message).
//
// Public read endpoints:
//   GET  /api/kol-claims/:wallet           — list active pending for wallet
//   GET  /api/kol-claims/:wallet/all       — full history (incl claimed/expired)
//   POST /api/kol-claims/:claimId/accept   — KOL signs to materialise position
//
// Public read for token disclosure:
//   GET  /api/kol-claims/mint/:mint/summary  — counts + totals for token page
//
// Admin endpoints (gated below):
//   GET  /api/admin/kol-claims             — list all (optional filters)
//   POST /api/admin/kol-claims/sweep       — manual run of expired-sweep cron
//   POST /api/admin/kol-claims/:id/revoke  — admin force-revoke a pending claim

app.get('/api/kol-claims/:wallet', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
    try { new PublicKey(wallet); }
    catch { return res.status(400).json({ ok: false, error: 'invalid wallet pubkey' }); }
    const rows = listActivePendingForWallet(wallet);
    res.json({ ok: true, wallet, claims: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/kol-claims/:wallet/all', (req, res) => {
  try {
    const wallet = String(req.params.wallet || '').trim();
    if (!wallet) return res.status(400).json({ ok: false, error: 'wallet required' });
    try { new PublicKey(wallet); }
    catch { return res.status(400).json({ ok: false, error: 'invalid wallet pubkey' }); }
    res.json({ ok: true, wallet, claims: listClaimsForWallet(wallet) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/kol-claims/mint/:mint/summary', (req, res) => {
  try {
    const mint = String(req.params.mint || '').trim();
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    try { new PublicKey(mint); }
    catch { return res.status(400).json({ ok: false, error: 'invalid mint pubkey' }); }
    const summary = summariseClaimsForMint(mint);
    res.json({ ok: true, summary: summary || { mint, total: 0 } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * POST /api/kol-claims/:claimId/accept
 *
 * The KOL signs a canonical message:
 *   stakrr-kol-accept:<claimId>:<signedAt>
 *
 * with the WALLET that the claim is bound to. Server verifies the ed25519
 * signature, then builds + signs + sends a stake_for(beneficiary=KOL) tx
 * paid by the dev wallet's vault keypair stored alongside the claim. On
 * confirmation the claim is moved to `status: 'claimed'`.
 *
 * Body:
 *   { signedAt: ISO, signature: base58-64-bytes }
 *
 * Idempotent — calling twice on a claimed claim returns the existing
 * txSig + position without sending a new tx.
 */
app.post('/api/kol-claims/:claimId/accept', async (req, res) => {
  try {
    const claimId = String(req.params.claimId || '').trim();
    if (!claimId) return res.status(400).json({ ok: false, error: 'claimId required' });
    const claim = getClaimById(claimId);
    if (!claim) return res.status(404).json({ ok: false, error: 'no such claim' });
    if (claim.status === 'claimed') {
      return res.json({ ok: true, claim, alreadyClaimed: true });
    }
    if (claim.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `claim is ${claim.status}, not acceptable` });
    }
    if (new Date(claim.expiresAt).getTime() < Date.now()) {
      return res.status(410).json({ ok: false, error: 'claim window has expired' });
    }

    const { signedAt, signature } = req.body || {};
    if (!signedAt || !signature) {
      return res.status(400).json({ ok: false, error: 'signedAt + signature required' });
    }
    const ts = Date.parse(signedAt);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'signedAt outside ±5 minute window' });
    }
    const message = `stakrr-kol-accept:${claimId}:${signedAt}`;
    let sigBytes;
    try { sigBytes = bs58.decode(signature); }
    catch { return res.status(400).json({ ok: false, error: 'signature is not base58' }); }
    if (sigBytes.length !== 64) {
      return res.status(400).json({ ok: false, error: 'signature must be 64 bytes' });
    }
    const walletPk = new PublicKey(claim.wallet);
    const ok = nacl.sign.detached.verify(
      Buffer.from(message, 'utf8'),
      sigBytes,
      walletPk.toBytes(),
    );
    if (!ok) return res.status(403).json({ ok: false, error: 'signature does not match claim wallet' });

    // Materialise on-chain: stake_for(beneficiary=KOL, payer=dev) for the
    // exact tokensRaw, locked for stakeLockDays. We prime_checkpoint every
    // reward line to baseline cleanly (this is the bug that bit GE9JWdz on
    // SQWARK — never skip it for fresh positions).
    const connection = getConnection();
    const stakeMint = new PublicKey(claim.mint);
    const beneficiary = walletPk;
    const devKp = getKeypairById(claim.devWalletId);
    const devPk = devKp.publicKey;
    await detectTokenProgram(connection, stakeMint);

    const pool = await fetchPool({ connection, stakeMint });
    if (!pool) return res.status(503).json({ ok: false, error: 'pool not yet initialized for this mint' });

    // Resolve reward lines on-chain (wSOL is registered on every Stakrr SOL
    // pool; token-mode pools also register the stake mint as a reward line).
    const rewardCandidates = new Set([config.wsolMint.toBase58()]);
    if (pool.rewardMint) rewardCandidates.add(pool.rewardMint);
    const rewardMints = [];
    for (const m of rewardCandidates) {
      const mintPk = new PublicKey(m);
      const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: mintPk });
      if (rm) rewardMints.push(mintPk);
    }
    if (rewardMints.length === 0) {
      return res.status(503).json({ ok: false, error: 'no reward mint registered for pool' });
    }

    // Time-based nonce keeps (pool, beneficiary, nonce) unique even if the
    // KOL re-stakes via the UI later.
    const nonce = new BN(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)));
    const sf = await stakeForIx({
      connection,
      payer: devPk,
      stakeMint,
      beneficiary,
      amountRaw: BigInt(claim.tokensRaw),
      lockDays: Number(claim.stakeLockDays),
      nonce,
    });
    const tx = new Transaction();
    if (config.priorityFeeMicroLamports > 0) {
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.priorityFeeMicroLamports,
      }));
    }
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }));
    tx.add(sf.ix);

    // v4: apply the per-position early-unstake bps that was set when the
    // pending claim was created. Bundled in the same tx as stake_for so
    // the override is atomic with the position. Authority for the override
    // ix must be pool.authority — which is the platform key after the
    // 85cc74b anti-rug rotation, NOT the dev wallet. We add the platform
    // keypair to the signer set when the override is non-zero.
    // `bps == 0` means "leave at pool default" — skip the ix entirely in
    // that case to save CU and bytes (5k CU + ~120 bytes per skipped ix;
    // matters when the KOL has many reward lines to prime).
    const claimBps = Math.max(0, Math.min(9000, Number(claim.earlyUnstakeBps || 0)));
    const platformAuthKp = claimBps > 0 ? authoritySigner() : null;
    const needsPlatformSigner = claimBps > 0
      && !platformAuthKp.publicKey.equals(devPk);
    if (claimBps > 0) {
      const sb = await setPositionEarlyUnstakeBpsIx({
        connection,
        authority: platformAuthKp.publicKey,
        stakeMint,
        position: sf.position,
        bps: claimBps,
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

    const claimSigners = needsPlatformSigner ? [devKp, platformAuthKp] : [devKp];
    const sig = await signAndPollConfirm(connection, tx, claimSigners, {
      label: 'kol-claim-accept',
      timeoutMs: 60_000,
    });

    // KOL accepted via the UI; default them to auto-push so cycle rewards
    // land in their wallet without further action. They can flip to manual
    // via Settings if they want to time their claims.
    try {
      const { ensureAutoPushDefault } = await import('./user-prefs.js');
      ensureAutoPushDefault(claim.wallet);
    } catch { /* non-fatal */ }

    const updated = updateClaim(claimId, {
      status: 'claimed',
      claimedAt: new Date().toISOString(),
      txSig: sig,
      position: sf.position.toBase58(),
      nonce: nonce.toString(),
    });
    res.json({ ok: true, claim: updated, txSig: sig });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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
      // v4: optional per-position early-unstake bps override (0..9000).
      // Bundled with stake_for in the same tx; signature requirements
      // depend on whether the override is non-zero (see below).
      earlyUnstakeBps,
    } = req.body || {};
    if (!mint || !devWallet || !presaleWallet || !cutoffSignature || !lockDays || !tokenTotalRaw) {
      return res.status(400).json({
        ok: false,
        error: 'mint, devWallet, presaleWallet, cutoffSignature, lockDays, tokenTotalRaw required',
      });
    }
    const bpsOverride = Math.max(0, Math.min(9000, Number(earlyUnstakeBps || 0)));

    // Override ix authority must be the live pool.authority. After 85cc74b
    // every Stakrr-launched pool rotates to PLATFORM_AUTHORITY in the same
    // tx as initialize_pool, so the dev keypair signing in the browser is
    // NOT a valid signer for set_position_early_unstake_bps. We tell the
    // builder to use the platform pubkey for the ix's authority field,
    // then partial-sign each batch server-side so the browser only needs
    // to add the dev's signature.
    const platformAuthKp = bpsOverride > 0 ? authoritySigner() : null;
    const needsPlatformPartialSign = bpsOverride > 0
      && !platformAuthKp.publicKey.equals(new PublicKey(devWallet));

    const result = await buildPresaleAutoStakeBatches({
      mint,
      devWallet,
      presaleWallet,
      cutoffSignature,
      lockDays,
      tokenTotalRaw,
      excludeWallets: Array.isArray(excludeWallets) ? excludeWallets : [],
      ...(minTransferLamports != null && { minTransferLamports: BigInt(minTransferLamports) }),
      earlyUnstakeBps: bpsOverride,
      overrideAuthority: bpsOverride > 0 ? platformAuthKp.publicKey : null,
    });

    if (needsPlatformPartialSign && Array.isArray(result.batches)) {
      // Replace each unsigned base64 with one that already carries the
      // platform's signature for the override ix slot. Browser then adds
      // the dev signature and broadcasts. Transaction.serialize with
      // requireAllSignatures:false preserves any partial sigs we attach.
      result.batches = result.batches.map((b) => {
        const tx = Transaction.from(Buffer.from(b.base64, 'base64'));
        tx.partialSign(platformAuthKp);
        const base64 = Buffer.from(
          tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
        ).toString('base64');
        return { ...b, base64 };
      });
    }

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
    if (req.query.tier) filter.tier = String(req.query.tier);
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
    const tier = body.tier || null;
    if (source === 'ephemeral') {
      const created = ensureEphemeralWallets(count, { labelPrefix: body.labelPrefix || 'ephemeral', tier });
      return res.json({ ok: true, created });
    }
    const created = [];
    for (let i = 0; i < count; i += 1) {
      created.push(generateSnipeWallet({
        label: body.label ? `${body.label}-${i + 1}` : undefined,
        source: 'pool',
        tags: Array.isArray(body.tags) ? body.tags : [],
        tier,
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
      tier: body.tier || null,
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
    const mm = body.mm && body.mm.walletId && Number(body.mm.entrySol) > 0
      ? { walletId: body.mm.walletId, entrySol: Number(body.mm.entrySol) }
      : null;
    const out = await quoteStealthLaunch({
      devWalletId: body.devWalletId,
      sniperWalletIds: Array.isArray(body.sniperWalletIds) ? body.sniperWalletIds : [],
      devBuySol: Number(body.devBuySol) || 0,
      sniperSolPerWallet: Number(body.sniperSolPerWallet) || 0,
      jitoTipSol: body.jitoTipSol == null ? null : Number(body.jitoTipSol),
      mm,
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
          // Forward the full orchestrator config — defaults handled downstream
          // by runKolAirdrop. Keep undefined when not provided so the
          // orchestrator's `|| default` patterns kick in cleanly. v4: push
          // is the default (positions visible on staking page from launch).
          mode: parsed.mode === 'pending-claim' ? 'pending-claim' : 'push',
          equalSplit: parsed.equalSplit !== false,
          claimWindowDays: parsed.claimWindowDays != null ? Number(parsed.claimWindowDays) : undefined,
          excludeWallets: Array.isArray(parsed.excludeWallets) ? parsed.excludeWallets : [],
          // v4 per-position early-unstake bps override (0..9000). 0 = leave at
          // pool default. Strong anti-dump knob for free KOL allocations.
          earlyUnstakeBps: parsed.earlyUnstakeBps != null ? Number(parsed.earlyUnstakeBps) : 0,
        };
      }
    }

    // Optional MM seed: { walletId, entrySol, config? }. Same multipart-vs-JSON
    // dance as kolAirdrop. The MM wallet buys at creator price as part of
    // the bundle, then the daemon picks the mint up automatically.
    let mm = null;
    if (body.mm) {
      let parsed = body.mm;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(400).json({ ok: false, error: 'mm must be valid JSON' }); }
      }
      if (parsed && parsed.walletId && Number(parsed.entrySol) > 0) {
        mm = {
          walletId: String(parsed.walletId),
          entrySol: Number(parsed.entrySol),
          config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
        };
      }
    }

    // Optional presale auto-stake: { presaleWallet, cutoffSignature,
    // lockDays, minTransferLamports, earlyUnstakeBps, excludeWallets[] }.
    // After the launch + KOL carve, the dev wallet's remaining bag is
    // distributed pro-rata to wallets that contributed SOL to
    // `presaleWallet` since `cutoffSignature`.
    let presale = null;
    if (body.presale) {
      let parsed = body.presale;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(400).json({ ok: false, error: 'presale must be valid JSON' }); }
      }
      if (parsed && parsed.presaleWallet && parsed.cutoffSignature) {
        presale = {
          presaleWallet: String(parsed.presaleWallet).trim(),
          cutoffSignature: String(parsed.cutoffSignature).trim(),
          lockDays: Number(parsed.lockDays) || 7,
          // Accept either `minTransferLamports` (raw) or `minTransferSol`
          // (decimal SOL string). Lamports wins when both are present.
          minTransferLamports: parsed.minTransferLamports != null
            ? String(parsed.minTransferLamports)
            : parsed.minTransferSol != null
              ? String(Math.round(Number(parsed.minTransferSol) * 1e9))
              : '10000000', // 0.01 SOL default — same as AdminPresaleView
          earlyUnstakeBps: parsed.earlyUnstakeBps != null
            ? Math.max(0, Math.min(9000, Number(parsed.earlyUnstakeBps)))
            : 0,
          excludeWallets: Array.isArray(parsed.excludeWallets) ? parsed.excludeWallets : [],
        };
      }
    }

    // Optional choreography: { absorberWalletIds: [...], config: {...} }.
    // Runs the dev-rug + absorber-wall sequence after pool init confirms.
    let choreography = null;
    if (body.choreography) {
      let parsed = body.choreography;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); }
        catch { return res.status(400).json({ ok: false, error: 'choreography must be valid JSON' }); }
      }
      if (parsed && (Array.isArray(parsed.absorberWalletIds) || parsed.config)) {
        choreography = {
          absorberWalletIds: Array.isArray(parsed.absorberWalletIds) ? parsed.absorberWalletIds : [],
          config: parsed.config && typeof parsed.config === 'object' ? parsed.config : {},
          filterTier: parsed.filterTier !== false,
        };
      }
    }

    let rewardLines = null;
    try { rewardLines = parseRewardLinesFromBody(body); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const result = await stealthLaunch({
      devWalletId: body.devWalletId,
      sniperWalletIds,
      devBuySol: Number(body.devBuySol) || 0,
      sniperSolPerWallet: Number(body.sniperSolPerWallet) || 0,
      jitoTipSol: body.jitoTipSol == null ? null : Number(body.jitoTipSol),
      slippageBps: Number(body.slippageBps) || 5000,
      rewardMode: body.rewardMode === 'token' ? 'token' : 'sol',
      rewardLines,
      metadata,
      fileBuffer: req.file?.buffer || null,
      fileContentType: req.file?.mimetype || null,
      imageUrl: body.imageUrl || null,
      metadataUri: metadataUri || null,
      metadataImageUrl: body.metadataImageUrl || null,
      initiatedBy: initiatorPk,
      kolAirdrop,
      presale,
      mm,
      choreography,
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
    const {
      mint,
      symbol,
      devWalletId,
      wallets,
      lockDays,
      tokenAllocationPct,
      tokenAllocationRaw,
      snipeId,
      mode,                 // 'push' (default) | 'pending-claim'
      equalSplit,           // bool, default true
      claimWindowDays,      // pending-claim window length, default 30
      excludeWallets,       // dedupe against presale contributors etc.
      earlyUnstakeBps,      // v4: per-position penalty override (0..9000)
    } = req.body || {};
    if (!mint || !devWalletId || !Array.isArray(wallets) || wallets.length === 0) {
      return res.status(400).json({ ok: false, error: 'mint, devWalletId, wallets[] required' });
    }
    const out = await runKolAirdrop({
      mint,
      symbol: symbol || null,
      devWalletId,
      wallets,
      lockDays: Number(lockDays) || 30,
      tokenAllocationPct: tokenAllocationPct != null ? Number(tokenAllocationPct) : undefined,
      tokenAllocationRaw,
      mode: mode || 'push',
      equalSplit: equalSplit !== false,
      claimWindowDays: Number(claimWindowDays) || 30,
      excludeWallets: Array.isArray(excludeWallets) ? excludeWallets : [],
      earlyUnstakeBps: Number(earlyUnstakeBps || 0),
      launchSnipeId: snipeId || null,
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

// Manual presale auto-stake — same orchestration as the inline launch
// path but invoked standalone, e.g. to retry a snipe whose presale step
// failed mid-flight (failed simulation, RPC 429, etc.). Body:
//   {
//     mint, devWalletId, presaleWallet, cutoffSignature,
//     lockDays?, tokenTotalRaw, excludeWallets?[], minTransferLamports?,
//     earlyUnstakeBps?, snipeId?,
//   }
// `tokenTotalRaw` should be the (live) presale slice — usually the
// snipe row's bagCarve.presaleRaw or the dev wallet's current ATA
// balance. The runner re-caps internally against the live ATA so
// passing a slightly stale number is safe (it'll just stake what's
// actually there).
app.post('/api/admin/snipe/presale/run', requireAdmin, requireVault, async (req, res) => {
  try {
    const {
      mint,
      devWalletId,
      presaleWallet,
      cutoffSignature,
      lockDays,
      tokenTotalRaw,
      excludeWallets,
      minTransferLamports,
      earlyUnstakeBps,
      snipeId,
    } = req.body || {};
    if (!mint || !devWalletId || !presaleWallet || !cutoffSignature || !tokenTotalRaw) {
      return res.status(400).json({
        ok: false,
        error: 'mint, devWalletId, presaleWallet, cutoffSignature, tokenTotalRaw required',
      });
    }
    const { runPresaleAutoStake } = await import('./snipe/presale-airdrop.js');
    const out = await runPresaleAutoStake({
      mint,
      devWalletId,
      presaleWallet,
      cutoffSignature,
      lockDays: Number(lockDays) || 7,
      tokenTotalRaw: String(tokenTotalRaw),
      excludeWallets: Array.isArray(excludeWallets) ? excludeWallets : [],
      ...(minTransferLamports != null && { minTransferLamports: BigInt(minTransferLamports) }),
      earlyUnstakeBps: Number(earlyUnstakeBps || 0),
      log: (msg, extra) => console.log(JSON.stringify({
        ts: new Date().toISOString(), tag: 'presale-airdrop', message: msg, snipeId: snipeId || null, ...extra,
      })),
    });
    if (snipeId) {
      try {
        const snipe = getSnipe(snipeId);
        if (snipe) {
          updateSnipe(snipeId, {
            presaleAirdrop: out,
            presaleAirdropRetroactiveAt: new Date().toISOString(),
          });
        }
      } catch { /* non-fatal */ }
    }
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Admin: KOL pending-claim management ──────────────────────────────────

app.get('/api/admin/kol-claims', requireAdmin, (req, res) => {
  try {
    const { status, mint, devWalletId } = req.query || {};
    const rows = listAllClaims({
      status: status || undefined,
      mint: mint || undefined,
      devWalletId: devWalletId || undefined,
    });
    res.json({ ok: true, count: rows.length, claims: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/kol-claims/sweep', requireAdmin, (_req, res) => {
  try {
    const swept = sweepExpiredClaims();
    res.json({ ok: true, sweptCount: swept.length, sweptIds: swept });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/kol-claims/:id/revoke', requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const claim = getClaimById(id);
    if (!claim) return res.status(404).json({ ok: false, error: 'no such claim' });
    if (claim.status !== 'pending') {
      return res.status(409).json({ ok: false, error: `claim is ${claim.status}, not revocable` });
    }
    const updated = updateClaim(id, {
      status: 'revoked',
      revokedAt: new Date().toISOString(),
      revokedReason: req.body?.reason || null,
    });
    res.json({ ok: true, claim: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Choreography: dev rug + absorber wall (admin-only, anti-sniper) ──────────

app.get('/api/admin/snipe/choreography/info', requireAdmin, (_req, res) => {
  res.json({ ok: true, defaults: DEFAULT_CHOREOGRAPHY_CONFIG });
});

app.post('/api/admin/snipe/choreography/quote', requireAdmin, requireVault, (req, res) => {
  try {
    const body = req.body || {};
    const out = quoteChoreography({
      absorberWalletIds: Array.isArray(body.absorberWalletIds) ? body.absorberWalletIds : [],
      config: body.config || {},
    });
    res.json({ ok: true, quote: out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * Standalone choreography on an already-launched mint. Used both for
 * retroactive runs (admin re-triggers after a launch) and as the worker
 * the in-launch flow calls when `choreography.enabled = true`.
 *
 * Long-running — can take 30s+ for the full drip window. Caller should
 * bump their HTTP client timeout accordingly. We respond when complete.
 */
app.post('/api/admin/snipe/choreography/run', requireAdmin, requireVault, async (req, res) => {
  try {
    const { mint, devWalletId, absorberWalletIds = [], config = {}, snipeId, filterTier } = req.body || {};
    if (!mint || !devWalletId) {
      return res.status(400).json({ ok: false, error: 'mint and devWalletId required' });
    }
    const out = await runDumpAndAbsorb({
      snipeId: snipeId || null,
      mint,
      devWalletId,
      absorberWalletIds: Array.isArray(absorberWalletIds) ? absorberWalletIds : [],
      filterTier: filterTier !== false,
      config,
    });
    res.json({ ok: true, result: out });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'choreography failed',
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 6),
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── MM bot (admin-only) ──────────────────────────────────────────────────────
//
// Per-token market-making config + status. Bot itself runs in a separate
// pm2 process (`stakrr-mm`) reading worker/data/mm.json on every tick.
// These endpoints just CRUD the config and surface state for the admin UI.

// ── Treasury health + manual cycle trigger (admin-only) ─────────────────────
//
// The treasury wallet pays for every claim/distribute/wrap/deposit tx. If it
// dips below ~0.005 SOL the cycle preflight skips the claim — this endpoint
// surfaces the live balance + reserve targets so the admin dashboard can
// flag the situation BEFORE stakers complain about missing rewards (which
// is how we caught the 26-hour silent outage that prompted this code).

app.get('/api/admin/treasury/status', requireAdmin, async (_req, res) => {
  try {
    const connection = getConnection();
    const treasuryPk = config.treasuryKeypair.publicKey;
    const platformVaultPk = config.platformFeeVault || null;
    const minReserveSol = parseFloat(process.env.TREASURY_MIN_RESERVE_SOL || '0.005');
    const targetReserveSol = parseFloat(process.env.TREASURY_TARGET_RESERVE_SOL || '0.05');
    const [treasuryLamports, platformVaultLamports] = await Promise.all([
      connection.getBalance(treasuryPk, 'confirmed'),
      platformVaultPk ? connection.getBalance(platformVaultPk, 'confirmed') : Promise.resolve(null),
    ]);
    const treasurySol = treasuryLamports / 1e9;
    const status = treasurySol < minReserveSol
      ? 'critical'
      : (treasurySol < targetReserveSol ? 'low' : 'ok');
    res.json({
      ok: true,
      treasury: {
        pubkey: treasuryPk.toBase58(),
        lamports: treasuryLamports,
        sol: treasurySol,
      },
      platformFeeVault: platformVaultPk ? {
        pubkey: platformVaultPk.toBase58(),
        lamports: platformVaultLamports,
        sol: (platformVaultLamports || 0) / 1e9,
      } : null,
      reserve: {
        minSol: minReserveSol,
        targetSol: targetReserveSol,
        status,
        gapToTargetSol: Math.max(0, targetReserveSol - treasurySol),
      },
      hint: status === 'critical'
        ? `Treasury is below the hard floor (${minReserveSol} SOL). All claim cycles are skipped. Send ≥${(targetReserveSol - treasurySol).toFixed(4)} SOL to ${treasuryPk.toBase58()} to resume.`
        : (status === 'low' ? `Treasury below target (${targetReserveSol} SOL). Cycles will hold back from staker portion to refill.` : null),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Force a single mint's claim cycle to run NOW. Useful after topping up the
 * treasury — instead of waiting for the next 10-min loop tick, the admin can
 * run the cycle immediately and verify it works. Returns the same result
 * shape as the loop's per-pool result.
 *
 * Long-running (claim + distribute + deposit + claim_push for each staker
 * can take 30-60s). nginx is configured to allow up to 180s for admin paths.
 */
app.post('/api/admin/pools/:mint/cycle', requireAdmin, async (req, res) => {
  try {
    const pool = getPool(req.params.mint);
    if (!pool) return res.status(404).json({ ok: false, error: 'pool not found' });
    if (pool.status !== 'active') {
      return res.status(409).json({ ok: false, error: `pool status='${pool.status}', expected 'active'` });
    }
    const result = await runPoolCycle({ pool });
    res.json({ ok: true, mint: req.params.mint, result });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'manual pool cycle failed',
      mint: req.params.mint,
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 6),
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/mm/info', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    defaults: MM_DEFAULT_CONFIG,
    tokens: listMmTokens(),
  });
});

app.get('/api/admin/mm/list', requireAdmin, (req, res) => {
  res.json({ ok: true, tokens: listMmTokens() });
});

app.get('/api/admin/mm/:mint', requireAdmin, (req, res) => {
  const t = getMmTokenInternal(req.params.mint);
  if (!t) return res.status(404).json({ ok: false, error: 'not in mm.json' });
  res.json({ ok: true, token: t });
});

/**
 * Configure (create or update) MM for a token. `walletId` MUST be a vault
 * id — the bot signs trades server-side using that keypair. Admin is
 * expected to fund the wallet externally before enabling.
 */
app.post('/api/admin/mm/configure', requireAdmin, requireVault, (req, res) => {
  try {
    const { mint, symbol, walletId, config, enabled } = req.body || {};
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    if (!walletId) return res.status(400).json({ ok: false, error: 'walletId required' });
    const t = upsertMmToken({
      mint,
      symbol: symbol || null,
      walletId,
      config: config || {},
      enabled: enabled !== false,
    });
    res.json({ ok: true, token: t });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/mm/pause', requireAdmin, (req, res) => {
  try {
    const { mint, reason } = req.body || {};
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    const t = pauseMmToken(mint, reason || 'manual pause');
    res.json({ ok: true, token: t });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/mm/resume', requireAdmin, (req, res) => {
  try {
    const { mint } = req.body || {};
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    const t = resumeMmToken(mint);
    res.json({ ok: true, token: t });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/mm/:mint', requireAdmin, (req, res) => {
  try {
    const out = deleteMmToken(req.params.mint);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

/**
 * Manual single-tick trigger — admin-only debug helper. Fires one strategy
 * step for a token on demand, regardless of nextActionAt. Useful for
 * verifying setup before letting the daemon take over.
 */
app.post('/api/admin/mm/tick', requireAdmin, requireVault, async (req, res) => {
  try {
    const { mint } = req.body || {};
    if (!mint) return res.status(400).json({ ok: false, error: 'mint required' });
    const out = await mmStrategyStep(mint);
    const next = mmScheduleNext(mint);
    res.json({ ok: true, result: out, nextAt: next });
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
    let rewardLines = null;
    try { rewardLines = parseRewardLinesFromBody(body); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const launchSource = body.launchSource === 'meteora' ? 'meteora' : 'pumpfun';
    const out = await prepareCreatorLaunch({
      metadata,
      uri: metadataUri || undefined,
      initialBuySol: Number(body.initialBuySol || 0),
      creatorWallet: body.creatorWallet.trim(),
      fileBuffer: req.file?.buffer || null,
      fileContentType: req.file?.mimetype || null,
      rewardMode,
      rewardLines,
      launchSource,
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
    let rewardLines = null;
    try { rewardLines = parseRewardLinesFromBody(req.body, { stakeMint: mint.trim() }); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const out = await buildUnsignedPoolRewardTxBase64({
      creatorWallet: creatorWallet.trim(),
      mint: mint.trim(),
      rewardMode: rm,
      rewardLines,
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

/**
 * Recovery finalize: when a launch's create tx confirmed but the pool-init
 * tx failed (e.g. blockhash expiry on the original 1-bundle flow), the
 * on-chain mint + bonding-curve exist but no registry row was written.
 * The user re-signs ONLY the pool tx (via /api/launch/pool-tx → wallet)
 * and posts here to verify on-chain state and persist the registry row.
 *
 * Distinguished from /api/launch/finalize because:
 *   - createSig is OPTIONAL — we'll fetch from RPC signature history if missing.
 *   - No lockFeesSig support — recovery is Meteora-first; pump.fun recoveries
 *     should retro-lock separately via /api/launch/lock-fees-finalize.
 *   - persistedMetadata + metadataUri come from the user (the original
 *     /prepare context is gone). Frontend captures these from the recovery
 *     form.
 */
app.post('/api/launch/recover-finalize', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.mint?.trim() || !b.creatorWallet?.trim() || !b.poolRewardSig?.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'mint, creatorWallet, poolRewardSig required',
      });
    }
    let rewardLines = null;
    try { rewardLines = parseRewardLinesFromBody(b, { stakeMint: b.mint.trim() }); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const launchSource = b.launchSource === 'pumpfun' ? 'pumpfun' : 'meteora';
    const out = await recoverFinalizeLaunch({
      mint: b.mint.trim(),
      creatorWallet: b.creatorWallet.trim(),
      poolRewardSig: b.poolRewardSig.trim(),
      createSig: b.createSig?.trim() || null,
      rewardMode: b.rewardMode === 'token' ? 'token' : 'sol',
      rewardLines,
      persistedMetadata: b.persistedMetadata || {},
      metadataUri: b.metadataUri || null,
      metadataSource: b.metadataSource || 'recovery',
      launchSource,
    });
    res.json(out);
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch recover-finalize failed',
      error: e.message,
      stack: e.stack?.split('\n').slice(0, 8),
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
    let rewardLines = null;
    try { rewardLines = parseRewardLinesFromBody(b, { stakeMint: b.mint.trim() }); }
    catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
    const launchSource = b.launchSource === 'meteora' ? 'meteora' : 'pumpfun';
    const out = await finalizeCreatorLaunch({
      createSig: b.createSig,
      lockFeesSig: b.lockFeesSig || null,
      poolRewardSig: b.poolRewardSig,
      autoStakeSig: b.autoStakeSig || null,
      mint: b.mint.trim(),
      creatorWallet: b.creatorWallet.trim(),
      rewardMode: b.rewardMode === 'token' ? 'token' : 'sol',
      rewardLines,
      persistedMetadata: b.persistedMetadata || {},
      metadataUri: b.metadataUri || null,
      metadataSource: b.metadataSource || 'caller',
      initialBuySol: Number(b.initialBuySol || 0),
      autoStake: !!(b.autoStake === true || b.autoStake === 'true' || b.autoStake === '1'),
      lockDays: Number(b.lockDays || 7),
      launchSource,
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

/**
 * Public Jupiter route-probe. Client passes a candidate output mint; we
 * quote 0.01 SOL → mint to confirm liquidity exists. Cheap (single quote)
 * and idempotent. Used by the launch UI to validate user-picked reward
 * tokens before they're locked into the pool config.
 */
app.get('/api/jupiter/probe', async (req, res) => {
  try {
    const outputMint = String(req.query.mint || '').trim();
    if (!outputMint) return res.status(400).json({ ok: false, error: 'mint required' });
    try { new PublicKey(outputMint); }
    catch { return res.status(400).json({ ok: false, error: 'invalid mint pubkey' }); }
    const slippageBps = Number(req.query.slippageBps || 100);
    const out = await probeJupiterRoute({ outputMint, slippageBps });
    res.json({ ok: out.ok, ...out });
  } catch (e) {
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
