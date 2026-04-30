// Stakrr backend API. Exposes a tiny JSON surface for the frontend:
//
//   POST /api/launch                  -> launch a Pump.fun token + pool
//   GET  /api/pools                   -> list active pools
//   GET  /api/pools/:mint             -> single pool detail (registry)
//   GET  /api/pools/:mint/public      -> partner-friendly stake-public payload
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

const app = express();
app.use(express.json({ limit: '32kb' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB image cap
});

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

app.get('/api/pools', (req, res) => {
  const pools = listPools({ status: 'active' }).map(stripPrivate);
  res.json({ ok: true, pools });
});

app.get('/api/pools/:mint', (req, res) => {
  const pool = getPool(req.params.mint);
  if (!pool) return res.status(404).json({ ok: false, error: 'not_found' });
  res.json({ ok: true, pool: stripPrivate(pool) });
});

app.get('/api/pools/:mint/public', async (req, res) => {
  try {
    const pool = getPool(req.params.mint);
    if (!pool) return res.status(404).json({ ok: false, error: 'not_found' });
    const stakeMint = new PublicKey(pool.stakeMint);
    const connection = new Connection(config.stakeRpcUrl, 'confirmed');
    const authority = authoritySigner();
    const onchain = await fetchPool({ connection, signer: authority, stakeMint });
    if (!onchain) {
      return res.json({
        ok: true,
        pool: { ...stripPrivate(pool), initialized: false },
      });
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
    res.json({
      ok: true,
      pool: {
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
        // Pre-claim probe diagnostics (filled in by the worker each cycle).
        // Useful for the UI to explain why a pool "feels quiet".
        claimProbe: {
          lastClaimedAt: pool.lastClaimedAt || null,
          lastClaimAttemptAt: pool.lastClaimAttemptAt || null,
          lastClaimAttemptReason: pool.lastClaimAttemptReason || null,
          lastClaimAttemptEstimate: pool.lastClaimAttemptEstimate || null,
        },
        snapshotAt: new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      message: 'pool public failed',
      error: e.message,
    }));
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---- Launch ----
//
// Body:
//   {
//     metadata: { name, symbol, description, twitter?, telegram?, website?, image? },
//     initialBuySol?: number,
//     creatorWallet?: string  // wallet that launched it via the UI (informational)
//   }
//
// MVP: no signed-wallet check required because the platform treasury is the
// only signer that matters on-chain. We will add wallet-signed nonce auth and
// a launch fee check before opening fully self-serve in production.
app.post('/api/launch', upload.single('image'), async (req, res) => {
  try {
    // multer + multipart: scalar fields are strings on req.body, file on req.file.
    const body = req.body || {};
    const metadata = {
      name: body.name?.trim(),
      symbol: body.symbol?.trim()?.toUpperCase(),
      description: body.description || '',
      twitter: body.twitter || undefined,
      telegram: body.telegram || undefined,
      website: body.website || undefined,
      image: body.imageUrl || undefined,
    };
    if (!metadata.name || !metadata.symbol) {
      return res.status(400).json({ ok: false, error: 'name and symbol required' });
    }
    const autoStake = body.autoStake === 'true' || body.autoStake === true || body.autoStake === '1';
    const rewardMode = body.rewardMode === 'token' ? 'token' : 'sol';
    const out = await launchToken({
      metadata,
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
