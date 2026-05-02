// Public stakers leaderboard for a single mint. Renders below the staking
// panel on /token/:mint. Pulls /api/tokens/:mint/stakers (built from
// fetchStakersLeaderboard on the worker) and shows account, stake amount,
// % of pool, lock duration, staked-since, and lifetime fees earned —
// matching the layout pattern we see on Pump.fun's own stakers tab.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../apiBase.js';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const ERR = '#dc2626';
const OK = '#16a34a';
const BORDER = '#e5e7eb';

const LAMPORTS = 1_000_000_000n;

function shortPk(s, n = 4) {
  if (!s) return '';
  return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

function fmtSolFromLamports(lamportsStr, digits = 6) {
  if (!lamportsStr || lamportsStr === '0') return '0';
  try {
    const n = BigInt(lamportsStr);
    if (n === 0n) return '0';
    const whole = n / LAMPORTS;
    const frac = n % LAMPORTS;
    const fracStr = frac.toString().padStart(9, '0').slice(0, digits).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return String(lamportsStr);
  }
}

function fmtTokens(rawStr, decimals = 6) {
  if (!rawStr || rawStr === '0') return '0';
  try {
    const n = BigInt(rawStr);
    if (n === 0n) return '0';
    const d = BigInt(10) ** BigInt(decimals);
    const whole = n / d;
    const wholeNum = Number(whole);
    if (wholeNum >= 1e9) return `${(wholeNum / 1e9).toFixed(2)}B`;
    if (wholeNum >= 1e6) return `${(wholeNum / 1e6).toFixed(2)}M`;
    if (wholeNum >= 1e3) return `${(wholeNum / 1e3).toFixed(2)}K`;
    return whole.toLocaleString('en-US');
  } catch {
    return rawStr;
  }
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n > 0) return `$${n.toFixed(4)}`;
  return '$0';
}

function relativeTime(ts) {
  if (!ts) return '—';
  const ms = Date.now() - ts * 1000;
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function formatStakedSince(lockStartTs) {
  if (!lockStartTs) return { abs: '—', rel: '' };
  const date = new Date(lockStartTs * 1000);
  const abs = date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();
  return { abs, rel: relativeTime(lockStartTs) };
}

const SORTS = {
  effective: { label: 'Stake', key: (r) => BigInt(r.effective) },
  amount:    { label: 'Tokens',  key: (r) => BigInt(r.amountRaw) },
  earned:    { label: 'Earned',  key: (r) => BigInt(r.earnedRaw) },
  recent:    { label: 'Newest',  key: (r) => BigInt(r.lockStart || 0) },
};

const PAGE_SIZE = 25;

// Lightweight DexScreener pricing — no key required, CORS-allowed. Cached
// across mounts in module scope so each token page only fetches once.
const PRICE_CACHE = new Map(); // mint -> { ts, priceUsd }
const PRICE_TTL_MS = 60_000;

async function fetchTokenPriceUsd(mint) {
  if (!mint) return null;
  const cached = PRICE_CACHE.get(mint);
  if (cached && Date.now() - cached.ts < PRICE_TTL_MS) return cached.priceUsd;
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const json = await res.json();
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];
    const best = pairs.find((p) => p.chainId === 'solana') || pairs[0];
    const p = best?.priceUsd ? Number(best.priceUsd) : null;
    if (p != null) PRICE_CACHE.set(mint, { ts: Date.now(), priceUsd: p });
    return p;
  } catch {
    return null;
  }
}

const SOL_MINT = 'So11111111111111111111111111111111111111112';

