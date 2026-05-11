/**
 * Reward-line schema, validation, and normalization.
 *
 * A "reward line" is a single (mint, weight, source) tuple describing how
 * the cycle worker should distribute claimed creator fees:
 *   - `mint`         — the token paid out to stakers
 *   - `weightBps`    — share of each cycle's staker pot, summed across
 *                      lines must equal 10_000
 *   - `source`       — how the line gets funded each cycle:
 *                       'pump-fees-direct'      (deposit lamports as wSOL,
 *                                                only valid when mint = wSOL)
 *                       'pump-fees-swap-jup'    (Jupiter swap from wSOL,
 *                                                then deposit_rewards)
 *                       'pump-fees-swap-pumpdev' (legacy: buy stake_mint
 *                                                via Pump bonding curve)
 *                       'manual'                (operator funds, cycle skips)
 *   - `slippageBps?` — per-line slippage tolerance for swap sources (default 100)
 *   - `label?`       — display string ("USDC", "GMEx")
 *   - `decimals?`    — cached at launch for UI math
 *
 * Backward-compat: pools created before this feature have no `rewardLines`
 * field. `effectiveRewardLines(pool)` synthesises a single-line array from
 * the legacy `rewardMint` / `rewardMode` so the cycle worker treats them
 * identically without a registry migration.
 */

import { PublicKey } from '@solana/web3.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const MAX_REWARD_LINES = 5;
export const VALID_SOURCES = [
  'pump-fees-direct',
  'pump-fees-swap-jup',
  'pump-fees-swap-pumpdev',
  'manual',
];
export const DEFAULT_SLIPPAGE_BPS = 100;

/** Throws on invalid input. Returns a sanitised array safe to persist. */
export function validateAndNormaliseRewardLines(input, { stakeMint } = {}) {
  if (!Array.isArray(input)) throw new Error('rewardLines must be an array');
  if (input.length === 0) throw new Error('rewardLines must have at least 1 entry');
  if (input.length > MAX_REWARD_LINES) {
    throw new Error(`rewardLines: max ${MAX_REWARD_LINES} entries (got ${input.length})`);
  }

  const stakeMintStr = stakeMint
    ? (typeof stakeMint === 'string' ? stakeMint : stakeMint.toBase58())
    : null;

  const seen = new Set();
  let totalBps = 0;
  const out = input.map((raw, idx) => {
    if (!raw || typeof raw !== 'object') {
      throw new Error(`rewardLines[${idx}]: must be an object`);
    }
    const mint = String(raw.mint || '').trim();
    if (!mint) throw new Error(`rewardLines[${idx}]: mint required`);
    try { new PublicKey(mint); } catch { throw new Error(`rewardLines[${idx}]: invalid mint pubkey "${mint}"`); }
    if (seen.has(mint)) throw new Error(`rewardLines[${idx}]: duplicate mint ${mint}`);
    seen.add(mint);

    const weightBps = Number(raw.weightBps);
    if (!Number.isFinite(weightBps) || weightBps < 0 || weightBps > 10_000 || !Number.isInteger(weightBps)) {
      throw new Error(`rewardLines[${idx}]: weightBps must be integer 0..10000 (got ${raw.weightBps})`);
    }
    totalBps += weightBps;

    const source = String(raw.source || '').trim();
    if (!VALID_SOURCES.includes(source)) {
      throw new Error(`rewardLines[${idx}]: source must be one of [${VALID_SOURCES.join(', ')}] (got "${source}")`);
    }

    // Source-specific consistency:
    if (source === 'pump-fees-direct' && mint !== WSOL_MINT) {
      throw new Error(`rewardLines[${idx}]: source=pump-fees-direct requires mint=wSOL (got ${mint})`);
    }
    if (source === 'pump-fees-swap-pumpdev' && stakeMintStr && mint !== stakeMintStr) {
      throw new Error(`rewardLines[${idx}]: source=pump-fees-swap-pumpdev requires mint=stakeMint (got ${mint}, stake=${stakeMintStr})`);
    }
    if (source === 'pump-fees-swap-jup' && mint === WSOL_MINT) {
      throw new Error(`rewardLines[${idx}]: source=pump-fees-swap-jup mint cannot be wSOL — use pump-fees-direct instead`);
    }

    let slippageBps = raw.slippageBps == null ? DEFAULT_SLIPPAGE_BPS : Number(raw.slippageBps);
    if (!Number.isFinite(slippageBps) || slippageBps < 1 || slippageBps > 5_000) {
      throw new Error(`rewardLines[${idx}]: slippageBps must be 1..5000 (got ${raw.slippageBps})`);
    }
    slippageBps = Math.floor(slippageBps);

    return {
      mint,
      weightBps,
      source,
      slippageBps,
      label: raw.label ? String(raw.label).slice(0, 32) : null,
      decimals: Number.isInteger(raw.decimals) && raw.decimals >= 0 && raw.decimals <= 18
        ? raw.decimals
        : null,
    };
  });

  if (totalBps !== 10_000) {
    throw new Error(`rewardLines: weightBps must sum to 10000 (got ${totalBps})`);
  }
  return out;
}

