// Creator-funded launch: PumpDev /api/create uses the creator wallet as `publicKey`
// (they pay SOL + sign the mint tx). The same wallet is the on-chain staking pool
// `authority`, so initialize_pool + add_reward_mint are signed in the browser.
// After Pump create, an optional `lock-fees` step migrates BondingCurve.creator
// from the deployer to a pump_fees::FeeSharingConfig PDA — 100% of creator
// royalties then route to PLATFORM_TREASURY (see pump-fees.js).
// The worker only prepares txs, verifies on-chain state, and writes the registry.

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { config } from './config.js';
import { buildCreateTokenTx } from './pumpdev.js';
import { uploadMetadata } from './pumpfun-ipfs.js';
import {
  buildLockFeesUnsignedTx,
  fetchFeeSharingConfig,
  findFeeSharingConfigPda,
} from './pump-fees.js';
import {
  addRewardMintIx,
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  initializePoolIx,
  primeCheckpointIx,
  stakeForIx,
} from './stake-program.js';
import { buildLockFeesIxs } from './pump-fees.js';
import { getPool, upsertPool, recordEvent } from './registry.js';
import { popMintKeypairFromPool } from './vanity-mints.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

function priorityFeeIx() {
  if (!config.priorityFeeMicroLamports) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports });
}

/**
 * Pump.fun creator fees accrue to required signers on the create tx. We pass the
 * connected wallet as `publicKey` to PumpDev; this asserts that wallet is a signer.
 */
function assertPumpCreateRequiresCreatorSigner(createTx, creatorPk) {
  const msg = createTx.message;
  const header = msg.header;
  if (!header || typeof header.numRequiredSignatures !== 'number') {
    throw new Error('PumpDev create: transaction message has no header');
  }
  const keys = msg.staticAccountKeys;
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('PumpDev create: transaction has no account keys');
  }
  const signers = keys.slice(0, header.numRequiredSignatures);
  if (!signers.some((pk) => pk.equals(creatorPk))) {
    throw new Error(
      `PumpDev /api/create returned a transaction that does not require the creator wallet `
      + `(${creatorPk.toBase58()}) as a signer.`,
    );
  }
}

async function confirmSucceeded(connection, signature, label) {
  const st = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!st || st.meta?.err) {
    throw new Error(`${label}: transaction ${signature} missing or failed on-chain`);
  }
}

/**
 * One-shot launch prep. Returns ALL three unsigned txs the client needs to
 * sign so the wallet adapter can call `signAllTransactions` once and Phantom
 * shows a single approval dialog instead of three:
 *
 *   1. createTx     — Pump.fun create + dev buy        (VersionedTransaction
 *                                                       partially signed by
 *                                                       the mint keypair)
 *   2. lockFeesTx   — pump_fees create_fee_sharing_config
 *                     + update_fee_shares (recipient = treasury)
 *   3. poolRewardTx — Stakrr initialize_pool + add_reward_mint
 *
 * (2) and (3) reference accounts derived deterministically from the mint, so
 * they're safe to build before the create tx lands. They use independent
 * blockhashes (each ~150 slot lifetime) which is fine because the client
 * sends them sequentially after Phantom approval.
 *
 * The auto-stake tx is intentionally NOT in the bundle — its amount depends
 * on the actual ATA balance after the dev buy lands, so it remains a separate
 * (4th) prompt only when the user enabled auto-stake.
 */
