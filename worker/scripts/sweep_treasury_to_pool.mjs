#!/usr/bin/env node
// One-shot: takes a fixed lamport amount sitting in the treasury and pushes it
// into the staking pool for `STAKE_MINT`, with the same 98/2 split the cycle
// loop applies. Used to flush the manually-bridged 13.1 SOL on yks7qy…pump
// after the AMM-bridge fix. Atomic: wrap + deposit_rewards + platform sweep
// all land in one signed tx (or none).
//
// Usage:
//   STAKE_MINT=<mint> LAMPORTS=<total_to_split> node scripts/sweep_treasury_to_pool.mjs
//
// Defaults:
//   STAKE_MINT  = yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump
//   LAMPORTS    = 13_000_000_000   (13 SOL — leave a buffer for tx fees)

import 'dotenv/config';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js';
import { signAndPollConfirm } from '../src/confirm.js';
import { wrapSolIxs } from '../src/wsol.js';
import { depositRewardsIx } from '../src/stake-program.js';
import { config, authoritySigner, getConnection } from '../src/config.js';

const STAKE_MINT = new PublicKey(process.env.STAKE_MINT || 'yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump');
const TOTAL = BigInt(process.env.LAMPORTS || 13_000_000_000n);

function log(message, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), message, ...extra }));
}

async function main() {
  const connection = getConnection();
  const treasury = config.treasuryKeypair;
  const authority = authoritySigner();

  const platform = (TOTAL * BigInt(config.platformFeeBps || 200)) / 10_000n;
  const stakers = TOTAL - platform;

  log('sweep: start', {
    stakeMint: STAKE_MINT.toBase58(),
    treasury: treasury.publicKey.toBase58(),
    feeVault: config.platformFeeVault?.toBase58?.() || null,
    total: TOTAL.toString(),
    platform: platform.toString(),
    stakers: stakers.toString(),
  });

  const treaPre = BigInt(await connection.getBalance(treasury.publicKey, 'confirmed'));
  log('sweep: treasury pre', { lamports: treaPre.toString(), sol: (Number(treaPre) / 1e9).toFixed(6) });
  if (treaPre < TOTAL + 5_000_000n) {
    throw new Error(`treasury too low: ${treaPre} < ${TOTAL + 5_000_000n}`);
  }

  const wrap = await wrapSolIxs({
    payer: treasury.publicKey,
    owner: treasury.publicKey,
    lamports: stakers,
  });

  const dep = await depositRewardsIx({
    connection,
    funder: treasury,
    stakeMint: STAKE_MINT,
    rewardMint: config.wsolMint,
    amountLamports: stakers,
  });

  const tx = new Transaction();
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  for (const ix of wrap.ixs) tx.add(ix);
  tx.add(dep.ix);
  if (config.platformFeeVault && platform > 0n) {
    tx.add(SystemProgram.transfer({
      fromPubkey: treasury.publicKey,
      toPubkey: config.platformFeeVault,
      lamports: Number(platform),
    }));
  }

  const sig = await signAndPollConfirm(connection, tx, [treasury], {
    commitment: 'confirmed',
    label: 'manual-sweep:deposit+platform-fee',
  });
  log('sweep: confirmed', { sig, url: `https://solscan.io/tx/${sig}` });

  const treaPost = BigInt(await connection.getBalance(treasury.publicKey, 'confirmed'));
  log('sweep: treasury post', {
    lamports: treaPost.toString(),
    delta: (treaPost - treaPre).toString(),
    deltaSol: (Number(treaPost - treaPre) / 1e9).toFixed(6),
  });
  // authority param is unused by the rest of this script but kept to mirror
  // the worker's signer plumbing — makes the intent obvious if/when this
  // script grows to do claim_push for stakers as a follow-up.
  void authority;
}

main().catch((e) => {
  log('sweep: FATAL', { error: e.message, stack: e.stack?.split('\n').slice(0, 6) });
  process.exit(1);
});
