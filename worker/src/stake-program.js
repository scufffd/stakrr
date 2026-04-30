// Anchor client wrapping the multi-pool pob-index-stake program for Stakrr.
//
// Stakrr deploys nothing on-chain — every per-token staking pool is a fresh
// `StakePool` account on the existing program. This module builds the four
// instructions Stakrr needs: initialize_pool, add_reward_mint, deposit_rewards,
// claim_push.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { config } from './config.js';

const { Program, AnchorProvider } = anchor;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IDL_PATH = path.resolve(__dirname, '..', '..', 'shared', 'idl', 'pob_index_stake.json');

const SEEDS = {
  pool: Buffer.from('pool'),
  reward: Buffer.from('reward'),
  position: Buffer.from('position'),
  checkpoint: Buffer.from('checkpoint'),
};

const VALID_LOCK_DAYS = new Set([1, 3, 7, 14, 21, 30]);

let cachedIdl = null;
function loadIdl() {
  if (!cachedIdl) cachedIdl = JSON.parse(fs.readFileSync(IDL_PATH, 'utf8'));
  return { ...cachedIdl, address: config.programId.toBase58() };
}

export function findPoolPda(stakeMint) {
  return PublicKey.findProgramAddressSync([SEEDS.pool, stakeMint.toBuffer()], config.programId)[0];
}

export function findRewardMintPda(pool, mint) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.reward, pool.toBuffer(), mint.toBuffer()],
    config.programId,
  )[0];
}

export function findCheckpointPda(position, rewardMintPda) {
  return PublicKey.findProgramAddressSync(
    [SEEDS.checkpoint, position.toBuffer(), rewardMintPda.toBuffer()],
    config.programId,
  )[0];
}

export function findPositionPda(pool, beneficiary, nonce) {
  const nonceBn = BN.isBN(nonce) ? nonce : new BN(nonce);
  return PublicKey.findProgramAddressSync(
    [
      SEEDS.position,
      pool.toBuffer(),
      beneficiary.toBuffer(),
      nonceBn.toArrayLike(Buffer, 'le', 8),
    ],
    config.programId,
  )[0];
}

export function rewardVaultAta(pool, mint, tokenProgram) {
  return getAssociatedTokenAddressSync(mint, pool, true, tokenProgram);
}