export async function prepareCreatorLaunch({
  metadata,
  creatorWallet,
  initialBuySol = 0,
  uri,
  fileBuffer = null,
  fileContentType = null,
  rewardMode = 'sol',
}) {
  if (!metadata?.name || !metadata?.symbol) {
    throw new Error('prepareCreatorLaunch: metadata.name and symbol required');
  }
  if (!creatorWallet?.trim()) {
    throw new Error('prepareCreatorLaunch: creatorWallet required (connect wallet)');
  }
  let creatorPk;
  try {
    creatorPk = new PublicKey(creatorWallet.trim());
  } catch {
    throw new Error('invalid creatorWallet pubkey');
  }
  const validRewardModes = ['sol', 'token'];
  if (!validRewardModes.includes(rewardMode)) {
    throw new Error(`invalid rewardMode '${rewardMode}'`);
  }

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
    log('launch:prepare metadata uploaded', { uri: metadataUri, source: metadataSource });
  }

  const persistedMetadata = { ...metadata, image: resolvedImage || metadata.image || null };

  let mintKeypairSecretB58;
  if (config.vanityMintPoolFile && config.vanityMintSuffix?.trim()) {
    const vk = popMintKeypairFromPool(config.vanityMintPoolFile, config.vanityMintSuffix.trim());
    if (vk) {
      mintKeypairSecretB58 = bs58.encode(vk.secretKey);
      log('launch:prepare vanity mint from pool', { mint: vk.publicKey.toBase58() });
    }
  }

  const { tx: createTx, mint, mintKeypair } = await buildCreateTokenTx({
    publicKey: creatorPk.toBase58(),
    name: metadata.name,
    symbol: metadata.symbol,
    uri: metadataUri,
    buyAmountSol: Number(initialBuySol) || 0,
    mintKeypairSecretB58: mintKeypairSecretB58 || null,
  });
  assertPumpCreateRequiresCreatorSigner(createTx, creatorPk);
  // VersionedTransaction has sign(), not partialSign() (see @solana/web3.js).
  createTx.sign([mintKeypair]);

  const createTxBase64 = Buffer.from(createTx.serialize()).toString('base64');
  const mintPk = mintKeypair.publicKey;
  const mintStr = mintPk.toBase58();

  log('launch:prepare pump create tx built', {
    creator: creatorPk.toBase58(),
    mint: mintStr,
    mintFromApi: mint,
  });

  // Build lockFeesTx + poolRewardTx in parallel against the freshly-known
  // mint pubkey. Both are pure PDA derivations from `mint` and don't require
  // the mint account to exist on chain yet, so this is safe to do here.
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const stakeMint = mintPk;
  const rewardMint = rewardMode === 'token' ? stakeMint : config.wsolMint;

  const [lockFees, poolReward] = await Promise.all([
    buildLockFeesTxFor({ connection, creatorPk, mintPk: stakeMint }),
    buildPoolRewardTxFor({ connection, creatorPk, stakeMint, rewardMint }),
  ]);

  return {
    ok: true,
    createTxBase64,
    lockFeesTxBase64: lockFees.base64,
    lockFeesRecipient: lockFees.recipient?.toBase58() || null,
    lockFeesEnabled: lockFees.enabled,
    poolRewardTxBase64: poolReward.base64,
    rewardMint: rewardMint.toBase58(),
    mint: mintStr,
    metadataUri,
    metadataSource,
    persistedMetadata,
    rewardMode,
    initialBuySol: Number(initialBuySol) || 0,
  };
}

/**
 * Internal helper used by `prepareCreatorLaunch` to assemble the lock-fees
 * legacy tx with a fresh blockhash. Returns `enabled: false` (with a null
 * base64) when the lock is disabled by config, so the client can transparently
 * skip it from the signAllTransactions array.
 */
async function buildLockFeesTxFor({ connection, creatorPk, mintPk }) {
  if (!config.lockFees.enabled) {
    return { enabled: false, base64: null, recipient: null };
  }
  const recipient = config.lockFees.recipient
    ? new PublicKey(config.lockFees.recipient)
    : config.treasuryKeypair.publicKey;

  const tx = new Transaction();
  if (config.priorityFeeMicroLamports) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }));
  }
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  for (const ix of buildLockFeesIxs({
    deployer: creatorPk,
    mint: mintPk,
    shareholders: [{ address: recipient, shareBps: 10_000 }],
  })) tx.add(ix);

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = creatorPk;

  const base64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');
  return { enabled: true, base64, recipient };
}

async function buildPoolRewardTxFor({ connection, creatorPk, stakeMint, rewardMint }) {
  const { ix: ixPool } = await initializePoolIx({
    connection,
    authority: creatorPk,
    stakeMint,
    allowMissingMint: true,
  });
  const { ix: ixReward } = await addRewardMintIx({
    connection,
    authority: creatorPk,
    stakeMint,
    rewardMint,
    allowMissingMint: true,
  });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ixPool);
  tx.add(ixReward);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = creatorPk;
  const base64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');
  return { base64 };
}
/**
 * Step 1.5 (JSON): unsigned legacy tx with create_fee_sharing_config +
 * update_fee_shares. Migrates BC.creator from deployer to a FeeSharingConfig
 * PDA so 100% of creator royalties flow to PLATFORM_TREASURY (or whichever
 * recipient `LOCK_FEES_RECIPIENT` is set to).
 *
 * Returns `{ ok: true, locked: true|false, lockFeesTxBase64?, recipient? }`.
 * If the lock is disabled, fee config already exists, or the registered
 * recipient cannot be derived, returns `{ ok: true, locked: false, reason }`
 * and the caller skips the step.
 */
