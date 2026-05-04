// Pump.fun bonding-curve math, client-side. Used by Launch + AdminSnipe to
// show "your X SOL buys ~Y% of supply" while the user is still typing the
// amount. Numbers are an estimate — actual fills depend on exact slot
// ordering, on-chain rounding, and any market activity that lands in the
// same block — but for a fresh launch where nobody else has bought yet
// the result is within ≤1 raw token of the on-chain outcome.
//
// All inputs/outputs that represent token or SOL amounts are BigInt in
// raw units (lamports for SOL, 6-dp atomic units for tokens) to avoid
// f64 precision drift at the supply boundary (1B * 10^6 = 10^15, which
// blows past 2^53).

// ── Constants matching pump.fun's bonding-curve initial state ────────────
// Sourced from the on-chain `BondingCurve` account state right after a
// fresh `create`. These are program defaults; pump can change them, in
// which case we'd need to refresh. As of v4 they have not.
export const PUMP_CURVE = Object.freeze({
  // 30 SOL of virtual reserves, denominated in lamports.
  initialVirtualSolReserves: 30_000_000_000n,
  // 1.073B tokens of virtual reserves, in 6-dp atomic units.
  initialVirtualTokenReserves: 1_073_000_000_000_000n,
  // 793.1M tokens actually available on the curve (the rest is locked
  // in the migration reserve and never tradable pre-bond).
  initialRealTokenReserves: 793_100_000_000_000n,
  // 1B total supply, 6 decimals.
  totalSupply: 1_000_000_000_000_000n,
  decimals: 6,
  // Pump charges 1% on each buy/sell. Fee comes off the input asset
  // (SOL on a buy) before it hits the curve, so an N-SOL buy actually
  // pumps the curve by 0.99 * N SOL. Apply the same here so the
  // estimate matches the user's wallet outcome, not the gross input.
  feeBpsDefault: 100,
});

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** Parse a SOL amount expressed as a string ("0.55") into BigInt lamports.
 *  Returns 0n for empty / invalid / negative. Rounds to nearest lamport. */
export function lamportsFromSolStr(input) {
  if (input === null || input === undefined || input === '') return 0n;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return 0n;
  return BigInt(Math.round(n * 1e9));
}

/** Simulate a single buy against an arbitrary curve state. State defaults
 *  to the fresh-launch initial reserves. Returns the next state alongside
 *  the tokens-out so callers can chain buys (see {@link simulateBundle}).
 *
 *  Rounding matches the on-chain program: tokensOut is computed via a
 *  ceil-divide on the new virtual token reserves, which means we never
 *  over-estimate the user's fill. Worst-case under-estimate is 1 raw
 *  token (10^-6 of a token), which is invisible at the UI level.
 */
export function simulateBuy(solInLamports, opts = {}) {
  const vSol = opts.virtualSol ?? PUMP_CURVE.initialVirtualSolReserves;
  const vTok = opts.virtualTokens ?? PUMP_CURVE.initialVirtualTokenReserves;
  const realTok = opts.realTokens ?? PUMP_CURVE.initialRealTokenReserves;
  const feeBps = BigInt(opts.feeBps ?? PUMP_CURVE.feeBpsDefault);

  const sol = typeof solInLamports === 'bigint' ? solInLamports : BigInt(solInLamports || 0);
  if (sol <= 0n) {
    return { tokensOut: 0n, virtualSol: vSol, virtualTokens: vTok, realTokens: realTok };
  }

  const solAfterFee = sol - (sol * feeBps) / 10_000n;
  const k = vSol * vTok;
  const newVSol = vSol + solAfterFee;
  // Ceil-divide → tokensOut rounded down (conservative).
  const newVTok = (k + newVSol - 1n) / newVSol;
  let tokensOut = vTok - newVTok;
  if (tokensOut < 0n) tokensOut = 0n;
  // Cap at what's actually in the real reserve. Past this point the
  // bonding curve is exhausted and the swap would migrate to AMM —
  // the UI estimate stops being meaningful, so we just clamp.
  if (tokensOut > realTok) tokensOut = realTok;

  return {
    tokensOut,
    virtualSol: newVSol,
    virtualTokens: vTok - tokensOut,
    realTokens: realTok - tokensOut,
  };
}

