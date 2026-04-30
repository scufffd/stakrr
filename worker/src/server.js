// Stakrr backend API. Exposes a tiny JSON surface for the frontend:
//
//   POST /api/launch                  -> launch a Pump.fun token + staking pool
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
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { config, authoritySigner } from './config.js';
import { getPool, listPools } from './registry.js';
import { fetchPool, fetchRewardMint, fetchActivePositions } from './stake-program.js';
import { launchToken } from './launch.js';
import { buildWalletSummary } from './wallet-summary.js';

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
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
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
// MVP: no signed-wallet check required because the platform treasury is the
// only signer that matters on-chain. We will add wallet-signed nonce auth and
// a launch fee check before opening fully self-serve in production.
app.post('/api/launch', upload.single('image'), async (req, res) => {
  try {
    // multer + multipart: scalar fields are strings on req.body, file on req.file.
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
    if (!metadataUri && !req.file?.buffer) {
      return res.status(400).json({
        ok: false,
        error: 'Token image required (or pin metadata from the browser / pass metadataUri).',
      });
    }
    const autoStake = body.autoStake === 'true' || body.autoStake === true || body.autoStake === '1';
    const rewardMode = body.rewardMode === 'token' ? 'token' : 'sol';
    const out = await launchToken({
      metadata,
      uri: metadataUri || undefined,
      initialBuySol: Number(body.initialBuySol || 0),
      creatorWallet: body.creatorWallet || null,
      fileBuffer: req.file?.buffer || null,
      fileContentType: req.file?.mimetype || null,
      autoStake,
      lockDays: Number(body.lockDays || 7),
      rewardMode,
    });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'launch failed',
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