export async function buildLockFeesTxBase64({ creatorWallet, mint }) {
  if (!config.lockFees.enabled) {
    return { ok: true, locked: false, reason: 'lock_fees_disabled' };
  }
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  let creatorPk;
  let mintPk;
  try {
    creatorPk = new PublicKey(creatorWallet.trim());
    mintPk = new PublicKey(mint.trim());
  } catch {
    throw new Error('invalid mint or creatorWallet');
  }

  const recipient = config.lockFees.recipient
    ? new PublicKey(config.lockFees.recipient)
    : config.treasuryKeypair.publicKey;

  // If the FeeSharingConfig PDA already exists for this mint we treat the lock
  // as a no-op (idempotent) and let the launch flow continue.
  const existing = await fetchFeeSharingConfig(connection, mintPk);
  if (existing) {
    log('launch:lock-fees already locked', {
      mint: mintPk.toBase58(),
      pda: existing.pda.toBase58(),
      recipient: existing.shareholders[0]?.address?.toBase58() || null,
    });
    return {
      ok: true,
      locked: false,
      reason: 'already_locked',
      pda: existing.pda.toBase58(),
      recipient: existing.shareholders[0]?.address?.toBase58() || null,
    };
  }

  const { tx, lastValidBlockHeight } = await buildLockFeesUnsignedTx({
    connection,
    deployer: creatorPk,
    mint: mintPk,
    shareholders: [{ address: recipient, shareBps: 10_000 }],
    priorityFeeMicroLamports: config.priorityFeeMicroLamports || 0,
  });

  const lockFeesTxBase64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');

  log('launch:lock-fees tx built', {
    mint: mintPk.toBase58(),
    pda: findFeeSharingConfigPda(mintPk).toBase58(),
    recipient: recipient.toBase58(),
  });

  return {
    ok: true,
    locked: true,
    lockFeesTxBase64,
    lastValidBlockHeight,
    pda: findFeeSharingConfigPda(mintPk).toBase58(),
    recipient: recipient.toBase58(),
  };
}

/**
 * Step 2 (JSON): unsigned legacy tx with initialize_pool + add_reward_mint (creator pays).
 */
export async function buildUnsignedPoolRewardTxBase64({
  creatorWallet,
  mint,
  rewardMode,
}) {
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const creatorPk = new PublicKey(creatorWallet.trim());
  const stakeMint = new PublicKey(mint.trim());
  const rewardMint = rewardMode === 'token' ? stakeMint : config.wsolMint;

  const existingPool = await fetchPool({ connection, signer: null, stakeMint });
  if (existingPool) {
    throw new Error('staking pool already exists for this mint');
  }

  const { ix: ixPool } = await initializePoolIx({ connection, authority: creatorPk, stakeMint });
  const { ix: ixReward } = await addRewardMintIx({
    connection,
    authority: creatorPk,
    stakeMint,
    rewardMint,
  });

  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ixPool);
  tx.add(ixReward);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = creatorPk;

  const poolRewardTxBase64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');

  return { poolRewardTxBase64, lastValidBlockHeight, rewardMint: rewardMint.toBase58() };
}

/**
 * Optional step: stake dev-bought tokens from the creator's ATA (creator pays fees).
 */
