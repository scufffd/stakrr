# Stakrr

Self-serve **proof-of-belief** launchpad for Pump.fun tokens with built-in staking and creator-fee rewards.

> Working name: **Stakrr** (placeholder, may rebrand to pumpr / STKE / final domain)

Anyone can launch a token via Pump.fun and instantly get a public staking pool where holders can lock their tokens and earn a share of the token's creator fees in SOL. Pump.fun is the only supported launch platform.

## How it works

1. Creator launches a token through Stakrr
   - The connected wallet pays for **everything** — Pump.fun create, the pump_fees lock, the staking pool init. The platform treasury is never charged.
   - The frontend calls `POST /api/launch/prepare`, which returns three unsigned transactions: (a) Pump.fun create + dev buy, (b) `pump_fees create_fee_sharing_config + update_fee_shares`, (c) Stakrr `initialize_pool + add_reward_mint`.
   - The wallet adapter calls `signAllTransactions(...)` once → Phantom shows a **single approval dialog** listing all three txs ("1-click launch"). The frontend then sends them sequentially with confirm-between.
   - The lock-fees tx migrates the on-chain `BondingCurve.creator` from the deployer to a `FeeSharingConfig` PDA (seeded by `["sharing-config", mint]` under `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`). 100% of creator royalties from that point forward route to the configured recipient — by default, `LOCK_FEES_RECIPIENT` (which falls back to the platform treasury). The deployer cannot redirect them.
   - On `finalize`, the worker verifies the `FeeSharingConfig` matches the expected recipient and persists `feeLock` metadata to the registry.
   - Optional auto-stake of the dev buy is a separate prompt (its amount depends on the actual ATA balance after the Pump buy lands).
2. Holders stake the new token
   - Standard pob-index-stake flow (lock tiers, multipliers, claims).
3. Creator fees auto-route to stakers
   - Worker periodically calls Pump's `distribute_creator_fees` for each fee-locked pool — fees are routed by the `pump_fees` program to the configured shareholders (treasury). For older non-locked pools, the worker still falls back to PumpDev `claim-account`.
   - 2% platform fee stays with the treasury; the rest is wrapped to wSOL (or swapped to the launched token if the pool is in `token` reward mode) and deposited as rewards via `deposit_rewards` + `claim_push`.
4. Stakers claim rewards
   - wSOL is auto-unwrapped to native SOL on payout (or claimed as wSOL by their wallet).

## Architecture

```
[Creator]
   │ launch token
   ▼
[Stakrr Frontend] ─signAllTransactions──► [Pump.fun create]
   │ (1 Phantom prompt, 3 txs)            [pump_fees lock-fees]
   │                                      [Stakrr init pool + reward]
   ▼
[pob-index-stake program]
   ▲
   │ deposit_rewards (wSOL or token), claim_push
   │
[Stakrr Worker] ◄── distribute_creator_fees ◄── [pump_fees FeeSharingConfig PDA]
                                                 (100% → treasury, immutable on-chain)
```

## Repo layout

```
STAKRR/
├── worker/             # Node worker + Express API
│   ├── src/
│   ├── scripts/
│   └── data/           # Local pool registry (gitignored)
├── frontend/           # React + Vite + Wallet Adapter UI
│   ├── src/
│   └── public/
├── shared/
│   └── idl/            # pob_index_stake IDL (read-only copy)
└── docs/
```

## Reused infrastructure

