// Per-pool: for Stakrr-locked tokens (BondingCurve.creator = FeeSharingConfig PDA),
// PumpDev /api/claim-distribute settles the share vaults to all configured
// recipients (treasury gets 100%); the legacy /api/claim-account is then a no-op
// and we skip it. For un-locked legacy tokens we still call /api/claim-account
// against the treasury wallet. After settlement: split platform / stakers, wrap,
// deposit_rewards, then claim_push when the pool authority is the platform.

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { confirmSignature, signAndPollConfirm } from './confirm.js';
import {
  buildAmmTransferCreatorFeesToPumpIx,
  buildBondingCurveDistributeFeesIx,
  findCoinCreatorVaultAuthorityPda,
  findFeeSharingConfigPda,
  WSOL_MINT,
} from './pump-fees.js';
import {
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config, authoritySigner, getConnection } from './config.js';
import { wrapSolIxs } from './wsol.js';
import { buildClaimCreatorFeesTx, buildClaimDistributeTx, buildBuyTokenTx } from './pumpdev.js';
import { shouldAttemptClaim } from './dexscreener.js';
import {
  depositRewardsIx,
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
} from './stake-program.js';
import { addToPoolMetrics, recordEvent, updatePoolFields } from './registry.js';
import { pushClaimsForPool, listPoolRewardMints } from './auto-push-claims.js';

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

// Treasury operational reserve (lamports). The treasury wallet pays for every
// claim/distribute/wrap/deposit tx, so it needs a non-trivial buffer beyond
// the rent-exempt minimum. Each successful cycle is roughly net-zero on
// treasury's SOL (claimed → split → fully forwarded), but tx fees + occasional
// rent for new ATAs slowly bleed it. Without a reserve mechanism, treasury
// drains to zero, the next cycle fails with "insufficient funds for rent",
// and EVERY subsequent cycle fails the same way (silent breakage — caught
// during the GE9J/SQWARK staker-rewards investigation when claims hadn't
// run for 26+ hours despite real volume).
//
// MIN: hard floor — below this the cycle skips entirely with a clear alert.
// TARGET: cycles top treasury up to this if claimed funds allow, holding back
//         from the staker portion (NEVER from platform fee — that's revenue).
const TREASURY_MIN_RESERVE_LAMPORTS = BigInt(
  Math.round((parseFloat(process.env.TREASURY_MIN_RESERVE_SOL || '0.005')) * 1e9),
);
const TREASURY_TARGET_RESERVE_LAMPORTS = BigInt(
  Math.round((parseFloat(process.env.TREASURY_TARGET_RESERVE_SOL || '0.05')) * 1e9),
);

/**
 * Read the AMM coin_creator_vault WSOL ATA balance for `mint`. Returns 0n
 * when the ATA hasn't been allocated yet (pre-graduation, or a graduated
 * token that hasn't accumulated any AMM-side creator fees). Failure-safe:
 * any RPC error returns 0n so we fall back to BC-only distribute rather
 * than skipping the cycle.
 *
 * Used by the claim loop to decide whether to bundle the AMM→BC bridge ix.
 */
async function readAmmVaultWsolBalance(connection, mintPk) {
  try {
    const sharingConfig = findFeeSharingConfigPda(mintPk);
    const cvAuth = findCoinCreatorVaultAuthorityPda(sharingConfig);
    const cvAta = getAssociatedTokenAddressSync(WSOL_MINT, cvAuth, true);
    const info = await connection.getAccountInfo(cvAta, 'confirmed');
    if (!info || info.data.length < 72) return 0n;
    // SPL token account layout: amount lives at byte offset 64 (u64 LE).
    return info.data.readBigUInt64LE(64);
  } catch {
    return 0n;
  }
}

