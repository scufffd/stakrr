// Per-pool: for Stakrr-locked tokens (BondingCurve.creator = FeeSharingConfig PDA),
// PumpDev /api/claim-distribute settles the share vaults to all configured
// recipients (treasury gets 100%); the legacy /api/claim-account is then a no-op
// and we skip it. For un-locked legacy tokens we still call /api/claim-account
// against the treasury wallet. After settlement: split platform / stakers, wrap,
// deposit_rewards, then claim_push when the pool authority is the platform.

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config, authoritySigner } from './config.js';
import { wrapSolIxs } from './wsol.js';
import { buildClaimCreatorFeesTx, buildClaimDistributeTx, buildBuyTokenTx } from './pumpdev.js';
import { shouldAttemptClaim } from './dexscreener.js';
import {
  depositRewardsIx,
  detectTokenProgram,
  fetchActivePositions,
  fetchPool,
  fetchRewardMint,
  findCheckpointPda,
  findPoolPda,
  findRewardMintPda,
  loadProgram,
} from './stake-program.js';
import { addToPoolMetrics, recordEvent, updatePoolFields } from './registry.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

function priorityFeeIx() {
  const micro = config.priorityFeeMicroLamports;
  if (!micro || micro <= 0) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro });
}

async function getSolBalance(connection, pubkey) {
  return BigInt(await connection.getBalance(pubkey, 'confirmed'));
}

async function claimCreatorFees(connection, treasury, { mint, feeLocked = false } = {}) {
  const beforeLamports = await getSolBalance(connection, treasury.publicKey);
  let signature = null;
  let distributeSig = null;
  try {
    // Fee-sharing tokens: settle vault → shareholders first (PumpDev claim-distribute).
    // https://pumpdev.io/claim-distribute — harmless to skip if mint has no share config.
    if (mint) {
      try {
        const dist = await buildClaimDistributeTx({
          publicKey: treasury.publicKey.toBase58(),
          mint,
        });
        dist.sign([treasury]);
        distributeSig = await connection.sendRawTransaction(dist.serialize(), {
          skipPreflight: false,
          maxRetries: 2,
        });
        await connection.confirmTransaction(distributeSig, 'confirmed');
        log('claim: claim-distribute ok', { mint, sig: distributeSig });
      } catch (e) {
        log('claim: claim-distribute skipped', { mint, error: e.message });
      }
    }

    // Locked tokens have no per-creator vault to claim from — the BC creator is
    // the FeeSharingConfig PDA, and claim-distribute already routed to
    // shareholders. Skip the legacy /api/claim-account call entirely.
    if (!feeLocked) {
      const vt = await buildClaimCreatorFeesTx({
        publicKey: treasury.publicKey.toBase58(),
        mint,
      });
      vt.sign([treasury]);
      signature = await connection.sendRawTransaction(vt.serialize(), { skipPreflight: false });
      await connection.confirmTransaction(signature, 'confirmed');
    }
  } catch (e) {
    log('claim: pumpdev claim failed', { error: e.message });
    return { claimedLamports: 0n, signature: null, distributeSig };
  }
  const afterLamports = await getSolBalance(connection, treasury.publicKey);
  const delta = afterLamports - beforeLamports;
  // Subtract a tx-fee floor; if delta is negative or tiny, treat as zero.
  if (delta < 5_000n) {
    return { claimedLamports: 0n, signature, distributeSig };
  }
  return { claimedLamports: delta, signature, distributeSig };
}

function splitFees(claimedLamports) {
  const platform = (claimedLamports * BigInt(config.platformFeeBps)) / 10_000n;
  const stakers = claimedLamports - platform;
  return { platform, stakers };
}

async function depositSolAsWsolToPool({ connection, treasury, stakeMint, lamports }) {
  if (lamports <= 0n) return null;

  const wrap = await wrapSolIxs({
    payer: treasury.publicKey,
    owner: treasury.publicKey,
    lamports,
  });

  const dep = await depositRewardsIx({
    connection,
    funder: treasury,
    stakeMint,
    rewardMint: config.wsolMint,
    amountLamports: lamports,
  });

  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  for (const ix of wrap.ixs) tx.add(ix);
  tx.add(dep.ix);

  const signature = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return signature;
}

/**
 * Token-reward path: spend `lamports` SOL on the bonding curve to buy the
 * launched mint, then deposit the resulting tokens as a separate tx.
 *
 * Returns `{ buySig, depositSig, depositedRaw }` or null if no tokens were
 * acquired (e.g. PumpDev rejection / curve issues).
 */