export async function detectTokenProgram(connection, mint) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not SPL / Token-2022`);
}

/**
 * Same as `detectTokenProgram` but returns a fallback when the mint isn't on
 * chain yet. Used by the launch flow to pre-build the pool tx in parallel
 * with the Pump create tx (so we can bundle them into a single Phantom
 * prompt).
 *
 * IMPORTANT: pump.fun bonding-curve tokens are owned by **Token-2022**
 * (TokenzQd…) — verifiable on any pump mint. Callers that pre-build pool
 * txs for fresh pump mints MUST pass `fallback = TOKEN_2022_PROGRAM_ID`,
 * otherwise the resulting `stakeVault` ATA will be derived under the
 * wrong token program and the InitializePool ix fails simulation with
 * "incorrect program id for instruction" (the ATA program tries to call
 * GetAccountDataSize on the mint via classic SPL Token, which doesn't own
 * it). Existing mints always get the real owner check.
 */
export async function detectTokenProgramOr(connection, mint, fallback = TOKEN_PROGRAM_ID) {
  const info = await connection.getAccountInfo(mint, 'confirmed');
  if (!info) return fallback;
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`Mint ${mint.toBase58()} is not SPL / Token-2022`);
}

function keypairWallet(keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(keypair); return tx; }),
  };
}

function readOnlyWallet() {
  return {
    publicKey: config.programId,
    signTransaction: async (tx) => tx,
    signAllTransactions: async (txs) => txs,
  };
}

/** @param {import('@solana/web3.js').Keypair | PublicKey} k */
export function pubkeyOf(k) {
  return k instanceof PublicKey ? k : k.publicKey;
}

export function loadProgram(connection, signerKeypair) {
  const provider = new AnchorProvider(connection, keypairWallet(signerKeypair), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(loadIdl(), provider);
}

/** Program handle for account reads and unsigned ix builds (no real signer). */
export function loadProgramReadOnly(connection) {
  const provider = new AnchorProvider(connection, readOnlyWallet(), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(loadIdl(), provider);
}

// --- Instruction builders ---------------------------------------------------

export async function initializePoolIx({
  connection,
  authority,
  stakeMint,
  allowMissingMint = false,
  fallbackTokenProgram = TOKEN_2022_PROGRAM_ID,
}) {
  const program = loadProgramReadOnly(connection);
  const authorityPk = pubkeyOf(authority);
  const tokenProgram = allowMissingMint
    ? await detectTokenProgramOr(connection, stakeMint, fallbackTokenProgram)
    : await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, tokenProgram);
  const ix = await program.methods
    .initializePool()
    .accounts({
      authority: authorityPk,
      stakeMint,
      pool,
      stakeVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, stakeVault, tokenProgram };
}

export async function addRewardMintIx({
  connection,
  authority,
  stakeMint,
  rewardMint,
  allowMissingMint = false,
  fallbackTokenProgram = TOKEN_2022_PROGRAM_ID,
}) {
  const program = loadProgramReadOnly(connection);
  const authorityPk = pubkeyOf(authority);
  const tokenProgram = allowMissingMint
    ? await detectTokenProgramOr(connection, rewardMint, fallbackTokenProgram)
    : await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const rewardVault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const ix = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: authorityPk,
      rewardTokenMint: rewardMint,
      rewardMint: rewardMintPda,
      rewardVault,
      tokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, rewardMintPda, rewardVault, tokenProgram };
}

export async function depositRewardsIx({ connection, funder, stakeMint, rewardMint, amountLamports }) {
  const program = loadProgramReadOnly(connection);
  const funderPk = pubkeyOf(funder);
  const tokenProgram = await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const funderAta = getAssociatedTokenAddressSync(rewardMint, funderPk, false, tokenProgram);
  const ix = await program.methods
    .depositRewards(new BN(amountLamports.toString()))
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault,
      funder: funderPk,
      funderTokenAccount: funderAta,
      tokenProgram,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault, funderAta, tokenProgram };
}

/**
 * Build a `stake_for` instruction. Treasury (payer) funds tokens + rent for a
 * fresh position whose `owner` is `beneficiary` — used to atomically stake
 * dev-bought tokens on behalf of a launcher inside the launch flow.
 */
export async function stakeForIx({
  connection,
  payer,           // Keypair | PublicKey — pays + signs stake_for
  stakeMint,
  beneficiary,     // PublicKey — wallet that will own the position
  amountRaw,       // bigint | string | number — raw token units
  lockDays,        // number — must be one of LOCK_TIERS
  nonce,           // BN | number | string
}) {
  if (!VALID_LOCK_DAYS.has(Number(lockDays))) {
    throw new Error(`Invalid lock tier: ${lockDays}`);
  }
  const program = loadProgramReadOnly(connection);
  const payerPk = pubkeyOf(payer);
  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, tokenProgram);
  const payerTokenAccount = getAssociatedTokenAddressSync(stakeMint, payerPk, false, tokenProgram);
  const position = findPositionPda(pool, beneficiary, nonce);
  const nonceBn = BN.isBN(nonce) ? nonce : new BN(nonce);
  const ix = await program.methods
    .stakeFor(new BN(amountRaw.toString()), Number(lockDays), nonceBn, beneficiary)
    .accounts({
      pool,
      stakeMint,
      stakeVault,
      payer: payerPk,
      payerTokenAccount,
      position,
      tokenProgram,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, pool, position, payerTokenAccount, stakeVault, tokenProgram };
}

/**
 * Build a `prime_checkpoint` instruction so a fresh position is baselined
 * against an existing reward mint and starts accruing from the next deposit.
 */
export async function primeCheckpointIx({
  connection,
  payer,           // Keypair | PublicKey — pays rent / signs
  stakeMint,
  position,
  rewardTokenMint,
}) {
  const program = loadProgramReadOnly(connection);
  const payerPk = pubkeyOf(payer);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardTokenMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const ix = await program.methods
    .primeCheckpoint()
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      position,
      checkpoint,
      payer: payerPk,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, checkpoint, rewardMintPda };
}

export async function fetchPool({ connection, signer: _signerIgnored, stakeMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  return program.account.stakePool.fetchNullable(pool);
}

export async function fetchRewardMint({ connection, signer: _signerIgnored, stakeMint, rewardMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  return program.account.rewardMint.fetchNullable(rewardMintPda);
}

export async function fetchActivePositions({ connection, signer: _signerIgnored, stakeMint }) {
  const program = loadProgramReadOnly(connection);
  const pool = findPoolPda(stakeMint);
  // Position layout: [discriminator(8)][bump(1)][pool(32)] -> filter offset 9.
  const all = await program.account.stakePosition.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  return all.filter((p) => !p.account.closed);
}

/** Open stake positions for `owner` in one pool (non-closed). */
export async function fetchOwnerPositionsInPool({ connection, signer, stakeMint, owner }) {
  const rows = await fetchActivePositions({ connection, signer, stakeMint });
  return rows.filter((p) => p.account.owner.equals(owner));
}

export { BN };
