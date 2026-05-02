// Admin-only market-maker dashboard.
//
// Lives at /admin/mm — off the public nav. Lets you:
//   • Configure MM for a token: pick a vault wallet (the bot signs trades
//     with its keypair), set bankrollSol cap + drawdown%, buy size + cadence.
//   • Monitor live: net spent, current vs peak P&L, drawdown, trade count,
//     errors, last action time.
//   • Pause/resume per-token. Manual one-shot tick for verification.
//
// HONEST WARNING (also surfaced in the UI): on Pump.fun bonding curve every
// round-trip is structurally lossy. The bot tracks every lamport spent in
// worker/data/mm.json. Use the bankroll + drawdown caps. Watch the
// "current P&L" column — it's almost always negative.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { apiUrl } from '../apiBase.js';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const ERR = '#dc2626';
const OK  = '#16a34a';
const WARN= '#d97706';
const BORDER = '#e5e7eb';

const LAMPORTS = 1_000_000_000n;

function shortPk(s, n = 4) {
  if (!s) return '';
  return s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s;
}

function fmtSol(lamportsLike, digits = 4) {
  if (lamportsLike == null) return '0';
  try {
    const n = typeof lamportsLike === 'bigint' ? lamportsLike : BigInt(lamportsLike);
    const sign = n < 0n ? '-' : '';
    const abs = n < 0n ? -n : n;
    const whole = abs / LAMPORTS;
    const frac = abs % LAMPORTS;
    const fracStr = frac.toString().padStart(9, '0').slice(0, digits).replace(/0+$/, '');
    return `${sign}${fracStr ? `${whole}.${fracStr}` : whole}`;
  } catch {
    return String(lamportsLike);
  }
}

function fmtPnl(lamportsStr) {
  if (!lamportsStr) return { v: '0', sign: 0 };
  const n = BigInt(lamportsStr);
  const sign = n === 0n ? 0 : (n > 0n ? 1 : -1);
  return { v: fmtSol(n, 6), sign };
}

