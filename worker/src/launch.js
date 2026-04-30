// Self-serve launch flow: create a Pump.fun token with the platform treasury
// as the on-chain creator/fee receiver, then initialize a fresh staking pool
// for that mint and register wSOL as the reward.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { config, authoritySigner } from './config.js';
import { buildCreateTokenTx } from './pumpdev.js';
import {
  addRewardMintIx,
  fetchPool,
  fetchRewardMint,
  initializePoolIx,
} from './stake-program.js';
import { upsertPool, recordEvent } from './registry.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

function priorityFeeIx() {
  if (!config.priorityFeeMicroLamports) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports });
}

async function ensurePoolInitialized({ connection, authority, stakeMint }) {
  const existing = await fetchPool({ connection, signer: authority, stakeMint });
  if (existing) return { signature: null, alreadyInitialized: true };
  const { ix } = await initializePoolIx({ connection, authority, stakeMint });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return { signature, alreadyInitialized: false };
}

async function ensureWsolRewardRegistered({ connection, authority, stakeMint }) {
  const existing = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint: config.wsolMint,
  });
  if (existing) return { signature: null, alreadyRegistered: true };
  const { ix } = await addRewardMintIx({
    connection,
    authority,
    stakeMint,
    rewardMint: config.wsolMint,
  });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [authority], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return { signature, alreadyRegistered: false };
}

/**
 * Launch a fresh Pump.fun token + staking pool.
 *
 * Flow:
 * 1. PumpDev /api/create returns a serialized tx; treasury signs (becomes the creator/fee receiver).
 * 2. Treasury initializes the staking pool for the new mint.
 * 3. Treasury registers wSOL as the reward mint.
 * 4. Pool is persisted in the registry.
 *
 * `creatorWallet` is informational metadata only — it does not control fees.
 */
export async function launchToken({
  metadata,             // { name, symbol, description, twitter?, telegram?, website?, image? }
  initialBuySol = 0,
  creatorWallet = null, // who launched it via the UI (informational)
}) {
  if (!metadata?.name || !metadata?.symbol) {
    throw new Error('launchToken: metadata.name and symbol required');
  }
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  // 1) Create the Pump.fun token.
  const mintKeypair = Keypair.generate();
  const createTx = await buildCreateTokenTx({
    publicKey: treasury.publicKey.toBase58(),
    metadata,
    initialBuySol,
  });
  // PumpDev creates a fresh token mint inside the tx; pumpdev returns the
  // mint signer requirements in the serialized tx itself. The treasury signs
  // as fee payer/creator.
  createTx.sign([treasury, mintKeypair]);
  const createSig = await connection.sendRawTransaction(createTx.serialize(), {
    skipPreflight: false,
  });
  await connection.confirmTransaction(createSig, 'confirmed');
  log('launch: pump.fun token created', { mint: mintKeypair.publicKey.toBase58(), sig: createSig });

  const stakeMint = mintKeypair.publicKey;

  // 2) Initialize pool.
  const initRes = await ensurePoolInitialized({ connection, authority, stakeMint });
  log('launch: pool initialized', { mint: stakeMint.toBase58(), sig: initRes.signature });

  // 3) Register wSOL reward.
  const rewardRes = await ensureWsolRewardRegistered({ connection, authority, stakeMint });
  log('launch: wSOL reward registered', { mint: stakeMint.toBase58(), sig: rewardRes.signature });

  // 4) Persist.
  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    rewardMint: config.wsolMint.toBase58(),
    platformFeeBps: config.platformFeeBps,
    creatorWallet,
    metadata,
    pumpfun: { createSig },
    onchain: {
      poolInitSig: initRes.signature,
      rewardInitSig: rewardRes.signature,
    },
  });

  recordEvent({
    type: 'launch',
    stakeMint: stakeMint.toBase58(),
    creatorWallet,
    name: metadata.name,
    symbol: metadata.symbol,
    createSig,
  });

  return {
    stakeMint: stakeMint.toBase58(),
    rewardMint: config.wsolMint.toBase58(),
    sigs: {
      create: createSig,
      poolInit: initRes.signature,
      rewardInit: rewardRes.signature,
    },
    pool,
  };
}
