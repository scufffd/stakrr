// Admin-only stealth-launch tool. Bundles create + dev buy + N sniper buys
// into a single Jito bundle so the platform's wallets are first-block buyers
// on every launch. Post-launch the admin can sell/sweep each sniper's bag
// from the same screen.
//
// Routed at /admin/snipe — deliberately not in the public header nav.
//
// Three tabs: Wallets · Launch · Snipes.
//   - Wallets: encrypted vault of sniper keypairs (pool + ephemeral). Generate,
//     import, rename, sweep SOL, delete, export secret (gated).
//   - Launch:  form to fire a stealth launch — picks dev wallet, multi-select
//     snipers, sets dev buy + per-sniper SOL + Jito tip + metadata.
//   - Snipes:  past launches with per-sniper holdings + sell/transfer/sweep.
//
// All API calls go to /api/admin/snipe/* and require x-admin-wallet header
// (real auth) plus an extra confirmation header for secret-key export.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { apiUrl } from '../apiBase.js';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const ERR = '#dc2626';
const OK = '#16a34a';

// Tier palette — keep in lockstep with the kind-pill in the snipes drawer
// so a wallet's role looks the same wherever it's shown.
const TIER_COLORS = {
  sniper:   { bg: '#dbeafe', fg: '#1e40af' },
  absorber: { bg: '#dcfce7', fg: '#166534' },
  mm:       { bg: '#ede9fe', fg: '#6d28d9' },
  dev:      { bg: '#fce7f3', fg: '#9d174d' },
};
const WARN = '#d97706';
const BORDER = '#e5e7eb';

// ── Helpers ─────────────────────────────────────────────────────────────────

