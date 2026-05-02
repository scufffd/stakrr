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
              <th style={th}>public key</th>
              <th style={{ ...th, textAlign: 'right' }}>SOL</th>
              <th style={th}>launch</th>
              <th style={th}>created</th>
              <th style={th}>actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((w) => (
              <tr key={w.id}>
                <td style={td}><span style={{ fontWeight: 600 }}>{w.label}</span></td>
                <td style={td}>
                  <span style={{
                    padding: '2px 6px', borderRadius: 4, fontSize: 11,
                    background: w.source === 'pool' ? '#dbeafe' : '#f1f5f9',
                    color: w.source === 'pool' ? '#1e40af' : '#475569',
                  }}>{w.source}</span>
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
            ))}
            {filtered.length === 0 && (
              <tr>
                <td style={{ ...td, textAlign: 'center', color: MUTED, padding: 24 }} colSpan={7}>
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
  const [jitoTipSol, setJitoTipSol] = useState('0.001');
  const [slippageBps, setSlippageBps] = useState('5000');
  const [rewardMode, setRewardMode] = useState('sol');

  const [quote, setQuote] = useState(null);
  const [quoteErr, setQuoteErr] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);

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
  const devCandidate = useMemo(
    () => fundedWallets.find((w) => w.id === devWalletId) || null,
    [fundedWallets, devWalletId],
  );

  const toggleSniper = useCallback((id) => {
    setSniperIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

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
        },
      });
      setQuote(out.quote);
    } catch (e) {
      setQuoteErr(e.message);
    }
  }, [adminPk, devWalletId, sniperIds, devBuySol, sniperSolPerWallet, jitoTipSol]);

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
      fd.append('jitoTipSol', String(Number(jitoTipSol) || 0.001));
      fd.append('slippageBps', String(Number(slippageBps) || 5000));
      fd.append('rewardMode', rewardMode);

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
  }, [adminPk, name, symbol, description, twitter, telegram, website, imageFile, imageUrl, metadataUri, devWalletId, sniperIds, devBuySol, sniperSolPerWallet, jitoTipSol, slippageBps, rewardMode, onLaunched]);

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: MUTED }}>{loading ? 'loading wallets…' : `${fundedWallets.length} funded`}</span>
          <button type="button" onClick={reload} style={smallBtn}>refresh</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
          {fundedWallets.map((w) => (
            <button
              type="button"
              key={w.id}
              onClick={() => setDevWalletId(w.id)}
              style={{
                ...selectableCard,
                borderColor: devWalletId === w.id ? SKY : BORDER,
                background: devWalletId === w.id ? '#ecfeff' : '#fff',
              }}
            >
              <div style={{ fontWeight: 600 }}>{w.label}</div>
              <div style={{ fontFamily: 'monospace', fontSize: 11, color: MUTED }}>{shortPk(w.publicKey, 5)}</div>
              <div style={{ marginTop: 4, fontSize: 13 }}>{fmtSol(w.sol)} SOL</div>
            </button>
          ))}
          {fundedWallets.length === 0 && (
            <div style={{ color: MUTED, gridColumn: '1 / -1' }}>No funded wallets — generate or import + fund some first.</div>
          )}
        </div>
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
          <Field label="Jito tip (SOL)">
            <input type="number" step="0.001" min="0.0005" value={jitoTipSol} onChange={(e) => setJitoTipSol(e.target.value)} style={inputStyle} />
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

      <Card title="5. Pre-flight quote" style={{ marginTop: 16 }}>
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

  const loadHoldings = useCallback(async (snipe) => {
    if (!snipe?.snipers) return;
    const next = { ...holdings };
    for (const s of snipe.snipers) {
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
  }, [adminPk, holdings]);

  const toggleExpand = useCallback(async (snipe) => {
    if (expandedId === snipe.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(snipe.id);
    await loadHoldings(snipe);
  }, [expandedId, loadHoldings]);

  const handleSell = useCallback(async (snipe, walletId, pct) => {
    if (!confirm(`Sell ${pct}% of this wallet's bag?`)) return;
    setBusy(`${snipe.id}-${walletId}`);
    try {
      await adminFetch('/api/admin/snipe/sell', {
        method: 'POST',
        adminPk,
        body: { walletId, mint: snipe.mint, sellPct: pct, slippage: 10, snipeId: snipe.id },
      });
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
                            {(s.snipers || []).map((sn) => {
                              const h = holdings[sn.walletId];
                              const id = `${s.id}-${sn.walletId}`;
                              return (
                                <tr key={sn.walletId}>
                                  <td style={td}><span style={{ fontFamily: 'monospace', fontSize: 12 }}>{shortPk(sn.publicKey, 5)}</span></td>
                                  <td style={td}>
                                    <span style={{ padding: '2px 6px', borderRadius: 4, fontSize: 11, background: sn.kind === 'in-bundle' ? '#dbeafe' : '#fef3c7', color: sn.kind === 'in-bundle' ? '#1e40af' : '#92400e' }}>{sn.kind}</span>
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
                                      <button onClick={() => handleSell(s, sn.walletId, 100)} disabled={busy === id || !h?.tokens?.amountRaw || h?.tokens?.amountRaw === '0'} style={tinyBtn}>sell all</button>
                                      <button onClick={() => handleSell(s, sn.walletId, 50)} disabled={busy === id || !h?.tokens?.amountRaw || h?.tokens?.amountRaw === '0'} style={tinyBtn}>sell 50%</button>
                                      <button onClick={() => handleTransfer(s, sn.walletId)} disabled={busy === id} style={tinyBtn}>transfer</button>
                                      <button onClick={() => handleSweep(s, sn.walletId)} disabled={busy === id || !h?.sol} style={tinyBtn}>sweep SOL</button>
                                    </div>
                                  </td>
                                </tr>
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

function Field({ label, children, style }) {
  return (
    <label style={{ display: 'block', ...style }}>
      <span style={{ display: 'block', fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</span>
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