export default function StakersLeaderboard({ mint, decimals = 6, symbol = 'TKN', rewardMode = 'sol' }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [sort, setSort] = useState('effective');
  const [page, setPage] = useState(0);
  const [tick, setTick] = useState(0);
  const [tokenPriceUsd, setTokenPriceUsd] = useState(null);
  const [solPriceUsd, setSolPriceUsd] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchTokenPriceUsd(mint), fetchTokenPriceUsd(SOL_MINT)]).then(([t, s]) => {
      if (cancelled) return;
      setTokenPriceUsd(t);
      setSolPriceUsd(s);
    });
    return () => { cancelled = true; };
  }, [mint, tick]);

  const reload = useCallback(async () => {
    if (!mint) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(apiUrl(`/api/tokens/${mint}/stakers`));
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setData(json);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [mint]);

  useEffect(() => { reload(); }, [reload, tick]);

  // Soft auto-refresh every 30s — claim cycles only run every 10m so this is
  // gentle enough not to hammer the worker for casual viewers.
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const sorted = useMemo(() => {
    if (!data?.stakers) return [];
    const k = (SORTS[sort] || SORTS.effective).key;
    return data.stakers.slice().sort((a, b) => {
      const A = k(a); const B = k(b);
      return A === B ? 0 : (B > A ? 1 : -1);
    });
  }, [data, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged = useMemo(
    () => sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    [sorted, page],
  );
  useEffect(() => { setPage(0); }, [sort, mint]);

  const stakerCount = data?.stakerCount || 0;

  // Aggregate stats
  const totals = useMemo(() => {
    if (!data?.stakers) return null;
    let amount = 0n;
    let earned = 0n;
    for (const s of data.stakers) {
      amount += BigInt(s.amountRaw);
      earned += BigInt(s.earnedRaw);
    }
    return { amount: amount.toString(), earned: earned.toString() };
  }, [data]);

  const isSolReward = (data?.rewardMode ?? rewardMode) !== 'token';

  return (
    <div className="panel panel--tight" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        padding: '16px 20px',
        borderBottom: `1px solid ${BORDER}`,
        display: 'flex',
        flexWrap: 'wrap',
        gap: 12,
        alignItems: 'baseline',
        justifyContent: 'space-between',
      }}>
        <div>
          <h3 className="section-title" style={{ margin: 0, fontSize: '1.35rem' }}>
            Stakers <span style={{ color: MUTED, fontWeight: 500, fontSize: '0.95rem' }}>({stakerCount.toLocaleString()})</span>
          </h3>
          {totals && (
            <div style={{ marginTop: 4, fontSize: 12, color: MUTED }}>
              {fmtTokens(totals.amount, decimals)} ${symbol} staked · {isSolReward ? `${fmtSolFromLamports(totals.earned, 4)} SOL` : `${fmtTokens(totals.earned, decimals)} $${symbol}`} paid out
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {Object.entries(SORTS).map(([k, v]) => (
            <button
              key={k}
              onClick={() => setSort(k)}
              style={{
                background: sort === k ? SKY : '#fff',
                color: sort === k ? '#fff' : SUB,
                border: `1px solid ${sort === k ? SKY : BORDER}`,
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 12,
                cursor: 'pointer',
                fontWeight: sort === k ? 600 : 500,
              }}
            >
              {v.label}
            </button>
          ))}
          <button
            onClick={() => setTick((x) => x + 1)}
            disabled={loading}
            style={{
              background: '#fff', color: SUB, border: `1px solid ${BORDER}`,
              borderRadius: 6, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
            }}
            title="refresh"
          >
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {err && (
        <div style={{ padding: 16, color: ERR, fontSize: 13 }}>
          Couldn't load stakers: {err}
        </div>
      )}

      {!err && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: '#fafafa' }}>
                <th style={th}>account</th>
                <th style={{ ...th, textAlign: 'right' }}>staked amount</th>
                <th style={{ ...th, textAlign: 'right' }}>value</th>
                <th style={{ ...th, textAlign: 'right' }}>% of pool</th>
                <th style={th}>staking duration</th>
                <th style={th}>staked since</th>
                <th style={{ ...th, textAlign: 'right' }}>fees earned</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((s) => {
                const since = formatStakedSince(s.lockStart);
                const tokensNum = Number(BigInt(s.amountRaw) * 100n / (10n ** BigInt(decimals))) / 100;
                const valueUsd = tokenPriceUsd != null && Number.isFinite(tokensNum)
                  ? tokensNum * tokenPriceUsd
                  : null;
                const earnedSol = isSolReward ? Number(s.earnedRaw) / 1e9 : null;
                const earnedTokens = !isSolReward ? Number(BigInt(s.earnedRaw) * 100n / (10n ** BigInt(decimals))) / 100 : null;
                const earnedUsd = isSolReward
                  ? (solPriceUsd != null ? earnedSol * solPriceUsd : null)
                  : (tokenPriceUsd != null && earnedTokens != null ? earnedTokens * tokenPriceUsd : null);
                const sharePct = (s.shareBps / 100).toFixed(s.shareBps >= 100 ? 1 : 2);
                return (
                  <tr key={s.position} style={{ borderTop: `1px solid ${BORDER}` }}>
                    <td style={td}>
                      <a
                        href={`https://solscan.io/account/${s.owner}`}
                        target="_blank"
                        rel="noreferrer"
                        title={s.owner}
                        style={{ color: INK, fontFamily: 'monospace', fontSize: 12, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                      >
                        <span aria-hidden style={{
                          width: 14, height: 14, borderRadius: 3, background: avatarColor(s.owner),
                          display: 'inline-block',
                        }} />
                        {shortPk(s.owner, 4)}
                      </a>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {fmtTokens(s.amountRaw, decimals)} <span style={{ color: MUTED, fontSize: 11 }}>{symbol}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: SUB }}>
                      {fmtUsd(valueUsd)}
                    </td>
                    <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                      {sharePct}%
                    </td>
                    <td style={td}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4, fontSize: 11,
                        background: lockBg(s.lockDays), color: lockFg(s.lockDays), fontWeight: 600,
                      }}>
                        {s.lockDays} DAYS
                      </span>
                    </td>
                    <td style={{ ...td, color: SUB, fontSize: 12 }}>
                      <div>{since.abs}</div>
                      <div style={{ color: MUTED, fontSize: 11 }}>{since.rel}</div>
                    </td>
                    <td style={{ ...td, textAlign: 'right', color: OK, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {isSolReward ? (
                        <>
                          {fmtSolFromLamports(s.earnedRaw, 6)} SOL
                          <div style={{ color: MUTED, fontSize: 11, fontWeight: 500 }}>{fmtUsd(earnedUsd)}</div>
                        </>
                      ) : (
                        <>
                          {fmtTokens(s.earnedRaw, decimals)} {symbol}
                          <div style={{ color: MUTED, fontSize: 11, fontWeight: 500 }}>{fmtUsd(earnedUsd)}</div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!loading && paged.length === 0 && (
                <tr>
                  <td style={{ ...td, color: MUTED, textAlign: 'center', padding: 24 }} colSpan={7}>
                    No stakers yet — be the first.
                  </td>
                </tr>
              )}
              {loading && paged.length === 0 && (
                <tr>
                  <td style={{ ...td, color: MUTED, textAlign: 'center', padding: 24 }} colSpan={7}>
                    Loading stakers…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && (
        <div style={{
          padding: '10px 16px',
          borderTop: `1px solid ${BORDER}`,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          fontSize: 12,
          color: MUTED,
        }}>
          <span>
            showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => setPage(0)} disabled={page === 0} style={pageBtn}>«</button>
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} style={pageBtn}>‹</button>
            <span style={{ padding: '4px 8px' }}>{page + 1} / {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1} style={pageBtn}>›</button>
            <button onClick={() => setPage(totalPages - 1)} disabled={page >= totalPages - 1} style={pageBtn}>»</button>
          </div>
        </div>
      )}
    </div>
  );
}

const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 11,
  color: MUTED,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  borderBottom: `1px solid ${BORDER}`,
};

const td = {
  padding: '12px 12px',
  fontSize: 13,
  color: INK,
  verticalAlign: 'middle',
};

const pageBtn = {
  background: '#fff',
  color: SUB,
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
  cursor: 'pointer',
  minWidth: 26,
};

// Stable per-wallet color so each staker's avatar dot is recognisable across
// scrolls. Hash the pubkey down to a hue.
function avatarColor(pk) {
  if (!pk) return '#ccc';
  let h = 0;
  for (let i = 0; i < pk.length; i += 1) h = (h * 31 + pk.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 65%, 55%)`;
}

function lockBg(days) {
  if (days >= 30) return '#fef3c7';
  if (days >= 14) return '#dbeafe';
  if (days >= 7)  return '#dcfce7';
  return '#f1f5f9';
}
function lockFg(days) {
  if (days >= 30) return '#92400e';
  if (days >= 14) return '#1e40af';
  if (days >= 7)  return '#166534';
  return '#475569';
}
