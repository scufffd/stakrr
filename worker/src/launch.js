// Creator-funded launch: PumpDev /api/create uses the creator wallet as `publicKey`
// (they pay SOL + sign the mint tx). The same wallet is the on-chain staking pool
// `authority`, so initialize_pool + add_reward_mint are signed in the browser.
// After Pump create, an optional `lock-fees` step migrates BondingCurve.creator
// from the deployer to a pump_fees::FeeSharingConfig PDA — 100% of creator
// royalties then route to PLATFORM_TREASURY (see pump-fees.js).
// The worker only prepares txs, verifies on-chain state, and writes the registry.

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import {
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  getTokenMetadata,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { config, getConnection } from './config.js';
import { buildCreateTokenTx as buildPumpfunCreateTokenTx } from './pumpdev.js';
import {
  buildCreateTokenTx as buildMeteoraCreateTokenTx,
  deriveMeteoraPoolAddress,
  getMeteoraConfigKey,
} from './meteora.js';
import { uploadMetadata } from './pumpfun-ipfs.js';
import {
  buildLockFeesUnsignedTx,
  fetchFeeSharingConfig,
  findFeeSharingConfigPda,
} from './pump-fees.js';

/** Whitelist for the new `launchSource` param. Only mainnet venues we operate. */
const VALID_LAUNCH_SOURCES = ['pumpfun', 'meteora'];
import {
  addRewardMintIx,
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  initializePoolIx,
  primeCheckpointIx,
  setPoolAuthorityIx,
  stakeForIx,
} from './stake-program.js';
import { buildLockFeesIxs } from './pump-fees.js';
import { getPool, upsertPool, recordEvent } from './registry.js';
import { popUnusedMintKeypairFromPool } from './vanity-mints.js';

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

/**
 * Meteora's createPool tx is a legacy `Transaction` (not VersionedTransaction).
 * Confirms the creator is required as a signer in at least one instruction.
 *
 * We can't inspect `tx.signatures` here because legacy Transaction populates
 * that array lazily on compile (during `serialize()` or `partialSign()`),
 * which we haven't called yet. Instead, walk the instructions' account
 * meta to find a signer slot bound to the creator pubkey.
 */
function assertMeteoraCreateRequiresCreatorSigner(legacyTx, creatorPk) {
  const instructions = legacyTx.instructions || [];
  if (!Array.isArray(instructions) || instructions.length === 0) {
    throw new Error('Meteora create: transaction has no instructions');
  }
  const creatorIsSigner = instructions.some((ix) =>
    (ix.keys || []).some((k) => k?.isSigner && k.pubkey?.equals?.(creatorPk)),
  );
  if (!creatorIsSigner) {
    throw new Error(
      `Meteora createPool returned a transaction that does not require the creator wallet `
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
  rewardLines = null,
  /**
   * Launch venue — selects which on-chain bonding curve the token is deployed
   * to. Defaults to `pumpfun` for backwards-compat (every existing caller
   * lands on the same code path). `meteora` deploys to a Stakrr-owned
   * Meteora DBC config and skips the pump_fees lock step (Meteora's
   * partner-fee model already routes 100% of trading fees to stakrr).
   */
  launchSource = 'pumpfun',
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
  if (!VALID_LAUNCH_SOURCES.includes(launchSource)) {
    throw new Error(`invalid launchSource '${launchSource}' (expected one of ${VALID_LAUNCH_SOURCES.join(', ')})`);
  }
  // Meteora launches REQUIRE the pre-deployed config key. Surface a clear
  // error here rather than letting it fail mid-tx-build.
  if (launchSource === 'meteora') {
    getMeteoraConfigKey(); // throws if METEORA_CONFIG_KEY env not set
  }

  // Allocate the vanity mint FIRST (before metadata upload) so we can
  // auto-populate `website` with https://stakrr.xyz/token/<mint> when the
  // deployer leaves it blank. Each launch then has a real landing page even
  // for projects that never make a website. Pre-pinned client-side metadata
  // (`uri` arg) is honored as-is — no retroactive rewrites.
  //
  // Per-venue pool selection: Pump.fun launches use the default (`pump`-suffix)
  // pool to match Pump.fun's tile branding. Meteora launches use a separate
  // (`stkr`-suffix) pool because their landing page lives on Stakrr — a
  // `pump` ending CA there would be misleading. If the Meteora pool isn't
  // configured yet, we fall through to a random ephemeral keypair (never
  // borrow from the Pump.fun pool).
  const connection = getConnection();
  const vanityPoolFile = launchSource === 'meteora'
    ? config.vanityMintMeteoraPoolFile
    : config.vanityMintPoolFile;
  const vanitySuffix = launchSource === 'meteora'
    ? config.vanityMintMeteoraSuffix
    : config.vanityMintSuffix;
  let mintKeypairSecretB58;
  let preallocatedVanity = null;
  if (vanityPoolFile && vanitySuffix?.trim()) {
    const result = await popUnusedMintKeypairFromPool(
      vanityPoolFile,
      vanitySuffix.trim(),
      connection,
    );
    if (result?.keypair) {
      preallocatedVanity = result.keypair;
      mintKeypairSecretB58 = bs58.encode(result.keypair.secretKey);
      log('launch:prepare vanity mint from pool', {
        venue: launchSource,
        pool: vanityPoolFile,
        suffix: vanitySuffix,
        mint: result.keypair.publicKey.toBase58(),
        prunedUsed: result.pruned,
      });
    }
  }

  // Predicted mint address: vanity (preallocated above) or a freshly-generated
  // ephemeral keypair from PumpDev if we don't have a vanity in stock. We
  // generate the ephemeral one here too so we can know the mint before
  // building createTx, then pass it via `mintKeypairSecretB58`.
  let predictedMintB58;
  if (preallocatedVanity) {
    predictedMintB58 = preallocatedVanity.publicKey.toBase58();
  } else {
    const ephemeral = Keypair.generate();
    mintKeypairSecretB58 = bs58.encode(ephemeral.secretKey);
    predictedMintB58 = ephemeral.publicKey.toBase58();
  }

  // Default the deployer's `website` to a Stakrr per-token landing page when
  // they didn't supply one. This way Pump.fun's tile / DexScreener / wallets
  // all surface a "click for staking & token info" link by default.
  const websiteForMetadata = metadata.website?.trim()
    || `${config.publicBaseUrl}/token/${predictedMintB58}`;

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
      website: websiteForMetadata,
      imageUrl: metadata.image,
      fileBuffer,
      fileContentType,
    });
    metadataUri = upload.metadataUri;
    metadataSource = upload.source;
    if (upload.imageUri) resolvedImage = upload.imageUri;
    log('launch:prepare metadata uploaded', {
      uri: metadataUri,
      source: metadataSource,
      websiteUsed: websiteForMetadata,
      websiteWasDefault: !metadata.website?.trim(),
    });
  }

  const persistedMetadata = {
    ...metadata,
    website: metadata.website?.trim() || websiteForMetadata,
    image: resolvedImage || metadata.image || null,
  };

  // Build the venue-specific create tx. Both paths return the same shape
  // `{ tx, mint, mintKeypair }` — Pump.fun returns a VersionedTransaction,
  // Meteora returns a legacy Transaction. The frontend handles both via
  // wallet adapter (`signTransaction` works for either).
  let createTx;
  let mint;
  let mintKeypair;
  let createTxBase64;
  if (launchSource === 'meteora') {
    const res = await buildMeteoraCreateTokenTx({
      publicKey: creatorPk.toBase58(),
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadataUri,
      buyAmountSol: Number(initialBuySol) || 0,
      mintKeypairSecretB58,
    });
    createTx = res.tx;
    mint = res.mint;
    mintKeypair = res.mintKeypair;
    assertMeteoraCreateRequiresCreatorSigner(createTx, creatorPk);
    // Set blockhash + feePayer FIRST, then partial-sign with the mint
    // keypair (legacy Transaction.partialSign requires a recentBlockhash
    // to derive the message hash it signs). The browser wallet adapter
    // adds the creator signature on top.
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    createTx.recentBlockhash = blockhash;
    createTx.feePayer = creatorPk;
    createTx.partialSign(mintKeypair);
    createTxBase64 = Buffer.from(
      createTx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString('base64');
  } else {
    const res = await buildPumpfunCreateTokenTx({
      publicKey: creatorPk.toBase58(),
      name: metadata.name,
      symbol: metadata.symbol,
      uri: metadataUri,
      buyAmountSol: Number(initialBuySol) || 0,
      mintKeypairSecretB58,
    });
    createTx = res.tx;
    mint = res.mint;
    mintKeypair = res.mintKeypair;
    assertPumpCreateRequiresCreatorSigner(createTx, creatorPk);
    createTx.sign([mintKeypair]);
    createTxBase64 = Buffer.from(createTx.serialize()).toString('base64');
  }
  const mintPk = mintKeypair.publicKey;
  const mintStr = mintPk.toBase58();
  // Sanity: PumpDev should always use the keypair we provided; if it didn't,
  // our pre-pinned metadata `website` would point at the wrong mint.
  if (mintStr !== predictedMintB58) {
    throw new Error(
      `predicted mint ${predictedMintB58} != actual mint ${mintStr} from PumpDev — refusing launch (metadata website would be wrong)`,
    );
  }

  log('launch:prepare create tx built', {
    venue: launchSource,
    creator: creatorPk.toBase58(),
    mint: mintStr,
    mintFromApi: mint,
  });

  // Build lockFeesTx + poolRewardTx in parallel against the freshly-known
  // mint pubkey. Both are pure PDA derivations from `mint` and don't require
  // the mint account to exist on chain yet, so this is safe to do here.
  // Reuses the `connection` opened earlier for the vanity-pool prune call.
  const stakeMint = mintPk;

  // Resolve effective reward lines for this launch:
  //   - explicit `rewardLines` (already validated by the caller)
  //   - else legacy single-line derived from rewardMode
  // The first line's mint is treated as the "primary" rewardMint for
  // legacy callers / display purposes.
  const effectiveLines = Array.isArray(rewardLines) && rewardLines.length > 0
    ? rewardLines
    : [{ mint: (rewardMode === 'token' ? stakeMint.toBase58() : config.wsolMint.toBase58()), weightBps: 10_000, source: rewardMode === 'token' ? 'pump-fees-swap-pumpdev' : 'pump-fees-direct' }];
  const primaryRewardMintStr = effectiveLines[0].mint;
  const primaryRewardMint = new PublicKey(primaryRewardMintStr);

  // Meteora's partner-fee mechanism is configured at the config level (we
  // are the partner; 100% of trading fees route to PLATFORM_TREASURY by
  // construction). There is no "lock fees" tx to build — the security model
  // is enforced by the on-chain config we deployed once at setup time.
  const lockFeesPromise = launchSource === 'meteora'
    ? Promise.resolve({ enabled: false, base64: null, recipient: null, reason: 'meteora_partner_fees' })
    : buildLockFeesTxFor({ connection, creatorPk, mintPk: stakeMint });
  const [lockFees, poolReward] = await Promise.all([
    lockFeesPromise,
    buildPoolRewardTxFor({ connection, creatorPk, stakeMint, rewardLines: effectiveLines }),
  ]);

  // Meteora pools have a deterministic on-chain pool address derived from
  // (quoteMint, baseMint, configKey). Persist it now so the cycle worker
  // can claim partner fees without re-deriving on every cycle.
  const meteoraPoolAddress = launchSource === 'meteora'
    ? deriveMeteoraPoolAddress({ baseMint: mintPk }).toBase58()
    : null;

  return {
    ok: true,
    createTxBase64,
    lockFeesTxBase64: lockFees.base64,
    lockFeesRecipient: lockFees.recipient?.toBase58() || null,
    lockFeesEnabled: lockFees.enabled,
    poolRewardTxBase64: poolReward.base64,
    rewardMint: primaryRewardMint.toBase58(),
    rewardLines: effectiveLines,
    mint: mintStr,
    metadataUri,
    metadataSource,
    persistedMetadata,
    rewardMode,
    initialBuySol: Number(initialBuySol) || 0,
    launchSource,
    meteoraPoolAddress,
    meteoraConfigKey: launchSource === 'meteora' ? getMeteoraConfigKey().toBase58() : null,
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

/**
 * `rewardLines` is an array of normalised reward-line specs (see
 * `reward-lines.js`). For backward compat, callers may pass `rewardMint`
 * (singular PublicKey) instead and we'll synthesise a single-line array
 * from it. The stake mint is ALWAYS added as a reward line (deduped) so
 * `unstake_early` can route the 10% principal penalty back to remaining
 * stakers — see comment below.
 *
 * Tx-size budget: each `addRewardMintIx` is ~64 bytes of message data
 * (3 account refs + 8 byte disc). With initialize_pool + up to 5 reward
 * lines + the stake-mint dedup ix + set_pool_authority + priority fee ix,
 * we stay well under the 1232-byte legacy tx ceiling.
 */
async function buildPoolRewardTxFor({ connection, creatorPk, stakeMint, rewardMint, rewardLines }) {
  // Derive line list from singular `rewardMint` when caller hasn't migrated.
  const lines = Array.isArray(rewardLines) && rewardLines.length > 0
    ? rewardLines
    : [{ mint: (rewardMint instanceof PublicKey ? rewardMint.toBase58() : String(rewardMint)) }];

  const { ix: ixPool } = await initializePoolIx({
    connection,
    authority: creatorPk,
    stakeMint,
    allowMissingMint: true,
  });

  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ixPool);

  // Track which reward mints we've already registered so we don't emit
  // duplicate `add_reward_mint` ixs (would revert with AccountAlreadyInitialized).
  const addedMints = new Set();
  for (const line of lines) {
    const mintStr = typeof line.mint === 'string' ? line.mint : line.mint.toBase58();
    if (addedMints.has(mintStr)) continue;
    addedMints.add(mintStr);
    const lineMintPk = new PublicKey(mintStr);
    const { ix: ixReward } = await addRewardMintIx({
      connection,
      authority: creatorPk,
      stakeMint,
      rewardMint: lineMintPk,
      allowMissingMint: true,
    });
    tx.add(ixReward);
  }

  // unstake_early routes the 10% principal penalty back to remaining stakers
  // through the stake-mint reward line, so the program requires
  // `add_reward_mint(stake_mint)` to have been called once. If the user's
  // reward-line config doesn't already include the stake mint, register it
  // here as a no-payout line so early-unstake works. Without this the program
  // fails at instruction-3 with `AccountNotInitialized` for
  // `stake_reward_mint` (Anchor 3012), as we hit live on yks7qy…pump.
  if (!addedMints.has(stakeMint.toBase58())) {
    const { ix: ixStakeRewardLine } = await addRewardMintIx({
      connection,
      authority: creatorPk,
      stakeMint,
      rewardMint: stakeMint,
      allowMissingMint: true,
    });
    tx.add(ixStakeRewardLine);
  }

  // Anti-rug: rotate pool authority from the deployer to PLATFORM_AUTHORITY in
  // the same tx the deployer signs. Stops third-party deployers from later
  // calling `sweep_reward_vault` / `admin_reset_*` to drain accumulated fees
  // (or staker principal in token-reward mode) from their own pool. The
  // deployer still controls `stake` / `unstake` / `claim` on positions they
  // open, but admin ops are now the platform's responsibility. Routine ops
  // (orphan redistribution) are handled by the v3 permissionless
  // `redistribute_orphan` ix, so this rotation does NOT add platform-key
  // signing burden for day-to-day flows.
  const platformAuthority = (config.authorityKeypair || config.treasuryKeypair).publicKey;
  if (!platformAuthority.equals(creatorPk)) {
    const { ix: ixRotateAuth } = await setPoolAuthorityIx({
      connection,
      authority: creatorPk,
      stakeMint,
      newAuthority: platformAuthority,
    });
    tx.add(ixRotateAuth);
  }

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
  const connection = getConnection();
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
  rewardLines = null,
}) {
  const connection = getConnection();
  const creatorPk = new PublicKey(creatorWallet.trim());
  const stakeMint = new PublicKey(mint.trim());

  const effectiveLines = Array.isArray(rewardLines) && rewardLines.length > 0
    ? rewardLines
    : [{ mint: (rewardMode === 'token' ? stakeMint.toBase58() : config.wsolMint.toBase58()), weightBps: 10_000, source: rewardMode === 'token' ? 'pump-fees-swap-pumpdev' : 'pump-fees-direct' }];
  const primaryRewardMintStr = effectiveLines[0].mint;
  const primaryRewardMint = new PublicKey(primaryRewardMintStr);

  const existingPool = await fetchPool({ connection, signer: null, stakeMint });
  if (existingPool) {
    throw new Error('staking pool already exists for this mint');
  }

  const { ix: ixPool } = await initializePoolIx({ connection, authority: creatorPk, stakeMint });

  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(ixPool);

  // Add an `add_reward_mint` ix for each configured reward line, deduped.
  const addedMints = new Set();
  for (const line of effectiveLines) {
    const mintStr = typeof line.mint === 'string' ? line.mint : line.mint.toBase58();
    if (addedMints.has(mintStr)) continue;
    addedMints.add(mintStr);
    const { ix: ixReward } = await addRewardMintIx({
      connection,
      authority: creatorPk,
      stakeMint,
      rewardMint: new PublicKey(mintStr),
    });
    tx.add(ixReward);
  }

  // Mirror the bundled-launch path: register the stake mint as its own reward
  // line so unstake_early can pay the 10% penalty back to remaining stakers.
  // See buildPoolRewardTxFor for the full rationale.
  if (!addedMints.has(stakeMint.toBase58())) {
    const { ix: ixStakeRewardLine } = await addRewardMintIx({
      connection,
      authority: creatorPk,
      stakeMint,
      rewardMint: stakeMint,
    });
    tx.add(ixStakeRewardLine);
  }

  // Anti-rug: rotate authority to platform — see buildPoolRewardTxFor for the
  // full rationale. Same single tx the creator signs already.
  const platformAuthority = (config.authorityKeypair || config.treasuryKeypair).publicKey;
  if (!platformAuthority.equals(creatorPk)) {
    const { ix: ixRotateAuth } = await setPoolAuthorityIx({
      connection,
      authority: creatorPk,
      stakeMint,
      newAuthority: platformAuthority,
    });
    tx.add(ixRotateAuth);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = creatorPk;

  const poolRewardTxBase64 = Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString('base64');

  return {
    poolRewardTxBase64,
    lastValidBlockHeight,
    rewardMint: primaryRewardMint.toBase58(),
    rewardLines: effectiveLines,
  };
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
  const connection = getConnection();
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
  rewardLines = null,
  persistedMetadata,
  metadataUri,
  metadataSource = 'caller',
  initialBuySol = 0,
  autoStake = false,
  lockDays = 7,
  /** Venue used for the create tx — must match what `prepare` was called with. */
  launchSource = 'pumpfun',
}) {
  if (!createSig || !poolRewardSig || !mint || !creatorWallet?.trim()) {
    throw new Error('finalizeCreatorLaunch: createSig, poolRewardSig, mint, creatorWallet required');
  }
  if (!VALID_LAUNCH_SOURCES.includes(launchSource)) {
    throw new Error(`invalid launchSource '${launchSource}'`);
  }
  let creatorPk;
  let stakeMint;
  try {
    creatorPk = new PublicKey(creatorWallet.trim());
    stakeMint = new PublicKey(mint.trim());
  } catch {
    throw new Error('invalid mint or creatorWallet');
  }
  // Resolve effective reward lines for persistence: explicit array takes
  // precedence over legacy rewardMode. The first line's mint is the primary
  // reward mint that legacy single-line consumers (frontend stats, etc) read.
  const effectiveLines = Array.isArray(rewardLines) && rewardLines.length > 0
    ? rewardLines
    : null;
  const primaryRewardMintStr = effectiveLines
    ? effectiveLines[0].mint
    : (rewardMode === 'token' ? stakeMint.toBase58() : config.wsolMint.toBase58());
  const rewardMint = new PublicKey(primaryRewardMintStr);
  const connection = getConnection();

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
  } else if (config.lockFees.enabled && launchSource !== 'meteora') {
    // Lock was supposed to run but the client didn't sign — emit a warning so
    // ops can spot tokens that slipped through unlocked. Meteora launches
    // intentionally skip the lock step (their fee model is config-driven).
    log('launch:finalize WARNING lock_fees enabled but no lockFeesSig supplied', {
      mint: stakeMint.toBase58(),
    });
  }

  const onchainPool = await fetchPool({ connection, signer: null, stakeMint });
  if (!onchainPool) {
    throw new Error('stake pool not found on-chain after launch txs');
  }
  // Anti-rug rotation (see buildPoolRewardTxFor / buildUnsignedPoolRewardTxBase64)
  // moves pool.authority from the deployer to the platform authority in the
  // same tx initialize_pool runs in. So the on-chain authority can legally be
  // EITHER the deployer (legacy / pre-rotation pools) OR the platform key
  // (modern pools). Anything else is a real mismatch and we should bail.
  const platformAuthorityPk = (config.authorityKeypair || config.treasuryKeypair).publicKey;
  const authorityIsCreator = onchainPool.authority.equals(creatorPk);
  const authorityIsPlatform = onchainPool.authority.equals(platformAuthorityPk);
  if (!authorityIsCreator && !authorityIsPlatform) {
    throw new Error(
      `on-chain pool authority ${onchainPool.authority.toBase58()} matches neither the creator ${creatorPk.toBase58()} nor the platform authority ${platformAuthorityPk.toBase58()}`,
    );
  }
  // Registry distinguishes the wallet that *deployed* the token (used for
  // attribution, leaderboards, royalty payout records) from the on-chain
  // authority that controls the pool (used for ops). Pre-rotation they were
  // the same; post-rotation they're different and we need both.
  const canonicalCreator = creatorPk;
  const canonicalPoolAuthority = onchainPool.authority;

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

  // Persist the venue alongside the rest of the registry row. Cycle worker
  // dispatches by `launchSource` to pick the right claim path.
  const meteoraBlock = launchSource === 'meteora'
    ? {
        configKey: getMeteoraConfigKey().toBase58(),
        poolAddress: deriveMeteoraPoolAddress({ baseMint: stakeMint }).toBase58(),
        graduated: false, // flipped true after migration is detected
        createSig,
        metadataUri: metadataUri || null,
        metadataSource,
      }
    : null;
  const pumpfunBlock = launchSource === 'pumpfun'
    ? { createSig, metadataUri: metadataUri || null, metadataSource }
    : null;

  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMode,
    rewardLines: effectiveLines, // null for legacy single-reward pools
    platformFeeBps: config.platformFeeBps,
    launchFunding: 'creator',
    launchSource,
    poolAuthority: canonicalPoolAuthority.toBase58(),
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
    // Per-venue blocks (only one is set per pool). Keeping `pumpfun` for
    // back-compat with legacy registry consumers; new readers should switch
    // on `launchSource` and consult the matching block.
    pumpfun: pumpfunBlock,
    meteora: meteoraBlock,
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
    launchSource,
  });

  log('launch:finalize registry written', {
    mint: stakeMint.toBase58(),
    creator: canonicalCreator.toBase58(),
    rewardMode,
    launchSource,
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
 * Resume a launch that landed the on-chain create tx but never wrote a
 * registry row. Triggered by the "Recover failed launch" UI when the user's
 * pool-init tx failed (e.g. blockhash expiry between create + pool-init in
 * the original 1-bundle flow). The mint exists, the venue's bonding curve
 * exists, the staking pool was just initialised by the user (signed in the
 * recovery flow); we just need to verify everything and write the registry.
 *
 * `createSig` is optional — when missing we fetch the mint's signature
 * history and pick the earliest one (which is the create tx by construction;
 * SPL Token mint accounts are only ever populated once at creation).
 */
export async function recoverFinalizeLaunch({
  mint,
  creatorWallet,
  poolRewardSig,
  rewardMode = 'sol',
  rewardLines = null,
  persistedMetadata = {},
  metadataUri = null,
  metadataSource = 'recovery',
  launchSource = 'meteora',
  createSig: providedCreateSig = null,
}) {
  if (!mint || !creatorWallet?.trim() || !poolRewardSig) {
    throw new Error('recoverFinalizeLaunch: mint, creatorWallet, poolRewardSig required');
  }
  if (!VALID_LAUNCH_SOURCES.includes(launchSource)) {
    throw new Error(`invalid launchSource '${launchSource}'`);
  }
  let creatorPk;
  let stakeMint;
  try {
    creatorPk = new PublicKey(creatorWallet.trim());
    stakeMint = new PublicKey(mint.trim());
  } catch {
    throw new Error('invalid mint or creatorWallet');
  }
  const connection = getConnection();

  // Confirm the user's pool-init tx actually succeeded before we trust it.
  await confirmSucceeded(connection, poolRewardSig, 'pool+reward');

  // Resolve createSig — the venue's create tx that brought the mint into
  // existence. We need this to populate the registry's pumpfun.createSig /
  // meteora.createSig field for transparency. Fetched on-demand from RPC
  // history because the original /prepare context is gone by the time we
  // recover.
  let createSig = providedCreateSig?.trim() || null;
  if (!createSig) {
    const history = await connection.getSignaturesForAddress(stakeMint, { limit: 100 }, 'confirmed');
    if (!history || history.length === 0) {
      throw new Error('recoverFinalizeLaunch: no signature history for mint — was create tx confirmed?');
    }
    // history is newest-first; create tx is the OLDEST signature touching
    // the mint account (mint init only ever happens once).
    const oldest = history[history.length - 1];
    if (oldest.err) {
      throw new Error(`recoverFinalizeLaunch: oldest mint sig errored on-chain: ${oldest.signature}`);
    }
    createSig = oldest.signature;
  }
  await confirmSucceeded(connection, createSig, 'create');

  // Verify venue-specific bonding curve / pool exists on-chain. For Meteora,
  // also derive the pool address for the registry row.
  let meteoraBlock = null;
  let pumpfunBlock = null;
  if (launchSource === 'meteora') {
    const cfgKey = getMeteoraConfigKey();
    const poolAddr = deriveMeteoraPoolAddress({ baseMint: stakeMint, configKey: cfgKey });
    const poolAcc = await connection.getAccountInfo(poolAddr, 'confirmed');
    if (!poolAcc) {
      throw new Error(`recoverFinalizeLaunch: Meteora pool ${poolAddr.toBase58()} not found on-chain`);
    }
    meteoraBlock = {
      configKey: cfgKey.toBase58(),
      poolAddress: poolAddr.toBase58(),
      graduated: false,
      createSig,
      metadataUri: metadataUri || null,
      metadataSource,
    };
  } else {
    pumpfunBlock = { createSig, metadataUri: metadataUri || null, metadataSource };
  }

  // Pull on-chain metadata when the caller didn't supply a metadataUri /
  // image. Meteora launches use Token-2022 with the TokenMetadata extension
  // embedded in the mint, which includes the original IPFS URI. We then
  // fetch the JSON to recover the image URL so the token page renders the
  // same way it would have post-launch. Best-effort: failures here just
  // leave the registry row with whatever fields the caller provided.
  let resolvedMetadataUri = metadataUri || null;
  let resolvedMetadata = { ...(persistedMetadata || {}) };
  try {
    const mintInfo = await getMint(
      connection, stakeMint, 'confirmed', TOKEN_2022_PROGRAM_ID,
    ).catch(() => null);
    if (mintInfo) {
      const tm = await getTokenMetadata(
        connection, stakeMint, 'confirmed', TOKEN_2022_PROGRAM_ID,
      );
      if (tm) {
        if (!resolvedMetadataUri && tm.uri) resolvedMetadataUri = tm.uri;
        if (!resolvedMetadata.name && tm.name) resolvedMetadata.name = tm.name;
        if (!resolvedMetadata.symbol && tm.symbol) resolvedMetadata.symbol = tm.symbol;
      }
    }
    if (resolvedMetadataUri && !resolvedMetadata.image) {
      // 5s timeout — IPFS gateways can be slow but we don't want recovery
      // to hang on a bad URI. Failure here is non-fatal.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      try {
        const resp = await fetch(resolvedMetadataUri, { signal: ctrl.signal });
        if (resp.ok) {
          const j = await resp.json();
          if (!resolvedMetadata.image && j.image) resolvedMetadata.image = j.image;
          if (!resolvedMetadata.description && j.description) resolvedMetadata.description = j.description;
          if (!resolvedMetadata.twitter && j.twitter) resolvedMetadata.twitter = j.twitter;
          if (!resolvedMetadata.telegram && j.telegram) resolvedMetadata.telegram = j.telegram;
          if (!resolvedMetadata.website && j.website) resolvedMetadata.website = j.website;
        }
      } finally {
        clearTimeout(t);
      }
    }
    // If we resolved a URI off-chain, mirror it into the venue block too
    // (registry consumers read it from there for back-compat).
    if (meteoraBlock && resolvedMetadataUri && !meteoraBlock.metadataUri) {
      meteoraBlock.metadataUri = resolvedMetadataUri;
    }
    if (pumpfunBlock && resolvedMetadataUri && !pumpfunBlock.metadataUri) {
      pumpfunBlock.metadataUri = resolvedMetadataUri;
    }
  } catch (e) {
    log('launch:recover metadata pull failed (continuing)', { error: e.message });
  }

  // Verify on-chain staking-pool was initialised. The pool authority should
  // either be the creator (legacy / pre-rotation) or platform authority
  // (modern launches that include the rotation ix in the same tx).
  const onchainPool = await fetchPool({ connection, signer: null, stakeMint });
  if (!onchainPool) {
    throw new Error('recoverFinalizeLaunch: stake pool not found on-chain after poolRewardSig');
  }
  const platformAuthorityPk = (config.authorityKeypair || config.treasuryKeypair).publicKey;
  const authorityIsCreator = onchainPool.authority.equals(creatorPk);
  const authorityIsPlatform = onchainPool.authority.equals(platformAuthorityPk);
  if (!authorityIsCreator && !authorityIsPlatform) {
    throw new Error(
      `recoverFinalizeLaunch: on-chain pool authority ${onchainPool.authority.toBase58()} matches neither creator ${creatorPk.toBase58()} nor platform ${platformAuthorityPk.toBase58()}`,
    );
  }
  const canonicalPoolAuthority = onchainPool.authority;

  // Resolve effective reward lines + primary reward mint (mirrors finalize).
  const effectiveLines = Array.isArray(rewardLines) && rewardLines.length > 0
    ? rewardLines
    : null;
  const primaryRewardMintStr = effectiveLines
    ? effectiveLines[0].mint
    : (rewardMode === 'token' ? stakeMint.toBase58() : config.wsolMint.toBase58());
  const rewardMint = new PublicKey(primaryRewardMintStr);

  const rewardAcct = await fetchRewardMint({
    connection,
    signer: null,
    stakeMint,
    rewardMint,
  });
  if (!rewardAcct) {
    throw new Error('recoverFinalizeLaunch: reward mint line not registered on-chain');
  }

  const pool = upsertPool({
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    rewardMode,
    rewardLines: effectiveLines,
    platformFeeBps: config.platformFeeBps,
    launchFunding: 'creator',
    launchSource,
    poolAuthority: canonicalPoolAuthority.toBase58(),
    pumpFeeClaimer: config.treasuryKeypair.publicKey.toBase58(),
    creatorWallet: creatorPk.toBase58(),
    metadata: resolvedMetadata,
    pumpfun: pumpfunBlock,
    meteora: meteoraBlock,
    onchain: {
      poolInitSig: poolRewardSig,
      rewardInitSig: poolRewardSig,
    },
  });

  recordEvent({
    type: 'launch_recovered',
    stakeMint: stakeMint.toBase58(),
    creatorWallet: creatorPk.toBase58(),
    name: persistedMetadata?.name,
    symbol: persistedMetadata?.symbol,
    createSig,
    poolRewardSig,
    launchFunding: 'creator',
    launchSource,
  });

  log('launch:recover registry written', {
    mint: stakeMint.toBase58(),
    creator: creatorPk.toBase58(),
    launchSource,
    createSig,
    poolRewardSig,
  });

  return {
    ok: true,
    stakeMint: stakeMint.toBase58(),
    rewardMint: rewardMint.toBase58(),
    sigs: {
      create: createSig,
      poolInit: poolRewardSig,
      rewardInit: poolRewardSig,
    },
    pool,
    token: pool,
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
  const connection = getConnection();
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