export async function buildCreatorAutoStakeTxBase64({
  creatorWallet,
  mint,
  lockDays,
  rewardMode,
  nonce,
}) {
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const creatorPk = new PublicKey(creatorWallet.trim());
  const stakeMint = new PublicKey(mint.trim());
  const rewardMint = rewardMode === 'token' ? stakeMint : config.wsolMint;
  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const ata = getAssociatedTokenAddressSync(stakeMint, creatorPk, false, tokenProgram);
  const acc = await getAccount(connection, ata, 'confirmed', tokenProgram);
  if (acc.amount <= 0n) {
    throw new Error('no tokens in creator ATA yet — wait a few seconds after create and retry');
  }

  const stakeRes = await stakeForIx({
    connection,
    payer: creatorPk,
    stakeMint,
    beneficiary: creatorPk,
    amountRaw: acc.amount,
    lockDays: Number(lockDays) || 7,
    nonce,
  });
  const primeRes = await primeCheckpointIx({
    connection,
    payer: creatorPk,
    stakeMint,
    position: stakeRes.position,
    rewardTokenMint: rewardMint,
  });

  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(stakeRes.ix);
  tx.add(primeRes.ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = creatorPk;

  const autoStakeTxBase64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');

  return {
    autoStakeTxBase64,
    lastValidBlockHeight,
    position: stakeRes.position.toBase58(),
    amountRaw: acc.amount.toString(),
    nonce: String(nonce),
    lockDays: Number(lockDays) || 7,
  };
}

/**
 * Step 3 (JSON): verify on-chain state and persist registry (no private keys).
 *
 * `lockFeesSig` is optional — when present we re-fetch the FeeSharingConfig
 * to confirm migration succeeded and persist the lock metadata so the worker
 * (and the public token view) know the token is fee-locked.
 */
export async function finalizeCreatorLaunch({
  createSig,
  lockFeesSig = null,
  poolRewardSig,
  autoStakeSig = null,
  mint,
  creatorWallet,
  rewardMode = 'sol',
  persistedMetadata,
  metadataUri,
  metadataSource = 'caller',
  initialBuySol = 0,
  autoStake = false,
  lockDays = 7,
}) {
  if (!createSig || !poolRewardSig || !mint || !creatorWallet?.trim()) {
    throw new Error('finalizeCreatorLaunch: createSig, poolRewardSig, mint, creatorWallet required');
  }
  let creatorPk;
  let stakeMint;
  try {
    creatorPk = new PublicKey(creatorWallet.trim());
    stakeMint = new PublicKey(mint.trim());
  } catch {
    throw new Error('invalid mint or creatorWallet');
  }
  const rewardMint = rewardMode === 'token' ? stakeMint : config.wsolMint;
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');

  await confirmSucceeded(connection, createSig, 'create');
  await confirmSucceeded(connection, poolRewardSig, 'pool+reward');

  let feeLock = null;
  if (lockFeesSig) {
    await confirmSucceeded(connection, lockFeesSig, 'lock-fees');
    const cfg = await fetchFeeSharingConfig(connection, stakeMint);
    if (!cfg) {
      throw new Error('lock-fees: FeeSharingConfig PDA not found after lockFeesSig confirmed');
    }
    const expected = config.lockFees.recipient
      ? new PublicKey(config.lockFees.recipient)
      : config.treasuryKeypair.publicKey;
    const recipient = cfg.shareholders[0]?.address || null;
    const recipientStr = recipient?.toBase58() || null;
    if (!recipient || !recipient.equals(expected)) {
      throw new Error(
        `lock-fees: configured recipient ${recipientStr} does not match expected ${expected.toBase58()}`,
      );
    }
    feeLock = {
      pda: cfg.pda.toBase58(),
      updateAuthority: cfg.updateAuthority.toBase58(),
      shareholders: cfg.shareholders.map((s) => ({
        address: s.address.toBase58(),
        shareBps: s.shareBps,
      })),
      lockSig: lockFeesSig,
    };
  } else if (config.lockFees.enabled) {
    // Lock was supposed to run but the client didn't sign — emit a warning so
    // ops can spot tokens that slipped through unlocked.
    log('launch:finalize WARNING lock_fees enabled but no lockFeesSig supplied', {
      mint: stakeMint.toBase58(),
    });
  }

  const onchainPool = await fetchPool({ connection, signer: null, stakeMint });
  if (!onchainPool) {
    throw new Error('stake pool not found on-chain after launch txs');
  }
  if (!onchainPool.authority.equals(creatorPk)) {
    throw new Error(
      `on-chain pool authority ${onchainPool.authority.toBase58()} does not match creatorWallet ${creatorPk.toBase58()}`,
    );
  }
  const canonicalCreator = onchainPool.authority;

  const rewardAcct = await fetchRewardMint({
    connection,
    signer: null,
    stakeMint,
    rewardMint,
  });
  if (!rewardAcct) {
    throw new Error('reward mint line not registered on-chain');
  }

  let autoStakeRes = null;
  if (autoStake) {
    if (!(Number(initialBuySol) > 0)) {
      throw new Error('finalize: autoStake was true but initialBuySol was 0');
    }
    if (!autoStakeSig) {
      throw new Error('finalize: autoStake expected autoStakeSig');
    }
    await confirmSucceeded(connection, autoStakeSig, 'auto-stake');
    autoStakeRes = { signature: autoStakeSig };
  }

  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMode,
    platformFeeBps: config.platformFeeBps,
    launchFunding: 'creator',
    poolAuthority: canonicalCreator.toBase58(),
    /**
     * Once feeLock is present, the BondingCurve.creator field is the
     * FeeSharingConfig PDA (not a wallet) and the worker calls
     * `distribute_creator_fees` to settle to the configured shareholders.
     * `pumpFeeClaimer` is left as treasury for backwards-compat with the
     * legacy claim-account path used by un-locked tokens.
     */
    pumpFeeClaimer: config.treasuryKeypair.publicKey.toBase58(),
    creatorWallet: canonicalCreator.toBase58(),
    metadata: persistedMetadata || {},
    pumpfun: { createSig, metadataUri: metadataUri || null, metadataSource },
    feeLock,
    onchain: {
      poolInitSig: poolRewardSig,
      rewardInitSig: poolRewardSig,
      autoStakeSig: autoStakeRes?.signature || null,
      lockFeesSig: feeLock?.lockSig || null,
    },
    initialBuySol: Number(initialBuySol) || 0,
  });

  recordEvent({
    type: 'launch',
    stakeMint: stakeMint.toBase58(),
    creatorWallet: canonicalCreator.toBase58(),
    name: persistedMetadata?.name,
    symbol: persistedMetadata?.symbol,
    createSig,
    lockFeesSig: feeLock?.lockSig || null,
    feeLockRecipient: feeLock?.shareholders?.[0]?.address || null,
    autoStake: !!(autoStake && autoStakeSig),
    launchFunding: 'creator',
  });

  log('launch:finalize registry written', {
    mint: stakeMint.toBase58(),
    creator: canonicalCreator.toBase58(),
    rewardMode,
  });

  return {
    ok: true,
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    sigs: {
      create: createSig,
      lockFees: feeLock?.lockSig || null,
      poolInit: poolRewardSig,
      rewardInit: poolRewardSig,
      autoStake: autoStakeRes?.signature || null,
    },
    feeLock,
    autoStake: autoStakeRes,
    pool,
    token: pool,
    lockDays: Number(lockDays) || 7,
  };
}