async function depositTokensToPool({ connection, treasury, stakeMint, lamports }) {
  if (lamports <= 0n) return null;

  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const treasuryAta = getAssociatedTokenAddressSync(
    stakeMint,
    treasury.publicKey,
    false,
    tokenProgram,
  );

  let beforeRaw = 0n;
  try {
    const acc = await getAccount(connection, treasuryAta, 'confirmed', tokenProgram);
    beforeRaw = acc.amount;
  } catch {
    beforeRaw = 0n;
  }

  // 1) Buy the launched token from the bonding curve.
  const solAmount = Number(lamports) / 1e9;
  const buyTx = await buildBuyTokenTx({
    publicKey: treasury.publicKey.toBase58(),
    mint: stakeMint.toBase58(),
    solAmount,
    slippage: 5,
    pool: 'auto',
  });
  buyTx.sign([treasury]);
  const buySig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: false });
  await connection.confirmTransaction(buySig, 'confirmed');

  // 2) Compute how many tokens we actually got, with a tiny retry to allow
  //    the ATA balance to settle on the RPC.
  let acquiredRaw = 0n;
  for (let i = 0; i < 5; i++) {
    try {
      const acc = await getAccount(connection, treasuryAta, 'confirmed', tokenProgram);
      const delta = acc.amount - beforeRaw;
      if (delta > 0n) { acquiredRaw = delta; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 600));
  }
  if (acquiredRaw <= 0n) {
    log('cycle: token swap returned 0 tokens', { stakeMint: stakeMint.toBase58(), buySig });
    return { buySig, depositSig: null, depositedRaw: '0' };
  }

  // 3) deposit_rewards(token) into the pool's reward vault.
  const dep = await depositRewardsIx({
    connection,
    funder: treasury,
    stakeMint,
    rewardMint: stakeMint,
    amountLamports: acquiredRaw,
  });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(dep.ix);
  const depositSig = await sendAndConfirmTransaction(connection, tx, [treasury], {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return { buySig, depositSig, depositedRaw: acquiredRaw.toString() };
}

// Build a single claim_push instruction for a given (position, rewardMintPda).
// Caller passes `tokenProgram` since reward mints can be classic SPL (wSOL) or
// Token-2022 (pump.fun launches).
async function buildClaimPushIx({
  connection,
  authority,
  stakeMint,
  rewardMint,
  position,
  positionOwner,
  tokenProgram,
}) {
  const program = loadProgram(connection, authority);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const userTokenAccount = getAssociatedTokenAddressSync(rewardMint, positionOwner, false, tokenProgram);

  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    authority.publicKey,
    userTokenAccount,
    positionOwner,
    rewardMint,
    tokenProgram,
  );

  const ix = await program.methods
    .claimPush()
    .accounts({
      pool,
      authority: authority.publicKey,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault,
      position,
      checkpoint,
      userTokenAccount,
      tokenProgram,
      systemProgram: SystemProgram.programId,
      rent: new PublicKey('SysvarRent111111111111111111111111111111111'),
    })
    .instruction();

  return { ataIx, ix };
}

const TX_PACKET_BUDGET_BYTES = 1180;

function packIxs({ groups, feePayer, recentBlockhash }) {
  const txs = [];
  let current = new Transaction();
  current.feePayer = feePayer;
  current.recentBlockhash = recentBlockhash;
  const fee = priorityFeeIx();
  if (fee) current.add(fee);

  const trySerialize = (tx) => {
    try {
      return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
    } catch {
      return Number.MAX_SAFE_INTEGER;
    }
  };

  for (const group of groups) {
    const trial = Transaction.from(current.serialize({ requireAllSignatures: false, verifySignatures: false }));
    trial.feePayer = feePayer;
    trial.recentBlockhash = recentBlockhash;
    for (const ix of group) trial.add(ix);
    if (trySerialize(trial) <= TX_PACKET_BUDGET_BYTES) {
      for (const ix of group) current.add(ix);
    } else {
      // current is full, push it and start a new one with this group.
      if (current.instructions.length > (priorityFeeIx() ? 1 : 0)) txs.push(current);
      current = new Transaction();
      current.feePayer = feePayer;
      current.recentBlockhash = recentBlockhash;
      const f = priorityFeeIx();
      if (f) current.add(f);
      for (const ix of group) current.add(ix);
    }
  }
  if (current.instructions.length > (priorityFeeIx() ? 1 : 0)) txs.push(current);
  return txs;
}

