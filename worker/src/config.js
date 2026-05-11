import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { buildResilientConnection } from './rpc-multiplex.js';

function required(key) {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env ${key}`);
  return v;
}

function optional(key, fallback = '') {
  return process.env[key] || fallback;
}

function intEnv(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Bad number env ${key}=${v}`);
  return n;
}

export function parseKeypair(value, label) {
  if (!value) throw new Error(`Missing keypair ${label}`);
  const trimmed = value.trim();
  // JSON array secret
  if (trimmed.startsWith('[')) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(trimmed)));
  }
  // Base58 secret
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}

function jsonObjectEnv(key) {
  const raw = optional(key, '').trim();
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o == null || typeof o !== 'object' || Array.isArray(o)) {
      throw new Error(`${key} must be a JSON object`);
    }
    return o;
  } catch (e) {
    if (e.message?.includes('must be a JSON')) throw e;
    throw new Error(`${key}: invalid JSON (${e.message})`);
  }
}

function csvEnv(key) {
  return optional(key, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  rpcUrl: required('RPC_URL'),
  stakeRpcUrl: optional('STAKE_RPC_URL', '') || required('RPC_URL'),
  /**
   * Comma-separated public RPC URLs that the worker (and frontend, mirrored via
   * VITE_RPC_URL_FALLBACKS) will fail over to when the primary returns 429,
   * 401/403, 5xx, or a network error. Used for non-Helius-specific calls
   * (getAccountInfo, getMultipleAccountsInfo, getLatestBlockhash, etc.) so a
   * Helius quota outage doesn't take Stakrr down.
   *
   * Sensible defaults for mainnet: api.mainnet-beta.solana.com,
   * solana-rpc.publicnode.com, solana.drpc.org. Override with your own paid
   * fallback if you have one (Triton One, QuickNode, etc.).
   */
   rpcUrlFallbacks: csvEnv('RPC_URL_FALLBACKS'),

  programId: new PublicKey(optional('STAKE_PROGRAM_ID', '65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA')),
  wsolMint: new PublicKey(optional('WSOL_MINT', 'So11111111111111111111111111111111111111112')),

  treasuryKeypair: parseKeypair(required('PLATFORM_TREASURY_PRIVATE_KEY'), 'PLATFORM_TREASURY_PRIVATE_KEY'),
  authorityKeypair: process.env.PLATFORM_AUTHORITY_PRIVATE_KEY
    ? parseKeypair(process.env.PLATFORM_AUTHORITY_PRIVATE_KEY, 'PLATFORM_AUTHORITY_PRIVATE_KEY')
    : null,

  pumpdev: {
    base: optional('PUMPDEV_API_BASE', 'https://pumpdev.io'),
    apiKey: optional('PUMPDEV_API_KEY', ''),
    /** Merged into POST /api/create (e.g. Pump fee-share fields). See PumpDev docs / support. */
    createExtra: jsonObjectEnv('PUMPDEV_CREATE_EXTRA_JSON'),
  },

  platformFeeBps: intEnv('PLATFORM_FEE_BPS', 200),
  launchFeeLamports: intEnv('LAUNCH_FEE_LAMPORTS', 0),
  minDistributeLamports: intEnv('MIN_DISTRIBUTE_LAMPORTS', 2_000_000),

  /**
   * Wallet that receives the platform fee skim every claim cycle. Kept
   * separate from `treasury` (which signs txs and pays network fees) so
   * platform revenue never gets mixed with operating capital. When unset,
   * the skim is a no-op and the 2% remains in the treasury.
   *
   * Set this to a wallet you don't actively transact from — e.g. a hardware
   * wallet or multisig — so balances are auditable.
   */
  platformFeeVault: (() => {
    const v = optional('PLATFORM_FEE_VAULT', '').trim();
    if (!v) return null;
    try { return new PublicKey(v); } catch { throw new Error(`PLATFORM_FEE_VAULT is not a valid pubkey: ${v}`); }
  })(),

  /**
   * `ADMIN_WALLET` is comma-separated to support multiple admin operators
   * (e.g. founder + ops alt). Each entry must be a valid base58 pubkey.
   * Backward-compatible: a single wallet still parses correctly.
   *
   * `adminWallet` (singular, first entry) is kept for any code/UI that
   * still treats the admin as a single value; new code should iterate
   * `adminWallets` to allow N admins.
   */
  adminWallets: (() => {
    const raw = optional('ADMIN_WALLET', '').trim();
    if (!raw) return [];
    return raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((v) => {
        try { return new PublicKey(v); }
        catch { throw new Error(`ADMIN_WALLET entry is not a valid pubkey: ${v}`); }
      });
  })(),
  get adminWallet() {
    return this.adminWallets[0] || null;
  },

  // Pump fee-share lock (see pump-fees.js). When `lockFees.enabled` is true,
  // every Stakrr launch runs `pump_fees::create_fee_sharing_config` +
  // `update_fee_shares` after the Pump create, migrating the on-chain
  // BondingCurve.creator from the deployer wallet to a FeeSharingConfig PDA.
  // 100% of creator royalties then route to PLATFORM_TREASURY by default;
  // override via LOCK_FEES_RECIPIENT to send to a different address (e.g. a
  // Stakrr DAO treasury).
  lockFees: {
    enabled: (optional('LOCK_FEES_ENABLED', 'true').toLowerCase() !== 'false'),
    recipient: optional('LOCK_FEES_RECIPIENT', '').trim() || null,
  },

  loopIntervalMs: intEnv('LOOP_INTERVAL_MS', 600_000),
  priorityFeeMicroLamports: intEnv('PRIORITY_FEE_MICROLAMPORTS', 10_000),

  listenHost: optional('LISTEN_HOST', '0.0.0.0'),
  port: intEnv('PORT', 3060),

  registryFile: optional('POOL_REGISTRY_FILE', './data/pools.json'),
  eventLedgerFile: optional('EVENT_LEDGER_FILE', './data/events.jsonl'),

  /** Optional JSON pool of pre-ground mints (see vanity-mints.js).
   * The default pool is used by Pump.fun launches — typically pre-ground
   * with a `pump` suffix to match Pump.fun's tile branding. */
  vanityMintPoolFile: optional('VANITY_MINT_POOL_FILE', ''),
  /** Public key must end with this base58 substring (e.g. STK, pump). */
  vanityMintSuffix: optional('VANITY_MINT_SUFFIX', 'STK'),

  /**
   * Per-venue vanity overrides. Meteora launches MUST NOT pull from the
   * `pump`-suffix pool because their landing page lives on Stakrr (not
   * Pump.fun) and a `pump` ending CA is misleading branding. Default
   * suffix is `stkr` — once the grinder produces a pool, set
   * `VANITY_MINT_POOL_FILE_METEORA=./data/vanity-stkr.json`. Until a pool
   * is configured, Meteora launches fall back to a freshly generated
   * (random-suffix) ephemeral keypair — never to the Pump.fun pool.
   */
  vanityMintMeteoraPoolFile: optional('VANITY_MINT_POOL_FILE_METEORA', ''),
  vanityMintMeteoraSuffix: optional('VANITY_MINT_SUFFIX_METEORA', 'stkr'),

  /**
   * Public origin Stakrr is served from. Used as the fallback `website` field
   * in Pump.fun token metadata when the deployer leaves website blank — we
   * point it at https://<base>/token/<mint> so every launch has a real
   * landing page even if the project never makes a website.
   */
  publicBaseUrl: optional('PUBLIC_BASE_URL', 'https://stakrr.xyz').replace(/\/$/, ''),

  rpcAccountCacheTtlMs: intEnv('POB_RPC_ACCOUNT_CACHE_TTL_MS', 21_600_000),
};

// Treasury doubles as authority unless an explicit authority keypair is set.
export function authoritySigner() {
  return config.authorityKeypair || config.treasuryKeypair;
}

/**
 * The single chokepoint for building a `Connection` in the worker. Always
 * use this — it wires up RPC fallbacks transparently so a Helius outage
 * doesn't kill the claim loop or the launch flow.
 *
 * `commitment` defaults to 'confirmed' (matches what every call site used
 * before this refactor).
 */
export function getConnection(commitment = 'confirmed') {
  return buildResilientConnection(
    config.stakeRpcUrl,
    config.rpcUrlFallbacks,
    { commitment },
  );
}
