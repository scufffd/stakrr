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

function keypairWallet(keypair) {
  return {
    publicKey: keypair.publicKey,
    signTransaction: async (tx) => { tx.partialSign(keypair); return tx; },
    signAllTransactions: async (txs) => txs.map((tx) => { tx.partialSign(keypair); return tx; }),
  };
}

export function loadProgram(connection, signerKeypair) {
  const provider = new AnchorProvider(connection, keypairWallet(signerKeypair), {
    commitment: 'confirmed',
    preflightCommitment: 'confirmed',
  });
  return new Program(loadIdl(), provider);
}

// --- Instruction builders ---------------------------------------------------

export async function initializePoolIx({ connection, authority, stakeMint }) {
  const program = loadProgram(connection, authority);
  const tokenProgram = await detectTokenProgram(connection, stakeMint);
  const pool = findPoolPda(stakeMint);
  const stakeVault = getAssociatedTokenAddressSync(stakeMint, pool, true, tokenProgram);
  const ix = await program.methods
    .initializePool()
    .accounts({
      authority: authority.publicKey,
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

export async function addRewardMintIx({ connection, authority, stakeMint, rewardMint }) {
  const program = loadProgram(connection, authority);
  const tokenProgram = await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const rewardVault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const ix = await program.methods
    .addRewardMint()
    .accounts({
      pool,
      authority: authority.publicKey,
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
  const program = loadProgram(connection, funder);
  const tokenProgram = await detectTokenProgram(connection, rewardMint);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);
  const funderAta = getAssociatedTokenAddressSync(rewardMint, funder.publicKey, false, tokenProgram);
  const ix = await program.methods
    .depositRewards(new BN(amountLamports.toString()))
    .accounts({
      pool,
      rewardMint: rewardMintPda,
      mint: rewardMint,
      vault,
      funder: funder.publicKey,
      funderTokenAccount: funderAta,
      tokenProgram,
    })
    .instruction();
  return { ix, pool, rewardMintPda, vault, funderAta, tokenProgram };
}

export async function fetchPool({ connection, signer, stakeMint }) {
  const program = loadProgram(connection, signer);
  const pool = findPoolPda(stakeMint);
  return program.account.stakePool.fetchNullable(pool);
}

export async function fetchRewardMint({ connection, signer, stakeMint, rewardMint }) {
  const program = loadProgram(connection, signer);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  return program.account.rewardMint.fetchNullable(rewardMintPda);
}

export async function fetchActivePositions({ connection, signer, stakeMint }) {
  const program = loadProgram(connection, signer);
  const pool = findPoolPda(stakeMint);
  // Position layout: [discriminator(8)][bump(1)][pool(32)] -> filter offset 9.
  const all = await program.account.stakePosition.all([
    { memcmp: { offset: 9, bytes: pool.toBase58() } },
  ]);
  return all.filter((p) => !p.account.closed);
}

export { BN };