/**
 * Retro-lock an already-launched token. The client signs and sends the
 * standalone lock-fees tx (built by `buildLockFeesTxBase64`); we verify the
 * resulting on-chain FeeSharingConfig and patch the registry row.
 *
 * Used by the "Retry fee lock" recovery path for tokens like IDK that were
 * launched before the lock bug-fix and ended up with the deployer wallet still
 * set as BondingCurve.creator.
 */
export async function finalizeLockFeesOnly({ mint, creatorWallet, lockFeesSig }) {
  if (!mint?.trim() || !creatorWallet?.trim() || !lockFeesSig?.trim()) {
    throw new Error('finalizeLockFeesOnly: mint, creatorWallet, lockFeesSig required');
  }
  let stakeMint;
  let creatorPk;
  try {
    stakeMint = new PublicKey(mint.trim());
    creatorPk = new PublicKey(creatorWallet.trim());
  } catch {
    throw new Error('invalid mint or creatorWallet');
  }
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  await confirmSucceeded(connection, lockFeesSig.trim(), 'lock-fees');
  const cfg = await fetchFeeSharingConfig(connection, stakeMint);
  if (!cfg) {
    throw new Error('lock-fees: FeeSharingConfig PDA not found after lockFeesSig confirmed');
  }
  const expected = config.lockFees.recipient
    ? new PublicKey(config.lockFees.recipient)
    : config.treasuryKeypair.publicKey;
  const recipient = cfg.shareholders[0]?.address || null;
  if (!recipient || !recipient.equals(expected)) {
    throw new Error(
      `lock-fees: configured recipient ${recipient?.toBase58() || null} does not match expected ${expected.toBase58()}`,
    );
  }
  const feeLock = {
    pda: cfg.pda.toBase58(),
    updateAuthority: cfg.updateAuthority.toBase58(),
    shareholders: cfg.shareholders.map((s) => ({
      address: s.address.toBase58(),
      shareBps: s.shareBps,
    })),
    lockSig: lockFeesSig.trim(),
  };

  // Patch the existing registry row. upsertPool does a shallow merge, so we
  // hand-merge the nested `onchain` field to preserve poolInitSig / autoStakeSig
  // / etc. that were written at original launch time.
  const existing = getPool(stakeMint.toBase58()) || {};
  if (existing.creatorWallet && existing.creatorWallet !== creatorPk.toBase58()) {
    throw new Error(
      `lock-fees: registry creator ${existing.creatorWallet} doesn't match supplied ${creatorPk.toBase58()}`,
    );
  }
  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    creatorWallet: creatorPk.toBase58(),
    feeLock,
    onchain: { ...(existing.onchain || {}), lockFeesSig: lockFeesSig.trim() },
  });

  recordEvent({
    type: 'fee_lock_retro',
    stakeMint: stakeMint.toBase58(),
    creatorWallet: creatorPk.toBase58(),
    lockFeesSig: lockFeesSig.trim(),
    feeLockRecipient: feeLock.shareholders[0]?.address || null,
  });

  log('launch:lock-fees retro applied', {
    mint: stakeMint.toBase58(),
    pda: cfg.pda.toBase58(),
    recipient: recipient.toBase58(),
  });

  return { ok: true, feeLock, pool };
}