function shortPk(s, n = 4) {
  if (!s) return '';
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function fmtSol(sol) {
  if (sol == null) return '—';
  const n = Number(sol);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function fmtTokens(amount, decimals) {
  if (amount == null) return '—';
  const n = Number(amount) / 10 ** (decimals || 0);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n > 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n > 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n > 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

async function adminFetch(path, { method = 'GET', adminPk, body, headers = {}, isFormData = false } = {}) {
  const opts = { method, headers: { ...headers } };
  if (adminPk) opts.headers['x-admin-wallet'] = adminPk;
  if (body) {
    if (isFormData) {
      opts.body = body;
    } else {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(apiUrl(path), opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.ok === false) {
    throw new Error(json.error || json.raw || `HTTP ${res.status}`);
  }
  return json;
}

// ── Tab: Wallets ────────────────────────────────────────────────────────────

function WalletsTab({ adminPk }) {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [filter, setFilter] = useState('all');
  const [busy, setBusy] = useState(null); // walletId being acted on
  const [newPoolCount, setNewPoolCount] = useState(1);
  const [newEphemeralCount, setNewEphemeralCount] = useState(3);
  const [importSecret, setImportSecret] = useState('');
  const [importLabel, setImportLabel] = useState('');
  const [importSource, setImportSource] = useState('pool');

  const reload = useCallback(async () => {
    if (!adminPk) return;
    setLoading(true);
    setErr(null);
    try {
      const out = await adminFetch('/api/admin/snipe/wallets', { adminPk });
      setWallets(out.wallets || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [adminPk]);

  useEffect(() => { reload(); }, [reload]);

  const filtered = useMemo(() => {
    if (filter === 'all') return wallets;
    return wallets.filter((w) => w.source === filter);
  }, [wallets, filter]);

  const handleGenerate = useCallback(async (source) => {
    setBusy('__gen');
    try {
      await adminFetch('/api/admin/snipe/wallets/generate', {
        method: 'POST',
        adminPk,
        body: {
          count: source === 'pool' ? Number(newPoolCount) : Number(newEphemeralCount),
          source,
        },
      });
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, newPoolCount, newEphemeralCount, reload]);

  const handleImport = useCallback(async () => {
    if (!importSecret.trim()) { setErr('paste a secret key first'); return; }
    setBusy('__import');
    try {
      await adminFetch('/api/admin/snipe/wallets/import', {
        method: 'POST',
        adminPk,
        body: {
          secretKey: importSecret.trim(),
          label: importLabel.trim() || undefined,
          source: importSource,
        },
      });
      setImportSecret('');
      setImportLabel('');
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, importSecret, importLabel, importSource, reload]);

  const handleSweep = useCallback(async (id) => {
    if (!confirm('Sweep all SOL from this wallet to the platform treasury?')) return;
    setBusy(id);
    try {
      await adminFetch('/api/admin/snipe/sweep', {
        method: 'POST',
        adminPk,
        body: { walletId: id },
      });
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, reload]);

  const handleDelete = useCallback(async (id, force = false) => {
    if (!confirm(force ? 'Force-delete this wallet? Any remaining SOL will be ORPHANED. Are you sure?' : 'Remove this wallet from the vault?')) return;
    setBusy(id);
    try {
      await adminFetch(`/api/admin/snipe/wallets/${id}${force ? '?force=1' : ''}`, {
        method: 'DELETE',
        adminPk,
      });
      await reload();
    } catch (e) {
      // 409 = still has SOL — offer force option
      if (/still has \d+ lamports/.test(e.message)) {
        if (confirm(`${e.message}\n\nDelete anyway and orphan the SOL?`)) {
          return handleDelete(id, true);
        }
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy(null);
    }
  }, [adminPk, reload]);

  const handleExport = useCallback(async (id) => {
    if (!confirm('Export this wallet\'s PRIVATE KEY in plaintext? Anyone who sees it can drain the wallet.')) return;
    if (!confirm('Are you SURE? Last warning.')) return;
    setBusy(id);
    try {
      const out = await adminFetch(`/api/admin/snipe/wallets/${id}/export`, {
        method: 'POST',
        adminPk,
        headers: { 'x-export-confirm': 'I-UNDERSTAND-EXPORTING-PRIVATE-KEYS' },
      });
      try {
        await navigator.clipboard.writeText(out.secretKeyB58);
        alert('Secret key copied to clipboard. Paste somewhere safe immediately.');
      } catch {
        prompt('Secret key (copy manually):', out.secretKeyB58);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk]);

  const handleRename = useCallback(async (id, currentLabel) => {
    const next = prompt('New label:', currentLabel || '');
    if (next == null) return;
    setBusy(id);
    try {
      await adminFetch(`/api/admin/snipe/wallets/${id}`, {
        method: 'PATCH',
        adminPk,
        body: { label: next.trim() },
      });
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, reload]);

  // Tier selection — purely organisational. The launch choreography uses
  // `tier === 'absorber'` to pick wallets for the post-rug accumulation
  // wave (separated from the in-bundle snipers so terminals don't cluster
  // them). Empty string clears the tier on the backend.
  const handleSetTier = useCallback(async (id, tier) => {
    setBusy(id);
    try {
      await adminFetch(`/api/admin/snipe/wallets/${id}`, {
        method: 'PATCH',
        adminPk,
        body: { tier: tier || null },
      });
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, reload]);

  const totalPoolSol = useMemo(
    () => wallets.filter((w) => w.source === 'pool').reduce((s, w) => s + (w.sol || 0), 0),
    [wallets],
  );
  const totalEphemeralSol = useMemo(
    () => wallets.filter((w) => w.source === 'ephemeral').reduce((s, w) => s + (w.sol || 0), 0),
    [wallets],
  );

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Stat label="Pool wallets" value={wallets.filter((w) => w.source === 'pool').length} note={`${fmtSol(totalPoolSol)} SOL total`} />
        <Stat label="Ephemeral wallets" value={wallets.filter((w) => w.source === 'ephemeral').length} note={`${fmtSol(totalEphemeralSol)} SOL total`} />
        <Stat label="Total" value={wallets.length} note={`${fmtSol(totalPoolSol + totalEphemeralSol)} SOL grand total`} />
      </div>

      <Card title="Generate sniper wallets">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Pool wallets to generate (persistent, reusable)">
            <input
              type="number" min={1} max={20}
              value={newPoolCount}
              onChange={(e) => setNewPoolCount(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <button
            onClick={() => handleGenerate('pool')}
            disabled={busy === '__gen'}
            style={btn(SKY)}
          >
            + generate pool
          </button>
          <Field label="Ephemeral wallets (single-launch, sweep & delete after)">
            <input
              type="number" min={1} max={20}
              value={newEphemeralCount}
              onChange={(e) => setNewEphemeralCount(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <button
            onClick={() => handleGenerate('ephemeral')}
            disabled={busy === '__gen'}
            style={btn('#94a3b8')}
          >
            + generate ephemeral
          </button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
          New wallets start with 0 SOL. Pre-fund manually before launching — see "Launch" tab for required amounts.
        </div>
      </Card>

      <Card title="Import existing keypair" style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 12, alignItems: 'flex-end' }}>
          <Field label="Secret key (base58 or JSON byte array)">
            <input
              type="password"
              placeholder="2vXkLp… or [123, 45, …]"
              value={importSecret}
              onChange={(e) => setImportSecret(e.target.value)}
              style={inputStyle}
            />
          </Field>
          <Field label="Label">
            <input value={importLabel} onChange={(e) => setImportLabel(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Source">
            <select value={importSource} onChange={(e) => setImportSource(e.target.value)} style={inputStyle}>
              <option value="pool">pool</option>
              <option value="ephemeral">ephemeral</option>
            </select>
          </Field>
          <button onClick={handleImport} disabled={busy === '__import'} style={btn(SKY)}>import</button>
        </div>
      </Card>

      <div style={{ marginTop: 24, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Wallets</strong>
        <FilterPills value={filter} onChange={setFilter} options={[
          { id: 'all', label: `all (${wallets.length})` },
          { id: 'pool', label: `pool (${wallets.filter((w) => w.source === 'pool').length})` },
          { id: 'ephemeral', label: `ephemeral (${wallets.filter((w) => w.source === 'ephemeral').length})` },
        ]} />
        <button onClick={reload} disabled={loading} style={smallBtn}>{loading ? '…' : 'refresh'}</button>
      </div>

      {err && <ErrorBox err={err} onDismiss={() => setErr(null)} />}

      <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 12 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>label</th>
              <th style={th}>source</th>
              <th style={th} title="Tier — used by the launch choreography to pick which wallets play which role. Set to 'absorber' for the post-rug accumulation wave.">tier</th>
              <th style={th}>public key</th>
              <th style={{ ...th, textAlign: 'right' }}>SOL</th>
              <th style={th}>launch</th>
              <th style={th}>created</th>
              <th style={th}>actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => {
              const tierColor = TIER_COLORS[w.tier] || { bg: '#f3f4f6', fg: '#6b7280' };
              return (
                <tr key={w.id}>
                  <td style={td}><span style={{ fontWeight: 600 }}>{w.label}</span></td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 6px', borderRadius: 4, fontSize: 11,
                      background: w.source === 'pool' ? '#dbeafe' : '#f1f5f9',
                      color: w.source === 'pool' ? '#1e40af' : '#475569',
                    }}>{w.source}</span>
                  </td>
                  <td style={td}>
                    <select
                      value={w.tier || ''}
                      onChange={(e) => handleSetTier(w.id, e.target.value)}
                      disabled={busy === w.id}
                      style={{
                        padding: '2px 6px', fontSize: 11, borderRadius: 4,
                        background: tierColor.bg, color: tierColor.fg,
                        border: `1px solid ${BORDER}`, fontWeight: w.tier ? 600 : 400,
                        cursor: busy === w.id ? 'wait' : 'pointer',
                      }}
                    >
                      <option value="">— none —</option>
                      <option value="sniper">sniper</option>
                      <option value="absorber">absorber</option>
                      <option value="mm">mm</option>
                      <option value="dev">dev</option>
                    </select>
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>
                    <button
                      onClick={() => navigator.clipboard?.writeText(w.publicKey)}
                      title={`${w.publicKey} — click to copy`}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: INK, padding: 0 }}
                    >
                      {shortPk(w.publicKey, 5)}
                    </button>
                  </td>
                  <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {w.solError ? <span style={{ color: ERR }} title={w.solError}>err</span> : fmtSol(w.sol)}
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>
                    {w.launchMint ? shortPk(w.launchMint, 4) : <span style={{ color: MUTED }}>—</span>}
                  </td>
                  <td style={{ ...td, color: MUTED }}>{timeAgo(w.createdAt)}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <button onClick={() => handleRename(w.id, w.label)} disabled={busy === w.id} style={tinyBtn}>rename</button>
                      <button onClick={() => handleSweep(w.id)} disabled={busy === w.id || !w.sol} style={tinyBtn}>sweep</button>
                      <button onClick={() => handleExport(w.id)} disabled={busy === w.id} style={{ ...tinyBtn, color: WARN }}>export</button>
                      <button onClick={() => handleDelete(w.id)} disabled={busy === w.id} style={{ ...tinyBtn, color: ERR }}>delete</button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td style={{ ...td, textAlign: 'center', color: MUTED, padding: 24 }} colSpan={8}>
                  {loading ? 'loading…' : 'No wallets in this filter. Generate or import above.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Tab: Launch ─────────────────────────────────────────────────────────────

function LaunchTab({ adminPk, onLaunched }) {
  const [wallets, setWallets] = useState([]);
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imageUrl, setImageUrl] = useState('');
  const [metadataUri, setMetadataUri] = useState('');

  const [devWalletId, setDevWalletId] = useState('');
  const [sniperIds, setSniperIds] = useState([]);
  const [devBuySol, setDevBuySol] = useState('0.1');
  const [sniperSolPerWallet, setSniperSolPerWallet] = useState('0.05');
  const [jitoTipSol, setJitoTipSol] = useState('0.005');
  const [slippageBps, setSlippageBps] = useState('5000');
  const [rewardMode, setRewardMode] = useState('sol');

  // Inline "import another wallet to use as dev" UX — paste a secret key,
  // it's stored encrypted in the vault (so it can be reused/swept later)
  // and auto-selected as the deployer for this launch.
  const [showDevImport, setShowDevImport] = useState(false);
  const [devImportSecret, setDevImportSecret] = useState('');
  const [devImportLabel, setDevImportLabel] = useState('');
  const [devImportSource, setDevImportSource] = useState('ephemeral');
  const [devImporting, setDevImporting] = useState(false);
  const [devImportErr, setDevImportErr] = useState(null);

  // Show wallets with 0 SOL too — useful right after importing a new dev
  // wallet that you're about to fund externally.
  const [showUnfunded, setShowUnfunded] = useState(false);

  const [quote, setQuote] = useState(null);
  const [quoteErr, setQuoteErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

  // KOL airdrop (optional inline auto-stake to a curated wallet list, runs
  // after pool init confirms, signed locally with the dev's vault keypair)
  const [kolEnabled, setKolEnabled] = useState(false);
  const [kolText, setKolText] = useState('');
  const [kolWallets, setKolWallets] = useState([]);
  const [kolParseErr, setKolParseErr] = useState(null);
  const [kolLockDays, setKolLockDays] = useState(30);
  const [kolAllocPct, setKolAllocPct] = useState(25);
  const [kolScanCategory, setKolScanCategory] = useState('pnl-7d');
  const [kolScanLimit, setKolScanLimit] = useState(20);
  const [kolScanLoading, setKolScanLoading] = useState(false);
  const [kolScanErr, setKolScanErr] = useState(null);
  // Pending-claim is the default — tokens stay earmarked in the dev wallet
  // until the KOL signs an accept message. Push mode = the legacy "stake
  // for them right away without their consent" behaviour, kept for cases
  // where conviction signal matters more than consent.
  const [kolMode, setKolMode] = useState('pending-claim');
  const [kolClaimWindowDays, setKolClaimWindowDays] = useState(30);
  // Reserved for future per-launch override; the worker also dedupes against
  // its own list (KOL CSV containing the same wallet twice).
  const [kolExcludeWalletsText, setKolExcludeWalletsText] = useState('');

  // MM seed bootstrap (optional). MM wallet buys at creator price as part
  // of the launch bundle, then the daemon picks the mint up automatically
  // and starts cycling buys/sells with bankroll/drawdown kill switches.
  // The early-entry bag is what makes the strategy structurally profitable.
  const [mmEnabled, setMmEnabled] = useState(false);
  const [mmWalletId, setMmWalletId] = useState('');
  const [mmEntrySol, setMmEntrySol] = useState('0.05');
  const [mmBankrollSol, setMmBankrollSol] = useState('0.5');
  const [mmDrawdownPct, setMmDrawdownPct] = useState('25');
  const [mmMinBuySol, setMmMinBuySol] = useState('0.005');
  const [mmMaxBuySol, setMmMaxBuySol] = useState('0.02');
  const [mmMinIntervalSec, setMmMinIntervalSec] = useState('45');
  const [mmMaxIntervalSec, setMmMaxIntervalSec] = useState('180');
  const [mmSlippage, setMmSlippage] = useState('15');

  // Choreography (dev rug + absorber wall, anti-sniper play). After pool
  // init confirms, the dev wallet sells (max scare → snipers exit), then
  // a wave of clean absorber wallets buys to absorb the supply. Each
  // absorber can optionally auto-stake to lock its bag.
  const [choreoEnabled, setChoreoEnabled] = useState(false);
  const [choreoAbsorberIds, setChoreoAbsorberIds] = useState([]);
  const [choreoDevStakePct, setChoreoDevStakePct] = useState('0');
  const [choreoDevStakeLockDays, setChoreoDevStakeLockDays] = useState('7');
  const [choreoDevSellPct, setChoreoDevSellPct] = useState('100');
  const [choreoDevSellDelayBlocks, setChoreoDevSellDelayBlocks] = useState('3');
  const [choreoAbsorberWaveDelayBlocks, setChoreoAbsorberWaveDelayBlocks] = useState('4');
  const [choreoAbsorberWaveSize, setChoreoAbsorberWaveSize] = useState('4');
  const [choreoAbsorberBuyMinSol, setChoreoAbsorberBuyMinSol] = useState('0.02');
  const [choreoAbsorberBuyMaxSol, setChoreoAbsorberBuyMaxSol] = useState('0.08');
  const [choreoAbsorberAutoStakePct, setChoreoAbsorberAutoStakePct] = useState('50');
  const [choreoAbsorberStakeLockDays, setChoreoAbsorberStakeLockDays] = useState('7');
  const [choreoDripWindowSec, setChoreoDripWindowSec] = useState('30');
  const [choreoDripIntervalMinMs, setChoreoDripIntervalMinMs] = useState('1500');
  const [choreoDripIntervalMaxMs, setChoreoDripIntervalMaxMs] = useState('4000');

  const reload = useCallback(async () => {
    if (!adminPk) return;
    setLoading(true);
    try {
      const out = await adminFetch('/api/admin/snipe/wallets', { adminPk });
      setWallets(out.wallets || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [adminPk]);

  useEffect(() => { reload(); }, [reload]);

  const fundedWallets = useMemo(
    () => wallets.filter((w) => (w.sol || 0) > 0).sort((a, b) => (b.sol || 0) - (a.sol || 0)),
    [wallets],
  );
  // Wallets explicitly tagged as absorbers — only these can be picked for the
  // choreography wave. Pre-flight requires SOL but we list unfunded too so
  // the user sees who they need to top-up.
  const absorberWallets = useMemo(
    () => wallets.filter((w) => w.tier === 'absorber').sort((a, b) => (b.sol || 0) - (a.sol || 0)),
    [wallets],
  );
  const choreoEstSpendSol = useMemo(() => {
    const avg = (Number(choreoAbsorberBuyMinSol) + Number(choreoAbsorberBuyMaxSol)) / 2;
    return choreoAbsorberIds.length * avg;
  }, [choreoAbsorberIds, choreoAbsorberBuyMinSol, choreoAbsorberBuyMaxSol]);
  // Dev picker: include unfunded wallets if the toggle is on (so a freshly
  // imported wallet shows up before you've topped it up). Sniper picker stays
  // funded-only — pre-flight will reject the launch otherwise.
  const devCandidates = useMemo(() => {
    const sorted = wallets.slice().sort((a, b) => (b.sol || 0) - (a.sol || 0));
    return showUnfunded ? sorted : sorted.filter((w) => (w.sol || 0) > 0);
  }, [wallets, showUnfunded]);
  const devCandidate = useMemo(
    () => devCandidates.find((w) => w.id === devWalletId) || wallets.find((w) => w.id === devWalletId) || null,
    [devCandidates, wallets, devWalletId],
  );

  const toggleSniper = useCallback((id) => {
    setSniperIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const handleDevImport = useCallback(async () => {
    setDevImportErr(null);
    if (!devImportSecret.trim()) { setDevImportErr('paste a secret key first'); return; }
    setDevImporting(true);
    try {
      const out = await adminFetch('/api/admin/snipe/wallets/import', {
        method: 'POST',
        adminPk,
        body: {
          secretKey: devImportSecret.trim(),
          label: devImportLabel.trim() || `dev-${new Date().toISOString().slice(11, 19)}`,
          source: devImportSource,
        },
      });
      // Refresh wallet list, then auto-select the import as dev.
      await reload();
      if (out.wallet?.id) setDevWalletId(out.wallet.id);
      // Surface unfunded wallets in case the import is empty (typical for
      // fresh keypairs the user is about to fund externally).
      setShowUnfunded(true);
      setDevImportSecret('');
      setDevImportLabel('');
      setShowDevImport(false);
    } catch (e) {
      setDevImportErr(e.message);
    } finally {
      setDevImporting(false);
    }
  }, [adminPk, devImportSecret, devImportLabel, devImportSource, reload]);

  const parseKolList = useCallback(async () => {
    setKolParseErr(null);
    if (!kolText.trim()) { setKolWallets([]); return; }
    try {
      const out = await adminFetch('/api/admin/snipe/kol/parse', {
        method: 'POST',
        adminPk,
        body: { text: kolText },
      });
      setKolWallets(out.wallets || []);
    } catch (e) {
      setKolParseErr(e.message);
      setKolWallets([]);
    }
  }, [adminPk, kolText]);

  // Re-parse on text changes (debounced) so the count updates live.
  useEffect(() => {
    if (!kolEnabled) return;
    const t = setTimeout(parseKolList, 350);
    return () => clearTimeout(t);
  }, [kolEnabled, parseKolList]);

  const fetchKolScan = useCallback(async () => {
    setKolScanErr(null);
    setKolScanLoading(true);
    try {
      const out = await adminFetch(`/api/admin/snipe/kol/scan?category=${encodeURIComponent(kolScanCategory)}&limit=${Number(kolScanLimit) || 20}`, {
        adminPk,
      });
      // Append to text area (one wallet per line) — the user can edit/curate.
      const lines = (out.wallets || []).map((w) => (w.label ? `${w.wallet}, 1, ${w.label}` : w.wallet));
      setKolText((prev) => {
        const sep = prev.trim() ? '\n' : '';
        return prev + sep + `# kolscan ${kolScanCategory} (${lines.length})\n` + lines.join('\n');
      });
    } catch (e) {
      setKolScanErr(e.message);
    } finally {
      setKolScanLoading(false);
    }
  }, [adminPk, kolScanCategory, kolScanLimit]);

  const refreshQuote = useCallback(async () => {
    setQuoteErr(null);
    setQuote(null);
    if (!devWalletId) return;
    try {
      const out = await adminFetch('/api/admin/snipe/quote', {
        method: 'POST',
        adminPk,
        body: {
          devWalletId,
          sniperWalletIds: sniperIds,
          devBuySol: Number(devBuySol),
          sniperSolPerWallet: Number(sniperSolPerWallet),
          jitoTipSol: Number(jitoTipSol),
          mm: mmEnabled && mmWalletId && Number(mmEntrySol) > 0
            ? { walletId: mmWalletId, entrySol: Number(mmEntrySol) }
            : null,
        },
      });
      setQuote(out.quote);
    } catch (e) {
      setQuoteErr(e.message);
    }
  }, [adminPk, devWalletId, sniperIds, devBuySol, sniperSolPerWallet, jitoTipSol, mmEnabled, mmWalletId, mmEntrySol]);

  useEffect(() => {
    const t = setTimeout(refreshQuote, 250);
    return () => clearTimeout(t);
  }, [refreshQuote]);

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    setErr(null);
    setResult(null);
    if (!name.trim() || !symbol.trim()) { setErr('name + symbol required'); return; }
    if (!devWalletId) { setErr('select a deployer wallet'); return; }
    if (!imageFile && !imageUrl.trim() && !metadataUri.trim()) {
      setErr('upload an image, paste an image URL, or pre-pinned metadata URI');
      return;
    }

    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('symbol', symbol.trim().toUpperCase());
      fd.append('description', description);
      if (twitter) fd.append('twitter', twitter);
      if (telegram) fd.append('telegram', telegram);
      if (website) fd.append('website', website);
      if (imageFile) fd.append('image', imageFile);
      if (imageUrl.trim()) fd.append('imageUrl', imageUrl.trim());
      if (metadataUri.trim()) fd.append('metadataUri', metadataUri.trim());
      fd.append('devWalletId', devWalletId);
      fd.append('sniperWalletIds', JSON.stringify(sniperIds));
      fd.append('devBuySol', String(Number(devBuySol) || 0));
      fd.append('sniperSolPerWallet', String(Number(sniperSolPerWallet) || 0));
      fd.append('jitoTipSol', String(Number(jitoTipSol) || 0.005));
      fd.append('slippageBps', String(Number(slippageBps) || 5000));
      fd.append('rewardMode', rewardMode);

      if (kolEnabled && kolWallets.length > 0) {
        const excludeWallets = kolExcludeWalletsText
          .split(/[\s,;\n]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        fd.append('kolAirdrop', JSON.stringify({
          wallets: kolWallets,
          lockDays: Number(kolLockDays) || 30,
          tokenAllocationPct: Number(kolAllocPct) || 25,
          mode: kolMode,
          equalSplit: true,
          claimWindowDays: Number(kolClaimWindowDays) || 30,
          excludeWallets,
        }));
      }

      if (mmEnabled && mmWalletId && Number(mmEntrySol) > 0) {
        fd.append('mm', JSON.stringify({
          walletId: mmWalletId,
          entrySol: Number(mmEntrySol),
          config: {
            bankrollSol: Number(mmBankrollSol) || 0.5,
            drawdownPct: Number(mmDrawdownPct) || 25,
            minBuySol: Number(mmMinBuySol) || 0.005,
            maxBuySol: Number(mmMaxBuySol) || 0.02,
            minIntervalSec: Number(mmMinIntervalSec) || 45,
            maxIntervalSec: Number(mmMaxIntervalSec) || 180,
            slippage: Number(mmSlippage) || 15,
          },
        }));
      }

      if (choreoEnabled) {
        fd.append('choreography', JSON.stringify({
          absorberWalletIds: choreoAbsorberIds,
          filterTier: true,
          config: {
            devStakePct: Number(choreoDevStakePct) || 0,
            devStakeLockDays: Number(choreoDevStakeLockDays) || 7,
            devSellPct: Number(choreoDevSellPct) || 100,
            devSellDelayBlocks: Number(choreoDevSellDelayBlocks) || 3,
            absorberWaveDelayBlocks: Number(choreoAbsorberWaveDelayBlocks) || 4,
            absorberWaveSize: Number(choreoAbsorberWaveSize) || 4,
            absorberBuyMinSol: Number(choreoAbsorberBuyMinSol) || 0.02,
            absorberBuyMaxSol: Number(choreoAbsorberBuyMaxSol) || 0.08,
            absorberAutoStakePct: Number(choreoAbsorberAutoStakePct) || 0,
            absorberStakeLockDays: Number(choreoAbsorberStakeLockDays) || 7,
            dripWindowSec: Number(choreoDripWindowSec) || 30,
            dripIntervalMinMs: Number(choreoDripIntervalMinMs) || 1500,
            dripIntervalMaxMs: Number(choreoDripIntervalMaxMs) || 4000,
          },
        }));
      }

      const out = await adminFetch('/api/admin/snipe/launch', {
        method: 'POST',
        adminPk,
        body: fd,
        isFormData: true,
      });
      setResult(out);
      if (onLaunched) onLaunched(out);
    } catch (ex) {
      setErr(ex.message);
    } finally {
      setSubmitting(false);
    }
  }, [adminPk, name, symbol, description, twitter, telegram, website, imageFile, imageUrl, metadataUri, devWalletId, sniperIds, devBuySol, sniperSolPerWallet, jitoTipSol, slippageBps, rewardMode, kolEnabled, kolWallets, kolLockDays, kolAllocPct, kolMode, kolClaimWindowDays, kolExcludeWalletsText, mmEnabled, mmWalletId, mmEntrySol, mmBankrollSol, mmDrawdownPct, mmMinBuySol, mmMaxBuySol, mmMinIntervalSec, mmMaxIntervalSec, mmSlippage, choreoEnabled, choreoAbsorberIds, choreoDevStakePct, choreoDevStakeLockDays, choreoDevSellPct, choreoDevSellDelayBlocks, choreoAbsorberWaveDelayBlocks, choreoAbsorberWaveSize, choreoAbsorberBuyMinSol, choreoAbsorberBuyMaxSol, choreoAbsorberAutoStakePct, choreoAbsorberStakeLockDays, choreoDripWindowSec, choreoDripIntervalMinMs, choreoDripIntervalMaxMs, onLaunched]);

  return (
    <form onSubmit={handleSubmit}>
      <Card title="1. Token metadata">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Name *"><input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} /></Field>
          <Field label="Symbol *"><input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={inputStyle} maxLength={10} /></Field>
        </div>
        <Field label="Description" style={{ marginTop: 12 }}>
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
          <Field label="Twitter"><input value={twitter} onChange={(e) => setTwitter(e.target.value)} style={inputStyle} /></Field>
          <Field label="Telegram"><input value={telegram} onChange={(e) => setTelegram(e.target.value)} style={inputStyle} /></Field>
          <Field label="Website"><input value={website} onChange={(e) => setWebsite(e.target.value)} style={inputStyle} /></Field>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
          <Field label="Image upload">
            <input type="file" accept="image/*" onChange={(e) => setImageFile(e.target.files?.[0] || null)} style={{ ...inputStyle, padding: 6 }} />
          </Field>
          <Field label="…or image URL">
            <input value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} style={inputStyle} placeholder="https://" />
          </Field>
        </div>
        <Field label="…or pre-pinned metadata URI (optional)" style={{ marginTop: 12 }}>
          <input value={metadataUri} onChange={(e) => setMetadataUri(e.target.value)} style={inputStyle} placeholder="https://ipfs… (skips upload)" />
        </Field>
      </Card>

      <Card title="2. Deployer wallet" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: MUTED }}>
            {loading
              ? 'loading wallets…'
              : `${devCandidates.length} ${showUnfunded ? 'wallet' : 'funded'}${devCandidates.length === 1 ? '' : 's'} shown`}
          </span>
          <button type="button" onClick={reload} style={smallBtn}>refresh</button>
          <label style={{ fontSize: 12, color: SUB, display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={showUnfunded}
              onChange={(e) => setShowUnfunded(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            show unfunded
          </label>
          <button
            type="button"
            onClick={() => setShowDevImport((v) => !v)}
            style={{ ...smallBtn, color: SKY, borderColor: SKY }}
          >
            {showDevImport ? '× cancel' : '+ import wallet to use as dev'}
          </button>
        </div>

        {showDevImport && (
          <div style={{
            border: `1px dashed ${SKY}`, borderRadius: 8, padding: 12, marginBottom: 12, background: '#f0fbfd',
          }}>
            <div style={{ fontSize: 12, color: SUB, marginBottom: 8 }}>
              Paste a base58 secret key (Phantom export) or a JSON byte array. Stored encrypted in the vault, auto-selected as dev.
              Use <strong>ephemeral</strong> for one-launch wallets you'll sweep + delete after; <strong>pool</strong> if you want to reuse it across launches.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: 8, alignItems: 'flex-end' }}>
              <Field label="Secret key">
                <input
                  type="password"
                  placeholder="2vXkLp… or [123, 45, …]"
                  value={devImportSecret}
                  onChange={(e) => setDevImportSecret(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Label (optional)">
                <input
                  value={devImportLabel}
                  onChange={(e) => setDevImportLabel(e.target.value)}
                  placeholder="e.g. dev-launch-7"
                  style={inputStyle}
                />
              </Field>
              <Field label="Source">
                <select value={devImportSource} onChange={(e) => setDevImportSource(e.target.value)} style={inputStyle}>
                  <option value="ephemeral">ephemeral (one-shot)</option>
                  <option value="pool">pool (reusable)</option>
                </select>
              </Field>
              <button
                type="button"
                onClick={handleDevImport}
                disabled={devImporting}
                style={btn(SKY)}
              >
                {devImporting ? 'importing…' : 'import & select'}
              </button>
            </div>
            {devImportErr && (
              <div style={{ color: ERR, fontSize: 12, marginTop: 8 }}>{devImportErr}</div>
            )}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {devCandidates.map((w) => {
            const isSelected = devWalletId === w.id;
            const unfunded = !(w.sol > 0);
            return (
              <button
                type="button"
                key={w.id}
                onClick={() => setDevWalletId(w.id)}
                style={{
                  ...selectableCard,
                  borderColor: isSelected ? SKY : BORDER,
                  background: isSelected ? '#ecfeff' : '#fff',
                  opacity: unfunded && !isSelected ? 0.65 : 1,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontWeight: 600 }}>{w.label}</span>
                  <span style={{
                    padding: '1px 5px', borderRadius: 3, fontSize: 10,
                    background: w.source === 'pool' ? '#dbeafe' : '#f1f5f9',
                    color: w.source === 'pool' ? '#1e40af' : '#475569',
                  }}>{w.source}</span>
                </div>
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: MUTED, marginTop: 2 }}>{shortPk(w.publicKey, 5)}</div>
                <div style={{ marginTop: 4, fontSize: 13, color: unfunded ? WARN : INK }}>
                  {fmtSol(w.sol)} SOL{unfunded && <span style={{ marginLeft: 4, fontSize: 10, color: WARN }}>· fund before launching</span>}
                </div>
              </button>
            );
          })}
          {devCandidates.length === 0 && (
            <div style={{ color: MUTED, gridColumn: '1 / -1' }}>
              {showUnfunded
                ? 'No wallets in the vault yet. Import one above or generate from the Wallets tab.'
                : 'No funded wallets. Toggle "show unfunded" to pick one anyway, or fund an existing wallet.'}
            </div>
          )}
        </div>

        {devCandidate && !(devCandidate.sol > 0) && (
          <div style={{
            marginTop: 10, padding: 8, fontSize: 12, color: WARN,
            background: '#fffbeb', border: `1px solid ${WARN}`, borderRadius: 6,
          }}>
            Selected dev wallet has 0 SOL. Send funds to <span style={{ fontFamily: 'monospace' }}>{devCandidate.publicKey}</span> before submitting — the pre-flight check will reject the launch otherwise.
            Hit refresh once the transfer lands.
          </div>
        )}
      </Card>

      <Card title="3. Sniper wallets" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: MUTED }}>{sniperIds.length} selected · max 3 fit in the bundle, rest go staggered</span>
          <button type="button" onClick={() => setSniperIds(fundedWallets.filter((w) => w.id !== devWalletId).slice(0, 3).map((w) => w.id))} style={smallBtn}>select first 3 funded</button>
          <button type="button" onClick={() => setSniperIds([])} style={smallBtn}>clear</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {fundedWallets.filter((w) => w.id !== devWalletId).map((w) => {
            const sel = sniperIds.includes(w.id);
            return (
              <button
                type="button"
                key={w.id}
                onClick={() => toggleSniper(w.id)}
                style={{
                  ...selectableCard,
                  borderColor: sel ? SKY : BORDER,
                  background: sel ? '#ecfeff' : '#fff',
                }}
              >
                <div style={{ fontWeight: 600 }}>{w.label}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 11, color: MUTED }}>{shortPk(w.publicKey, 5)}</div>
                <div style={{ marginTop: 4, fontSize: 13 }}>{fmtSol(w.sol)} SOL</div>
                <div style={{ fontSize: 11, color: sel ? SKY : MUTED, marginTop: 2 }}>{sel ? '✓ selected' : 'tap to select'}</div>
              </button>
            );
          })}
        </div>
      </Card>

      <Card title="4. Bundle parameters" style={{ marginTop: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
          <Field label="Dev buy (SOL)">
            <input type="number" step="0.01" min="0" value={devBuySol} onChange={(e) => setDevBuySol(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Per-sniper (SOL)">
            <input type="number" step="0.01" min="0" value={sniperSolPerWallet} onChange={(e) => setSniperSolPerWallet(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Jito tip (SOL)" hint="Jito's effective floor moves with congestion (typically 0.001-0.005 SOL). Below floor = bundle silently dropped → 'bundle confirmation timed out'. 0.005 is a safe default for most launches.">
            <input type="number" step="0.001" min="0.001" value={jitoTipSol} onChange={(e) => setJitoTipSol(e.target.value)} style={inputStyle} />
          </Field>
          <Field label="Slippage (bps, 100=1%)">
            <input type="number" step="100" min="100" max="9000" value={slippageBps} onChange={(e) => setSlippageBps(e.target.value)} style={inputStyle} />
          </Field>
        </div>
        <Field label="Reward mode" style={{ marginTop: 12 }}>
          <select value={rewardMode} onChange={(e) => setRewardMode(e.target.value)} style={inputStyle}>
            <option value="sol">SOL (wsol-rewards) — most launches</option>
            <option value="token">Token (self-rewards) — pool earns the launched token</option>
          </select>
        </Field>
      </Card>

      <Card title="5. KOL airdrop (optional)" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            id="kol-enabled"
            type="checkbox"
            checked={kolEnabled}
            onChange={(e) => setKolEnabled(e.target.checked)}
          />
          <label htmlFor="kol-enabled" style={{ fontSize: 13, color: SUB, cursor: 'pointer' }}>
            Auto-stake a slice of the dev-buy bag to KOL wallets after pool init
          </label>
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: kolEnabled ? 12 : 0 }}>
          Slice of the dev-buy bag is split <strong>equally</strong> across the listed wallets. Default mode is <em>pending-claim</em>: tokens stay in the dev wallet until each KOL signs an accept message; unclaimed slots auto-expire and revert to the dev after the window. Push mode creates positions immediately without consent (legacy).
        </div>

        {kolEnabled && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1fr 0.9fr', gap: 12, marginBottom: 12 }}>
              <Field label="Delivery mode">
                <select value={kolMode} onChange={(e) => setKolMode(e.target.value)} style={inputStyle}>
                  <option value="pending-claim">Pending-claim (recommended)</option>
                  <option value="push">Push (no consent)</option>
                </select>
              </Field>
              <Field label="Lock duration (after claim)">
                <select value={kolLockDays} onChange={(e) => setKolLockDays(Number(e.target.value))} style={inputStyle}>
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={21}>21 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                </select>
              </Field>
              <Field label={kolMode === 'pending-claim' ? 'Claim window' : 'Claim window (n/a for push)'}>
                <select
                  value={kolClaimWindowDays}
                  onChange={(e) => setKolClaimWindowDays(Number(e.target.value))}
                  style={inputStyle}
                  disabled={kolMode === 'push'}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                </select>
              </Field>
              <Field label="% of dev buy bag">
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={kolAllocPct}
                  onChange={(e) => setKolAllocPct(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Exclude wallets (optional, dedupe vs presale contributors etc.)">
                <textarea
                  rows={2}
                  value={kolExcludeWalletsText}
                  onChange={(e) => setKolExcludeWalletsText(e.target.value)}
                  placeholder="paste pubkeys to skip (comma/space/newline separated)"
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 11, resize: 'vertical' }}
                />
              </Field>
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                <div style={{ fontSize: 11, color: MUTED, marginBottom: 4 }}>Wallets parsed</div>
                <div style={{
                  border: `1px solid ${BORDER}`, borderRadius: 8, padding: '8px 10px',
                  background: kolWallets.length ? '#f0fdf4' : '#fff', fontWeight: 600,
                }}>
                  {kolWallets.length} {kolWallets.length === 1 ? 'wallet' : 'wallets'}
                  {kolWallets.length > 0 && (
                    <span style={{ color: MUTED, fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                      · equal split
                      {kolMode === 'pending-claim'
                        ? ' · earmarked, no on-chain action until claimed'
                        : ` · ≈ ${Math.ceil(kolWallets.length / 2)} batches`}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="KOL wallets (one address per line, optional `,weight,label` columns)">
                <textarea
                  rows={8}
                  value={kolText}
                  onChange={(e) => setKolText(e.target.value)}
                  placeholder={'# paste pubkeys, one per line\n# or addr,weight,label\nABC123…XYZ\nDEF456…UVW, 2, alpha-kol'}
                  style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
                />
              </Field>
              <div>
                <Field label="Or fetch from KolScan">
                  <select value={kolScanCategory} onChange={(e) => setKolScanCategory(e.target.value)} style={inputStyle}>
                    <option value="pnl-24h">P&L · 24h</option>
                    <option value="pnl-7d">P&L · 7d</option>
                    <option value="pnl-30d">P&L · 30d</option>
                    <option value="volume-24h">Volume · 24h</option>
                    <option value="top-traders">Top traders · all-time</option>
                  </select>
                </Field>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 8 }}>
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={kolScanLimit}
                    onChange={(e) => setKolScanLimit(e.target.value)}
                    style={{ ...inputStyle, width: 70, padding: '6px 8px' }}
                  />
                  <span style={{ color: MUTED, fontSize: 12 }}>wallets</span>
                  <button
                    type="button"
                    onClick={fetchKolScan}
                    disabled={kolScanLoading}
                    style={{ ...smallBtn, marginLeft: 'auto' }}
                  >
                    {kolScanLoading ? 'fetching…' : 'fetch + append'}
                  </button>
                </div>
                {kolScanErr && <div style={{ fontSize: 11, color: ERR, marginTop: 6 }}>{kolScanErr}</div>}
                <div style={{ fontSize: 10, color: MUTED, marginTop: 8, lineHeight: 1.4 }}>
                  KolScan integration is best-effort — if their API changes the fetch errors and you fall back to manual paste/CSV. Cached 60s server-side.
                </div>
              </div>
            </div>

            {kolParseErr && (
              <div style={{ color: ERR, fontSize: 12, marginBottom: 8 }}>
                Parse error: {kolParseErr}
              </div>
            )}

            {kolWallets.length > 0 && (
              <div style={{ fontSize: 11, color: MUTED, padding: 8, background: '#f9fafb', borderRadius: 6 }}>
                {kolMode === 'pending-claim' ? (
                  <>
                    Will earmark <strong style={{ color: INK }}>{kolAllocPct}%</strong> of the dev wallet's post-bundle bag, split <strong style={{ color: INK }}>equally</strong> across <strong style={{ color: INK }}>{kolWallets.length} wallets</strong>. Each KOL has <strong style={{ color: INK }}>{kolClaimWindowDays} days</strong> to sign an accept message; on accept their position is locked <strong style={{ color: INK }}>{kolLockDays} days</strong>. Unclaimed slots auto-expire and revert to the dev — no on-chain action either way.
                  </>
                ) : (
                  <>
                    Will create <strong style={{ color: INK }}>{kolWallets.length} stake positions</strong> across <strong style={{ color: INK }}>{Math.ceil(kolWallets.length / 2)} txs</strong>, locked for <strong style={{ color: INK }}>{kolLockDays} days</strong>, using <strong style={{ color: INK }}>{kolAllocPct}%</strong> of the dev wallet's post-bundle bag (equal split, no consent required).
                  </>
                )}
              </div>
            )}
          </>
        )}
      </Card>

      <Card title="6. MM seed (optional — buys at creator price + auto-cycle)" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            id="mm-enabled"
            type="checkbox"
            checked={mmEnabled}
            onChange={(e) => setMmEnabled(e.target.checked)}
          />
          <label htmlFor="mm-enabled" style={{ fontSize: 13, color: SUB, cursor: 'pointer' }}>
            Buy in the launch bundle with an MM wallet, then enable cycling buys/sells automatically
          </label>
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: mmEnabled ? 12 : 0, lineHeight: 1.5 }}>
          The MM wallet acquires its bag at <em>creator price</em> in the same bundle as the dev buy and snipers, so subsequent sells lock in real profit instead of bleeding spread. The <code>stakrr-mm</code> daemon picks up this mint on its next 10s tick and starts running the subtle-ladder strategy with the bankroll/drawdown caps below.
        </div>

        {mmEnabled && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="MM wallet (must be in vault, funded with entry SOL + bankroll + gas)">
                <select value={mmWalletId} onChange={(e) => setMmWalletId(e.target.value)} style={inputStyle}>
                  <option value="">— select wallet —</option>
                  {devCandidates.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.label || shortPk(w.publicKey)} · {fmtSol(w.sol)} SOL
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Entry SOL (in-bundle buy)">
                <input
                  type="number"
                  step="0.01"
                  min="0.001"
                  value={mmEntrySol}
                  onChange={(e) => setMmEntrySol(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, color: SUB, marginTop: 8, marginBottom: 6 }}>
              Daemon strategy config (post-launch cycling)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Bankroll cap (SOL · max net spend before pause)">
                <input
                  type="number"
                  step="0.05"
                  min="0.05"
                  value={mmBankrollSol}
                  onChange={(e) => setMmBankrollSol(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Drawdown % (pause if P&L drops X% below peak)">
                <input
                  type="number"
                  step="5"
                  min="5"
                  max="90"
                  value={mmDrawdownPct}
                  onChange={(e) => setMmDrawdownPct(e.target.value)}
                  style={inputStyle}
                />
              </Field>
              <Field label="Slippage %">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="50"
                  value={mmSlippage}
                  onChange={(e) => setMmSlippage(e.target.value)}
                  style={inputStyle}
                />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Min buy SOL">
                <input type="number" step="0.001" min="0.001" value={mmMinBuySol} onChange={(e) => setMmMinBuySol(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Max buy SOL">
                <input type="number" step="0.001" min="0.001" value={mmMaxBuySol} onChange={(e) => setMmMaxBuySol(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Min interval (s)">
                <input type="number" step="5" min="10" value={mmMinIntervalSec} onChange={(e) => setMmMinIntervalSec(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Max interval (s)">
                <input type="number" step="5" min="20" value={mmMaxIntervalSec} onChange={(e) => setMmMaxIntervalSec(e.target.value)} style={inputStyle} />
              </Field>
            </div>

            {quote?.mm && (
              <div style={{ fontSize: 11, color: MUTED, padding: 8, background: '#f0fdf4', borderRadius: 6 }}>
                MM wallet <strong style={{ color: INK }}>{shortPk(quote.mm.wallet?.publicKey)}</strong> needs <strong style={{ color: INK }}>{fmtSol(quote.mm.estSpend)} SOL</strong> for the seed buy (has <strong style={{ color: quote.mm.wallet?.sol >= quote.mm.estSpend ? OK : ERR }}>{fmtSol(quote.mm.wallet?.sol)}</strong>). Post-launch the daemon will cycle within the <strong style={{ color: INK }}>{mmBankrollSol} SOL</strong> bankroll cap. {quote.mm.inBundle ? 'In-bundle slot reserved.' : 'Bundle full — MM seed will run staggered post-bundle.'}
              </div>
            )}

            <details style={{ marginTop: 10, fontSize: 11, color: MUTED }}>
              <summary style={{ cursor: 'pointer' }}>Why this is net-positive (vs. cold-start MM which is net-negative)</summary>
              <div style={{ paddingTop: 6, lineHeight: 1.5 }}>
                Cold MM on a bonding curve loses ~spread + slippage on every round-trip — there's no edge so it's structurally negative-EV. By buying in the create bundle, the MM wallet enters at the lowest curve price the token will ever see. Every sell after that point realises real bag profit; small subsequent buys to maintain chart activity are dwarfed by accumulated sell receipts. P&L is tracked in <code>worker/data/mm.json</code> and visible at <code>/admin/mm</code>; the bankroll cap pauses cycling if cumulative net spend exceeds it (safety against an unexpected dump).
              </div>
            </details>
          </>
        )}
      </Card>

      <Card title="7. Dump & absorb (anti-sniper choreography)" style={{ marginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <input
            id="choreo-enabled"
            type="checkbox"
            checked={choreoEnabled}
            onChange={(e) => setChoreoEnabled(e.target.checked)}
          />
          <label htmlFor="choreo-enabled" style={{ fontSize: 13, color: SUB, cursor: 'pointer' }}>
            After pool init: dev wallet sells (max scare → snipers exit), then absorber wallets buy + auto-stake to lock supply
          </label>
        </div>
        <div style={{ fontSize: 11, color: MUTED, marginBottom: choreoEnabled ? 12 : 0, lineHeight: 1.5 }}>
          Sequence: <strong>dev rug</strong> at <strong>launchSlot+{choreoDevSellDelayBlocks}</strong> (~{Math.round((Number(choreoDevSellDelayBlocks) || 0) * 400)}ms) → <strong>{choreoAbsorberWaveSize}-wallet absorber wave</strong> at <strong>launchSlot+{choreoAbsorberWaveDelayBlocks}</strong> (~{Math.round((Number(choreoAbsorberWaveDelayBlocks) || 0) * 400)}ms) → <strong>drip accumulation</strong> over {choreoDripWindowSec}s. Snipers race in slots launchSlot+1..3, so firing the rug at slot+3 and absorbers at slot+4 catches their panic-sells right as they land. All absorber buys use jittered amounts/slippage/priority fees so terminals can't fingerprint them as a coordinated bundle.
        </div>

        {choreoEnabled && (
          <>
            {absorberWallets.length === 0 && (
              <div style={{ padding: 10, background: '#fffbeb', border: `1px solid #fde68a`, borderRadius: 6, fontSize: 12, color: '#92400e', marginBottom: 12 }}>
                No wallets tagged as <code>tier=absorber</code>. Go to the <strong>Wallets</strong> tab and use the tier dropdown to mark wallets as absorbers — they MUST be different from snipers and ideally funded from a separate source (CEX withdrawal, multi-hop, or aged wallet) so terminals don't cluster them.
              </div>
            )}

            <Field label={`Absorber wallets (pick from tier='absorber' \u2014 ${absorberWallets.length} available)`} style={{ marginBottom: 12 }}>
              <div style={{
                maxHeight: 180, overflowY: 'auto', border: `1px solid ${BORDER}`, borderRadius: 8, padding: 8, background: '#fff',
              }}>
                {absorberWallets.map((w) => {
                  const checked = choreoAbsorberIds.includes(w.id);
                  return (
                    <label key={w.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', cursor: 'pointer',
                      background: checked ? '#f0fdf4' : 'transparent', borderRadius: 4, fontSize: 12,
                    }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setChoreoAbsorberIds((prev) => (
                          prev.includes(w.id) ? prev.filter((x) => x !== w.id) : [...prev, w.id]
                        ))}
                      />
                      <span style={{ fontWeight: 600 }}>{w.label}</span>
                      <span style={{ color: MUTED, fontFamily: 'monospace' }}>{shortPk(w.publicKey, 4)}</span>
                      <span style={{ marginLeft: 'auto', color: (w.sol || 0) >= Number(choreoAbsorberBuyMaxSol) + 0.01 ? OK : ERR }}>
                        {fmtSol(w.sol)} SOL
                      </span>
                    </label>
                  );
                })}
                {absorberWallets.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, paddingTop: 6, borderTop: `1px solid ${BORDER}` }}>
                    <button type="button" onClick={() => setChoreoAbsorberIds(absorberWallets.map((w) => w.id))} style={smallBtn}>select all</button>
                    <button type="button" onClick={() => setChoreoAbsorberIds([])} style={smallBtn}>clear</button>
                    <span style={{ marginLeft: 'auto', color: MUTED, fontSize: 11, alignSelf: 'center' }}>
                      {choreoAbsorberIds.length} selected · est spend {fmtSol(choreoEstSpendSol)} SOL
                    </span>
                  </div>
                )}
              </div>
            </Field>

            <div style={{ fontSize: 12, fontWeight: 600, color: SUB, marginBottom: 6 }}>
              Dev wallet (Phase 0 + 1)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Dev stake % (preserves supply)" hint="Stakes X% of dev bag to itself BEFORE the rug. 0 = max scare on the sell.">
                <input type="number" step="5" min="0" max="100" value={choreoDevStakePct} onChange={(e) => setChoreoDevStakePct(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Dev stake lock (days)">
                <input type="number" step="1" min="1" max="365" value={choreoDevStakeLockDays} onChange={(e) => setChoreoDevStakeLockDays(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Dev sell % of remaining">
                <input type="number" step="5" min="1" max="100" value={choreoDevSellPct} onChange={(e) => setChoreoDevSellPct(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Dev rug delay (blocks after launch)" hint="Solana slots are ~400ms. Snipers race in slots launchSlot+1..3 — fire the rug at slot+3 to catch them mid-buy. 0 = same block as launch (rare but possible).">
                <input type="number" step="1" min="0" max="50" value={choreoDevSellDelayBlocks} onChange={(e) => setChoreoDevSellDelayBlocks(e.target.value)} style={inputStyle} />
              </Field>
            </div>

            <div style={{ fontSize: 12, fontWeight: 600, color: SUB, marginBottom: 6 }}>
              Absorber wave + drip (Phase 2-4)
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Wave delay (blocks after launch)" hint="Default 4 = absorbers fire at slot launchSlot+4, just after the on-chain sniper window (slots 1-3) ends. Each block is ~400ms.">
                <input type="number" step="1" min="0" max="50" value={choreoAbsorberWaveDelayBlocks} onChange={(e) => setChoreoAbsorberWaveDelayBlocks(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Wave size (parallel)">
                <input type="number" step="1" min="1" max="20" value={choreoAbsorberWaveSize} onChange={(e) => setChoreoAbsorberWaveSize(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Buy min SOL (jittered)">
                <input type="number" step="0.005" min="0.001" value={choreoAbsorberBuyMinSol} onChange={(e) => setChoreoAbsorberBuyMinSol(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Buy max SOL (jittered)">
                <input type="number" step="0.005" min="0.002" value={choreoAbsorberBuyMaxSol} onChange={(e) => setChoreoAbsorberBuyMaxSol(e.target.value)} style={inputStyle} />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <Field label="Drip window (s)">
                <input type="number" step="5" min="5" max="600" value={choreoDripWindowSec} onChange={(e) => setChoreoDripWindowSec(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Drip interval min (ms)">
                <input type="number" step="500" min="500" max="60000" value={choreoDripIntervalMinMs} onChange={(e) => setChoreoDripIntervalMinMs(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Drip interval max (ms)">
                <input type="number" step="500" min="1000" max="60000" value={choreoDripIntervalMaxMs} onChange={(e) => setChoreoDripIntervalMaxMs(e.target.value)} style={inputStyle} />
              </Field>
              <Field label="Absorber auto-stake %" hint="After each absorber buys, stake X% of its bag to itself (locks supply, earns fees, terminals tag as 'staker' not 'sniper')">
                <input type="number" step="10" min="0" max="100" value={choreoAbsorberAutoStakePct} onChange={(e) => setChoreoAbsorberAutoStakePct(e.target.value)} style={inputStyle} />
              </Field>
            </div>

            {Number(choreoAbsorberAutoStakePct) > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, marginBottom: 12 }}>
                <Field label="Absorber stake lock (days)">
                  <input type="number" step="1" min="1" max="365" value={choreoAbsorberStakeLockDays} onChange={(e) => setChoreoAbsorberStakeLockDays(e.target.value)} style={inputStyle} />
                </Field>
              </div>
            )}

            <details style={{ fontSize: 11, color: MUTED }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, color: SUB, fontWeight: 600 }}>
                Why this works (and the disclaimers)
              </summary>
              <div style={{ paddingTop: 6, lineHeight: 1.6 }}>
                <strong>Anti-sniper mechanism:</strong> trading terminals (Photon, BullX, Trojan, Axiom) auto-tag wallets that bought in blocks 0-3 as "snipers" and fire "dev sold" alerts when the dev wallet sells &gt;50% of its bag. The dev rug at T+0.6s triggers those alerts → real snipers panic-sell + copy-trader bots auto-exit at their stop-losses. Their tokens flow to the bonding curve → our absorber wallets (which bought at block 6+ outside the sniper window) catch them at the dump price.
                <br /><br />
                <strong>Anti-cluster:</strong> every absorber buy uses a different SOL amount (jittered ±50% within your range), different slippage (base ±5%), different priority fee (base ±50%), and lands in a different block. No round numbers (avoids 0.05/0.1/0.5 fingerprints). Wave is parallel; drip is sequential with random intervals.
                <br /><br />
                <strong>Funding lineage caveat:</strong> if all your absorber wallets were funded from the same source within 10 minutes of each other, terminals will cluster them as one entity regardless of jitter. Best practice is to fund absorbers from CEX withdrawals (untraceable past the exchange) or via multi-hop SOL routing with idle time between hops. We don't (yet) automate this — it's on you to maintain a clean wallet stable.
                <br /><br />
                <strong>Risk:</strong> if the launch has organic demand, the dev rug kills sentiment regardless of absorbers. Use this on launches you don't intend to grow organically, or pair with strong KOL/community comms to override the bearish signal.
                <br /><br />
                <strong>Legal:</strong> this is wash trading + sniper exploitation. Norm on Pump.fun memecoin space, not enforced; would be illegal in regulated markets. You're operating at your own risk.
              </div>
            </details>
          </>
        )}
      </Card>

      <Card title="8. Pre-flight quote" style={{ marginTop: 16 }}>
        {quoteErr && <div style={{ color: ERR, marginBottom: 8 }}>{quoteErr}</div>}
        {quote ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            <Stat label="Bundle slots" value={`${quote.inBundleCount} / ${quote.bundleCap}`} note={quote.overflowCount > 0 ? `${quote.overflowCount} staggered` : 'all in-bundle'} />
            <Stat label="Dev needs" value={`${fmtSol(quote.estDevSpend)} SOL`} note={`have ${fmtSol(devCandidate?.sol)}`} warning={devCandidate && devCandidate.sol < quote.estDevSpend} />
            <Stat label="Per sniper needs" value={`${fmtSol(quote.estSniperSpend)} SOL`} note={`${quote.snipers.length} wallets`} />
            <Stat label="Jito tip" value={`${fmtSol(quote.jitoTipSol)} SOL`} note="via Jito 5-region race" />
          </div>
        ) : (
          <div style={{ color: MUTED }}>{devWalletId ? 'computing…' : 'pick a deployer wallet to compute'}</div>
        )}
      </Card>

      {err && <ErrorBox err={err} onDismiss={() => setErr(null)} style={{ marginTop: 16 }} />}

      <div style={{ display: 'flex', gap: 12, marginTop: 24, alignItems: 'center' }}>
        <button type="submit" disabled={submitting} style={{ ...btn(SKY), padding: '12px 24px', fontSize: 16, fontWeight: 600 }}>
          {submitting ? 'launching… (creates token + dev buy + snipes in one bundle)' : 'launch + snipe (Jito bundle)'}
        </button>
        {submitting && <span style={{ color: MUTED, fontSize: 12 }}>~10–30s for bundle confirm + lock-fees + pool init</span>}
      </div>

      {result && (
        <Card title="✓ launch confirmed" style={{ marginTop: 16, borderColor: OK, background: '#f0fdf4' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <KV k="mint" v={result.mint} link={`https://pump.fun/coin/${result.mint}`} />
            <KV k="bundle id" v={result.bundleId} />
            <KV k="lock fees sig" v={result.lockFeesSig} link={result.lockFeesSig ? `https://solscan.io/tx/${result.lockFeesSig}` : null} />
            <KV k="pool init sig" v={result.poolRewardSig} link={result.poolRewardSig ? `https://solscan.io/tx/${result.poolRewardSig}` : null} />
            <KV k="snipers in bundle" v={String(result.inBundleSnipers?.length || 0)} />
            <KV k="overflow snipers" v={String(result.overflowSnipers?.length || 0)} />
          </div>
          {result.kolAirdrop && (
            <div style={{ marginTop: 12, padding: 10, background: result.kolAirdrop.ok ? '#dcfce7' : '#fee2e2', borderRadius: 6, fontSize: 12 }}>
              <strong>KOL airdrop:</strong>{' '}
              {result.kolAirdrop.ok ? (
                <>
                  staked {result.kolAirdrop.totals?.walletCount} positions in {result.kolAirdrop.totals?.batchCount} txs
                  ({fmtTokens(result.kolAirdrop.totals?.tokensSentRaw, 6)} {symbol}) · {result.kolAirdrop.totals?.lockDays}d lock
                </>
              ) : (
                <span style={{ color: ERR }}>failed: {result.kolAirdrop.error || 'see worker logs'}</span>
              )}
            </div>
          )}
          {result.choreography && (
            <div style={{ marginTop: 12, padding: 10, background: result.choreography.ok ? '#dcfce7' : '#fee2e2', borderRadius: 6, fontSize: 12 }}>
              <strong>Choreography:</strong>{' '}
              {result.choreography.ok ? (
                <>
                  dev rug {result.choreography.devRug?.skipped ? 'skipped' : <a href={`https://solscan.io/tx/${result.choreography.devRug?.sig}`} target="_blank" rel="noreferrer" style={linkStyle}>tx</a>}
                  {result.choreography.devStake && !result.choreography.devStake.skipped && (
                    <> · dev pre-staked <a href={`https://solscan.io/tx/${result.choreography.devStake.sig}`} target="_blank" rel="noreferrer" style={linkStyle}>tx</a></>
                  )}
                  {' · '}absorber wave {result.choreography.absorberWave?.filter((r) => !r.error).length}/{result.choreography.absorberWave?.length} ok
                  {' · '}drip {result.choreography.absorberDrip?.filter((r) => !r.error).length}/{result.choreography.absorberDrip?.length} ok
                  {result.choreography.absorberStakes?.length > 0 && (
                    <> · {result.choreography.absorberStakes.filter((r) => !r.error && !r.skipped).length} absorbers auto-staked</>
                  )}
                </>
              ) : (
                <span style={{ color: ERR }}>failed: {result.choreography.error || 'see worker logs'}</span>
              )}
            </div>
          )}
          {result.mmBootstrap && (
            <div style={{ marginTop: 12, padding: 10, background: result.mmBootstrap.ok ? '#dcfce7' : '#fee2e2', borderRadius: 6, fontSize: 12 }}>
              <strong>MM seed:</strong>{' '}
              {result.mmBootstrap.ok ? (
                <>
                  wallet <code>{shortPk(result.mmBootstrap.wallet)}</code> bought {fmtSol(result.mmBootstrap.entrySol)} SOL at creator price · daemon enabled (bankroll {fmtSol(result.mmBootstrap.config?.bankrollSol)} SOL) · <a href="/admin/mm" style={{ color: SKY }}>monitor at /admin/mm</a>
                </>
              ) : (
                <span style={{ color: ERR }}>register failed: {result.mmBootstrap.error || 'see worker logs'} (configure manually at /admin/mm)</span>
              )}
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <a href={`/token/${result.mint}`} target="_blank" rel="noreferrer" style={{ color: SKY, fontWeight: 600 }}>
              → open public stake page
            </a>
          </div>
        </Card>
      )}
    </form>
  );
}

// ── Tab: Snipes (past launches) ─────────────────────────────────────────────

function SnipesTab({ adminPk }) {
  const [snipes, setSnipes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [holdings, setHoldings] = useState({}); // walletId -> holdings
  const [busy, setBusy] = useState(null);
  const [drawerKey, setDrawerKey] = useState(null); // `${snipeId}-${walletId}` of the open trade drawer
  const [lastSig, setLastSig] = useState(null);
  const [mmInfo, setMmInfo] = useState({}); // mint -> mm token record (status, state, recentTrades)
  const [mmBusy, setMmBusy] = useState(null);

  const reload = useCallback(async () => {
    if (!adminPk) return;
    setLoading(true);
    setErr(null);
    try {
      const out = await adminFetch('/api/admin/snipe/snipes', { adminPk });
      setSnipes(out.snipes || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [adminPk]);

  useEffect(() => { reload(); }, [reload]);

  // For wallet listing we treat the dev + MM wallets as additional rows of
  // the snipers table so the existing trade/transfer/sweep handlers work
  // unchanged. Dev goes first (it's the deployer + did the dev buy), then
  // snipers (in-bundle then overflow), then the MM seed.
  const allWalletsForSnipe = useCallback((snipe) => {
    const list = [];
    if (snipe.devWalletId && snipe.devWallet) {
      list.push({
        walletId: snipe.devWalletId,
        publicKey: snipe.devWallet,
        kind: 'dev',
        // The dev's "buy" was its devBuySol portion of the bundle (signed
        // alongside the create tx). No separate buy sig — it's the same
        // bundle as create.
        solSpent: Number(snipe.devBuySol) || 0,
        buySig: snipe.txSignatures?.[0] || null,
        error: null,
      });
    }
    for (const s of (snipe.snipers || [])) list.push(s);
    if (snipe.mmBootstrap?.ok && snipe.mmBootstrap.walletId) {
      const dup = list.some((s) => s.walletId === snipe.mmBootstrap.walletId);
      if (!dup) {
        list.push({
          walletId: snipe.mmBootstrap.walletId,
          publicKey: snipe.mmBootstrap.wallet,
          kind: 'mm',
          solSpent: snipe.mmBootstrap.entrySol || 0,
          buySig: null,
          error: null,
        });
      }
    }
    return list;
  }, []);

  const loadHoldings = useCallback(async (snipe) => {
    const wallets = allWalletsForSnipe(snipe);
    if (wallets.length === 0) return;
    const next = { ...holdings };
    for (const s of wallets) {
      try {
        const out = await adminFetch('/api/admin/snipe/holdings', {
          method: 'POST',
          adminPk,
          body: { walletId: s.walletId, mint: snipe.mint },
        });
        next[s.walletId] = out.holdings;
      } catch (e) {
        next[s.walletId] = { error: e.message };
      }
    }
    setHoldings(next);
  }, [adminPk, holdings, allWalletsForSnipe]);

  const loadMmInfo = useCallback(async (snipe) => {
    if (!snipe.mmBootstrap?.ok) return;
    try {
      const out = await adminFetch(`/api/admin/mm/${snipe.mint}`, { adminPk });
      setMmInfo((prev) => ({ ...prev, [snipe.mint]: out.token }));
    } catch (e) {
      setMmInfo((prev) => ({ ...prev, [snipe.mint]: { error: e.message } }));
    }
  }, [adminPk]);

  const toggleExpand = useCallback(async (snipe) => {
    if (expandedId === snipe.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(snipe.id);
    await Promise.all([loadHoldings(snipe), loadMmInfo(snipe)]);
  }, [expandedId, loadHoldings, loadMmInfo]);

  const handleMmAction = useCallback(async (snipe, action) => {
    setMmBusy(`${snipe.mint}-${action}`);
    try {
      let path;
      let method = 'POST';
      if (action === 'pause') path = `/api/admin/mm/pause`;
      else if (action === 'resume') path = `/api/admin/mm/resume`;
      else if (action === 'tick') path = `/api/admin/mm/tick`;
      else if (action === 'delete') {
        if (!confirm(`Disable MM for ${snipe.symbol}? The wallet keeps its bag — you can re-enable from /admin/mm later.`)) {
          setMmBusy(null);
          return;
        }
        path = `/api/admin/mm/${snipe.mint}`;
        method = 'DELETE';
      } else return;
      await adminFetch(path, {
        method,
        adminPk,
        body: action === 'delete' ? undefined : { mint: snipe.mint },
      });
      await loadMmInfo(snipe);
    } catch (e) {
      setErr(e.message);
    } finally {
      setMmBusy(null);
    }
  }, [adminPk, loadMmInfo]);

  const handleSell = useCallback(async (snipe, walletId, pct, slippage = 10) => {
    setBusy(`${snipe.id}-${walletId}`);
    setLastSig(null);
    try {
      const out = await adminFetch('/api/admin/snipe/sell', {
        method: 'POST',
        adminPk,
        body: { walletId, mint: snipe.mint, sellPct: pct, slippage, snipeId: snipe.id },
      });
      setLastSig(out.sig || null);
      await loadHoldings(snipe);
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, loadHoldings, reload]);

  const handleBuy = useCallback(async (snipe, walletId, solAmount, slippage = 10) => {
    if (!(solAmount > 0)) { setErr('amount must be > 0'); return; }
    setBusy(`${snipe.id}-${walletId}`);
    setLastSig(null);
    try {
      const out = await adminFetch('/api/admin/snipe/buy', {
        method: 'POST',
        adminPk,
        body: { walletId, mint: snipe.mint, solAmount, slippage, snipeId: snipe.id },
      });
      setLastSig(out.sig || null);
      await loadHoldings(snipe);
      await reload();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, loadHoldings, reload]);

  const handleSweep = useCallback(async (snipe, walletId) => {
    if (!confirm('Sweep all SOL from this wallet to the platform treasury?')) return;
    setBusy(`${snipe.id}-${walletId}`);
    try {
      await adminFetch('/api/admin/snipe/sweep', {
        method: 'POST',
        adminPk,
        body: { walletId, snipeId: snipe.id },
      });
      await loadHoldings(snipe);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, loadHoldings]);

  const handleTransfer = useCallback(async (snipe, walletId) => {
    const w = holdings[walletId];
    if (!w?.tokens || w.tokens.amountRaw === '0') { alert('wallet has no tokens to transfer'); return; }
    const to = prompt('Recipient address:');
    if (!to) return;
    const amount = prompt(`Amount in raw token units (max ${w.tokens.amountRaw}):`, w.tokens.amountRaw);
    if (!amount) return;
    setBusy(`${snipe.id}-${walletId}`);
    try {
      await adminFetch('/api/admin/snipe/transfer', {
        method: 'POST',
        adminPk,
        body: { walletId, mint: snipe.mint, toAddress: to.trim(), amountRaw: amount.trim(), snipeId: snipe.id },
      });
      await loadHoldings(snipe);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  }, [adminPk, holdings, loadHoldings]);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <strong>Past launches</strong>
        <span style={{ color: MUTED, fontSize: 12 }}>{snipes.length} total</span>
        <button onClick={reload} disabled={loading} style={smallBtn}>{loading ? '…' : 'refresh'}</button>
      </div>

      {err && <ErrorBox err={err} onDismiss={() => setErr(null)} />}

      <div style={{ overflowX: 'auto', border: `1px solid ${BORDER}`, borderRadius: 12 }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>created</th>
              <th style={th}>token</th>
              <th style={th}>mint</th>
              <th style={th}>status</th>
              <th style={{ ...th, textAlign: 'right' }}>dev buy</th>
              <th style={{ ...th, textAlign: 'right' }}>snipers</th>
              <th style={th}>links</th>
            </tr>
          </thead>
          <tbody>
            {snipes.map((s) => (
              <React.Fragment key={s.id}>
                <tr style={{ cursor: 'pointer', background: expandedId === s.id ? '#fafafa' : '#fff' }} onClick={() => toggleExpand(s)}>
                  <td style={td}>{timeAgo(s.createdAt)}</td>
                  <td style={td}><strong>{s.symbol}</strong> <span style={{ color: MUTED }}>· {s.name}</span></td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{shortPk(s.mint, 5)}</td>
                  <td style={td}>
                    <StatusPill status={s.status} />
                    {s.statusError && <div style={{ fontSize: 11, color: ERR, marginTop: 2 }}>{s.statusError.slice(0, 80)}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{fmtSol(s.devBuySol)} SOL</td>
                  <td style={{ ...td, textAlign: 'right' }}>{s.snipers?.length || 0}</td>
                  <td style={td}>
                    <a href={`/token/${s.mint}`} target="_blank" rel="noreferrer" style={linkStyle} onClick={(e) => e.stopPropagation()}>stake</a>
                    {' · '}
                    <a href={`https://pump.fun/coin/${s.mint}`} target="_blank" rel="noreferrer" style={linkStyle} onClick={(e) => e.stopPropagation()}>pump</a>
                    {' · '}
                    <a href={`https://solscan.io/token/${s.mint}`} target="_blank" rel="noreferrer" style={linkStyle} onClick={(e) => e.stopPropagation()}>solscan</a>
                  </td>
                </tr>
                {expandedId === s.id && (
                  <tr>
                    <td colSpan={7} style={{ padding: 0, background: '#fafafa', borderTop: `1px solid ${BORDER}` }}>
                      <div style={{ padding: 16 }}>
                        <div style={{ marginBottom: 12, color: MUTED, fontSize: 12 }}>
                          Bundle: {s.bundleId || '—'} · {s.bundleEndpoint || ''}
                        </div>

                        {s.mmBootstrap?.ok && (
                          <MmPanel
                            snipe={s}
                            mm={mmInfo[s.mint]}
                            busy={mmBusy}
                            onPause={() => handleMmAction(s, 'pause')}
                            onResume={() => handleMmAction(s, 'resume')}
                            onTick={() => handleMmAction(s, 'tick')}
                            onDelete={() => handleMmAction(s, 'delete')}
                            onRefresh={() => loadMmInfo(s)}
                          />
                        )}

                        <table style={tableStyle}>
                          <thead>
                            <tr>
                              <th style={th}>wallet</th>
                              <th style={th}>kind</th>
                              <th style={{ ...th, textAlign: 'right' }}>SOL</th>
                              <th style={{ ...th, textAlign: 'right' }}>tokens</th>
                              <th style={th}>buy sig</th>
                              <th style={th}>actions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {allWalletsForSnipe(s).map((sn) => {
                              const h = holdings[sn.walletId];
                              const id = `${s.id}-${sn.walletId}`;
                              const drawerOpen = drawerKey === id;
                              return (
                                <React.Fragment key={sn.walletId}>
                                  <tr>
                                    <td style={td}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortPk(sn.publicKey, 5)}</span></td>
                                    <td style={td}>
                                      {(() => {
                                        const palette = sn.kind === 'dev'
                                          ? { bg: '#fce7f3', fg: '#9d174d' }
                                          : sn.kind === 'in-bundle'
                                            ? { bg: '#dbeafe', fg: '#1e40af' }
                                            : sn.kind === 'mm'
                                              ? { bg: '#ede9fe', fg: '#6d28d9' }
                                              : { bg: '#fef3c7', fg: '#92400e' };
                                        const bold = sn.kind === 'mm' || sn.kind === 'dev';
                                        return (
                                          <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: palette.bg, color: palette.fg, fontWeight: bold ? 600 : 400 }}>{sn.kind}</span>
                                        );
                                      })()}
                                    </td>
                                    <td style={{ ...td, textAlign: 'right' }}>{fmtSol(h?.sol)}</td>
                                    <td style={{ ...td, textAlign: 'right' }}>
                                      {h?.tokens ? fmtTokens(h.tokens.amountRaw, h.tokens.decimals) : (h?.error ? <span style={{ color: ERR }}>err</span> : '…')}
                                    </td>
                                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                                      {sn.buySig ? (
                                        <a href={`https://solscan.io/tx/${sn.buySig}`} target="_blank" rel="noreferrer" style={linkStyle}>{shortPk(sn.buySig, 5)}</a>
                                      ) : sn.error ? <span style={{ color: ERR }} title={sn.error}>err</span> : '—'}
                                    </td>
                                    <td style={td}>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                        <button
                                          onClick={() => setDrawerKey(drawerOpen ? null : id)}
                                          style={{ ...tinyBtn, background: drawerOpen ? SKY : '#fff', color: drawerOpen ? '#fff' : SUB, borderColor: drawerOpen ? SKY : BORDER, fontWeight: 600 }}
                                        >
                                          {drawerOpen ? 'close' : 'trade'}
                                        </button>
                                        <button onClick={() => handleTransfer(s, sn.walletId)} disabled={busy === id} style={tinyBtn}>transfer</button>
                                        <button onClick={() => handleSweep(s, sn.walletId)} disabled={busy === id || !h?.sol} style={tinyBtn}>sweep SOL</button>
                                      </div>
                                    </td>
                                  </tr>
                                  {drawerOpen && (
                                    <tr>
                                      <td colSpan={6} style={{ padding: 0, background: '#fff', borderBottom: `1px solid ${BORDER}` }}>
                                        <TradeDrawer
                                          snipe={s}
                                          sniper={sn}
                                          holdings={h}
                                          busy={busy === id}
                                          lastSig={lastSig}
                                          onSell={(pct, slip) => handleSell(s, sn.walletId, pct, slip)}
                                          onBuy={(sol, slip) => handleBuy(s, sn.walletId, sol, slip)}
                                          onRefresh={() => loadHoldings(s)}
                                        />
                                      </td>
                                    </tr>
                                  )}
                                </React.Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {snipes.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'center', color: MUTED, padding: 24 }} colSpan={7}>{loading ? 'loading…' : 'No stealth launches yet — start one in the Launch tab.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── MmPanel: inline market-maker daemon controls per snipe ──────────────────
//
// Surfaces /admin/mm functionality directly inside the past-launches drawer
// so the operator doesn't have to context-switch between two pages. Shows
// running/paused status, P&L (sells - buys, in lamports), trade count,
// next-action ETA, and provides pause/resume/tick-now/disable actions.

function MmPanel({ snipe, mm, busy, onPause, onResume, onTick, onDelete, onRefresh }) {
  const lamportsToSol = (s) => {
    if (s == null) return 0;
    try { return Number(BigInt(s)) / 1_000_000_000; } catch { return 0; }
  };
  const isLoading = !mm;
  const errored = mm?.error;
  const enabled = !!mm?.enabled;
  const config = mm?.config || {};
  const state = mm?.state || {};
  const pnl = lamportsToSol(state.currentPnlLamports);
  const peak = lamportsToSol(state.peakPnlLamports);
  const spent = lamportsToSol(state.totalSpentLamports);
  const received = lamportsToSol(state.totalReceivedLamports);
  const drawdown = peak > 0 ? Math.max(0, ((peak - pnl) / peak) * 100) : 0;
  const bankrollUsedPct = config.bankrollSol ? Math.min(100, ((spent - received) / config.bankrollSol) * 100) : 0;
  const nextEta = state.nextActionAt ? new Date(state.nextActionAt) : null;
  const nextSecs = nextEta ? Math.max(0, Math.floor((nextEta - Date.now()) / 1000)) : null;

  const headerColor = errored ? ERR : (enabled ? OK : '#92400e');
  const headerBg = errored ? '#fef2f2' : (enabled ? '#f0fdf4' : '#fffbeb');
  const headerLabel = errored
    ? 'MM: error reading state'
    : (enabled ? 'MM running' : `MM paused${state.pauseReason ? ` (${state.pauseReason})` : ''}`);

  return (
    <div style={{ marginBottom: 16, border: `1px solid ${BORDER}`, borderRadius: 10, background: '#fff', overflow: 'hidden' }}>
      <div style={{
        padding: '10px 14px', background: headerBg, borderBottom: `1px solid ${BORDER}`,
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: headerColor, display: 'inline-block' }} />
        <strong style={{ color: headerColor, fontSize: 13 }}>{headerLabel}</strong>
        {snipe.mmBootstrap?.entrySol > 0 && (
          <span style={{ color: MUTED, fontSize: 11 }}>
            seeded with {fmtSol(snipe.mmBootstrap.entrySol)} SOL at creator price
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={onRefresh} style={tinyBtn} disabled={!!busy}>refresh</button>
          {enabled ? (
            <button onClick={onPause} style={{ ...tinyBtn, color: '#92400e' }} disabled={busy === `${snipe.mint}-pause`}>
              {busy === `${snipe.mint}-pause` ? '…' : 'pause'}
            </button>
          ) : (
            <button onClick={onResume} style={{ ...tinyBtn, color: OK, fontWeight: 600 }} disabled={busy === `${snipe.mint}-resume` || errored}>
              {busy === `${snipe.mint}-resume` ? '…' : 'resume'}
            </button>
          )}
          <button onClick={onTick} style={tinyBtn} disabled={busy === `${snipe.mint}-tick` || !enabled} title="Force the daemon to consider this token now (skip wait)">
            {busy === `${snipe.mint}-tick` ? '…' : 'tick now'}
          </button>
          <a href="/admin/mm" target="_blank" rel="noreferrer" style={{ ...tinyBtn, textDecoration: 'none', color: SKY }}>full dashboard ↗</a>
          <button onClick={onDelete} style={{ ...tinyBtn, color: ERR }} disabled={busy === `${snipe.mint}-delete`}>
            {busy === `${snipe.mint}-delete` ? '…' : 'disable'}
          </button>
        </div>
      </div>

      {isLoading && <div style={{ padding: 14, color: MUTED, fontSize: 12 }}>loading MM state…</div>}
      {errored && <div style={{ padding: 14, color: ERR, fontSize: 12 }}>{mm.error}</div>}
      {!isLoading && !errored && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 0 }}>
            <MmStat label="P&L (realised)" value={`${pnl >= 0 ? '+' : ''}${pnl.toFixed(5)} SOL`} sub={`peak ${peak.toFixed(5)}`} good={pnl >= 0} bad={pnl < 0} />
            <MmStat label="Trades" value={String(state.tradesCount || 0)} sub={`${state.errorsCount || 0} errors`} />
            <MmStat label="Spent / received" value={`${spent.toFixed(4)} / ${received.toFixed(4)}`} sub="SOL out / in" />
            <MmStat label="Bankroll used" value={`${bankrollUsedPct.toFixed(1)}%`} sub={`cap ${config.bankrollSol} SOL`} bad={bankrollUsedPct >= 100} />
            <MmStat label="Drawdown" value={`${drawdown.toFixed(1)}%`} sub={`limit ${config.drawdownPct}%`} bad={drawdown >= (config.drawdownPct || 25)} />
          </div>
          <div style={{ padding: '8px 14px', borderTop: `1px solid ${BORDER}`, fontSize: 11, color: MUTED, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <span>
              MM wallet: <code style={{ color: INK }}>{shortPk(snipe.mmBootstrap?.wallet, 5)}</code> · last action: {state.lastActionAt ? timeAgo(state.lastActionAt) : 'never'}
              {state.lastSig && (
                <> · last sig: <a href={`https://solscan.io/tx/${state.lastSig}`} target="_blank" rel="noreferrer" style={linkStyle}>{shortPk(state.lastSig, 5)}</a></>
              )}
            </span>
            <span>
              {enabled
                ? (nextSecs != null ? `next action in ~${nextSecs}s` : 'next action: due now')
                : 'paused — daemon will skip this token'}
              {' · '}
              buy size {config.minBuySol}–{config.maxBuySol} SOL · interval {config.minIntervalSec}–{config.maxIntervalSec}s
            </span>
          </div>
          {(mm.recentTrades || []).length > 0 && (
            <div style={{ padding: '8px 14px', borderTop: `1px solid ${BORDER}`, fontSize: 11 }}>
              <div style={{ color: MUTED, marginBottom: 4 }}>Recent trades:</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {mm.recentTrades.slice().reverse().map((t, i) => {
                  const sol = t.type === 'buy' ? lamportsToSol(t.solSpentLamports) : lamportsToSol(t.solReceivedLamports);
                  const c = t.error ? ERR : (t.type === 'buy' ? '#1e40af' : OK);
                  return (
                    <a
                      key={`${t.sig || i}-${t.ts}`}
                      href={t.sig ? `https://solscan.io/tx/${t.sig}` : '#'}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => { if (!t.sig) e.preventDefault(); }}
                      style={{
                        padding: '2px 6px', borderRadius: 4, background: '#f8fafc',
                        border: `1px solid ${BORDER}`, color: c, fontFamily: 'monospace',
                        textDecoration: 'none',
                      }}
                      title={t.error || `${t.type} ${sol.toFixed(5)} SOL @ ${new Date(t.ts).toLocaleTimeString()}`}
                    >
                      {t.type} {sol.toFixed(4)}
                    </a>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MmStat({ label, value, sub, good, bad }) {
  const fg = bad ? ERR : (good ? OK : INK);
  return (
    <div style={{ padding: '10px 14px', borderRight: `1px solid ${BORDER}` }}>
      <div style={{ fontSize: 10, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 600, color: fg, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: MUTED, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── TradeDrawer: per-sniper buy/sell panel ──────────────────────────────────

function TradeDrawer({ snipe, sniper, holdings, busy, lastSig, onSell, onBuy, onRefresh }) {
  const [mode, setMode] = useState('sell'); // 'sell' | 'buy'
  const [sellPct, setSellPct] = useState(100);
  const [buySol, setBuySol] = useState('');
  const [slippage, setSlippage] = useState(10);

  const tokens = holdings?.tokens;
  const sol = holdings?.sol || 0;
  const decimals = tokens?.decimals ?? 6;
  const tokenBalance = tokens ? Number(BigInt(tokens.amountRaw) * 1000n / (10n ** BigInt(decimals))) / 1000 : 0;
  const sellRaw = tokens && tokens.amountRaw !== '0'
    ? (BigInt(tokens.amountRaw) * BigInt(Math.round(sellPct))) / 100n
    : 0n;
  const sellTokens = decimals != null
    ? Number(sellRaw * 1000n / (10n ** BigInt(decimals))) / 1000
    : 0;

  const buyAmt = Number(buySol);
  const canBuy = !busy && buyAmt > 0 && buyAmt <= sol - 0.005; // leave fee buffer
  const canSell = !busy && tokens && tokens.amountRaw !== '0' && sellPct > 0;

  return (
    <div style={{ padding: 16, background: '#fafafa', borderTop: `1px solid ${BORDER}` }}>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* Left: balances */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
          <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 }}>Wallet</div>
          <div style={{ fontFamily: 'monospace', fontSize: 12, color: INK }}>{sniper.publicKey}</div>
          <div style={{ marginTop: 4, fontSize: 13 }}>
            <div><strong>{fmtSol(sol, 6)}</strong> SOL</div>
            <div><strong>{tokens ? fmtTokens(tokens.amountRaw, decimals) : '0'}</strong> {snipe.symbol}</div>
          </div>
          <button onClick={onRefresh} style={{ ...smallBtn, marginTop: 4, alignSelf: 'flex-start' }}>refresh balances</button>
        </div>

        {/* Right: trade form */}
        <div style={{ flex: 1, minWidth: 320 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
            <button
              onClick={() => setMode('sell')}
              style={{ ...tinyBtn, padding: '6px 14px', fontSize: 12, fontWeight: 600,
                background: mode === 'sell' ? '#dc2626' : '#fff',
                color: mode === 'sell' ? '#fff' : SUB,
                borderColor: mode === 'sell' ? '#dc2626' : BORDER }}
            >
              SELL
            </button>
            <button
              onClick={() => setMode('buy')}
              style={{ ...tinyBtn, padding: '6px 14px', fontSize: 12, fontWeight: 600,
                background: mode === 'buy' ? '#16a34a' : '#fff',
                color: mode === 'buy' ? '#fff' : SUB,
                borderColor: mode === 'buy' ? '#16a34a' : BORDER }}
            >
              BUY MORE
            </button>
          </div>

          {mode === 'sell' ? (
            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: MUTED, marginBottom: 4 }}>
                  <span>Sell</span>
                  <span><strong style={{ color: INK }}>{sellPct}%</strong> = {fmtTokens(sellRaw.toString(), decimals)} {snipe.symbol}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={sellPct}
                  onChange={(e) => setSellPct(Number(e.target.value))}
                  style={{ width: '100%' }}
                  disabled={!tokens || tokens.amountRaw === '0'}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {[10, 25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      onClick={() => setSellPct(p)}
                      style={{ ...tinyBtn, padding: '3px 8px', fontWeight: sellPct === p ? 600 : 500,
                        background: sellPct === p ? SKY : '#fff',
                        color: sellPct === p ? '#fff' : SUB,
                        borderColor: sellPct === p ? SKY : BORDER }}
                    >
                      {p}%
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: MUTED }}>Slippage</span>
                {[5, 10, 15, 25].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSlippage(s)}
                    style={{ ...tinyBtn, padding: '3px 8px', fontWeight: slippage === s ? 600 : 500,
                      background: slippage === s ? SKY : '#fff',
                      color: slippage === s ? '#fff' : SUB,
                      borderColor: slippage === s ? SKY : BORDER }}
                  >
                    {s}%
                  </button>
                ))}
                <input
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(Math.max(1, Math.min(99, Number(e.target.value) || 10)))}
                  style={{ ...inputStyle, width: 70, padding: '4px 8px', fontSize: 12 }}
                  min={1} max={99}
                />
              </div>
              <div>
                <button
                  onClick={() => onSell(sellPct, slippage)}
                  disabled={!canSell}
                  style={{ ...btn('#dc2626'), width: '100%', opacity: canSell ? 1 : 0.5, cursor: canSell ? 'pointer' : 'not-allowed' }}
                >
                  {busy ? '…submitting' : `Sell ${sellPct}% (${fmtTokens(sellRaw.toString(), decimals)} ${snipe.symbol})`}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: MUTED, marginBottom: 4 }}>
                  <span>Buy with</span>
                  <span>SOL balance: <strong style={{ color: INK }}>{fmtSol(sol, 6)}</strong></span>
                </div>
                <input
                  type="number"
                  value={buySol}
                  onChange={(e) => setBuySol(e.target.value)}
                  placeholder="0.05"
                  step="0.001"
                  min="0"
                  style={inputStyle}
                />
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {[0.01, 0.05, 0.1, 0.25].map((amt) => (
                    <button
                      key={amt}
                      onClick={() => setBuySol(String(amt))}
                      disabled={amt > sol - 0.005}
                      style={{ ...tinyBtn, padding: '3px 8px' }}
                    >
                      {amt} SOL
                    </button>
                  ))}
                  <button
                    onClick={() => setBuySol(String(Math.max(0, sol - 0.01).toFixed(4)))}
                    style={{ ...tinyBtn, padding: '3px 8px' }}
                  >
                    max
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: MUTED }}>Slippage</span>
                {[5, 10, 15, 25].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSlippage(s)}
                    style={{ ...tinyBtn, padding: '3px 8px', fontWeight: slippage === s ? 600 : 500,
                      background: slippage === s ? SKY : '#fff',
                      color: slippage === s ? '#fff' : SUB,
                      borderColor: slippage === s ? SKY : BORDER }}
                  >
                    {s}%
                  </button>
                ))}
                <input
                  type="number"
                  value={slippage}
                  onChange={(e) => setSlippage(Math.max(1, Math.min(99, Number(e.target.value) || 10)))}
                  style={{ ...inputStyle, width: 70, padding: '4px 8px', fontSize: 12 }}
                  min={1} max={99}
                />
              </div>
              <div>
                <button
                  onClick={() => onBuy(buyAmt, slippage)}
                  disabled={!canBuy}
                  style={{ ...btn('#16a34a'), width: '100%', opacity: canBuy ? 1 : 0.5, cursor: canBuy ? 'pointer' : 'not-allowed' }}
                >
                  {busy ? '…submitting' : `Buy with ${buyAmt || 0} SOL`}
                </button>
              </div>
            </div>
          )}

          {lastSig && (
            <div style={{ marginTop: 8, fontSize: 12, color: MUTED }}>
              last tx:{' '}
              <a href={`https://solscan.io/tx/${lastSig}`} target="_blank" rel="noreferrer" style={linkStyle}>
                {shortPk(lastSig, 7)}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Layout primitives ───────────────────────────────────────────────────────

const inputStyle = {
  border: `1px solid ${BORDER}`,
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 14,
  width: '100%',
  fontFamily: 'inherit',
};

const btn = (color) => ({
  background: color,
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  padding: '8px 14px',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
});

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

const tableStyle = { width: '100%', borderCollapse: 'collapse', background: '#fff' };
const th = { textAlign: 'left', padding: '10px 12px', fontSize: 12, color: MUTED, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, background: '#fafafa', borderBottom: `1px solid ${BORDER}` };
const td = { padding: '10px 12px', fontSize: 13, color: INK, borderBottom: `1px solid ${BORDER}`, verticalAlign: 'middle' };
const linkStyle = { color: SKY, textDecoration: 'none' };

const selectableCard = {
  border: `2px solid ${BORDER}`,
  borderRadius: 10,
  padding: 10,
  textAlign: 'left',
  cursor: 'pointer',
  background: '#fff',
};

function Field({ label, children, style, hint }) {
  return (
    <label style={{ display: 'block', ...style }} title={hint || undefined}>
      <span style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>
        {label}
        {hint && <span style={{ marginLeft: 4, fontSize: 10, color: MUTED, cursor: 'help' }}>ⓘ</span>}
      </span>
      {children}
    </label>
  );
}

function Card({ title, children, style }) {
  return (
    <section style={{ border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, background: '#fff', ...style }}>
      <div style={{ fontSize: 13, color: SUB, fontWeight: 600, marginBottom: 12 }}>{title}</div>
      {children}
    </section>
  );
}

function Stat({ label, value, note, warning }) {
  return (
    <div style={{
      flex: 1, minWidth: 140, border: `1px solid ${warning ? ERR : BORDER}`,
      borderRadius: 8, padding: 10, background: warning ? '#fef2f2' : '#fff',
    }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: warning ? ERR : INK, marginTop: 2 }}>{value}</div>
      {note && <div style={{ fontSize: 11, color: warning ? ERR : MUTED, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

function FilterPills({ value, onChange, options }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          style={{
            ...tinyBtn,
            background: value === opt.id ? SKY : '#fff',
            color: value === opt.id ? '#fff' : SUB,
            borderColor: value === opt.id ? SKY : BORDER,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ErrorBox({ err, onDismiss, style }) {
  return (
    <div style={{ padding: 10, background: '#fef2f2', color: ERR, border: `1px solid ${ERR}`, borderRadius: 8, marginBottom: 12, ...style }}>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ flex: 1 }}>{err}</span>
        {onDismiss && <button onClick={onDismiss} style={{ ...tinyBtn, color: ERR }}>×</button>}
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const colors = {
    pending: ['#dbeafe', '#1e40af'],
    'bundle-ok': ['#fef3c7', '#92400e'],
    'pool-ok': ['#dcfce7', '#166534'],
    finalized: ['#dcfce7', '#166534'],
    failed: ['#fee2e2', '#991b1b'],
  };
  const [bg, fg] = colors[status] || ['#f1f5f9', '#475569'];
  return (
    <span style={{ padding: '3px 8px', borderRadius: 4, fontSize: 11, background: bg, color: fg, fontWeight: 600 }}>
      {status || 'unknown'}
    </span>
  );
}

function KV({ k, v, link }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</div>
      <div style={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
        {link ? <a href={link} target="_blank" rel="noreferrer" style={linkStyle}>{v || '—'}</a> : (v || '—')}
      </div>
    </div>
  );
}

// ── Top-level component ─────────────────────────────────────────────────────

export default function AdminSnipeView({ adminWallets = [] }) {
  const wallet = useWallet();
  const [tab, setTab] = useState('wallets');

  const adminPk = wallet?.publicKey?.toBase58() || null;
  const isAdmin = adminPk && adminWallets.includes(adminPk);

  if (!wallet?.connected) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <h2 style={{ color: INK, marginTop: 0 }}>Connect your admin wallet to continue.</h2>
        <p style={{ color: MUTED }}>This page is restricted to wallets configured as ADMIN_WALLET on the worker.</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={{ padding: 32, textAlign: 'center' }}>
        <h2 style={{ color: ERR, marginTop: 0 }}>Wallet not authorised.</h2>
        <p style={{ color: MUTED, fontFamily: 'monospace', fontSize: 12 }}>
          Connected: {adminPk}
          <br />
          Authorised: {adminWallets.length === 0 ? '(none configured)' : adminWallets.map(shortPk).join(', ')}
        </p>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 24, color: INK }}>Stealth Launch</h1>
        <span style={{ fontSize: 12, color: MUTED }}>admin only · /admin/snipe</span>
      </div>
      <p style={{ marginTop: 4, color: SUB, fontSize: 13 }}>
        Bundles create + dev buy + sniper buys into one Jito bundle so the platform's wallets are first-block buyers on every launch.
      </p>

      <div style={{ display: 'flex', gap: 4, marginTop: 16, marginBottom: 24, borderBottom: `1px solid ${BORDER}` }}>
        {[
          { id: 'wallets', label: 'Wallets' },
          { id: 'launch', label: 'Launch + snipe' },
          { id: 'snipes', label: 'Active snipes' },
        ].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: 'none',
              border: 'none',
              borderBottom: tab === t.id ? `2px solid ${SKY}` : '2px solid transparent',
              color: tab === t.id ? INK : MUTED,
              padding: '10px 16px',
              fontSize: 14,
              fontWeight: tab === t.id ? 600 : 500,
              cursor: 'pointer',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'wallets' && <WalletsTab adminPk={adminPk} />}
      {tab === 'launch' && <LaunchTab adminPk={adminPk} onLaunched={() => setTab('snipes')} />}
      {tab === 'snipes' && <SnipesTab adminPk={adminPk} />}
    </div>
  );
}