/**
 * Build the runtime view of a pool's reward lines: the persisted array if
 * present, else a synthesised single-line array derived from the legacy
 * `rewardMode` / `rewardMint` fields. Always returns at least 1 line.
 */
export function effectiveRewardLines(pool) {
  if (Array.isArray(pool?.rewardLines) && pool.rewardLines.length > 0) {
    return pool.rewardLines.map((l) => ({
      mint: l.mint,
      weightBps: l.weightBps,
      source: l.source,
      slippageBps: l.slippageBps || DEFAULT_SLIPPAGE_BPS,
      label: l.label || null,
      decimals: Number.isInteger(l.decimals) ? l.decimals : null,
    }));
  }

  // Legacy single-line fallback.
  const mode = pool?.rewardMode === 'token' ? 'token' : 'sol';
  if (mode === 'token') {
    return [{
      mint: pool.stakeMint,
      weightBps: 10_000,
      source: 'pump-fees-swap-pumpdev',
      slippageBps: 500,
      label: pool?.metadata?.symbol || null,
      decimals: null,
    }];
  }
  return [{
    mint: WSOL_MINT,
    weightBps: 10_000,
    source: 'pump-fees-direct',
    slippageBps: DEFAULT_SLIPPAGE_BPS,
    label: 'wSOL',
    decimals: 9,
  }];
}

/**
 * Largest-remainder split of `totalLamports` across the given lines'
 * `weightBps`. Returns BigInt[] in the same order as `lines`. The sum
 * always equals `totalLamports` exactly — leftover dust is awarded to
 * the lines with the largest fractional remainders, then ties broken by
 * the lines with the largest weight (so the "primary" line absorbs
 * dust rather than a 1bps trace line).
 */
export function allocateByWeight(totalLamports, lines) {
  const total = BigInt(totalLamports);
  if (total === 0n || lines.length === 0) return lines.map(() => 0n);
  const weights = lines.map((l) => BigInt(l.weightBps));
  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  if (totalWeight === 0n) return lines.map(() => 0n);

  const floors = lines.map((_, i) => total * weights[i] / totalWeight);
  const remainders = lines.map((_, i) => (total * weights[i]) % totalWeight);
  let assigned = floors.reduce((a, b) => a + b, 0n);
  let dust = total - assigned;
  // Sort indices by (remainder desc, weight desc) for stable dust allocation.
  const order = lines.map((_, i) => i).sort((a, b) => {
    if (remainders[a] !== remainders[b]) return remainders[b] > remainders[a] ? 1 : -1;
    return weights[b] > weights[a] ? 1 : -1;
  });
  for (let i = 0; i < order.length && dust > 0n; i += 1) {
    floors[order[i]] += 1n;
    dust -= 1n;
  }
  return floors;
}
