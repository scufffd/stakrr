# Stakrr

Self-serve **proof-of-belief** launchpad for Pump.fun tokens with built-in staking and creator-fee rewards.

> Working name: **Stakrr** (placeholder, may rebrand to pumpr / STKE / final domain)

Anyone can launch a token via Pump.fun and instantly get a public staking pool where holders can lock their tokens and earn a share of the token's creator fees in SOL. Pump.fun is the only supported launch platform.

## How it works

1. Creator launches a token through Stakrr
   - Stakrr calls the Pump.fun create endpoint via [PumpDev](https://pumpdev.io/)
   - The platform treasury wallet is set as the on-chain creator-fee receiver
   - Stakrr then calls `initialize_pool` on the staking program for the new mint
   - `add_reward_mint(wSOL)` is registered so the pool can pay rewards in wrapped SOL
2. Holders stake the new token
   - Standard pob-index-stake flow (lock tiers, multipliers, claims)
3. Creator fees auto-route to stakers
   - Worker periodically claims accumulated creator fees from Pump.fun
   - 2% platform fee is sent to the platform treasury
   - 98% is wrapped to wSOL and deposited as rewards into the pool
   - Worker pushes rewards to active stakers via `claim_push`
4. Stakers claim rewards
   - wSOL is auto-unwrapped to native SOL on payout (or claimed as wSOL by their wallet)

## Architecture

```
[Creator]
   │ launch token
   ▼
[Stakrr Frontend] ───► [PumpDev API] ───► [Pump.fun Token]
   │
   │ init pool + add wSOL reward
   ▼
[pob-index-stake program]
   ▲
   │ deposit_rewards (wSOL), claim_push
   │
[Stakrr Worker] ◄── claim creator fees ◄── [Platform Treasury]
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

- `PLATFORM_TREASURY_PRIVATE_KEY` — pays for token creates, becomes the Pump.fun creator-fee receiver
- `PLATFORM_AUTHORITY_PRIVATE_KEY` — owns each `StakePool` (passes as `authority` on `initialize_pool`)
- `PUMPDEV_API_KEY` — Pump.fun integration
- `STAKE_PROGRAM_ID` — `65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA`
- `WSOL_MINT` — `So11111111111111111111111111111111111111112`
- `PLATFORM_FEE_BPS` — defaults to `200` (2%)

## Progress tracker

Each phase is committed and pushed; this section is the source of truth for "what's done".

- [x] Phase 0 — Repo scaffold, IDL copied, README, .env.example, .gitignore
- [x] Phase 1 — Pool registry + multi-pool worker loop (PumpDev claim → 2% cut → wSOL deposit → claim_push)
- [x] Phase 2 — Self-serve launch backend (`POST /api/launch`) + frontend launch flow form
- [x] Phase 3a — Pool directory + per-pool stats page + public partner API (`GET /api/pools/:mint/public`)
- [ ] Phase 3b — Per-pool stake / claim / unstake UI (port from POBINDEX, parameterized by mint)
- [ ] Phase 4 — Hosting (DO server, separate pm2 namespace, nginx vhost), domain selection
- [ ] Phase 5 — Faith integration (announce launches, scan pools)

### Files

- `worker/src/config.js` — env loader, treasury & authority keypairs, platform fee bps
- `worker/src/registry.js` — JSON pool registry + event ledger
- `worker/src/pumpdev.js` — Pump.fun create + claim creator-fees adapter (PumpDev)
- `worker/src/wsol.js` — wrap / unwrap SOL helpers
- `worker/src/stake-program.js` — Anchor client wrapping pob-index-stake (initialize_pool, add_reward_mint, deposit_rewards, claim_push, fetchers)
- `worker/src/launch.js` — orchestrates `pumpdev create` → `initialize_pool` → `add_reward_mint(wSOL)` → registry persist
- `worker/src/claim-and-distribute.js` — per-pool cycle: claim, fee split, wrap, deposit_rewards, claim_push to active stakers
- `worker/src/run-loop.js` — multi-pool loop on `LOOP_INTERVAL_MS`
- `worker/src/server.js` — Express API: launch, list pools, partner public endpoint
- `worker/scripts/{run-loop,run-cycle,list-pools}.js`
- `frontend/src/App.jsx` — shell + tabs (Pools / Launch)
- `frontend/src/views/LaunchView.jsx` — token launch form
- `frontend/src/views/DirectoryView.jsx` — list of active pools
- `frontend/src/views/PoolView.jsx` — per-pool stats placeholder; staking UI is Phase 3b

## Run (dev)

```
# worker
cd worker
cp .env.example .env   # fill in keys + RPC
npm install
npm run loop

# frontend
cd ../frontend
npm install
npm run dev
```
