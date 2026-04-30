// Register an existing mint into the stakrr pool registry.
// Useful for local testing: point the directory + staking UI at a mint that
// already has a pool on the pob-index-stake program (e.g. POB500) without
// paying to launch a fresh Pump.fun token.
//
// Usage:
//   node scripts/register-pool.js \
//     --mint <stakeMintB58> \
//     --name "POB500" --symbol "POB500" \
//     [--description "..."] [--twitter ...] [--telegram ...] [--website ...]
//     [--creator <wallet>]

import process from 'node:process';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, authoritySigner } from '../src/config.js';
import { fetchPool, fetchRewardMint } from '../src/stake-program.js';
import { upsertPool, recordEvent } from '../src/registry.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

async function main() {
  const mintStr = arg('mint');
  if (!mintStr) {
    console.error('Missing --mint <stakeMintB58>');
    process.exit(1);
  }
  const stakeMint = new PublicKey(mintStr);
  const connection = new Connection(config.stakeRpcUrl, 'confirmed');
  const authority = authoritySigner();

  const onchain = await fetchPool({ connection, signer: authority, stakeMint });
  if (!onchain) {
    console.error(`No StakePool exists on the program for mint ${mintStr}.`);
    console.error(`Initialize it first via /api/launch (or run init-pool).`);
    process.exit(2);
  }

  const wsolReward = await fetchRewardMint({
    connection,
    signer: authority,
    stakeMint,
    rewardMint: config.wsolMint,
  });

  const pool = upsertPool({
    stakeMint: mintStr,
    rewardMint: config.wsolMint.toBase58(),
    platformFeeBps: config.platformFeeBps,
    creatorWallet: arg('creator'),
    metadata: {
      name: arg('name', mintStr.slice(0, 6) + '...'),
      symbol: arg('symbol', 'TKN').toUpperCase(),
      description: arg('description', '') || undefined,
      twitter: arg('twitter') || undefined,
      telegram: arg('telegram') || undefined,
      website: arg('website') || undefined,
    },
    pumpfun: { createSig: arg('createSig') || null },
    onchain: {
      poolInitSig: null,
      rewardInitSig: wsolReward ? null : 'wsol-not-registered',
      hasWsolReward: !!wsolReward,
    },
  });

  recordEvent({
    type: 'register-pool',
    stakeMint: mintStr,
    metadata: pool.metadata,
    hasWsolReward: !!wsolReward,
  });

  console.log(JSON.stringify({
    ok: true,
    pool: {
      ...pool,
      onchain: {
        ...pool.onchain,
        totalStaked: onchain.totalStaked?.toString?.() || '0',
        totalEffective: onchain.totalEffective?.toString?.() || '0',
      },
      hasWsolReward: !!wsolReward,
    },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
