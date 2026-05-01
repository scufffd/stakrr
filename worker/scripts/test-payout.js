#!/usr/bin/env node
/**
 * test-payout.js — exercise the staker-payout half of the cycle without
 * paying PumpDev's claim-distribute commission.
 *
 * Purpose:
 *   Verify deposit_rewards + claim_push wiring on a brand-new pool when the
 *   creator-vault has nothing to claim yet. Skips claim-distribute entirely;
 *   takes a fixed `LAMPORTS` from the treasury, wraps it as wSOL, deposits
 *   into the pool's reward vault, and pushes claims to active stakers.
 *
 * Usage:
 *   STAKE_MINT=<mint> LAMPORTS=20000 node scripts/test-payout.js
 *
 * Defaults:
 *   STAKE_MINT — first active pool in the registry
 *   LAMPORTS   — 20_000 (0.00002 SOL — enough to be visible, cheap to test)
 */

import { ComputeBudgetProgram, PublicKey, Transaction } from '@solana/web3.js';
import { config, getConnection, authoritySigner } from '../src/config.js';
import { listPools } from '../src/registry.js';
import { wrapSolIxs } from '../src/wsol.js';
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
} from '../src/stake-program.js';
import { signAndPollConfirm } from '../src/confirm.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { SystemProgram } from '@solana/web3.js';

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

async function main() {
  const stakeMintB58 = process.env.STAKE_MINT || (listPools({ status: 'active' })[0]?.stakeMint);
  if (!stakeMintB58) throw new Error('no active pool — pass STAKE_MINT=...');
  const lamports = BigInt(process.env.LAMPORTS || 20_000);
  const stakeMint = new PublicKey(stakeMintB58);
  const rewardMint = config.wsolMint;

  const connection = getConnection();
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  log('test-payout: start', {
    stakeMint: stakeMintB58,
    lamports: lamports.toString(),
    treasury: treasury.publicKey.toBase58(),
    authority: authority.publicKey.toBase58(),
  });

  const onchain = await fetchPool({ connection, signer: authority, stakeMint });
  if (!onchain) throw new Error('pool not initialized on chain');
  log('test-payout: pool fetched', {
    authority: onchain.authority.toBase58(),
    totalEffective: onchain.totalEffective?.toString?.() || '?',
  });
  if (onchain.totalEffective?.isZero?.()) {
    log('test-payout: WARNING — pool has zero effective stake; deposit will succeed but no one earns');
  }

  const reward = await fetchRewardMint({ connection, signer: authority, stakeMint, rewardMint });
  if (!reward) throw new Error('reward mint not registered (run cycle once first)');

  // --- Step 1: wrap SOL into wSOL ATA owned by treasury ---
  const wrap = await wrapSolIxs({
    payer: treasury.publicKey,
    owner: treasury.publicKey,
    lamports,
  });

  // --- Step 2: deposit_rewards(wsol, lamports) ---
  const dep = await depositRewardsIx({
    connection,
    funder: treasury,
    stakeMint,
    rewardMint,
    amountLamports: lamports,
  });

  const tx1 = new Transaction();
  tx1.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of wrap.ixs) tx1.add(ix);
  tx1.add(dep.ix);

  const depositSig = await signAndPollConfirm(connection, tx1, [treasury], {
    commitment: 'confirmed',
    label: 'test-payout deposit',
  });
  log('test-payout: deposit_rewards landed', { depositSig, lamports: lamports.toString() });

  // --- Step 3: enumerate active stakers and push claims ---
  const positions = await fetchActivePositions({ connection, signer: authority, stakeMint });
  log('test-payout: positions fetched', { count: positions.length });
  if (positions.length === 0) {
    log('test-payout: no positions — skipping push (deposit went into vault for future stakers)');
    return;
  }

  const tokenProgram = await detectTokenProgram(connection, rewardMint);
  const program = loadProgram(connection, authority);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true, tokenProgram);

  const RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
  const pushSigs = [];
  for (const p of positions) {
    const positionOwner = p.account.owner;
    const checkpoint = findCheckpointPda(p.publicKey, rewardMintPda);
    const userTokenAccount = getAssociatedTokenAddressSync(rewardMint, positionOwner, false, tokenProgram);

    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      authority.publicKey,
      userTokenAccount,
      positionOwner,
      rewardMint,
      tokenProgram,
    );

    const pushIx = await program.methods
      .claimPush()
      .accounts({
        pool,
        authority: authority.publicKey,
        rewardMint: rewardMintPda,
        mint: rewardMint,
        vault,
        position: p.publicKey,
        checkpoint,
        userTokenAccount,
        tokenProgram,
        systemProgram: SystemProgram.programId,
        rent: RENT,
      })
      .instruction();

    const tx2 = new Transaction();
    tx2.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
    tx2.add(ataIx);
    tx2.add(pushIx);

    try {
      const sig = await signAndPollConfirm(connection, tx2, [authority], {
        commitment: 'confirmed',
        label: `claim_push(${p.publicKey.toBase58().slice(0, 8)}…)`,
      });
      pushSigs.push({ position: p.publicKey.toBase58(), owner: positionOwner.toBase58(), sig });
      log('test-payout: claim_push landed', { position: p.publicKey.toBase58(), owner: positionOwner.toBase58(), sig });
    } catch (e) {
      log('test-payout: claim_push failed', { position: p.publicKey.toBase58(), error: e.message });
    }
  }

  log('test-payout: done', { depositSig, pushed: pushSigs.length, sigs: pushSigs });
}

main().catch((e) => {
  log('test-payout: FATAL', { error: e.message, stack: e.stack?.split('\n').slice(0, 6) });
  process.exit(1);
});
