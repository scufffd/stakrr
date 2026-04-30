// DexScreener adapter — used as a pre-claim guard so the worker doesn't burn
// tx + priority fees on PumpDev `claim-account` calls when no real volume has
// hit a token since the last claim.
//
// Free public API. Pump.fun tokens are indexed under the `solana` chain.
// Docs: https://docs.dexscreener.com/api/reference
//   GET https://api.dexscreener.com/latest/dex/tokens/{mint}
//
// Response (relevant subset):
//   {
//     pairs: [{
//       chainId: 'solana',
//       dexId: 'pumpfun' | 'raydium' | ...,
//       priceNative: '0.0000000123',            // SOL per token
//       priceUsd: '0.000123',
//       txns: { m5: { buys, sells }, h1: {...}, h6: {...}, h24: {...} },
//       volume: { m5: 1234, h1: ..., h6: ..., h24: ... },   // USD
//       liquidity: { usd, base, quote },
//       fdv, marketCap,
//     }]
//   }

const ENDPOINT = (mint) => `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Fetch the token's pair data from DexScreener. Returns the first Solana pair
 * (pump.fun / pump-amm / raydium / etc) with the most liquidity, or null if
 * the token isn't indexed yet.
 *
 * Throws on network errors (caller decides how to fall back).
 */
export async function fetchPair(mintB58, { timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ENDPOINT(mintB58), {
      headers: { 'user-agent': BROWSER_UA, accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`dexscreener HTTP ${res.status}`);
  }
  const json = await res.json();
  const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
  if (pairs.length === 0) return null;
  // Prefer Solana pairs; fall back to whatever DexScreener returns.
  const sol = pairs.filter((p) => p.chainId === 'solana');
  const ranked = (sol.length ? sol : pairs).sort(
    (a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0),
  );
  return ranked[0] || null;
}

/**
 * Estimate creator fees accrued (in SOL lamports) since `sinceTs` based on
 * DexScreener volume. Pump.fun's creator fee is 5 bps (0.05%) of trade
 * volume, paid in SOL. We use the closest volume window that covers the
 * "since" interval.
 *
 * Returns { ok, accruedLamports, volumeUsd, priceSol, source } or
 * { ok: false, reason } when DexScreener has no data.
 */
export async function estimateCreatorFeeSinceTs(mintB58, sinceTs) {
  let pair;
  try {
    pair = await fetchPair(mintB58);
  } catch (e) {
    return { ok: false, reason: `dexscreener_error: ${e.message}` };
  }
  if (!pair) return { ok: false, reason: 'pair_not_indexed' };

  const now = Math.floor(Date.now() / 1000);
  const elapsed = Math.max(1, now - (sinceTs || now));

  // Pick the smallest window that fully contains the elapsed interval.
  const windows = [
    { key: 'm5', span: 5 * 60 },
    { key: 'h1', span: 60 * 60 },
    { key: 'h6', span: 6 * 60 * 60 },
    { key: 'h24', span: 24 * 60 * 60 },
  ];
  const w = windows.find((x) => x.span >= elapsed) || windows[windows.length - 1];

  const volumeUsd = Number(pair.volume?.[w.key] || 0);
  const priceUsd = Number(pair.priceUsd || 0);
  const priceNative = Number(pair.priceNative || 0); // SOL per token

  // Volume reported in USD; convert to SOL via priceUsd / priceNative ratio.
  // SOL/USD ratio = priceUsd / priceNative (since both refer to same token).
  let solPerUsd = 0;
  if (priceUsd > 0 && priceNative > 0) {
    solPerUsd = priceNative / priceUsd; // SOL per USD = priceNative(SOL/token) / priceUsd(USD/token)
  }
  const volumeSol = volumeUsd * solPerUsd;
  const volumeLamports = BigInt(Math.floor(volumeSol * 1e9));

  // Pump.fun creator fee ≈ 5 bps of trade volume.
  const accruedLamports = (volumeLamports * 5n) / 10_000n;

  return {
    ok: true,
    window: w.key,
    elapsedSec: elapsed,
    volumeUsd,
    volumeSol,
    accruedLamports: accruedLamports.toString(),
    priceUsd,
    priceNative,
    txns: pair.txns?.[w.key] || null,
    source: pair.dexId || 'unknown',
  };
}

/**
 * Decide whether a claim is worth attempting. We claim if any of:
 *   1. Estimated accrued creator fee since last claim ≥ minLamports
 *   2. The token isn't indexed yet AND we haven't claimed before (give a
 *      brand-new launch the benefit of the doubt).
 *   3. We haven't tried in `forceProbeAfterMs` (catch-up for tokens with
 *      sustained sub-threshold trickle volume).
 *
 * We also enforce a `cooldownAfterSuccessMs` between *successful* claims so
 * that the DexScreener trailing windows have time to refresh and we don't
 * double-count volume we already collected.
 */
export async function shouldAttemptClaim({
  mint,
  lastClaimedAt,
  lastClaimAttemptAt,
  minLamports = 5_000n,
  forceProbeAfterMs = 4 * 60 * 60 * 1000, // 4h: catch-up for slow drips
  cooldownAfterSuccessMs = 6 * 60 * 1000, // 6m: a hair past DexScreener's m5
}) {
  // Cooldown: never claim within `cooldownAfterSuccessMs` of a *successful*
  // claim. This prevents the m5 window from re-asserting volume we already
  // pocketed and triggering a no-op claim that just burns priority fees.
  if (lastClaimedAt) {
    const sinceLastSuccessMs = Date.now() - Date.parse(lastClaimedAt);
    if (sinceLastSuccessMs < cooldownAfterSuccessMs) {
      return {
        attempt: false,
        reason: 'cooldown_after_success',
        cooldownRemainingMs: cooldownAfterSuccessMs - sinceLastSuccessMs,
      };
    }
  }

  const lastEvent = lastClaimedAt || lastClaimAttemptAt;
  const lastEventMs = lastEvent ? Date.parse(lastEvent) : 0;
  const ageMs = Date.now() - lastEventMs;
  if (lastEventMs && ageMs >= forceProbeAfterMs) {
    return { attempt: true, reason: 'catch_up_force_probe', ageMs };
  }

  const sinceTs = lastEventMs ? Math.floor(lastEventMs / 1000) : 0;
  const est = await estimateCreatorFeeSinceTs(mint, sinceTs);
  if (!est.ok) {
    // DexScreener can't tell us — be optimistic on first run, conservative
    // on repeat (we just tried and got nothing back).
    if (!lastEventMs) return { attempt: true, reason: 'no_prior_claim', est };
    return { attempt: false, reason: est.reason, est };
  }
  if (BigInt(est.accruedLamports) >= BigInt(minLamports.toString())) {
    return { attempt: true, reason: 'volume_threshold', est };
  }
  return { attempt: false, reason: 'below_threshold', est };
}
