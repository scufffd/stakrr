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
import { buildClaimCreatorFeesTx, buildClaimDistributeTx, buildBuyTokenTx as buildPumpfunBuyTokenTx } from './pumpdev.js';
import {
  buildBuyTokenTx as buildMeteoraBuyTokenTx,
  buildClaimCreatorFeesTx as buildMeteoraClaimPartnerFeesTx,
  getPoolState as getMeteoraPoolState,
} from './meteora.js';
import { shouldAttemptClaim } from './dexscreener.js';
import {
  depositRewardsIx,
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
} from './stake-program.js';
import { addToPoolMetrics, recordEvent, updatePoolFields } from './registry.js';
import { pushClaimsForPool, listPoolRewardMints } from './auto-push-claims.js';
import { effectiveRewardLines, allocateByWeight } from './reward-lines.js';
import { executeSwap } from './jupiter.js';

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
// TARGET: every cycle must leave treasury balance ≥ TARGET after the cycle's
//         distribution + tx costs settle. We achieve this by computing a
//         forward-looking `maxDistributable` (treasury_after_claim −
//         TARGET − cycle_tx_cushion) and holding back whatever can't fit.
//         Holdback comes off the staker portion first, then the platform
//         fee if even a 100% staker holdback isn't enough — operational
//         expense before profit-sharing, since a drained treasury blocks
//         every future cycle for every pool until it's manually topped up.
// CYCLE_TX_COST_CUSHION: conservative estimate of all in-flight txs this
//         cycle still has to land (claim + deposit + sweep, or claim + buy
//         + deposit + sweep for token mode) at our current priority fee
//         settings. Without this cushion we'd distribute exactly down to
//         TARGET and end the cycle slightly below by the time fees clear.
const TREASURY_MIN_RESERVE_LAMPORTS = BigInt(
  Math.round((parseFloat(process.env.TREASURY_MIN_RESERVE_SOL || '0.005')) * 1e9),
);
const TREASURY_TARGET_RESERVE_LAMPORTS = BigInt(
  Math.round((parseFloat(process.env.TREASURY_TARGET_RESERVE_SOL || '0.05')) * 1e9),
);
const TREASURY_CYCLE_TX_COST_CUSHION_LAMPORTS = BigInt(
  Math.round((parseFloat(process.env.TREASURY_CYCLE_TX_COST_CUSHION_SOL || '0.002')) * 1e9),
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

/**
 * Top-level claim dispatcher. Picks the right code path for the token's venue:
 *   - `pumpfun` (default): legacy pump_fees flow (native distribute + claim).
 *   - `meteora`: partner-fee claim via Meteora DBC SDK.
 *
 * Returns the same shape regardless of venue:
 *   { claimedLamports: bigint, signature, distributeSig?, distributePath? }
 *
 * This wraps the existing pump.fun helper as `claimPumpfunCreatorFees` so the
 * (large, well-tested) flow stays intact while letting Meteora pools take a
 * separate, simpler path.
 */
async function claimCreatorFees(
  connection,
  treasury,
  { mint, feeLocked = false, launchSource = 'pumpfun', meteoraConfigKey = null } = {},
) {
  if (launchSource === 'meteora') {
    return claimMeteoraPartnerFees(connection, treasury, { mint, configKey: meteoraConfigKey });
  }
  return claimPumpfunCreatorFees(connection, treasury, { mint, feeLocked });
}

/**
 * Meteora claim path. The Stakrr-owned config sets `feeClaimer = treasury`
 * and `creatorTradingFeePercentage = 0`, so `claimPartnerTradingFee` collects
 * 100% of accumulated quote-token (SOL) fees in a single tx. The SDK handles
 * wSOL wrap/unwrap internally, so the treasury's native SOL balance reflects
 * the claim immediately and the existing `delta = after - before` accounting
 * works without modification.
 *
 * Pre-graduation: claim works against the virtual pool.
 * Post-graduation: claim still works for any unclaimed fees that accrued
 * pre-migration; new post-grad fees flow through the DAMM v2 pool's
 * partner-locked LP and require a separate flow (TODO: add a DAMM v2 fee
 * claim path; v1 just logs and returns 0).
 */
async function claimMeteoraPartnerFees(connection, treasury, { mint, configKey = null }) {
  const beforeLamports = await getSolBalance(connection, treasury.publicKey);

  // Probe pool state — skip the claim entirely if the pool is fully migrated
  // and we've already drained pre-grad fees in a prior cycle. We can't tell
  // that perfectly without reading the partner-fee accumulator, but checking
  // `isMigrated` lets us short-circuit the common "graduated and idle" case
  // and avoid the rent-create cost on the temp wSOL ATA.
  const state = await getMeteoraPoolState({ mint, configKey });
  if (!state) {
    log('claim: meteora pool state missing — skipping', { mint });
    return { claimedLamports: 0n, signature: null, distributeSig: null, distributePath: 'meteora-skip' };
  }

  let signature = null;
  try {
    const tx = await buildMeteoraClaimPartnerFeesTx({
      mint,
      feeClaimer: treasury.publicKey,
      payer: treasury.publicKey,
      receiver: treasury.publicKey,
      configKey,
    });

    // Priority fee — same posture as the pump.fun claim path.
    const priorityIx = priorityFeeIx();
    if (priorityIx) {
      tx.instructions.unshift(priorityIx);
    }

    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = treasury.publicKey;

    signature = await signAndPollConfirm(connection, tx, [treasury], {
      commitment: 'confirmed',
      label: 'meteora-claim-partner-fees',
    });
    log('claim: meteora partner fees claimed', {
      mint,
      sig: signature,
      isMigrated: state.isMigrated,
    });
  } catch (e) {
    // Common no-op error: "no fees to claim" — treat as a clean zero rather
    // than a failure so the cycle worker still updates lastClaimAttemptAt.
    const msg = String(e?.message || '');
    if (/no fees|nothing to claim|InsufficientLiquidity|nothing to distribute/i.test(msg)) {
      log('claim: meteora reported no fees to claim', { mint, reason: msg.slice(0, 200) });
      return { claimedLamports: 0n, signature: null, distributeSig: null, distributePath: 'meteora' };
    }
    log('claim: meteora claim failed', { mint, error: msg });
    return { claimedLamports: 0n, signature: null, distributeSig: null, distributePath: 'meteora' };
  }

  const afterLamports = await getSolBalance(connection, treasury.publicKey);
  const delta = afterLamports - beforeLamports;
  // Same fee-floor as pump path: discard tiny deltas that are just network
  // fee noise (priority fee + rent for ATAs not fully recovered, etc.).
  if (delta < 5_000n) {
    return {
      claimedLamports: 0n,
      signature,
      distributeSig: null,
      distributePath: 'meteora',
    };
  }
  return {
    claimedLamports: delta,
    signature,
    distributeSig: null,
    distributePath: 'meteora',
  };
}

async function claimPumpfunCreatorFees(connection, treasury, { mint, feeLocked = false } = {}) {
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

/**
 * Wrap `lamports` SOL into wSOL and `deposit_rewards` into the wSOL reward
 * line. Optionally bundles the platform fee sweep into the same tx for
 * atomicity (both move or neither). Returns `{ depositSig, sweepSig }`.
 *
 * Used by:
 *   - Single-line wSOL pools (legacy fast path, sweep bundled)
 *   - Multi-line pools with `pump-fees-direct` lines (sweep deferred to
 *     a standalone tx so it always runs regardless of which lines deposit)
 */
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
 * Multi-reward fan-out: convert `lamports` of treasury wSOL into the line's
 * target token via Jupiter, then `deposit_rewards(target_mint, acquiredRaw)`
 * into the reward line. Returns `{ depositSig, swapSig, acquiredRaw }` or
 * null if the swap returned 0 (no liquidity, route gone, etc).
 *
 * Failure-mode contract: this function CAN throw on submit/confirm errors.
 * The caller MUST wrap each line's call in try/catch so one bad line doesn't
 * break the others — that's the cycle's per-line resilience guarantee.
 */
async function depositJupSwapToPool({ connection, treasury, stakeMint, line, lamports }) {
  if (lamports <= 0n) return null;
  const targetMint = new PublicKey(line.mint);
  const slippageBps = line.slippageBps || 100;

  const swap = await executeSwap({
    connection,
    signer: treasury,
    inputMint: WSOL_MINT,
    outputMint: line.mint,
    amountLamports: lamports,
    slippageBps,
    label: `cycle:swap-${(line.label || line.mint).slice(0, 12)}`,
  });
  // Real failure path: quote/build/submit error. Per-line isolation —
  // the wSOL allocation stays in the treasury and gets re-attempted
  // next cycle on top of fresh accruals.
  if (!swap.ok) {
    log('cycle: jupiter swap failed', {
      stakeMint: stakeMint.toBase58(),
      line: line.mint,
      lamportsIn: lamports.toString(),
      reason: swap.error || 'unknown',
    });
    return null;
  }

  // After a successful swap, deposit the FULL ATA balance — not just the
  // swap delta. This is self-healing: if a previous cycle's swap
  // confirmed on-chain but our helper read 0 acquired (e.g. the
  // pre-fix detectTokenProgram bug, or RPC catch-up exceeding the
  // retry window), the orphan tokens left behind in the treasury ATA
  // get swept into the pool next cycle. The treasury's reward-mint
  // ATAs are only ever populated by this code path, so depositing
  // the full balance is safe.
  const tokenProgram = await detectTokenProgram(connection, targetMint);
  const treasuryAta = getAssociatedTokenAddressSync(
    targetMint,
    treasury.publicKey,
    false,
    tokenProgram,
  );
  let totalRaw = 0n;
  try {
    const acc = await getAccount(connection, treasuryAta, 'confirmed', tokenProgram);
    totalRaw = acc.amount;
  } catch {
    totalRaw = 0n;
  }
  if (totalRaw <= 0n) {
    log('cycle: jupiter swap returned no tokens', {
      stakeMint: stakeMint.toBase58(),
      line: line.mint,
      lamportsIn: lamports.toString(),
      swapSig: swap.sig,
    });
    return null;
  }

  const dep = await depositRewardsIx({
    connection,
    funder: treasury,
    stakeMint,
    rewardMint: targetMint,
    amountLamports: totalRaw,
  });
  const tx = new Transaction();
  const fee = priorityFeeIx();
  if (fee) tx.add(fee);
  tx.add(dep.ix);
  const depositSig = await signAndPollConfirm(connection, tx, [treasury], {
    commitment: 'confirmed',
    label: `deposit_rewards(${(line.label || line.mint).slice(0, 12)})`,
  });
  return { depositSig, swapSig: swap.sig, acquiredRaw: totalRaw };
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
 *
 * `launchSource` selects which curve to buy from:
 *   - `pumpfun` (default): PumpDev /api/trade-local against pump's BC.
 *   - `meteora`: Meteora DBC SDK swap against the per-mint virtual pool.
 *     Caller MUST gate on `pool.meteora.graduated === false` — this helper
 *     does not check graduation status and the SDK swap will fail post-grad.
 */
async function depositTokensToPool({
  connection,
  treasury,
  stakeMint,
  lamports,
  launchSource = 'pumpfun',
  meteoraConfigKey = null,
}) {
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

  // 1) Buy the launched token from the bonding curve. Both venues return a
  //    legacy Transaction — same downstream send/confirm flow.
  const solAmount = Number(lamports) / 1e9;
  let buyTx;
  let label;
  if (launchSource === 'meteora') {
    buyTx = await buildMeteoraBuyTokenTx({
      publicKey: treasury.publicKey,
      mint: stakeMint,
      solAmount,
      configKey: meteoraConfigKey,
    });
    // Meteora swap tx is unsigned — fill blockhash + feePayer + priority fee.
    const priorityIx = priorityFeeIx();
    if (priorityIx) buyTx.instructions.unshift(priorityIx);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    buyTx.recentBlockhash = blockhash;
    buyTx.feePayer = treasury.publicKey;
    label = 'meteora-buy';
  } else {
    buyTx = await buildPumpfunBuyTokenTx({
      publicKey: treasury.publicKey.toBase58(),
      mint: stakeMint.toBase58(),
      solAmount,
      slippage: 5,
      pool: 'auto',
    });
    label = 'pump-buy';
  }
  buyTx.sign([treasury]);
  const buySig = await connection.sendRawTransaction(buyTx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await confirmSignature(connection, buySig, { commitment: 'confirmed', label });

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

  // 2) Claim creator fees. The dispatcher branches by `pool.launchSource`:
  //    - `pumpfun` (default): legacy pump_fees flow (native distribute +
  //      claim-account / claim-distribute). Uses fee-sharing config when
  //      `pool.feeLock` is present.
  //    - `meteora`: partner-fee claim via Meteora DBC SDK. The Stakrr-owned
  //      config has feeClaimer=treasury and creatorTradingFeePercentage=0,
  //      so 100% of accrued SOL fees land in the treasury.
  const launchSourceForClaim = pool.launchSource || 'pumpfun';
  const meteoraConfigKey = pool.meteora?.configKey || null;
  const { claimedLamports, signature: claimSig, distributeSig, distributePath } = await claimCreatorFees(
    connection,
    treasury,
    {
      mint: pool.stakeMint,
      feeLocked: !!pool.feeLock,
      launchSource: launchSourceForClaim,
      meteoraConfigKey,
    },
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
  const splitResult = splitFees(claimedLamports);
  const platformBeforeReserve = splitResult.platform;
  const stakersBeforeReserve = splitResult.stakers;

  // === Reserve protection (forward-looking) ============================
  //
  // The OLD logic only held back when the treasury was already below TARGET
  // at the moment we measured — it didn't model what the balance would BE
  // after we sent `platform + stakers` out the door. That meant a cycle
  // could claim 1 SOL into a treasury holding 0.07 SOL (now 1.07 SOL,
  // comfortably above the 0.05 SOL target → no holdback), then send out
  // ~1 SOL leaving 0.07 SOL again. After a few cycles' worth of tx fees
  // and ATA rents the treasury slipped below MIN and every pool's cycle
  // started failing preflight (the `treasury_underfunded` state).
  //
  // The NEW logic computes `maxDistributable` as everything ABOVE the
  // reserve floor (target + cycle-tx cushion) and caps the outgoing
  // payment to that. Anything that can't fit is held back, prioritising:
  //
  //   1. Staker portion first  — variable revenue-share, can be paid next
  //                              cycle without breaking anyone.
  //   2. Platform fee second   — only if a 100% staker holdback isn't
  //                              enough; protects the reserve absolutely.
  //   3. Skip entirely         — if even both portions can't cover the
  //                              shortfall, hold the full claim and let
  //                              the next cycle pay it forward (treasury
  //                              just goes UP this round).
  //
  // Net effect: treasury balance after the cycle settles is always
  // ≥ TARGET_RESERVE, so the underfunded state becomes unreachable as
  // long as `claimedLamports > 0` keeps arriving and gross creator fees
  // exceed gross cycle costs (which they always do — fees are dollars,
  // costs are sub-cent).
  const treasuryAfterClaim = await getSolBalance(connection, treasury.publicKey);
  const reserveFloor = TREASURY_TARGET_RESERVE_LAMPORTS + TREASURY_CYCLE_TX_COST_CUSHION_LAMPORTS;
  const maxDistributable = treasuryAfterClaim > reserveFloor
    ? treasuryAfterClaim - reserveFloor
    : 0n;

  let platform = platformBeforeReserve;
  let stakers = stakersBeforeReserve;
  let reserveTopupFromStakers = 0n;
  let reserveTopupFromPlatform = 0n;

  const intendedSpend = platformBeforeReserve + stakersBeforeReserve;
  if (intendedSpend > maxDistributable) {
    const shortfall = intendedSpend - maxDistributable;
    if (shortfall <= stakersBeforeReserve) {
      reserveTopupFromStakers = shortfall;
      stakers = stakersBeforeReserve - shortfall;
    } else {
      reserveTopupFromStakers = stakersBeforeReserve;
      stakers = 0n;
      const remainingShortfall = shortfall - stakersBeforeReserve;
      reserveTopupFromPlatform =
        remainingShortfall < platformBeforeReserve ? remainingShortfall : platformBeforeReserve;
      platform = platformBeforeReserve - reserveTopupFromPlatform;
    }
  }
  const reserveTopupLamports = reserveTopupFromStakers + reserveTopupFromPlatform;
  // Sanity check — projected balance after this cycle's outflows must
  // sit at or above the floor. If not, our math drifted; refuse to
  // distribute and surface a clear error rather than risk underfunding.
  const projectedTreasuryAfter = treasuryAfterClaim - platform - stakers;
  if (projectedTreasuryAfter < TREASURY_TARGET_RESERVE_LAMPORTS) {
    log('cycle: reserve-protection assertion failed — refusing to distribute', {
      stakeMint: pool.stakeMint,
      treasuryAfterClaim: treasuryAfterClaim.toString(),
      platform: platform.toString(),
      stakers: stakers.toString(),
      projectedTreasuryAfter: projectedTreasuryAfter.toString(),
      targetReserve: TREASURY_TARGET_RESERVE_LAMPORTS.toString(),
    });
    return {
      status: 'reserve_protected',
      claimedLamports: claimedLamports.toString(),
      treasuryAfterClaim: treasuryAfterClaim.toString(),
      heldBackLamports: (platformBeforeReserve + stakersBeforeReserve).toString(),
    };
  }

  log('cycle: split', {
    stakeMint: pool.stakeMint,
    rewardMode,
    platform: platform.toString(),
    platformBeforeReserve: platformBeforeReserve.toString(),
    stakers: stakers.toString(),
    stakersBeforeReserve: stakersBeforeReserve.toString(),
    reserveTopupLamports: reserveTopupLamports.toString(),
    reserveTopupFromStakers: reserveTopupFromStakers.toString(),
    reserveTopupFromPlatform: reserveTopupFromPlatform.toString(),
    treasuryAfterClaim: treasuryAfterClaim.toString(),
    treasuryTargetReserve: TREASURY_TARGET_RESERVE_LAMPORTS.toString(),
    treasuryCycleTxCostCushion: TREASURY_CYCLE_TX_COST_CUSHION_LAMPORTS.toString(),
    maxDistributable: maxDistributable.toString(),
    projectedTreasuryAfter: projectedTreasuryAfter.toString(),
  });

  let depositSig = null;
  let buySig = null;
  let sweepSig = null;
  let rewardsDepositedRaw = '0';
  let rewardsDepositedLabel = stakers.toString(); // for SOL mode, lamports == raw

  // Resolve the effective reward-line plan for this pool. Single-line
  // legacy pools synthesise a one-entry array from rewardMode (see
  // `effectiveRewardLines`), so this code path covers BOTH old and new
  // pools without a registry migration.
  const rewardLines = effectiveRewardLines(pool);
  const isLegacySingleLine = !Array.isArray(pool.rewardLines) || pool.rewardLines.length === 0;
  const lineResults = []; // [{ line, ok, depositSig?, swapSig?, depositedRaw?, error? }]

  if (stakers > 0n && !onchain.totalEffective?.isZero?.()) {
    // FAST PATH: legacy single-line wSOL pool. Keep the bundled deposit+sweep
    // tx (saves one tx fee per cycle) — most pools today fall into this case.
    if (isLegacySingleLine && rewardLines[0].source === 'pump-fees-direct') {
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
      lineResults.push({ line: rewardLines[0], ok: !!depositSig, depositSig, depositedRaw: stakers.toString() });
      log('cycle: deposited wSOL to pool + swept platform fee', {
        stakeMint: pool.stakeMint,
        sig: depositSig,
        sweepBundled: !!sweepSig,
        platformLamports: platform.toString(),
      });
    } else if (isLegacySingleLine && rewardLines[0].source === 'pump-fees-swap-pumpdev') {
      // FAST PATH: legacy token-mode pool — buy stake_mint via the launch
      // venue's bonding curve (pump.fun OR meteora, dispatched by
      // `pool.launchSource`), deposit, then sweep platform fee as a
      // standalone tx. The source label `pump-fees-swap-pumpdev` is kept
      // for back-compat — semantically it just means "buy stake_mint from
      // the native curve" and the venue dispatch happens inside.
      // Meteora pools that have already graduated cannot be bought via
      // their virtual pool; gate here and skip rather than spending the
      // SOL on a guaranteed-to-fail swap.
      if (launchSourceForClaim === 'meteora') {
        const meteoraState = await getMeteoraPoolState({
          mint: pool.stakeMint,
          configKey: meteoraConfigKey,
        });
        if (meteoraState?.isMigrated) {
          log('cycle: meteora pool graduated — skipping token-mode buy', {
            stakeMint: pool.stakeMint,
            poolAddress: meteoraState.poolAddress.toBase58(),
          });
          // Hold the staker portion in the treasury — next cycle's check
          // will keep skipping until ops manually convert via Jupiter or
          // we add a DAMM-v2-aware buy path. The platform fee still gets
          // swept so we don't leak revenue collection.
          await sweepPlatformFeeStandalone({ connection, treasury, lamports: platform })
            .catch((e) => log('cycle: platform-fee sweep on grad-skip failed', { error: e.message }));
          return {
            status: 'meteora_graduated_token_mode_skipped',
            claimedLamports: claimedLamports.toString(),
          };
        }
      }
      const res = await depositTokensToPool({
        connection,
        treasury,
        stakeMint,
        lamports: stakers,
        launchSource: launchSourceForClaim,
        meteoraConfigKey,
      });
      if (res) {
        buySig = res.buySig;
        depositSig = res.depositSig;
        rewardsDepositedRaw = res.depositedRaw;
        rewardsDepositedLabel = res.depositedRaw;
        lineResults.push({ line: rewardLines[0], ok: !!depositSig, depositSig, swapSig: buySig, depositedRaw: res.depositedRaw });
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
      // MULTI-LINE PATH: split staker pot by weight, dispatch per source.
      // Per-line try/catch keeps one failed line from breaking the cycle.
      const allocations = allocateByWeight(stakers, rewardLines);
      log('cycle: multi-line allocations', {
        stakeMint: pool.stakeMint,
        lines: rewardLines.map((l, i) => ({ mint: l.mint, source: l.source, weightBps: l.weightBps, lamports: allocations[i].toString() })),
      });
      for (let i = 0; i < rewardLines.length; i += 1) {
        const line = rewardLines[i];
        const allocLamports = allocations[i];
        if (allocLamports === 0n || line.source === 'manual') {
          lineResults.push({ line, ok: true, skipped: line.source === 'manual' ? 'manual' : 'zero' });
          continue;
        }
        try {
          if (line.source === 'pump-fees-direct') {
            const res = await depositSolAsWsolToPool({
              connection,
              treasury,
              stakeMint,
              lamports: allocLamports,
              platformLamports: 0n, // sweep is standalone in multi-line mode
            });
            depositSig = depositSig || res.depositSig;
            lineResults.push({ line, ok: !!res.depositSig, depositSig: res.depositSig, depositedRaw: allocLamports.toString() });
            log('cycle: line deposited (direct wSOL)', {
              stakeMint: pool.stakeMint,
              line: line.mint,
              lamports: allocLamports.toString(),
              sig: res.depositSig,
            });
          } else if (line.source === 'pump-fees-swap-jup') {
            const res = await depositJupSwapToPool({
              connection,
              treasury,
              stakeMint,
              line,
              lamports: allocLamports,
            });
            if (res) {
              depositSig = depositSig || res.depositSig;
              lineResults.push({
                line, ok: true,
                depositSig: res.depositSig,
                swapSig: res.swapSig,
                depositedRaw: res.acquiredRaw.toString(),
              });
              log('cycle: line swapped + deposited (jup)', {
                stakeMint: pool.stakeMint,
                line: line.mint,
                lamportsIn: allocLamports.toString(),
                acquiredRaw: res.acquiredRaw.toString(),
                swapSig: res.swapSig,
                depositSig: res.depositSig,
              });
            } else {
              lineResults.push({ line, ok: false, error: 'jupiter returned no tokens' });
            }
          } else if (line.source === 'pump-fees-swap-pumpdev') {
            const res = await depositTokensToPool({
              connection,
              treasury,
              stakeMint,
              lamports: allocLamports,
              launchSource: launchSourceForClaim,
              meteoraConfigKey,
            });
            if (res) {
              depositSig = depositSig || res.depositSig;
              buySig = buySig || res.buySig;
              lineResults.push({
                line, ok: !!res.depositSig,
                depositSig: res.depositSig,
                swapSig: res.buySig,
                depositedRaw: res.depositedRaw,
              });
            } else {
              lineResults.push({ line, ok: false, error: 'pump-buy returned no tokens' });
            }
          }
        } catch (e) {
          // Per-line failure isolation — log and continue with the next line.
          // Treasury keeps the line's allocation (it stays as wSOL or SOL on
          // the treasury wallet), so funds are NOT lost — they'll be retried
          // next cycle as part of fresh fee accruals.
          log('cycle: line failed (continuing)', {
            stakeMint: pool.stakeMint,
            line: line.mint,
            source: line.source,
            error: e.message,
          });
          lineResults.push({ line, ok: false, error: e.message });
        }
      }
      // Standalone platform-fee sweep AFTER all lines (regardless of whether
      // any deposited successfully). Even if every line failed we still want
      // to skim the 2% — those lamports stay in the treasury otherwise.
      if (platform > 0n) {
        try {
          sweepSig = await sweepPlatformFeeStandalone({ connection, treasury, lamports: platform });
          if (sweepSig) log('cycle: swept platform fee (standalone)', { stakeMint: pool.stakeMint, sweepSig, lamports: platform.toString() });
        } catch (e) {
          log('cycle: platform-fee sweep failed (will retry next cycle)', { stakeMint: pool.stakeMint, error: e.message });
        }
      }
      // Roll up totals for legacy metrics. We use lamports-in (allocLamports
      // sum) as `rewardsDepositedRaw` for SOL-denominated metrics; per-line
      // raw amounts are recorded individually in the cycle event.
      const totalDepositedLamports = lineResults
        .filter((r) => r.ok && r.depositSig)
        .reduce((acc, r) => acc + BigInt(r.depositedRaw || 0n), 0n);
      rewardsDepositedRaw = totalDepositedLamports.toString();
      rewardsDepositedLabel = totalDepositedLamports.toString();
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

  // Per-line breakdown for the cycle event log — admins can inspect which
  // reward lines deposited successfully and which failed (and why).
  const rewardLinesEvent = lineResults.map((r) => ({
    mint: r.line.mint,
    label: r.line.label || null,
    source: r.line.source,
    weightBps: r.line.weightBps,
    ok: !!r.ok,
    skipped: r.skipped || null,
    depositSig: r.depositSig || null,
    swapSig: r.swapSig || null,
    depositedRaw: r.depositedRaw || null,
    error: r.error || null,
  }));

  recordEvent({
    type: 'cycle',
    stakeMint: pool.stakeMint,
    rewardMode,
    claimedLamports: claimedLamports.toString(),
    platformFeeLamports: platform.toString(),
    platformFeeVault: config.platformFeeVault?.toBase58() || null,
    rewardsDepositedRaw,
    rewardsDepositedLabel,
    rewardLines: rewardLinesEvent,
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
    rewardLines: rewardLinesEvent,
    claimSig,
    distributeSig,
    buySig,
    depositSig,
    sweepSig,
    pushedClaims: pushResult.totalPushed,
  };
}
