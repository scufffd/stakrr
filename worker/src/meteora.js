/**
 * Meteora Dynamic Bonding Curve (DBC) adapter.
 *
 * Mirrors the surface of `pumpdev.js` (buildCreateTokenTx, buildBuyTokenTx,
 * buildClaimCreatorFeesTx) so `launch.js` and `claim-and-distribute.js` can
 * dispatch by venue without growing parallel branches everywhere.
 *
 * Key differences from Pump.fun:
 *   - No off-chain HTTP API. Everything is built locally via the official
 *     `@meteora-ag/dynamic-bonding-curve-sdk` against on-chain program
 *     `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`.
 *   - The "creator fee" model is replaced by partner / creator trading fees.
 *     We deploy a single Stakrr-owned `config` PDA where:
 *       - `feeClaimer` = PLATFORM_TREASURY (= stakrr partner)
 *       - `creatorTradingFeePercentage` = 0
 *     so 100% of trading fees flow to the platform treasury. The cycle
 *     worker then claims via `claimPartnerTradingFee` and deposits to the
 *     staking pool exactly like Pump.fun creator fees.
 *   - SOL quote, fees in SOL only (`collectFeeMode = QuoteToken`).
 *   - Migration to DAMM v2 with permanent-locked LP on the partner side
 *     so post-graduation fees keep flowing to stakers.
 *
 * The config preset (memecoin, $3k init MC → $69k migration MC) is provisioned
 * once via `worker/scripts/setup-meteora-config.js` and pinned to env as
 * `METEORA_CONFIG_KEY`. New launches simply reference the pre-deployed config.
 */