function ago(ts) {
  if (!ts) return '—';
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms)) return '—';
  if (ms < 0) return `in ${Math.round(-ms / 1000)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

async function adminFetch(path, { method = 'GET', adminPk, body } = {}) {
  const headers = { 'x-admin-wallet': adminPk || '' };
  let payload;
  if (body) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export default function AdminMmView({ adminWallets = [] }) {
  const wallet = useWallet();
  const adminPk = wallet?.publicKey?.toBase58() || null;
  const isAdmin = adminPk && adminWallets.includes(adminPk);

  const [tokens, setTokens] = useState([]);
  const [defaults, setDefaults] = useState(null);
  const [vaultWallets, setVaultWallets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

  const reload = useCallback(async () => {
    if (!adminPk) return;
    setLoading(true);
    try {
      const [info, vault] = await Promise.all([
        adminFetch('/api/admin/mm/info', { adminPk }),
        adminFetch('/api/admin/snipe/wallets', { adminPk }).catch(() => ({ wallets: [] })),
      ]);
      setTokens(info.tokens || []);
      setDefaults(info.defaults || null);
      setVaultWallets(vault.wallets || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [adminPk]);

  useEffect(() => { reload(); }, [reload]);
  // Soft auto-refresh every 15s — daemon ticks every 10s so this stays fresh.
  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const handlePause = useCallback(async (mint) => {
    if (!confirm('Pause MM for this token?')) return;
    setBusy(mint);
    try {
      await adminFetch('/api/admin/mm/pause', { method: 'POST', adminPk, body: { mint, reason: 'manual via UI' } });
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [adminPk, reload]);

  const handleResume = useCallback(async (mint) => {
    setBusy(mint);
    try {
      await adminFetch('/api/admin/mm/resume', { method: 'POST', adminPk, body: { mint } });
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [adminPk, reload]);

  const handleDelete = useCallback(async (mint) => {
    if (!confirm(`Remove MM config for ${shortPk(mint)} entirely? Trade history is dropped (P&L data lost).`)) return;
    setBusy(mint);
    try {
      await adminFetch(`/api/admin/mm/${mint}`, { method: 'DELETE', adminPk });
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [adminPk, reload]);

  const handleTick = useCallback(async (mint) => {
    setBusy(mint);
    try {
      const out = await adminFetch('/api/admin/mm/tick', { method: 'POST', adminPk, body: { mint } });
      alert(`tick result: ${out.result.action}${out.result.error ? `\nerror: ${out.result.error}` : out.result.sig ? `\nsig: ${out.result.sig}` : ''}`);
      await reload();
    } catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  }, [adminPk, reload]);

  if (!adminPk) {
    return <div style={{ padding: 32, color: MUTED }}>Connect a wallet to access MM admin.</div>;
  }
  if (!isAdmin) {
    return <div style={{ padding: 32, color: ERR }}>Connected wallet is not an admin.</div>;
  }

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1280, margin: '0 auto' }}>
      <h2 style={{ margin: 0, marginBottom: 4, color: INK }}>Market maker</h2>
      <p style={{ color: MUTED, fontSize: 13, marginTop: 0, marginBottom: 16, lineHeight: 1.5 }}>
        Per-token MM bot. Adds small buys + sells on a randomised cadence to make the chart look active.
        On the bonding curve every round-trip pays a 1% fee each side, so the bot is structurally
        net-negative on its own trading P&L. Use the <strong>bankroll cap</strong> + <strong>drawdown</strong>{' '}
        kill switches to bound loss. The bot pauses itself when either trips. Daemon: <code>stakrr-mm</code> (pm2).
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <button
          onClick={() => setShowAddForm((x) => !x)}
          style={{ background: SKY, color: '#fff', border: 'none', borderRadius: 8, padding: '8px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
        >
          {showAddForm ? '× cancel' : '＋ configure new token'}
        </button>
        <button onClick={reload} disabled={loading} style={smallBtn}>{loading ? '…' : 'refresh'}</button>
        <span style={{ color: MUTED, fontSize: 12 }}>{tokens.length} configured</span>
      </div>

      {err && <div style={{ background: '#fef2f2', color: ERR, padding: 10, borderRadius: 6, fontSize: 13, marginBottom: 12 }}>
        {err} <button onClick={() => setErr(null)} style={{ float: 'right', background: 'transparent', border: 'none', color: ERR, cursor: 'pointer' }}>×</button>
      </div>}

      {showAddForm && defaults && (
        <ConfigureForm
          defaults={defaults}
          vaultWallets={vaultWallets}
          adminPk={adminPk}
          onSaved={() => { setShowAddForm(false); reload(); }}
          existingMints={tokens.map((t) => t.mint)}
        />
      )}

      <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 12, marginTop: 12 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ background: '#fafafa' }}>
              <th style={th}>token</th>
              <th style={th}>wallet</th>
              <th style={th}>status</th>
              <th style={{ ...th, textAlign: 'right' }}>spent</th>
              <th style={{ ...th, textAlign: 'right' }}>received</th>
              <th style={{ ...th, textAlign: 'right' }}>P&L</th>
              <th style={{ ...th, textAlign: 'right' }}>drawdown</th>
              <th style={{ ...th, textAlign: 'right' }}>trades</th>
              <th style={th}>last action</th>
              <th style={th}>actions</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => {
              const peak = BigInt(t.state?.peakPnlLamports || '0');
              const cur = BigInt(t.state?.currentPnlLamports || '0');
              const drawPct = peak > 0n
                ? Number((peak - cur) * 10_000n / peak) / 100
                : 0;
              const pnl = fmtPnl(t.state?.currentPnlLamports);
              const status = !t.enabled
                ? { label: t.state?.pausedAt ? 'paused' : 'disabled', color: '#6b7280', bg: '#f3f4f6' }
                : { label: 'running', color: OK, bg: '#dcfce7' };
              const w = vaultWallets.find((v) => v.id === t.walletId);
              return (
                <tr key={t.mint} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{t.symbol || '—'}</div>
                    <div style={{ fontFamily: 'monospace', fontSize: 11, color: MUTED }}>
                      <a href={`/token/${t.mint}`} target="_blank" rel="noreferrer" style={{ color: SKY, textDecoration: 'none' }}>
                        {shortPk(t.mint, 5)}
                      </a>
                    </div>
                  </td>
                  <td style={{ ...td, fontSize: 12 }}>
                    {w?.label || '—'}
                    <div style={{ color: MUTED, fontSize: 11, fontFamily: 'monospace' }}>
                      {shortPk(t.walletId?.slice(4) || '', 4)} · {fmtSol(BigInt(Math.round((w?.sol || 0) * 1e9)), 4)} SOL
                    </div>
                  </td>
                  <td style={td}>
                    <span style={{ padding: '2px 8px', borderRadius: 4, fontSize: 11, color: status.color, background: status.bg, fontWeight: 600 }}>
                      {status.label}
                    </span>
                    {t.state?.pauseReason && (
                      <div style={{ fontSize: 10, color: WARN, marginTop: 2, maxWidth: 180, lineHeight: 1.3 }} title={t.state.pauseReason}>
                        {t.state.pauseReason.slice(0, 60)}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtSol(t.state?.totalSpentLamports || '0')}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtSol(t.state?.totalReceivedLamports || '0')}
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: pnl.sign > 0 ? OK : (pnl.sign < 0 ? ERR : INK), fontWeight: 600 }}>
                    {pnl.sign > 0 ? '+' : ''}{pnl.v}
                    <div style={{ fontSize: 10, color: MUTED, fontWeight: 400 }}>
                      peak {fmtSol(t.state?.peakPnlLamports || '0', 4)}
                    </div>
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: drawPct >= (t.config?.drawdownPct || 100) * 0.8 ? WARN : MUTED }}>
                    {drawPct.toFixed(1)}%
                    <div style={{ fontSize: 10, color: MUTED }}>cap {t.config?.drawdownPct}%</div>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {t.state?.tradesCount || 0}
                    {t.state?.errorsCount > 0 && (
                      <span style={{ color: ERR, fontSize: 11, marginLeft: 4 }} title={`${t.state.errorsCount} failed trades`}>
                        ({t.state.errorsCount} err)
                      </span>
                    )}
                  </td>
                  <td style={{ ...td, fontSize: 12, color: SUB }}>
                    {ago(t.state?.lastActionAt)}
                    {t.state?.nextActionAt && t.enabled && (
                      <div style={{ fontSize: 10, color: MUTED }}>next {ago(t.state.nextActionAt)}</div>
                    )}
                  </td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {t.enabled
                        ? <button onClick={() => handlePause(t.mint)} disabled={busy === t.mint} style={tinyBtn}>pause</button>
                        : <button onClick={() => handleResume(t.mint)} disabled={busy === t.mint} style={{ ...tinyBtn, background: OK, color: '#fff', borderColor: OK }}>resume</button>}
                      <button onClick={() => handleTick(t.mint)} disabled={busy === t.mint} style={tinyBtn} title="fire one strategy step now (bypass nextActionAt)">tick</button>
                      <button onClick={() => handleDelete(t.mint)} disabled={busy === t.mint} style={{ ...tinyBtn, color: ERR }}>remove</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {tokens.length === 0 && !loading && (
              <tr><td colSpan={10} style={{ ...td, textAlign: 'center', color: MUTED, padding: 24 }}>No tokens configured. Click "configure new token" to start.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfigureForm({ defaults, vaultWallets, adminPk, onSaved, existingMints }) {
  const [mint, setMint] = useState('');
  const [symbol, setSymbol] = useState('');
  const [walletId, setWalletId] = useState('');
  const [bankrollSol, setBankrollSol] = useState(defaults.bankrollSol);
  const [drawdownPct, setDrawdownPct] = useState(defaults.drawdownPct);
  const [minBuySol, setMinBuySol] = useState(defaults.minBuySol);
  const [maxBuySol, setMaxBuySol] = useState(defaults.maxBuySol);
  const [minIntervalSec, setMinIntervalSec] = useState(defaults.minIntervalSec);
  const [maxIntervalSec, setMaxIntervalSec] = useState(defaults.maxIntervalSec);
  const [slippage, setSlippage] = useState(defaults.slippage);
  const [maxTradesPerHour, setMaxTradesPerHour] = useState(defaults.maxTradesPerHour);
  const [enabled, setEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const fundedWallets = useMemo(
    () => vaultWallets.filter((w) => (w.sol || 0) >= 0.005).sort((a, b) => (b.sol || 0) - (a.sol || 0)),
    [vaultWallets],
  );

  const onSubmit = useCallback(async (e) => {
    e?.preventDefault();
    setErr(null);
    if (!mint || mint.length < 32) { setErr('valid mint required'); return; }
    if (existingMints.includes(mint)) { setErr('already configured (edit existing row instead)'); return; }
    if (!walletId) { setErr('pick an MM wallet'); return; }
    setSubmitting(true);
    try {
      await adminFetch('/api/admin/mm/configure', {
        method: 'POST',
        adminPk,
        body: {
          mint: mint.trim(),
          symbol: symbol.trim() || null,
          walletId,
          enabled,
          config: {
            bankrollSol: Number(bankrollSol),
            drawdownPct: Number(drawdownPct),
            minBuySol: Number(minBuySol),
            maxBuySol: Number(maxBuySol),
            minIntervalSec: Number(minIntervalSec),
            maxIntervalSec: Number(maxIntervalSec),
            slippage: Number(slippage),
            maxTradesPerHour: Number(maxTradesPerHour),
          },
        },
      });
      onSaved();
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSubmitting(false);
    }
  }, [adminPk, mint, symbol, walletId, enabled, bankrollSol, drawdownPct, minBuySol, maxBuySol, minIntervalSec, maxIntervalSec, slippage, maxTradesPerHour, existingMints, onSaved]);

  return (
    <form onSubmit={onSubmit} style={{ border: `1px solid ${SKY}`, borderRadius: 12, padding: 16, background: '#f0f9ff', marginBottom: 12 }}>
      <div style={{ fontWeight: 600, color: SUB, marginBottom: 12 }}>Configure MM for a token</div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 2fr', gap: 12, marginBottom: 12 }}>
        <Field label="Mint *">
          <input value={mint} onChange={(e) => setMint(e.target.value.trim())} style={input} placeholder="abc…pump" />
        </Field>
        <Field label="Symbol">
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={input} maxLength={10} />
        </Field>
        <Field label="MM wallet (vault) *">
          <select value={walletId} onChange={(e) => setWalletId(e.target.value)} style={input}>
            <option value="">— pick a funded vault wallet —</option>
            {fundedWallets.map((w) => (
              <option key={w.id} value={w.id}>{w.label} · {(w.sol || 0).toFixed(4)} SOL</option>
            ))}
          </select>
        </Field>
      </div>

      <div style={{ background: '#fef3c7', color: '#92400e', padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
        ⚠️ The bot will spend SOL from this wallet on buys. <strong>It is structurally net-negative on Pump's curve.</strong>{' '}
        Set <code>bankrollSol</code> to your max acceptable loss. The bot pauses itself when (a) net-spent ≥ bankroll OR (b) drawdown from peak ≥ drawdownPct.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
        <Field label="Bankroll cap (SOL)" hint="hard pause when net spend ≥ this">
          <input type="number" step="0.05" min="0.05" value={bankrollSol} onChange={(e) => setBankrollSol(e.target.value)} style={input} />
        </Field>
        <Field label="Drawdown cap %" hint="pause if P&L drops X% below peak">
          <input type="number" step="5" min="5" max="100" value={drawdownPct} onChange={(e) => setDrawdownPct(e.target.value)} style={input} />
        </Field>
        <Field label="Slippage %">
          <input type="number" step="1" min="1" max="50" value={slippage} onChange={(e) => setSlippage(e.target.value)} style={input} />
        </Field>
        <Field label="Max trades/hour">
          <input type="number" step="1" min="1" max="120" value={maxTradesPerHour} onChange={(e) => setMaxTradesPerHour(e.target.value)} style={input} />
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 12 }}>
        <Field label="Min buy (SOL)">
          <input type="number" step="0.001" min="0.001" value={minBuySol} onChange={(e) => setMinBuySol(e.target.value)} style={input} />
        </Field>
        <Field label="Max buy (SOL)">
          <input type="number" step="0.001" min="0.001" value={maxBuySol} onChange={(e) => setMaxBuySol(e.target.value)} style={input} />
        </Field>
        <Field label="Min interval (sec)">
          <input type="number" step="5" min="10" value={minIntervalSec} onChange={(e) => setMinIntervalSec(e.target.value)} style={input} />
        </Field>
        <Field label="Max interval (sec)">
          <input type="number" step="5" min="10" value={maxIntervalSec} onChange={(e) => setMaxIntervalSec(e.target.value)} style={input} />
        </Field>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: SUB, fontSize: 13, marginBottom: 12 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Start trading immediately (otherwise saved as paused)
      </label>

      {err && <div style={{ color: ERR, fontSize: 13, marginBottom: 8 }}>{err}</div>}

      <button type="submit" disabled={submitting} style={{ background: SKY, color: '#fff', border: 'none', borderRadius: 8, padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
        {submitting ? 'saving…' : enabled ? 'save + start trading' : 'save (paused)'}
      </button>
    </form>
  );
}

const input = {
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 14,
  width: '100%',
  fontFamily: 'inherit',
};

function Field({ label, hint, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</span>
      {children}
      {hint && <div style={{ fontSize: 10, color: MUTED, marginTop: 2 }}>{hint}</div>}
    </label>
  );
}

const smallBtn = {
  background: '#fff',
  color: SUB,
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  padding: '4px 10px',
  fontSize: 12,
  cursor: 'pointer',
};

const tinyBtn = {
  background: '#fff',
  color: SUB,
  border: `1px solid ${BORDER}`,
  borderRadius: 4,
  padding: '3px 8px',
  fontSize: 11,
  cursor: 'pointer',
};

const th = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 11,
  color: MUTED,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
};

const td = {
  padding: '10px 12px',
  fontSize: 13,
  color: INK,
  verticalAlign: 'top',
};
