/**
 * Setup: deploy a Stakrr-owned Meteora DBC `config` PDA on mainnet.
 *
 * Meteora DBC configs are IMMUTABLE on-chain. To change the fee tier (or
 * any other curve param) we deploy a NEW config and rotate
 * METEORA_CONFIG_KEY in env. Existing pools that referenced the old config
 * continue using their original fee forever — only new launches pick up
 * the new config. This script is safe to re-run for redeployment.
 *
 * What it does:
 *   1. Picks a config keypair file based on the fee tier
 *      (`data/meteora-config-keypair-{bps}bps.json`) so multiple fee tiers
 *      can coexist on disk for easy rollback. Generates a fresh keypair
 *      if the file doesn't exist.
 *   2. Builds the "memecoin" curve preset (3k initial MC → 69k migration MC,
 *      SOL-quoted, 0% creator fee so 100% flows to partner = stakrr).
 *   3. Sets the trading fee (pre-grad) AND post-migration DAMM v2 LP fee
 *      to METEORA_FEE_BPS (default 200 = 2%).
 *   4. Calls `partner.createConfig()` and submits the tx with the treasury
 *      keypair as payer + feeClaimer + leftoverReceiver.
 *   5. Prints the resulting config public key. Caller MUST add it to env as
 *      `METEORA_CONFIG_KEY=<pubkey>` and restart the worker.
 *
 * Idempotent: if a config keypair file already exists on disk and the
 * matching config account exists on-chain, the script logs and exits
 * without spending any SOL.
 *
 * Cost: ~0.05 SOL one-time per fee tier (rent for the config account).
 * The config is shared across every Meteora launch deployed against it.
 *
 *   USAGE
 *   $ cd worker && node scripts/setup-meteora-config.js
 *   $ METEORA_FEE_BPS=200 node scripts/setup-meteora-config.js   # 2% fee
 *
 *   ENV NEEDED
 *   - PLATFORM_TREASURY_PRIVATE_KEY  (already set; pays + signs as feeClaimer)
 *   - METEORA_FEE_BPS                (optional, default 200. Allowed: 25, 30,
 *                                     100, 200, 400, 600 — must match an
 *                                     entry in MigrationFeeOption.)
 *   - METEORA_CONFIG_KEYPAIR_PATH    (optional. Default derived from fee tier
 *                                     so multiple tiers don't collide on disk.)
 *   - SOL_PRICE_USD                  (optional, defaults to 200; used to derive
 *                                     SOL-denominated mc targets from $3k/$69k)
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  buildCurveWithMarketCap,
  ActivationType,
  TokenType,
  TokenDecimal,
  TokenUpdateAuthorityOption,
  CollectFeeMode,
  BaseFeeMode,
  MigrationOption,
  MigrationFeeOption,
  MigratedCollectFeeMode,
  DammV2DynamicFeeMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { config, getConnection } from '../src/config.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

// --- 1. Pick fee tier + map to MigrationFeeOption enum ---------------------
//
// Pre-graduation `startingFeeBps`/`endingFeeBps` accept any value 0-9999, but
// the post-graduation DAMM v2 fee is constrained to a fixed enum (25, 30,
// 100, 200, 400, 600 bps). To keep pre/post fees consistent — i.e. trader
// experience doesn't shift across migration — we only allow fee tiers that
// have a matching MigrationFeeOption.
const FEE_TIER_TO_OPTION = {
  25:  MigrationFeeOption.FixedBps25,
  30:  MigrationFeeOption.FixedBps30,
  100: MigrationFeeOption.FixedBps100,
  200: MigrationFeeOption.FixedBps200,
  400: MigrationFeeOption.FixedBps400,
  600: MigrationFeeOption.FixedBps600,
};
const FEE_BPS = parseInt(process.env.METEORA_FEE_BPS || '200', 10);
if (!(FEE_BPS in FEE_TIER_TO_OPTION)) {
  throw new Error(
    `METEORA_FEE_BPS must be one of ${Object.keys(FEE_TIER_TO_OPTION).join(', ')} `
    + `(got: ${process.env.METEORA_FEE_BPS}). These are the only tiers DAMM v2 supports `
    + `for the post-graduation pool, and we keep pre/post fees aligned.`,
  );
}
const MIGRATION_FEE_OPTION = FEE_TIER_TO_OPTION[FEE_BPS];

// --- 2. Resolve config keypair file (per-fee-tier so tiers don't collide) ---
//
// Each fee tier gets its own keypair file. This way the operator can keep
// the old config around (still referenced by old pools) while deploying a
// new tier — `meteora-config-keypair-100bps.json` and
// `meteora-config-keypair-200bps.json` coexist cleanly.
const KEYPAIR_PATH = process.env.METEORA_CONFIG_KEYPAIR_PATH
  || path.resolve(process.cwd(), 'data', `meteora-config-keypair-${FEE_BPS}bps.json`);

function loadOrGenerateConfigKeypair() {
  if (fs.existsSync(KEYPAIR_PATH)) {
    const raw = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf8'));
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    log('config keypair: loaded from disk', { path: KEYPAIR_PATH, pubkey: kp.publicKey.toBase58() });
    return kp;
  }
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(KEYPAIR_PATH), { recursive: true });
  fs.writeFileSync(KEYPAIR_PATH, JSON.stringify(Array.from(kp.secretKey)));
  log('config keypair: generated + saved', { path: KEYPAIR_PATH, pubkey: kp.publicKey.toBase58() });
  return kp;
}

// --- 2. Curve preset: memecoin (3k → 69k mc, SOL-quoted) ---
//
// USD-target MCs are translated to quote-token (SOL) units. The Meteora curve
// is fixed at construction time — once deployed, MC values float in USD as
// SOL price moves. We snapshot the SOL price at deploy time and document it
// so future operators can verify the curve still tracks reasonable MC bands.
//
// SOL price: pinned via SOL_PRICE_USD env. Defaults to $200 — a conservative
// long-running average that gives sensible MC bands across a wide range of
// real SOL prices ($100-$300). If SOL price moves dramatically (>2x in
// either direction), redeploy with an updated SOL_PRICE_USD and rotate
// METEORA_CONFIG_KEY in env.
const SOL_PRICE_USD = parseFloat(process.env.SOL_PRICE_USD || '200');
if (!Number.isFinite(SOL_PRICE_USD) || SOL_PRICE_USD <= 0) {
  throw new Error(`SOL_PRICE_USD must be a positive number (got: ${process.env.SOL_PRICE_USD})`);
}

const INITIAL_MC_USD = 3_000;
const MIGRATION_MC_USD = 69_000;
const INITIAL_MC_SOL = INITIAL_MC_USD / SOL_PRICE_USD;       // ~15 SOL @ $200
const MIGRATION_MC_SOL = MIGRATION_MC_USD / SOL_PRICE_USD;   // ~345 SOL @ $200

function buildMemecoinCurve() {
  return buildCurveWithMarketCap({
    token: {
      // Standard SPL memecoin shape: 1B supply, 6 decimals (matches pump.fun
      // convention so wallets / dexscreener / Jupiter all index identically).
      tokenType: TokenType.SPL,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE, // SOL is 9 decimals
      tokenUpdateAuthority: TokenUpdateAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      // No tokens reserved for the platform — every token launched goes
      // to traders and the LP. Cleaner story for memecoin launches.
      leftover: 0,
    },
    fee: {
      // Flat trading fee at FEE_BPS (default 200 = 2%). Equivalent to
      // pump.fun's bonding-curve fee. Using FeeSchedulerLinear with
      // starting==ending makes the SDK happy without an actual schedule.
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: FEE_BPS,
          endingFeeBps: FEE_BPS,
          numberOfPeriod: 0,
          totalDuration: 0,
        },
      },
      dynamicFeeEnabled: false,
      // Fees collected in QUOTE TOKEN (SOL) only. Critical: any other mode
      // would split fees between SOL and the launched memecoin, requiring
      // us to swap base-token fees back to SOL on every cycle. Keeping it
      // pure SOL means the cycle worker's existing wSOL deposit path "just
      // works" without per-pool swap logic.
      collectFeeMode: CollectFeeMode.QuoteToken,
      // 100% of trading fees flow to the partner (stakrr platform treasury,
      // configured below as `feeClaimer`). The cycle worker then claims
      // these via `claimPartnerTradingFee` and deposits into the staking
      // pool's wSOL reward vault — same flow as pump.fun creator fees.
      creatorTradingFeePercentage: 0,
      // No extra creation fee — keep launches frictionless. Stakrr pays
      // the rent (~0.005-0.02 SOL per pool) out of platform revenue.
      poolCreationFee: 0,
      // We don't bundle a swap into the create tx (the firstBuyParam in
      // `createPoolWithFirstBuy` uses a separate ix), so leave this off.
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      // DAMM v2 — more capital efficient than v1, supports configurable
      // migrated-pool fees and locked LP fee streams.
      migrationOption: MigrationOption.MET_DAMM_V2,
      // Post-graduation pool fee — kept in lock-step with the pre-grad
      // FEE_BPS so the trader fee experience doesn't shift across
      // migration. The mapping is enforced by FEE_TIER_TO_OPTION above.
      migrationFeeOption: MIGRATION_FEE_OPTION,
      // No "migration fee" skim from the bonded SOL. Everything migrates
      // into the LP cleanly.
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      // 100% of post-migration LP locked permanently to the partner (stakrr).
      // Why this and not creator-locked: stakrr's whole value prop is "all
      // fees flow to stakers." Locking LP under stakrr keeps that promise
      // post-graduation — DAMM v2 trading fees on the migrated pool will
      // be claimable by stakrr (via partnerWithdrawSurplus or DAMM v2
      // claim flows) and can be deposited as staker rewards.
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 100,
      creatorLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    lockedVesting: {
      // No creator-side vesting — the partner-locked LP above already
      // covers our "rug-resistant" guarantee.
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp, // wall-clock seconds
    initialMarketCap: INITIAL_MC_SOL,
    migrationMarketCap: MIGRATION_MC_SOL,
  });
}

async function main() {
  const connection = getConnection();
  const treasury = config.treasuryKeypair;
  log('start', {
    treasury: treasury.publicKey.toBase58(),
    rpc: config.rpcUrl,
    feeBps: FEE_BPS,
    feePercent: `${(FEE_BPS / 100).toFixed(2)}%`,
    keypairPath: KEYPAIR_PATH,
    initialMcUsd: INITIAL_MC_USD,
    migrationMcUsd: MIGRATION_MC_USD,
    initialMcSol: INITIAL_MC_SOL,
    migrationMcSol: MIGRATION_MC_SOL,
    solPriceUsd: SOL_PRICE_USD,
  });

  // Quick balance check — config creation rents ~0.05 SOL plus tx fees.
  const balLamports = await connection.getBalance(treasury.publicKey, 'confirmed');
  if (balLamports < 0.1 * 1e9) {
    throw new Error(
      `treasury (${treasury.publicKey.toBase58()}) needs at least 0.1 SOL — current: ${(balLamports / 1e9).toFixed(4)} SOL`,
    );
  }

  const configKp = loadOrGenerateConfigKeypair();

  // Idempotency: if the config already exists on-chain we're done.
  const client = DynamicBondingCurveClient.create(connection, 'confirmed');
  try {
    const existing = await client.state.getPoolConfig(configKp.publicKey);
    if (existing) {
      log('config already exists on-chain — nothing to do', {
        configKey: configKp.publicKey.toBase58(),
      });
      console.log(`\nMETEORA_CONFIG_KEY=${configKp.publicKey.toBase58()}\n`);
      return;
    }
  } catch {
    // Account not found — proceed with creation. (getPoolConfig throws on
    // missing account; that's expected for first-time setup.)
  }

  const curveConfig = buildMemecoinCurve();
  log('curve config built', { feeClaimer: treasury.publicKey.toBase58() });

  const tx = await client.partner.createConfig({
    config: configKp.publicKey,
    feeClaimer: treasury.publicKey,        // stakrr is the partner — gets all trading fees
    leftoverReceiver: treasury.publicKey,  // catch-all for any base-token leftovers
    payer: treasury.publicKey,
    quoteMint: NATIVE_MINT,                 // wSOL
    ...curveConfig,
  });

  // Prepend a priority-fee ix so the createConfig lands quickly even on busy
  // mainnet slots. The default sendAndConfirmTransaction settings are fine
  // for everything else.
  if (config.priorityFeeMicroLamports > 0) {
    tx.instructions.unshift(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: config.priorityFeeMicroLamports,
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = treasury.publicKey;

  const sig = await sendAndConfirmTransaction(
    connection,
    tx,
    [treasury, configKp], // both must sign — config keypair authorises the new account
    { commitment: 'confirmed', skipPreflight: false, maxRetries: 3 },
  );
  log('config created', {
    configKey: configKp.publicKey.toBase58(),
    sig,
    explorer: `https://solscan.io/tx/${sig}`,
  });

  console.log(`

============================================================
  Meteora DBC config deployed (${(FEE_BPS / 100).toFixed(2)}% trading fee).

  Update your worker .env:

      METEORA_CONFIG_KEY=${configKp.publicKey.toBase58()}

  Then restart the API + loop services. Future Stakrr launches
  with launchSource='meteora' will reference this config.

  NOTE: Existing pools that referenced any prior config remain
  on their original fee tier — Meteora configs are immutable.
============================================================
  `);
}

main().catch((e) => {
  console.error('setup-meteora-config failed:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