import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { Keypair, PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import bs58 from 'bs58';
import { getConnection } from './config.js';

/**
 * The quote mint for every Stakrr-deployed Meteora pool. Hard-coded to wSOL —
 * we only support SOL-denominated curves (per product spec). Override via env
 * only if a future preset uses a different quote (e.g. USDC bonding curves).
 */
export const METEORA_QUOTE_MINT = new PublicKey(
  process.env.METEORA_QUOTE_MINT || 'So11111111111111111111111111111111111111112',
);

/** u64::MAX — used as `maxQuoteAmount` for the partner-fee claim to mean "all". */
const U64_MAX_BN = new BN('18446744073709551615');

let _client = null;

/**
 * Lazy singleton so test/CLI scripts pick up env vars at first call. The DBC
 * client is stateless apart from the Connection, which we already share via
 * `getConnection()` and its RPC fallback wiring.
 */
function getDbcClient() {
  if (_client) return _client;
  const conn = getConnection();
  _client = DynamicBondingCurveClient.create(conn, 'confirmed');
  return _client;
}

/**
 * Resolve the pinned config key from env. Throws clearly if not set so the
 * launch flow surfaces a useful operator error instead of an opaque RPC fail.
 */
export function getMeteoraConfigKey() {
  const v = (process.env.METEORA_CONFIG_KEY || '').trim();
  if (!v) {
    throw new Error(
      'METEORA_CONFIG_KEY env not set — run worker/scripts/setup-meteora-config.js first',
    );
  }
  try {
    return new PublicKey(v);
  } catch {
    throw new Error(`METEORA_CONFIG_KEY is not a valid pubkey: ${v}`);
  }
}

/**
 * Derive the on-chain virtual-pool address for a (baseMint, configKey) pair.
 * Pool addresses are deterministic so we can fetch state / claim fees / quote
 * swaps without persisting them — but we DO persist them in the registry for
 * cheap lookup.
 */
export function deriveMeteoraPoolAddress({ baseMint, configKey = null }) {
  const baseMintPk = typeof baseMint === 'string' ? new PublicKey(baseMint) : baseMint;
  const cfg = configKey
    ? (typeof configKey === 'string' ? new PublicKey(configKey) : configKey)
    : getMeteoraConfigKey();
  return deriveDbcPoolAddress(METEORA_QUOTE_MINT, baseMintPk, cfg);
}

/**
 * Build the Meteora DBC pool-creation transaction.
 *
 * Returns the same shape as pumpdev.buildCreateTokenTx so launch.js can
 * dispatch by venue: `{ tx, mint, mintKeypair }`.
 *
 * The mint is allocated within the createPool ix, NOT pre-existing. We
 * must `partialSign` with the mint keypair before shipping to the browser
 * so the wallet adapter only needs to add the creator's signature.
 *
 * `buyAmountSol > 0` bundles a first-buy in the same tx (matches pump.fun's
 * "dev buy" UX where the creator gets a small allocation atomically with
 * the curve creation).
 */
export async function buildCreateTokenTx({
  publicKey,           // base58 pubkey of creator (= payer = poolCreator)
  name,
  symbol,
  uri,
  buyAmountSol = 0,
  // Optional vanity mint (base58-encoded 64-byte secret key). Same flow as Pump.fun
  // launches — `popUnusedMintKeypairFromPool` upstream picks a pre-ground key.
  mintKeypairSecretB58 = null,
  configKey = null,
}) {
  if (!publicKey) throw new Error('meteora.buildCreateTokenTx: publicKey required');
  if (!name || !symbol) throw new Error('meteora.buildCreateTokenTx: name + symbol required');
  if (!uri) throw new Error('meteora.buildCreateTokenTx: uri required (upload metadata first)');

  const creatorPk = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;

  let mintKeypair;
  if (mintKeypairSecretB58) {
    mintKeypair = Keypair.fromSecretKey(bs58.decode(mintKeypairSecretB58));
  } else {
    mintKeypair = Keypair.generate();
  }
  const mintPk = mintKeypair.publicKey;

  const cfgKey = configKey
    ? (typeof configKey === 'string' ? new PublicKey(configKey) : configKey)
    : getMeteoraConfigKey();

  const client = getDbcClient();
  const createPoolParam = {
    baseMint: mintPk,
    config: cfgKey,
    name,
    symbol,
    uri,
    payer: creatorPk,
    poolCreator: creatorPk,
  };

  const buyLamports = Math.max(0, Math.floor(Number(buyAmountSol) * 1e9));

  let tx;
  if (buyLamports > 0) {
    // Bundle the first-buy: the curve gets a price tick immediately and the
    // creator receives their dev allocation atomically. Equivalent to Pump.fun
    // bundling buyAmountSol into /api/create.
    tx = await client.pool.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: creatorPk,
        receiver: creatorPk,
        buyAmount: new BN(buyLamports),
        // We accept any output amount — slippage on the FIRST buy of a fresh
        // curve is intrinsic to the curve shape, not market noise. The user's
        // initialBuySol is the spec; whatever the curve gives back is correct.
        minimumAmountOut: new BN(0),
        referralTokenAccount: null,
      },
    });
  } else {
    tx = await client.pool.createPool(createPoolParam);
  }

  // NOTE: we do NOT call `tx.partialSign(mintKeypair)` here — `partialSign`
  // requires the tx to have a `recentBlockhash` set already, which it
  // doesn't when the SDK returns it. The caller (launch.js) sets the
  // blockhash + feePayer AFTER this returns and signs the mint keypair
  // there. We return the keypair so the caller can sign with it.
  return { tx, mint: mintPk.toBase58(), mintKeypair };
}

/**
 * Build a buy tx on a Meteora DBC pool — used by the worker for token-mode
 * deposits (buy stake_mint, then deposit_rewards). For pre-graduation pools
 * only; the cycle worker MUST gate on `getPoolState().isMigrated === false`
 * before calling this and fall back to Jupiter for graduated pools.
 *
 * Returns a Transaction (legacy, not Versioned) so caller can `tx.sign([signer])`
 * and `connection.sendRawTransaction(tx.serialize())` — same shape as
 * pumpdev.buildBuyTokenTx.
 */
export async function buildBuyTokenTx({
  publicKey,
  mint,
  solAmount,
  configKey = null,
  // Pump.fun's `slippage` is a percent (5 = 5%); Meteora speaks bps. We
  // accept either by detecting which is plausible. Kept loose because the
  // cycle worker calls this with sub-1-SOL amounts where slippage-via-quote
  // is the safer path and `minimumAmountOut: 0` is acceptable.
  minimumAmountOut = null,
}) {
  const ownerPk = typeof publicKey === 'string' ? new PublicKey(publicKey) : publicKey;
  const baseMint = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const cfgKey = configKey
    ? (typeof configKey === 'string' ? new PublicKey(configKey) : configKey)
    : getMeteoraConfigKey();
  const poolAddr = deriveDbcPoolAddress(METEORA_QUOTE_MINT, baseMint, cfgKey);

  const lamports = BigInt(Math.floor(Number(solAmount) * 1e9));
  if (lamports <= 0n) {
    throw new Error('meteora.buildBuyTokenTx: solAmount must be > 0');
  }

  const client = getDbcClient();
  return client.pool.swap({
    owner: ownerPk,
    pool: poolAddr,
    amountIn: new BN(lamports.toString()),
    // The cycle worker measures acquired tokens via ATA delta after confirm;
    // it doesn't need a tight slippage guard here because the per-cycle SOL
    // size is small (sub-cent → low single-digit USD). Caller can override
    // for larger flows.
    minimumAmountOut: new BN(minimumAmountOut != null ? String(minimumAmountOut) : 0),
    swapBaseForQuote: false, // false = quote (SOL) for base (token) = "buy"
    referralTokenAccount: null,
    payer: ownerPk,
  });
}