/** Chain a sequence of buys through the same curve, in order. Each entry
 *  in `buysSolLamports` is a SOL amount in lamports (BigInt or coercible).
 *  Returns per-buy results plus the final cumulative state. Order matters
 *  on Pump because each buy permanently moves the price; the dev going
 *  first in a launch bundle gets a meaningfully cheaper fill than the
 *  snipers behind them. */
export function simulateBundle(buysSolLamports, opts = {}) {
  let state = {
    virtualSol: opts.virtualSol ?? PUMP_CURVE.initialVirtualSolReserves,
    virtualTokens: opts.virtualTokens ?? PUMP_CURVE.initialVirtualTokenReserves,
    realTokens: opts.realTokens ?? PUMP_CURVE.initialRealTokenReserves,
  };
  const results = [];
  let cumulative = 0n;
  for (const sol of buysSolLamports) {
    const r = simulateBuy(sol, { ...opts, ...state });
    cumulative += r.tokensOut;
    results.push({
      solIn: typeof sol === 'bigint' ? sol : BigInt(sol || 0),
      tokensOut: r.tokensOut,
      cumulativeTokensOut: cumulative,
    });
    state = { virtualSol: r.virtualSol, virtualTokens: r.virtualTokens, realTokens: r.realTokens };
  }
  return { results, finalState: state, totalTokensOut: cumulative };
}

/** % of total supply for a raw token amount, returned as a Number with
 *  2-decimal precision (i.e. 0.55 means 0.55%). Safe for f64 because
 *  we scale by 10000 inside BigInt land first. */
export function pctOfSupply(tokensRaw) {
  const t = typeof tokensRaw === 'bigint' ? tokensRaw : BigInt(tokensRaw || 0);
  if (t <= 0n) return 0;
  // Multiply by 1e6 to get 4 decimals of pct precision (0.0001%).
  const scaled = (t * 1_000_000n) / PUMP_CURVE.totalSupply;
  return Number(scaled) / 10_000; // → percent with 4-dp resolution
}

/** Compact human-readable token count, e.g. 5_500_000_000_000n → "5.50M".
 *  Drops to fixed (not scientific) below 1K so very small allocations
 *  (e.g. a 0.001 SOL test buy) still render legibly. */
export function formatTokensCompact(tokensRaw, decimals = PUMP_CURVE.decimals) {
  const t = typeof tokensRaw === 'bigint' ? tokensRaw : BigInt(tokensRaw || 0);
  if (t <= 0n) return '0';
  const n = Number(t) / 10 ** decimals;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  // Sub-token allocations are unusual but possible at very low SOL — keep
  // up to 6 sig figs so they don't render as "0".
  return n.toPrecision(3);
}

/** Format a percent number (e.g. 0.5524) to a stable 2-dp string. */
export function formatPct(pct) {
  if (!Number.isFinite(pct) || pct <= 0) return '0%';
  if (pct < 0.01) return '<0.01%';
  return `${pct.toFixed(2)}%`;
}

/** One-shot helper: SOL amount string → {pct, tokens, label}. Convenience
 *  wrapper for views that don't need to chain buys. */
export function estimateBuyImpact(solStr, opts = {}) {
  const lamports = lamportsFromSolStr(solStr);
  const { tokensOut } = simulateBuy(lamports, opts);
  const pct = pctOfSupply(tokensOut);
  return {
    lamports,
    tokensOut,
    pct,
    label: `≈ ${formatPct(pct)} of supply · ${formatTokensCompact(tokensOut)} tokens`,
  };
}