async function pushClaimsToActiveStakers({ connection, stakeMint, rewardMint }) {
  const authority = authoritySigner();
  const positions = await fetchActivePositions({ connection, signer: authority, stakeMint });
  if (positions.length === 0) {
    return { pushed: 0, skipped: 0, txSigs: [] };
  }
  const tokenProgram = await detectTokenProgram(connection, rewardMint);

  const groups = [];
  for (const p of positions) {
    try {
      const { ataIx, ix } = await buildClaimPushIx({
        connection,
        authority,
        stakeMint,
        rewardMint,
        position: p.publicKey,
        positionOwner: p.account.owner,
        tokenProgram,
      });
      groups.push([ataIx, ix]);
    } catch (e) {
      log('claim_push: build failed', { position: p.publicKey.toBase58(), error: e.message });
    }
  }
  if (groups.length === 0) return { pushed: 0, skipped: positions.length, txSigs: [] };

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const txs = packIxs({ groups, feePayer: authority.publicKey, recentBlockhash: blockhash });
  const sigs = [];
  for (const tx of txs) {
    try {
      const s = await sendAndConfirmTransaction(connection, tx, [authority], {
        commitment: 'confirmed',
        preflightCommitment: 'confirmed',
      });
      sigs.push(s);
    } catch (e) {
      log('claim_push: tx failed', { error: e.message });
    }
  }
  return { pushed: groups.length, skipped: positions.length - groups.length, txSigs: sigs };
}