async function claimCreatorFees(connection, treasury, { mint, feeLocked = false } = {}) {
  const beforeLamports = await getSolBalance(connection, treasury.publicKey);
  let signature = null;
  let distributeSig = null;
  let distributePath = null; // 'native' | 'pumpdev' | null
  try {
    // Fee-sharing tokens: settle vault → shareholders first.
    //
    // Preferred path: build Pump BC's `DistributeCreatorFees` ix natively. We
    // own the discriminator + account layout (see pump-fees.js comments), and
    // it's a pure on-chain settlement — no PumpDev tip wallet involved. Saves
    // ~0.0025 SOL per cycle vs PumpDev's `/api/claim-distribute`.
    //
    // Fallback path: PumpDev's hosted endpoint (https://pumpdev.io/claim-distribute).
    // Used only if the native ix simulation/send fails (program upgrade, account
    // layout change, etc.) so we don't paint ourselves into a corner.
    if (mint && feeLocked) {
      try {
        const mintPk = new PublicKey(mint);
        // Atomic post-grad bridge: pump_amm `transfer_creator_fees_to_pump`
        // moves any AMM-side WSOL fees → BC creator vault as native lamports
        // first, then BC `DistributeCreatorFees` settles the entire vault to
        // the share table. We only include the bridge when the AMM vault
        // actually has non-trivial WSOL — otherwise the bridge's idempotent
        // ATA-create would waste ~0.002 SOL of rent on pre-grad tokens that
        // never have an AMM creator vault to drain. Threshold matches the
        // legacy claim threshold so we don't bother with dust either.
        // Discovered after yks7qy…pump silently leaked 13.1 SOL post-grad
        // before this fix (the BC vault returned 0-lamport claims while
        // real volume piled up in the untouched AMM vault).
        const ammVaultBalance = await readAmmVaultWsolBalance(connection, mintPk);
        const includeBridge = ammVaultBalance >= BigInt(config.minDistributeLamports || 0);
        if (ammVaultBalance > 0n) {
          log('claim: amm vault state', {
            mint,
            ammVaultLamports: ammVaultBalance.toString(),
            bridge: includeBridge ? 'include' : 'skip-below-threshold',
          });
        }

        const distributeIx = buildBondingCurveDistributeFeesIx({
          payer: treasury.publicKey,
          mint: mintPk,
        });
        const tx = new Transaction();
        if (includeBridge) {
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
        }
        const fee = priorityFeeIx();
        if (fee) tx.add(fee);
        if (includeBridge) {
          tx.add(buildAmmTransferCreatorFeesToPumpIx({ mint: mintPk }));
        }
        tx.add(distributeIx);
        distributeSig = await signAndPollConfirm(connection, tx, [treasury], {
          commitment: 'confirmed',
          label: includeBridge ? 'amm-bridge+native-distribute' : 'native-distribute',
        });
        distributePath = 'native';
        log('claim: native distribute ok', { mint, sig: distributeSig, bridged: includeBridge });
      } catch (eNative) {
        log('claim: native distribute failed, falling back to pumpdev', {
          mint,
          error: eNative.message,
        });
        try {
          const dist = await buildClaimDistributeTx({
            publicKey: treasury.publicKey.toBase58(),
            mint,
          });
          dist.sign([treasury]);
          distributeSig = await connection.sendRawTransaction(dist.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          });
          await confirmSignature(connection, distributeSig, { commitment: 'confirmed', label: 'pumpdev-distribute' });
          distributePath = 'pumpdev';
          log('claim: pumpdev distribute ok', { mint, sig: distributeSig });
        } catch (ePumpdev) {
          log('claim: both distribute paths failed', { mint, native: eNative.message, pumpdev: ePumpdev.message });
        }
      }
    } else if (mint) {
      // Non-locked legacy token still needs PumpDev (their hosted endpoint
      // also handles the `claim_account` flow for unshared creator-vaults).
      try {
        const dist = await buildClaimDistributeTx({
          publicKey: treasury.publicKey.toBase58(),
          mint,
        });
        dist.sign([treasury]);
        distributeSig = await connection.sendRawTransaction(dist.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmSignature(connection, distributeSig, { commitment: 'confirmed', label: 'pumpdev-distribute' });
        distributePath = 'pumpdev';
        log('claim: pumpdev distribute ok', { mint, sig: distributeSig });
      } catch (e) {
        log('claim: pumpdev distribute skipped', { mint, error: e.message });
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
      signature = await connection.sendRawTransaction(vt.serialize(), { skipPreflight: false, maxRetries: 3 });
      await confirmSignature(connection, signature, { commitment: 'confirmed', label: 'claim-account' });
    }
  } catch (e) {
    log('claim: pumpdev claim failed', { error: e.message });
    return { claimedLamports: 0n, signature: null, distributeSig, distributePath };
  }
  const afterLamports = await getSolBalance(connection, treasury.publicKey);
  const delta = afterLamports - beforeLamports;
  // Subtract a tx-fee floor; if delta is negative or tiny, treat as zero.
  if (delta < 5_000n) {
    return { claimedLamports: 0n, signature, distributeSig, distributePath };
  }
  return { claimedLamports: delta, signature, distributeSig, distributePath };
}

function splitFees(claimedLamports) {
  const platform = (claimedLamports * BigInt(config.platformFeeBps)) / 10_000n;
  const stakers = claimedLamports - platform;
  return { platform, stakers };
}

/**
 * Build a SystemProgram.transfer ix sweeping the platform fee out of the
 * treasury into the dedicated fee vault. Returns null when no vault is
 * configured (env unset) or amount is zero — caller should treat null as
 * "don't add this ix" so tx layout is unchanged in legacy deployments.
 */
function buildPlatformFeeSweepIx(treasury, lamports) {
  if (!config.platformFeeVault) return null;
  if (lamports <= 0n) return null;
  return SystemProgram.transfer({
    fromPubkey: treasury.publicKey,
    toPubkey: config.platformFeeVault,
    lamports: Number(lamports),
  });
}

async function depositSolAsWsolToPool({ connection, treasury, stakeMint, lamports, platformLamports = 0n }) {
  if (lamports <= 0n) return { depositSig: null, sweepSig: null };

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

  // Bundle the platform-fee sweep in the same tx — saves a network fee +
  // ensures it's atomic with the staker deposit (we either move both or
  // neither, never just the staker portion).
  const sweep = buildPlatformFeeSweepIx(treasury, platformLamports);
  if (sweep) tx.add(sweep);

  const signature = await signAndPollConfirm(connection, tx, [treasury], {
    commitment: 'confirmed',
    label: 'deposit_rewards(wsol)+sweep',
  });
  return { depositSig: signature, sweepSig: sweep ? signature : null };
}

/**
 * Token-reward mode can't piggy-back the sweep onto the deposit tx (that
 * tx has its own large account list). Sweep as a tiny standalone tx after
 * the deposit. ~5000 lamports network fee, paid by treasury.
 */
async function sweepPlatformFeeStandalone({ connection, treasury, lamports }) {
  const sweepIx = buildPlatformFeeSweepIx(treasury, lamports);
  if (!sweepIx) return null;
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(sweepIx);
  return signAndPollConfirm(connection, tx, [treasury], {
    commitment: 'confirmed',
    label: 'platform_fee_sweep',
  });
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
  const buySig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await confirmSignature(connection, buySig, { commitment: 'confirmed', label: 'pump-buy' });

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
  const depositSig = await signAndPollConfirm(connection, tx, [treasury], {
    commitment: 'confirmed',
    label: 'deposit_rewards(token)',
  });
  return { buySig, depositSig, depositedRaw: acquiredRaw.toString() };
}

// Auto-push of `claim_push` to active stakers is now handled by
// `auto-push-claims.js` (per-pool authority resolution, opt-out, threshold
// gating, multi-reward-line). The legacy in-file implementation that
// previously lived here was removed when the dedicated module landed.

export async function runPoolCycle({ pool }) {
  const stakeMint = new PublicKey(pool.stakeMint);
  const rewardMode = pool.rewardMode || 'sol';
  const rewardMint = rewardMode === 'token'
    ? stakeMint
    : new PublicKey(pool.rewardMint || config.wsolMint.toBase58());
  const connection = getConnection();
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

  // Preflight: treasury balance must be above the hard floor to even attempt
  // the claim — every claim/distribute tx is signed and rent-paid by treasury.
  // If we're underfunded, abort the cycle with a clear surfaceable status so
  // the admin dashboard can flag it (instead of silently looping on simulation
  // failures forever like before this check existed).
  const treasuryBalanceBefore = await getSolBalance(connection, treasury.publicKey);
  if (treasuryBalanceBefore < TREASURY_MIN_RESERVE_LAMPORTS) {
    log('cycle: TREASURY_UNDERFUNDED — skipping claim', {
      stakeMint: pool.stakeMint,
      treasury: treasury.publicKey.toBase58(),
      balanceLamports: treasuryBalanceBefore.toString(),
      minReserveLamports: TREASURY_MIN_RESERVE_LAMPORTS.toString(),
      targetReserveLamports: TREASURY_TARGET_RESERVE_LAMPORTS.toString(),
      hint: `top up treasury wallet (${treasury.publicKey.toBase58()}) to ≥ ${Number(TREASURY_TARGET_RESERVE_LAMPORTS) / 1e9} SOL — no claim cycles will run until then`,
    });
    updatePoolFields(pool.stakeMint, {
      lastClaimAttemptAt: new Date().toISOString(),
      lastClaimAttemptReason: 'treasury_underfunded',
      lastClaimAttemptEstimate: {
        balanceLamports: treasuryBalanceBefore.toString(),
        minReserveLamports: TREASURY_MIN_RESERVE_LAMPORTS.toString(),
        targetReserveLamports: TREASURY_TARGET_RESERVE_LAMPORTS.toString(),
      },
    });
    return {
      status: 'treasury_underfunded',
      treasury: treasury.publicKey.toBase58(),
      balanceLamports: treasuryBalanceBefore.toString(),
      minReserveLamports: TREASURY_MIN_RESERVE_LAMPORTS.toString(),
    };
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
  const { claimedLamports, signature: claimSig, distributeSig, distributePath } = await claimCreatorFees(
    connection,
    treasury,
    { mint: pool.stakeMint, feeLocked: !!pool.feeLock },
  );
  log('cycle: claimed', {
    stakeMint: pool.stakeMint,
    claimedLamports: claimedLamports.toString(),
    claimSig,
    distributeSig,
    distributePath,
  });
  if (claimedLamports > 0n) {
    updatePoolFields(pool.stakeMint, { lastClaimedAt: new Date().toISOString() });
  }
  if (claimedLamports < BigInt(config.minDistributeLamports)) {
    return { status: 'below_min_distribute', claimedLamports: claimedLamports.toString() };
  }

  // 2) Split fees.
  const { platform, stakers: stakersBeforeReserve } = splitFees(claimedLamports);

  // Operational reserve top-up: if the treasury is below the target reserve,
  // hold back lamports from the STAKER portion (never from platform — that's
  // the user's revenue) to refill it. This makes cycles self-sustaining over
  // the long run: after the first cycle following a near-empty treasury, we
  // back-fill the reserve from one cycle's stakers, and every subsequent
  // cycle is net-zero on reserve (so 100% of stakers portion goes to stakers).
  //
  // We re-measure treasury balance AFTER the claim — claimedLamports just
  // landed there, so it might already be above target without holdback.
  const treasuryAfterClaim = await getSolBalance(connection, treasury.publicKey);
  let reserveTopupLamports = 0n;
  if (treasuryAfterClaim < TREASURY_TARGET_RESERVE_LAMPORTS) {
    const needed = TREASURY_TARGET_RESERVE_LAMPORTS - treasuryAfterClaim;
    // Cap the holdback at 80% of the staker portion so a single tiny cycle
    // can't consume the entire claimed amount. Stakers always receive
    // something. After 2-3 cycles the reserve is fully topped up regardless.
    const maxHoldback = (stakersBeforeReserve * 8n) / 10n;
    reserveTopupLamports = needed > maxHoldback ? maxHoldback : needed;
  }
  const stakers = stakersBeforeReserve - reserveTopupLamports;

  log('cycle: split', {
    stakeMint: pool.stakeMint,
    rewardMode,
    platform: platform.toString(),
    stakers: stakers.toString(),
    stakersBeforeReserve: stakersBeforeReserve.toString(),
    reserveTopupLamports: reserveTopupLamports.toString(),
    treasuryAfterClaim: treasuryAfterClaim.toString(),
    treasuryTargetReserve: TREASURY_TARGET_RESERVE_LAMPORTS.toString(),
  });

  let depositSig = null;
  let buySig = null;
  let sweepSig = null;
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
        sweepSig = await sweepPlatformFeeStandalone({ connection, treasury, lamports: platform });
        if (sweepSig) log('cycle: swept platform fee', { stakeMint: pool.stakeMint, sweepSig, lamports: platform.toString() });
      }
    } else {
      const solRes = await depositSolAsWsolToPool({
        connection,
        treasury,
        stakeMint,
        lamports: stakers,
        platformLamports: platform,
      });
      depositSig = solRes.depositSig;
      sweepSig = solRes.sweepSig;
      rewardsDepositedRaw = stakers.toString();
      rewardsDepositedLabel = stakers.toString();
      log('cycle: deposited wSOL to pool + swept platform fee', {
        stakeMint: pool.stakeMint,
        sig: depositSig,
        sweepBundled: !!sweepSig,
        platformLamports: platform.toString(),
      });
    }
  }

  // 3) Auto-push to stakers — runs the upgraded module which:
  //    - tries platform_authority first, then per-pool env keys (POOL_AUTH /
  //      FAITH_KEYPAID for legacy SQWARK + FLfR pools)
  //    - skips wallets that have toggled `autoPush: false` in user-prefs
  //    - threshold-gates per (position, reward) pair to avoid dust pushes
  //    - iterates ALL registered reward mints (e.g. SQWARK has both wSOL +
  //      stake-mint reward lines for early-unstake penalty redistribution)
  //
  // We enumerate reward mints fresh from on-chain rather than trusting the
  // registry's `rewardMint` field — registry only tracks the primary reward
  // mode, but pools can have additional reward lines added over time.
  let pushResult = { totalPushed: 0, totalSkipped: 0, totalOptedOut: 0, txSigs: [] };
  if (depositSig) {
    try {
      const rewardMints = await listPoolRewardMints({ connection, stakeMint });
      if (rewardMints.length > 0) {
        pushResult = await pushClaimsForPool({ connection, stakeMint, rewardMints });
        log('cycle: pushed claims', { stakeMint: pool.stakeMint, ...pushResult });
      }
    } catch (e) {
      log('cycle: auto-push failed', { stakeMint: pool.stakeMint, error: e.message });
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
    platformFeeVault: config.platformFeeVault?.toBase58() || null,
    rewardsDepositedRaw,
    rewardsDepositedLabel,
    claimSig,
    distributeSig,
    buySig,
    depositSig,
    sweepSig,
    pushedClaims: pushResult.totalPushed,
    pushSkippedBelowThreshold: pushResult.totalSkipped,
    pushSkippedOptedOut: pushResult.totalOptedOut,
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
    sweepSig,
    pushedClaims: pushResult.totalPushed,
  };
}
