// Builds unsigned stake_for + prime_checkpoint transactions to distribute
// the dev-buy bag of a freshly-launched token across presale contributors
// pro-rata. The `payer` (dev wallet, which holds the dev-buy tokens in its
// ATA) signs each tx in the browser via wallet adapter.
//
// Returns BASE64-serialized legacy `Transaction` objects (matches the rest
// of Stakrr's launch flow) with feePayer/recentBlockhash already set so the
// browser can pass them straight to signAllTransactions().

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import BN from 'bn.js';
import { config, getConnection } from './config.js';
import {
  detectTokenProgram,
  fetchPool,
  fetchRewardMint,
  primeCheckpointIx,
  stakeForIx,
} from './stake-program.js';
import { allocateAllocations, scanPresaleContributions } from './presale-scan.js';

// Conservative — stake_for + prime_checkpoint per beneficiary is ~12-14
// unique accounts; 2 beneficiaries fits comfortably under the 1232 byte
// versioned-tx ceiling with a compute budget ix added. Bump only after
// measuring actual serialized size on mainnet.
const BENEFICIARIES_PER_TX = 2;

function priorityFeeIx() {
  const micro = config.priorityFeeMicroLamports;
  if (!micro || micro <= 0) return null;
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports: micro });
}

function uniqueNonce(seed, i) {
  // Time-based nonce so consecutive runs across launches don't collide on
  // (pool, beneficiary, nonce) — the position PDA's seed.
  return new BN(BigInt(Date.now()) * 1000n + BigInt(seed * 1000 + i));
}

/**
 * Resolve which reward mints we need to prime_checkpoint per fresh
 * position. For Stakrr's standard launches this is just one (wSOL); the
 * pool's `rewardMint` field tells us. We also accept the pool's optional
 * extras list if the registry ever grows multi-reward.
 */
async function listPoolRewardMints({ connection, stakeMint, pool }) {
  // Always include wSOL since every Stakrr pool registers it as a reward.
  const candidates = new Set([config.wsolMint.toBase58()]);
  if (pool?.rewardMint) candidates.add(pool.rewardMint);
  const out = [];
  for (const m of candidates) {
    const mintPk = new PublicKey(m);
    const rm = await fetchRewardMint({ connection, stakeMint, rewardMint: mintPk });
    if (rm) out.push(mintPk);
  }
  return out;
}

/**
 * Build the batched txs. Returns:
 *   {
 *     allocations: [{ wallet, lamports, tokens, shareBps }],
 *     batches:     [{ index, base64, beneficiaries: [{wallet,tokens,nonce,position}] }],
 *     totals:      { lamports, tokensRaw, contributorCount, batchCount },
 *   }
 *
 * `tokenTotalRaw` is the raw token amount the dev wants to distribute —
 * typically the dev-buy ATA balance after Pump's create+buy lands. Caller
 * is responsible for ensuring the dev wallet's ATA actually holds at least
 * `tokenTotalRaw` raw units before submitting these txs.
 */
export async function buildPresaleAutoStakeBatches({
  mint,
  devWallet,
  presaleWallet,
  cutoffSignature,
  lockDays,
  tokenTotalRaw,
  excludeWallets = [],
  minTransferLamports,
}) {
  const connection = getConnection();
  const stakeMint = new PublicKey(mint);
  const devPk = new PublicKey(devWallet);

  const pool = await fetchPool({ connection, stakeMint });
  if (!pool) throw new Error(`stake pool not found for mint ${mint} — has the launch finalised yet?`);

  // Detect token program once so error messages from stakeForIx are clean.
  await detectTokenProgram(connection, stakeMint);

  const scan = await scanPresaleContributions({
    connection,
    presaleWallet,
    cutoffSignature,
    excludeWallets,
    minTransferLamports,
  });

  if (!scan.contributors.length) {
    return {
      allocations: [],
      batches: [],
      totals: {
        lamports: scan.totalLamports,
        tokensRaw: '0',
        contributorCount: 0,
        batchCount: 0,
      },
      scan,
    };
  }

  const allocs = allocateAllocations(scan.contributors, BigInt(tokenTotalRaw))
    // Drop zero-token allocations (dust). Shouldn't happen if tokenTotalRaw
    // > contributorCount, but guard against pathological input.
    .filter((r) => r.tokens > 0n);

  if (!allocs.length) {
    return {
      allocations: [],
      batches: [],
      totals: {
        lamports: scan.totalLamports,
        tokensRaw: '0',
        contributorCount: 0,
        batchCount: 0,
      },
      scan,
    };
  }

  const rewardMints = await listPoolRewardMints({ connection, stakeMint, pool });
  if (!rewardMints.length) {
    throw new Error(`no reward mint registered for pool ${stakeMint.toBase58()}`);
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  const batches = [];
  for (let bi = 0; bi < allocs.length; bi += BENEFICIARIES_PER_TX) {
    const slice = allocs.slice(bi, bi + BENEFICIARIES_PER_TX);
    const tx = new Transaction();
    const fee = priorityFeeIx();
    if (fee) tx.add(fee);

    const batchMeta = [];
    for (let i = 0; i < slice.length; i += 1) {
      const a = slice[i];
      const beneficiary = new PublicKey(a.wallet);
      const nonce = uniqueNonce(bi, i);

      const sf = await stakeForIx({
        connection,
        payer: devPk,
        stakeMint,
        beneficiary,
        amountRaw: a.tokens,
        lockDays: Number(lockDays),
        nonce,
      });
      tx.add(sf.ix);

      for (const rewardMint of rewardMints) {
        const pc = await primeCheckpointIx({
          connection,
          payer: devPk,
          stakeMint,
          position: sf.position,
          rewardTokenMint: rewardMint,
        });
        tx.add(pc.ix);
      }

      batchMeta.push({
        wallet: a.wallet,
        tokensRaw: a.tokens.toString(),
        lamports: a.lamports.toString(),
        shareBps: a.shareBps,
        nonce: nonce.toString(),
        position: sf.position.toBase58(),
      });
    }

    tx.feePayer = devPk;
    tx.recentBlockhash = blockhash;
    const base64 = Buffer.from(
      tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
    ).toString('base64');

    batches.push({
      index: batches.length,
      base64,
      beneficiaries: batchMeta,
    });
  }

  const tokensTotal = allocs.reduce((acc, r) => acc + r.tokens, 0n);

  return {
    allocations: allocs.map((a) => ({
      wallet: a.wallet,
      lamports: a.lamports.toString(),
      tokensRaw: a.tokens.toString(),
      shareBps: a.shareBps,
    })),
    batches,
    totals: {
      lamports: scan.totalLamports,
      tokensRaw: tokensTotal.toString(),
      contributorCount: allocs.length,
      batchCount: batches.length,
      lastValidBlockHeight,
      rewardMints: rewardMints.map((m) => m.toBase58()),
      lockDays: Number(lockDays),
    },
    scan,
  };
}
