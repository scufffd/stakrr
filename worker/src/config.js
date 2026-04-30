import 'dotenv/config';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

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

export const config = {
  rpcUrl: required('RPC_URL'),
  stakeRpcUrl: optional('STAKE_RPC_URL', '') || required('RPC_URL'),

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

  /** Optional JSON pool of pre-ground mints (see vanity-mints.js). */
  vanityMintPoolFile: optional('VANITY_MINT_POOL_FILE', ''),
  /** Public key must end with this base58 substring (e.g. STK, pump). */
  vanityMintSuffix: optional('VANITY_MINT_SUFFIX', 'STK'),

  rpcAccountCacheTtlMs: intEnv('POB_RPC_ACCOUNT_CACHE_TTL_MS', 21_600_000),
};

// Treasury doubles as authority unless an explicit authority keypair is set.
export function authoritySigner() {
  return config.authorityKeypair || config.treasuryKeypair;
}