This project deliberately reuses the multi-pool capable [pob-index-stake](https://github.com/scufffd/pob500) on-chain program. We deploy nothing new on-chain. Each Stakrr launch creates a fresh `StakePool` for that token's mint, fully isolated from POB500's pool.

## Configuration

See `worker/.env.example` for required environment variables.

Key env vars:

- `PLATFORM_TREASURY_PRIVATE_KEY` — receives the 2% platform fee + (by default) 100% of creator royalties via the `pump_fees` `FeeSharingConfig` PDA. Does **not** pay for any launches.
- `PLATFORM_AUTHORITY_PRIVATE_KEY` — worker-side signer for `claim_push`, reward deposits, etc. Each `StakePool` authority is the launching wallet (creator-funded), not this key.
- `PUMPDEV_API_KEY` — Pump.fun integration (still used for metadata / fallback claim path)
- `STAKE_PROGRAM_ID` — `65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA`
- `WSOL_MINT` — `So11111111111111111111111111111111111111112`
- `PLATFORM_FEE_BPS` — defaults to `200` (2%)
- `LOCK_FEES_ENABLED` — `true` (default) wires every new launch through the `pump_fees` lock so creator royalties cannot be redirected away from the staking pool
- `LOCK_FEES_RECIPIENT` — pubkey that receives 100% of creator royalties (defaults to the treasury)

## Progress tracker

Each phase is committed and pushed; this section is the source of truth for "what's done".

- [x] Phase 0 — Repo scaffold, IDL copied, README, .env.example, .gitignore
- [x] Phase 1 — Pool registry + multi-pool worker loop (PumpDev claim → 2% cut → wSOL deposit → claim_push)
- [x] Phase 2 — Self-serve launch backend (`POST /api/launch`) + frontend launch flow form
- [x] Phase 3a — Pool directory + per-pool stats page + public partner API (`GET /api/pools/:mint/public`)
- [x] Phase 3b — Per-pool stake / claim / unstake UI (multi-pool StakeClient, claim → wSOL → unwrap to SOL in one tx)
- [x] Phase 3c — Atomic auto-stake on launch: optional `stake_for(beneficiary=launcher)` immediately after create, so the dev-buy tokens land already locked in the launcher's wallet
- [x] Phase 3d — Token page template (header, stat strip, two-column body, pump.fun buy link)
- [x] Phase 3e — Reward-mode picker on launch: stakers earn either **SOL** (current default — fees are wrapped to wSOL and deposited as rewards, auto-unwrapped on claim) or **the launched token** (buyback-and-distribute — worker swaps claimed fees to the token via Pump.fun and deposits them as rewards)
- [x] Phase 3f — DexScreener pre-claim probe: each cycle queries the token's DexScreener pair and skips PumpDev `claim-account` calls when no fresh creator-fee volume has accrued since the last successful claim. Saves ~0.0026 SOL per skipped no-op claim and avoids "transaction already processed" loops on quiet pools.
- [x] Phase 3g — Creator-funded launches: connected wallet pays all on-chain SOL (Pump create, dev buy, fee lock, pool init), treasury is never charged. `assertLaunchBalances` preflights wallet balance with actionable error messages.
- [x] Phase 3h — pump_fees lock-fees integration: every launch migrates `BondingCurve.creator` from the deployer to a `FeeSharingConfig` PDA, immutably routing 100% of creator royalties to `LOCK_FEES_RECIPIENT` (treasury by default). Worker uses Pump's `distribute_creator_fees` for locked pools and falls back to PumpDev `claim-account` for legacy un-locked pools.
- [x] Phase 3i — 1-click bundled launch: `signAllTransactions` signs Pump create + lock-fees + pool init in a single Phantom prompt. `/api/launch/lock-fees-finalize` exposes a retro-lock path for tokens that launched before the lock shipped.
- [ ] Phase 4 — Hosting (DO server, separate pm2 namespace, nginx vhost), domain selection
- [ ] Phase 5 — Faith integration (announce launches, scan pools)

### Files

- `worker/src/config.js` — env loader, treasury & authority keypairs, platform fee bps
- `worker/src/registry.js` — JSON pool registry + event ledger
- `worker/src/pumpdev.js` — Pump.fun create + claim creator-fees adapter (PumpDev)
- `worker/src/dexscreener.js` — DexScreener volume probe used to gate PumpDev claim attempts (5m / 1h / 6h / 24h windows, 5 bps creator-fee estimate, 6m post-success cooldown, 4h catch-up override)
- `worker/src/wsol.js` — wrap / unwrap SOL helpers
- `worker/src/stake-program.js` — Anchor client wrapping pob-index-stake (initialize_pool, add_reward_mint, deposit_rewards, claim_push, stake_for, prime_checkpoint, fetchers)
- `worker/src/launch.js` — orchestrates `pumpdev create` → `initialize_pool` → `add_reward_mint(wSOL)` → optional atomic `stake_for(beneficiary=launcher)` → registry persist
- `worker/src/claim-and-distribute.js` — per-pool cycle: claim, fee split, wrap, deposit_rewards, claim_push to active stakers
- `worker/src/run-loop.js` — multi-pool loop on `LOOP_INTERVAL_MS`
- `worker/src/server.js` — Express API: launch, list pools, partner public endpoint
- `worker/scripts/{run-loop,run-cycle,list-pools}.js`
- `frontend/src/App.jsx` — shell + tabs (Pools / Launch)
- `frontend/src/views/LaunchView.jsx` — token launch form
- `frontend/src/views/DirectoryView.jsx` — list of active pools
- `frontend/src/views/PoolView.jsx` — per-pool stats + embedded `StakePoolView`
- `frontend/src/staking-sdk/` — copy of pob-index-stake JS SDK (PDAs, ix builders); inlined into the frontend for Vite polyfill compatibility
- `frontend/src/stake/useStakePoolClient.js` — hook: builds an Anchor `StakeClient` for any `stakeMint`
- `frontend/src/stake/StakePoolView.jsx` — stake form (amount + lock tier), positions list, claim wSOL → unwrap to SOL, unstake / unstake_early

## Run (dev)

```
# worker
cd worker
cp .env.example .env   # fill in keys + RPC
npm install
npm run serve          # API on :3060
npm run loop           # claim/distribute loop

# frontend
cd ../frontend
cp .env.example .env   # set VITE_RPC_URL=<helius> (mainnet-beta is throttled)
npm install
npm run dev            # http://localhost:5180
```

## Auto-stake on launch

When the launcher is wallet-connected and sets a non-zero "Initial dev buy
(SOL)", they can tick **"Atomically stake the dev buy on launch"** and pick a
lock tier. The flow becomes:

1. Treasury creates the token via PumpDev (treasury holds the dev-bought tokens after create).
2. Treasury immediately signs `stake_for(amount=devBuyBalance, lockDays, nonce, beneficiary=launcherWallet)` followed by a `prime_checkpoint(wSOL)` so the new position is baselined to start earning from the next worker cycle.
3. The position is owned by the launcher's wallet — they can `claim` / `unstake` themselves later. Treasury never holds the locked tokens after this point.

Lock tiers (enforced by the on-chain program): 1 / 3 / 7 / 14 / 21 / 30 days
with multipliers 1.00× / 1.25× / 1.50× / 2.00× / 2.50× / 3.00×.

## Pre-claim volume probe

Each cycle, before sending a PumpDev `claim-account` transaction, the worker
queries [DexScreener](https://api.dexscreener.com/latest/dex/tokens/{mint})
for the token's primary Solana pair and estimates accrued creator fees as
`volumeUsd × (priceNative / priceUsd) × 5 bps`. The smallest reporting window
(`m5` / `h1` / `h6` / `h24`) that fully spans the time since the pool's last
successful claim is used.

A claim is attempted when any of the following are true:

- Estimated accrued fee since last successful claim ≥ `6_000` lamports (covers ~2× the worst-case priority fee for the claim tx)
- The pool has never claimed before AND the token isn't indexed on DexScreener yet (give brand-new launches the benefit of the doubt)
- More than `4 hours` have passed since the last attempt (catch-up for tokens with sustained sub-threshold trickle volume)

A claim is **skipped** when:

- We're within `6 minutes` of the last successful claim (cooldown so the DexScreener m5 window has time to refresh and we don't double-count volume we already pocketed)
- The estimate is below threshold AND we've claimed at least once before

The probe diagnostics (`lastClaimedAt`, `lastClaimAttemptAt`, `lastClaimAttemptReason`, `lastClaimAttemptEstimate`) are persisted to `worker/data/pools.json` and surfaced on `GET /api/pools/:mint/public` under `pool.claimProbe`.
