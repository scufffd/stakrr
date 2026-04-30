// Per-pool: claim creator fees from Pump.fun, take platform fee, wrap remaining
// SOL into wSOL, deposit_rewards into the wSOL reward vault, then push claims
// to active stakers via claim_push.

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
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { config, authoritySigner } from './config.js';
import { wrapSolIxs } from './wsol.js';
import { buildClaimCreatorFeesTx } from './pumpdev.js';
import {
  depositRewardsIx,
  fetchActivePositions,
  fetchPool,
  fetchRewardMint,
  findCheckpointPda,
  findPoolPda,
  findRewardMintPda,
  loadProgram,
} from './stake-program.js';
import { addToPoolMetrics, recordEvent } from './registry.js';

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

async function claimCreatorFees(connection, treasury) {
  const beforeLamports = await getSolBalance(connection, treasury.publicKey);
  let signature = null;
  try {
    const vt = await buildClaimCreatorFeesTx({ publicKey: treasury.publicKey.toBase58() });
    vt.sign([treasury]);
    signature = await connection.sendRawTransaction(vt.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(signature, 'confirmed');
  } catch (e) {
    log('claim: pumpdev claim failed', { error: e.message });
    return { claimedLamports: 0n, signature: null };
  }
  const afterLamports = await getSolBalance(connection, treasury.publicKey);
  const delta = afterLamports - beforeLamports;
  // Subtract a tx-fee floor; if delta is negative or tiny, treat as zero.
  if (delta < 5_000n) {
    return { claimedLamports: 0n, signature };
  }
  return { claimedLamports: delta, signature };
}

function splitFees(claimedLamports) {
  const platform = (claimedLamports * BigInt(config.platformFeeBps)) / 10_000n;
  const stakers = claimedLamports - platform;
  return { platform, stakers };
}

async function depositToPool({ connection, treasury, stakeMint, lamports }) {
  if (lamports <= 0n) return null;

  // 1) wrap SOL -> wSOL on treasury's wSOL ATA
  const wrap = await wrapSolIxs({
    payer: treasury.publicKey,
    owner: treasury.publicKey,
    lamports,
  });

  // 2) deposit_rewards into the pool's wSOL reward vault
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

// Build a single claim_push instruction for a given (position, rewardMintPda).
async function buildClaimPushIx({
  connection,
  authority,
  stakeMint,
  rewardMint,
  position,
  positionOwner,
}) {
  const program = loadProgram(connection, authority);
  const pool = findPoolPda(stakeMint);
  const rewardMintPda = findRewardMintPda(pool, rewardMint);
  const checkpoint = findCheckpointPda(position, rewardMintPda);
  const tokenProgram = TOKEN_PROGRAM_ID; // wSOL is classic SPL
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

async function pushClaimsToActiveStakers({ connection, stakeMint }) {
  const authority = authoritySigner();
  const positions = await fetchActivePositions({ connection, signer: authority, stakeMint });
  if (positions.length === 0) {
    return { pushed: 0, skipped: 0, txSigs: [] };
  }

  const groups = [];
  for (const p of positions) {
    try {
      const { ataIx, ix } = await buildClaimPushIx({
        connection,
        authority,
        stakeMint,
        rewardMint: config.wsolMint,
        position: p.publicKey,
        positionOwner: p.account.owner,
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
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  const onchain = await fetchPool({ connection, signer: authority, stakeMint });
  if (!onchain) {
    log('cycle: pool not initialized', { stakeMint: pool.stakeMint });
    return { status: 'pool_uninitialized' };
  }
  if (onchain.totalEffective?.isZero?.()) {
    log('cycle: pool has zero effective stake, skipping deposit', { stakeMint: pool.stakeMint });
  }

  const wsolReward = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint: config.wsolMint,
  });
  if (!wsolReward) {
    log('cycle: wSOL reward mint not registered, skipping', { stakeMint: pool.stakeMint });
    return { status: 'reward_unregistered' };
  }

  // 1) Claim creator fees.
  const { claimedLamports, signature: claimSig } = await claimCreatorFees(connection, treasury);
  log('cycle: claimed', {
    stakeMint: pool.stakeMint,
    claimedLamports: claimedLamports.toString(),
    claimSig,
  });
  if (claimedLamports < BigInt(config.minDistributeLamports)) {
    return { status: 'below_min_distribute', claimedLamports: claimedLamports.toString() };
  }

  // 2) Split fees.
  const { platform, stakers } = splitFees(claimedLamports);
  log('cycle: split', {
    stakeMint: pool.stakeMint,
    platform: platform.toString(),
    stakers: stakers.toString(),
  });

  let depositSig = null;
  if (stakers > 0n && !onchain.totalEffective?.isZero?.()) {
    depositSig = await depositToPool({
      connection,
      treasury,
      stakeMint,
      lamports: stakers,
    });
    log('cycle: deposited wSOL to pool', { stakeMint: pool.stakeMint, sig: depositSig });
  }

  // 3) Push to stakers (only if we deposited).
  let pushResult = { pushed: 0, skipped: 0, txSigs: [] };
  if (depositSig) {
    pushResult = await pushClaimsToActiveStakers({ connection, stakeMint });
    log('cycle: pushed claims', { stakeMint: pool.stakeMint, ...pushResult });
  }

  // 4) Update metrics.
  addToPoolMetrics(pool.stakeMint, {
    totalCreatorFeesClaimedLamports: claimedLamports.toString(),
    totalPlatformFeesLamports: platform.toString(),
    totalRewardsDistributedLamports: stakers.toString(),
  });
  recordEvent({
    type: 'cycle',
    stakeMint: pool.stakeMint,
    claimedLamports: claimedLamports.toString(),
    platformFeeLamports: platform.toString(),
    rewardsDepositedLamports: stakers.toString(),
    claimSig,
    depositSig,
    pushedClaims: pushResult.pushed,
    pushTxSigs: pushResult.txSigs,
  });

  return {
    status: 'ok',
    claimedLamports: claimedLamports.toString(),
    platformFeeLamports: platform.toString(),
    rewardsDepositedLamports: stakers.toString(),
    claimSig,
    depositSig,
    pushedClaims: pushResult.pushed,
  };
}
