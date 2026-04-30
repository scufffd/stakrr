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
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { config, authoritySigner } from './config.js';
import { getPool, listPools } from './registry.js';
import { fetchPool, fetchRewardMint, fetchActivePositions } from './stake-program.js';
import { launchToken } from './launch.js';

const app = express();
app.use(express.json({ limit: '32kb' }));

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
    const reward = await fetchRewardMint({
      connection,
      signer: authority,
      stakeMint,
      rewardMint: config.wsolMint,
    });
    const positions = await fetchActivePositions({ connection, signer: authority, stakeMint });
    const uniqueStakers = new Set(positions.map((p) => p.account.owner.toBase58())).size;
    res.json({
      ok: true,
      pool: {
        ...stripPrivate(pool),
        initialized: true,
        totalStaked: onchain.totalStaked?.toString?.() || '0',
        totalEffective: onchain.totalEffective?.toString?.() || '0',
        rewardMintCount: onchain.rewardMintCount ?? null,
        rewardWsol: reward
          ? {
              accPerShare: reward.accPerShare?.toString?.() || '0',
              totalDeposited: reward.totalDeposited?.toString?.() || '0',
              totalClaimed: reward.totalClaimed?.toString?.() || '0',
              lastDepositTs: reward.lastDepositTs?.toString?.() || '0',
            }
          : null,
        activePositions: positions.length,
        uniqueStakers,
        snapshotAt: new Date().toISOString(),
      },
    });
  } catch (e) {
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
app.post('/api/launch', async (req, res) => {
  try {
    const { metadata, initialBuySol, creatorWallet } = req.body || {};
    if (!metadata?.name || !metadata?.symbol) {
      return res.status(400).json({ ok: false, error: 'metadata.name and metadata.symbol required' });
    }
    const out = await launchToken({
      metadata,
      initialBuySol: Number(initialBuySol || 0),
      creatorWallet: creatorWallet || null,
    });
    res.json({ ok: true, ...out });
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