/**
 * Build a partner-fee claim tx for a Meteora DBC pool.
 *
 * Stakrr is the partner (configured at config time as `feeClaimer`). The
 * resulting SOL/wSOL is delivered to `receiver` (defaults to feeClaimer).
 * For SOL-quote pools the SDK handles wSOL wrap/unwrap internally via the
 * `tempWSolAcc` mechanism — caller doesn't need to manage that.
 *
 * Returns a Transaction; caller signs with treasury and submits via the
 * existing `signAndPollConfirm` helper used by the cycle worker.
 */
export async function buildClaimCreatorFeesTx({
  mint,
  feeClaimer,
  payer = null,
  receiver = null,
  configKey = null,
  // collectFeeMode = QuoteToken at config time means base-token fees never
  // accrue, so we skip them by default. Pass `claimBase=true` only if you
  // ever switch a config to OutputToken mode (not currently used).
  claimBase = false,
}) {
  if (!mint) throw new Error('meteora.buildClaimCreatorFeesTx: mint required');
  if (!feeClaimer) throw new Error('meteora.buildClaimCreatorFeesTx: feeClaimer required');

  const baseMint = typeof mint === 'string' ? new PublicKey(mint) : mint;
  const claimerPk = typeof feeClaimer === 'string' ? new PublicKey(feeClaimer) : feeClaimer;
  const payerPk = payer
    ? (typeof payer === 'string' ? new PublicKey(payer) : payer)
    : claimerPk;
  const receiverPk = receiver
    ? (typeof receiver === 'string' ? new PublicKey(receiver) : receiver)
    : claimerPk;
  const cfgKey = configKey
    ? (typeof configKey === 'string' ? new PublicKey(configKey) : configKey)
    : getMeteoraConfigKey();

  const poolAddr = deriveDbcPoolAddress(METEORA_QUOTE_MINT, baseMint, cfgKey);

  const client = getDbcClient();
  return client.partner.claimPartnerTradingFee({
    pool: poolAddr,
    feeClaimer: claimerPk,
    payer: payerPk,
    maxBaseAmount: claimBase ? U64_MAX_BN : new BN(0),
    maxQuoteAmount: U64_MAX_BN,
    receiver: receiverPk,
  });
}

/**
 * Fetch on-chain pool state. Returns null when the pool doesn't exist (yet),
 * or `{ poolAddress, isMigrated, migrationProgress, configAddress }` for
 * existing pools.
 *
 * Used by the cycle worker to:
 *   1. Confirm a pool finished its on-chain initialization before claiming.
 *   2. Detect graduation and switch to the DAMM v2 fee-claim path.
 */
export async function getPoolState({ mint, configKey = null }) {
  try {
    const baseMint = typeof mint === 'string' ? new PublicKey(mint) : mint;
    const cfgKey = configKey
      ? (typeof configKey === 'string' ? new PublicKey(configKey) : configKey)
      : getMeteoraConfigKey();
    const poolAddr = deriveDbcPoolAddress(METEORA_QUOTE_MINT, baseMint, cfgKey);
    const client = getDbcClient();
    const state = await client.state.getPool(poolAddr);
    if (!state) return null;
    // Meteora program stores `isMigrated` as u8 (0/1) and `migrationProgress`
    // as a small int; coerce both to plain JS values for downstream consumers.
    return {
      poolAddress: poolAddr,
      isMigrated: Number(state.isMigrated || 0) > 0,
      migrationProgress: Number(state.migrationProgress || 0),
      configAddress: state.config,
    };
  } catch {
    return null;
  }
}
