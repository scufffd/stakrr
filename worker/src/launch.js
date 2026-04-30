// Self-serve launch flow: create a Pump.fun token with the platform treasury
// as the on-chain creator/fee receiver, then initialize a fresh staking pool
// for that mint and register wSOL as the reward.

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config, authoritySigner } from './config.js';
import { buildCreateTokenTx } from './pumpdev.js';
import { uploadMetadata } from './pumpfun-ipfs.js';
import {
  addRewardMintIx,
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  initializePoolIx,
  primeCheckpointIx,
  stakeForIx,
} from './stake-program.js';
import { upsertPool, recordEvent } from './registry.js';
import { popMintKeypairFromPool } from './vanity-mints.js';

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

async function waitForTreasuryTokenAccount({
  connection,
  treasury,
  stakeMint,
  tokenProgram,
  attempts = 6,
  delayMs = 1500,
}) {
  const ata = getAssociatedTokenAddressSync(stakeMint, treasury.publicKey, false, tokenProgram);
  for (let i = 0; i < attempts; i++) {
    try {
      const acc = await getAccount(connection, ata, 'confirmed', tokenProgram);
      if (acc.amount > 0n) return { ata, amountRaw: acc.amount };
    } catch (e) {
      // ATA may not yet exist or balance not yet propagated.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(
    `treasury token balance for ${stakeMint.toBase58()} did not materialize after ${attempts} attempts`,
  );
}

/**
 * Atomically stake the dev-bought tokens currently sitting in the treasury's
 * ATA on behalf of the launcher. Treasury pays + signs; the resulting
 * `StakePosition` is owned by the launcher wallet, so they can claim/unstake
 * directly with their own wallet later.
 *
 * Returns null if conditions are not met (missing launcher, lock tier, or no
 * dev-buy tokens to stake) so the caller can decide whether to surface an
 * error.
 */
async function autoStakeDevBuy({
  connection,
  treasury,
  stakeMint,
  launcher,
  lockDays,
  rewardMint,
}) {
  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const { ata: payerTokenAccount, amountRaw } = await waitForTreasuryTokenAccount({
    connection,
    treasury,
    stakeMint,
    tokenProgram,
  });
  const nonce = Date.now();
  const stakeRes = await stakeForIx({
    connection,
    payer: treasury,
    stakeMint,
    beneficiary: launcher,
    amountRaw,
    lockDays,
    nonce,
  });
  // Prime checkpoint for the active reward mint so the first deposit baselines
  // correctly (wSOL for SOL mode, the token itself for token mode).
  const primeRes = await primeCheckpointIx({
    connection,
    payer: treasury,
    stakeMint,
    position: stakeRes.position,
    rewardTokenMint: rewardMint,
  });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(stakeRes.ix);
  tx.add(primeRes.ix);
  const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return {
    signature,
    position: stakeRes.position.toBase58(),
    amountRaw: amountRaw.toString(),
    nonce: String(nonce),
    lockDays,
    beneficiary: launcher.toBase58(),
    payerTokenAccount: payerTokenAccount.toBase58(),
  };
}

async function ensureRewardRegistered({ connection, authority, stakeMint, rewardMint }) {
  const existing = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint,
  });
  if (existing) return { signature: null, alreadyRegistered: true };
  const { ix } = await addRewardMintIx({
    connection,
    authority,
    stakeMint,
    rewardMint,
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
 * 1. Upload metadata JSON to pump.fun's IPFS (server fetches the image URL).
 * 2. PumpDev /api/create returns a serialized tx + the mint keypair; treasury
 *    + mint sign, we send via our RPC. Treasury becomes the on-chain creator
 *    so all future creator fees flow to it.
 * 3. Treasury initializes the staking pool for the new mint.
 * 4. Treasury registers wSOL as the reward mint.
 * 5. Pool is persisted in the registry.
 *
 * `creatorWallet` is informational metadata only — it does not control fees.
 */
export async function launchToken({
  metadata,              // { name, symbol, description, twitter?, telegram?, website?, image? }
  initialBuySol = 0,
  creatorWallet = null,  // who launched it via the UI (informational, beneficiary if autoStake)
  uri,                   // optional pre-uploaded metadata URI; skips the upload step
  fileBuffer = null,     // optional Buffer of an uploaded image
  fileContentType = null,
  autoStake = false,     // atomically stake_for(creatorWallet) using dev-buy tokens
  lockDays = 7,          // lock tier when autoStake is true
  rewardMode = 'sol',    // 'sol' (default — wSOL with auto-unwrap on claim) | 'token' (own token, swapped via PumpDev)
}) {
  if (!metadata?.name || !metadata?.symbol) {
    throw new Error('launchToken: metadata.name and symbol required');
  }
  const validRewardModes = ['sol', 'token'];
  if (!validRewardModes.includes(rewardMode)) {
    throw new Error(`invalid rewardMode '${rewardMode}', expected one of: ${validRewardModes.join(', ')}`);
  }
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  // Validate autoStake preconditions early so we don't half-launch.
  let launcherPk = null;
  if (autoStake) {
    if (!creatorWallet) {
      throw new Error('autoStake requires creatorWallet (launcher) to be set');
    }
    if (!(Number(initialBuySol) > 0)) {
      throw new Error('autoStake requires initialBuySol > 0 so there are tokens to stake');
    }
    try {
      launcherPk = new PublicKey(creatorWallet);
    } catch {
      throw new Error('invalid creatorWallet pubkey');
    }
  }

  // 1) Upload metadata (pump.fun IPFS, falling back to Pinata) unless the
  //    caller already supplied a uri.
  let metadataUri = uri || null;
  let metadataSource = uri ? 'caller' : null;
  let resolvedImage = metadata.image || null;
  if (!metadataUri) {
    const upload = await uploadMetadata({
      name: metadata.name,
      symbol: metadata.symbol,
      description: metadata.description,
      twitter: metadata.twitter,
      telegram: metadata.telegram,
      website: metadata.website,
      imageUrl: metadata.image,
      fileBuffer,
      fileContentType,
    });
    metadataUri = upload.metadataUri;
    metadataSource = upload.source;
    if (upload.imageUri) resolvedImage = upload.imageUri;
    log('launch: metadata uploaded', { uri: metadataUri, source: metadataSource });
  }
  // Persist the resolved image URL so the pool page can render it.
  const persistedMetadata = { ...metadata, image: resolvedImage || metadata.image || null };

  // 2) Build the create-token transaction via PumpDev (optional vanity mint from
  //    VANITY_MINT_POOL_FILE + VANITY_MINT_SUFFIX — see vanity-mints.js / PumpDev `mintKeypair`).
  let mintKeypairSecretB58;
  if (config.vanityMintPoolFile && config.vanityMintSuffix?.trim()) {
    const vk = popMintKeypairFromPool(config.vanityMintPoolFile, config.vanityMintSuffix.trim());
    if (vk) {
      mintKeypairSecretB58 = bs58.encode(vk.secretKey);
      log('launch: vanity mint from pool', { mint: vk.publicKey.toBase58() });
    }
  }
  const { tx: createTx, mint, mintKeypair } = await buildCreateTokenTx({
    publicKey: treasury.publicKey.toBase58(),
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadataUri,
    buyAmountSol: Number(initialBuySol) || 0,
    mintKeypairSecretB58: mintKeypairSecretB58 || null,
  });
  createTx.sign([treasury, mintKeypair]);
  const createSig = await connection.sendRawTransaction(createTx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(createSig, 'confirmed');
  log('launch: pump.fun token created', { mint, sig: createSig });

  const stakeMint = mintKeypair.publicKey;

  // 2) Initialize pool.
  const initRes = await ensurePoolInitialized({ connection, authority, stakeMint });
  log('launch: pool initialized', { mint: stakeMint.toBase58(), sig: initRes.signature });

  // 3) Register the reward mint. SOL mode -> wSOL; token mode -> the launched
  //    mint itself (cycle worker swaps SOL->token via PumpDev each cycle).
  const rewardMint = rewardMode === 'token' ? stakeMint : config.wsolMint;
  const rewardRes = await ensureRewardRegistered({
    connection,
    authority,
    stakeMint,
    rewardMint,
  });
  log('launch: reward registered', {
    mint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMode,
    sig: rewardRes.signature,
  });

  // 4) Optional: auto-stake the dev-bought tokens on behalf of the launcher.
  let autoStakeRes = null;
  if (autoStake && launcherPk) {
    try {
      autoStakeRes = await autoStakeDevBuy({
        connection,
        treasury,
        stakeMint,
        launcher: launcherPk,
        lockDays: Number(lockDays) || 7,
        rewardMint,
      });
      log('launch: auto-staked dev buy', {
        mint: stakeMint.toBase58(),
        beneficiary: autoStakeRes.beneficiary,
        amount: autoStakeRes.amountRaw,
        lockDays: autoStakeRes.lockDays,
        sig: autoStakeRes.signature,
      });
    } catch (e) {
      // Don't roll back the launch; surface the error so the UI can prompt
      // the launcher to stake manually from the pool page.
      log('launch: auto-stake failed', {
        mint: stakeMint.toBase58(),
        error: e.message,
      });
      autoStakeRes = { error: e.message };
    }
  }

  // 5) Persist.
  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMode,
    platformFeeBps: config.platformFeeBps,
    creatorWallet,
    metadata: persistedMetadata,
    pumpfun: { createSig, metadataUri, metadataSource },
    onchain: {
      poolInitSig: initRes.signature,
      rewardInitSig: rewardRes.signature,
      autoStakeSig: autoStakeRes && !autoStakeRes.error ? autoStakeRes.signature : null,
    },
    initialBuySol: Number(initialBuySol) || 0,
  });

  recordEvent({
    type: 'launch',
    stakeMint: stakeMint.toBase58(),
    creatorWallet,
    name: metadata.name,
    symbol: metadata.symbol,
    createSig,
    autoStake: !!(autoStake && autoStakeRes && !autoStakeRes.error),
  });

  return {
    stakeMint: stakeMint.toBase58(),
    rewardMint: config.wsolMint.toBase58(),
    sigs: {
      create: createSig,
      poolInit: initRes.signature,
      rewardInit: rewardRes.signature,
      autoStake: autoStakeRes && !autoStakeRes.error ? autoStakeRes.signature : null,
    },
    autoStake: autoStakeRes,
    pool,
    token: pool,
  };
}