export async function runPoolCycle({ pool }) {
  const stakeMint = new PublicKey(pool.stakeMint);
  const rewardMode = pool.rewardMode || 'sol';
  const rewardMint = rewardMode === 'token'
    ? stakeMint
    : new PublicKey(pool.rewardMint || config.wsolMint.toBase58());
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  // Locked tokens route fees via FeeSharingConfig → claim-distribute settles
  // straight to the configured shareholders, so the pumpFeeClaimer mismatch
  // warning is irrelevant here.
  if (
    !pool.feeLock
    && pool.launchFunding !== 'creator'
    && pool.pumpFeeClaimer
    && pool.pumpFeeClaimer !== treasury.publicKey.toBase58()
  ) {
    log('cycle: WARNING pumpFeeClaimer in registry differs from PLATFORM_TREASURY — worker still signs claims with treasury', {
      stakeMint: pool.stakeMint,
      pumpFeeClaimer: pool.pumpFeeClaimer,
      treasury: treasury.publicKey.toBase58(),
    });
  }

  const onchain = await fetchPool({ connection, signer: authority, stakeMint });
  if (!onchain) {
    log('cycle: pool not initialized', { stakeMint: pool.stakeMint });
    return { status: 'pool_uninitialized' };
  }
  if (onchain.totalEffective?.isZero?.()) {
    log('cycle: pool has zero effective stake, skipping deposit', { stakeMint: pool.stakeMint });
  }

  const reward = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint,
  });
  if (!reward) {
    log('cycle: reward mint not registered, skipping', {
      stakeMint: pool.stakeMint,
      rewardMint: rewardMint.toBase58(),
      rewardMode,
    });
    return { status: 'reward_unregistered' };
  }

  // 1) Pre-claim probe via DexScreener. Pump.fun's `CollectCreatorFee`
  //    instruction returns "no creator fee to collect" silently when nothing
  //    has accrued, but we still pay tx + priority fees (~0.0026 SOL). Skip
  //    the claim entirely when DexScreener says there hasn't been enough
  //    volume since our last successful claim.
  const probe = await shouldAttemptClaim({
    mint: pool.stakeMint,
    lastClaimedAt: pool.lastClaimedAt,
    lastClaimAttemptAt: pool.lastClaimAttemptAt,
    // Require ~2× the average claim tx cost in projected creator fees before
    // we attempt — keeps us net-positive even on noisy probes.
    minLamports: 6_000n,
  });
  log('cycle: pre-claim probe', {
    stakeMint: pool.stakeMint,
    attempt: probe.attempt,
    reason: probe.reason,
    estimate: probe.est ? {
      window: probe.est.window,
      elapsedSec: probe.est.elapsedSec,
      volumeUsd: probe.est.volumeUsd,
      accruedLamports: probe.est.accruedLamports,
      source: probe.est.source,
    } : null,
  });
  // Always update lastClaimAttemptAt so the catch-up timer is correct.
  updatePoolFields(pool.stakeMint, {
    lastClaimAttemptAt: new Date().toISOString(),
    lastClaimAttemptReason: probe.reason,
    lastClaimAttemptEstimate: probe.est || null,
  });
  if (!probe.attempt) {
    return {
      status: 'skipped_no_volume',
      reason: probe.reason,
      estimate: probe.est || null,
    };
  }

  // 2) Claim creator fees. We pass the pool's stakeMint so PumpDev uses the
  //    correct claim instruction when fee-sharing is configured. Locked tokens
  //    rely entirely on claim-distribute (the BC creator is a PDA, not the
  //    treasury) so we skip the legacy claim-account call for them.
  const { claimedLamports, signature: claimSig, distributeSig } = await claimCreatorFees(
    connection,
    treasury,
    { mint: pool.stakeMint, feeLocked: !!pool.feeLock },
  );
  log('cycle: claimed', {
    stakeMint: pool.stakeMint,
    claimedLamports: claimedLamports.toString(),
    claimSig,
    distributeSig,
  });
  if (claimedLamports > 0n) {
    updatePoolFields(pool.stakeMint, { lastClaimedAt: new Date().toISOString() });
  }
  if (claimedLamports < BigInt(config.minDistributeLamports)) {
    return { status: 'below_min_distribute', claimedLamports: claimedLamports.toString() };
  }

  // 2) Split fees.
  const { platform, stakers } = splitFees(claimedLamports);
  log('cycle: split', {
    stakeMint: pool.stakeMint,
    rewardMode,
    platform: platform.toString(),
    stakers: stakers.toString(),
  });

  let depositSig = null;
  let buySig = null;
  let rewardsDepositedRaw = '0';
  let rewardsDepositedLabel = stakers.toString(); // for SOL mode, lamports == raw

  if (stakers > 0n && !onchain.totalEffective?.isZero?.()) {
    if (rewardMode === 'token') {
      const res = await depositTokensToPool({
        connection,
        treasury,
        stakeMint,
        lamports: stakers,
      });
      if (res) {
        buySig = res.buySig;
        depositSig = res.depositSig;
        rewardsDepositedRaw = res.depositedRaw;
        rewardsDepositedLabel = res.depositedRaw;
        log('cycle: swapped SOL to token + deposited', {
          stakeMint: pool.stakeMint,
          buySig,
          depositSig,
          depositedRaw: res.depositedRaw,
        });
      }
    } else {
      depositSig = await depositSolAsWsolToPool({
        connection,
        treasury,
        stakeMint,
        lamports: stakers,
      });
      rewardsDepositedRaw = stakers.toString();
      rewardsDepositedLabel = stakers.toString();
      log('cycle: deposited wSOL to pool', { stakeMint: pool.stakeMint, sig: depositSig });
    }
  }

  // 3) Push to stakers (only if we deposited and platform owns the pool — claim_push signs as authority).
  let pushResult = { pushed: 0, skipped: 0, txSigs: [] };
  if (depositSig) {
    const poolAuthorityMatches = onchain.authority.equals(authority.publicKey);
    if (poolAuthorityMatches) {
      pushResult = await pushClaimsToActiveStakers({ connection, stakeMint, rewardMint });
      log('cycle: pushed claims', { stakeMint: pool.stakeMint, ...pushResult });
    } else {
      log('cycle: skipping claim_push (pool authority is not platform authority; stakers claim from UI)', {
        stakeMint: pool.stakeMint,
        poolAuthority: onchain.authority.toBase58(),
        workerAuthority: authority.publicKey.toBase58(),
      });
    }
  }

  // 4) Update metrics. We bookkeep SOL-denominated metrics regardless (so the
  //    UI can always show "creator fees claimed in SOL" + "platform fee in SOL")
  //    and only fill in token-denominated fields when rewardMode === 'token'.
  const metricsDelta = {
    totalCreatorFeesClaimedLamports: claimedLamports.toString(),
    totalPlatformFeesLamports: platform.toString(),
  };
  if (rewardMode === 'token') {
    metricsDelta.totalRewardsTokenRaw = rewardsDepositedRaw;
  } else {
    metricsDelta.totalRewardsDistributedLamports = stakers.toString();
  }
  addToPoolMetrics(pool.stakeMint, metricsDelta);

  recordEvent({
    type: 'cycle',
    stakeMint: pool.stakeMint,
    rewardMode,
    claimedLamports: claimedLamports.toString(),
    platformFeeLamports: platform.toString(),
    rewardsDepositedRaw,
    rewardsDepositedLabel,
    claimSig,
    distributeSig,
    buySig,
    depositSig,
    pushedClaims: pushResult.pushed,
    pushTxSigs: pushResult.txSigs,
  });

  return {
    status: 'ok',
    rewardMode,
    claimedLamports: claimedLamports.toString(),
    platformFeeLamports: platform.toString(),
    rewardsDepositedRaw,
    claimSig,
    distributeSig,
    buySig,
    depositSig,
    pushedClaims: pushResult.pushed,
  };
}
