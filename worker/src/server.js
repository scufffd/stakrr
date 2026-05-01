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
import { fetchPool, fetchRewardMint, fetchActivePositions } from './stake-program.js';
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
    lockFeesEnabled: config.lockFees.enabled,
    platformFeeBps: config.platformFeeBps,
    minDistributeLamports: config.minDistributeLamports,
    loopIntervalMs: config.loopIntervalMs,
    repo: process.env.PUBLIC_REPO_URL || 'https://github.com/scufffd/stakrr',
  });
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
