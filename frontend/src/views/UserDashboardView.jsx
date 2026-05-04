import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAnchorWallet, useConnection, useWallet } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { apiUrl } from '../apiBase.js';
import { claimPositionRewards } from '../stake/claimPosition.js';

const STAKE_PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_STAKE_PROGRAM_ID || '65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA',
);

const INK = '#0C0C0C';
const SKY = '#35C5E0';
const MUTED = '#888';

function shorten(a, h = 4, t = 4) {
  if (!a) return '';
  return a.length > h + t + 2 ? `${a.slice(0, h)}…${a.slice(-t)}` : a;
}

function fmtRaw(raw, decimals = 6) {
  if (!raw || raw === '0') return '0';
  try {
    const n = BigInt(raw);
    const d = BigInt(10) ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr ? `${whole.toLocaleString('en-US')}.${fracStr.slice(0, 4)}` : whole.toLocaleString('en-US');
  } catch {
    return String(raw);
  }
}

// SOL is always 9 decimals — keep dust visible (6 decimals) so even small
// staker rewards (~0.0001 SOL) don't render as "0".
function fmtLamports(lamports, dp = 6) {
  if (!lamports || lamports === '0') return '0';
  try {
    const n = Number(BigInt(lamports)) / 1e9;
    if (n === 0) return '0';
    if (n < 0.000001) return '<0.000001';
    return n.toFixed(dp).replace(/\.?0+$/, '');
  } catch {
    return String(lamports);
  }
}

export default function UserDashboardView({ wallet, onSelectToken }) {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  // signMessage isn't exposed via useAnchorWallet — pull it from the
  // adapter directly so the auto-push toggle can authenticate updates.
  const fullWallet = useWallet();
  const [tab, setTab] = useState('positions');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [claimBusyKey, setClaimBusyKey] = useState(null);
  const [claimMsg, setClaimMsg] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [prefsLoading, setPrefsLoading] = useState(false);
  const [prefsBusy, setPrefsBusy] = useState(false);
  const [prefsMsg, setPrefsMsg] = useState(null);

  // Pending KOL airdrop claims for this wallet — drives the "KOL Claims"
  // tab. Each entry represents an earmarked dev-wallet bag the user can
  // accept via signed message; the worker then materialises the staked
  // position from the dev's vault keypair (user pays no SOL).
  const [kolClaims, setKolClaims] = useState([]);
  const [kolClaimsLoading, setKolClaimsLoading] = useState(false);
  const [kolAcceptBusy, setKolAcceptBusy] = useState(null);
  const [kolMsg, setKolMsg] = useState(null);

  const pk = wallet?.publicKey?.toBase58?.() || null;

  const rewardRows = useMemo(() => {
    if (!data?.staked?.length) return [];
    return data.staked.flatMap((row) =>
      row.positions.map((pos) => ({
        ...row,
        pos,
        key: `${row.stakeMint}-${pos.position}`,
      })),
    );
  }, [data]);

  const load = useCallback(async () => {
    if (!pk) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(apiUrl(`/api/wallet/${pk}/summary`));
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setData(d);
    } catch (e) {
      setError(e.message || String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [pk]);

  const onClaimReward = useCallback(
    async (row, pos) => {
      setClaimBusyKey(`${row.stakeMint}-${pos.position}`);
      setClaimMsg(null);
      try {
        if (!anchorWallet?.publicKey || !anchorWallet.signTransaction) {
          throw new Error('Connect a wallet that can sign transactions');
        }
        const sig = await claimPositionRewards({
          connection,
          wallet: anchorWallet,
          signTransaction: anchorWallet.signTransaction,
          stakeMintB58: row.stakeMint,
          rewardMode: row.rewardMode || 'sol',
          rewardMintB58: row.rewardMint,
          positionB58: pos.position,
          programId: STAKE_PROGRAM_ID,
        });
        setClaimMsg({ ok: true, text: `Claimed — ${sig.slice(0, 8)}…` });
        await load();
      } catch (e) {
        setClaimMsg({ ok: false, text: e.message || String(e) });
      } finally {
        setClaimBusyKey(null);
      }
    },
    [anchorWallet, connection, load],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Load the wallet's auto-push preference from the worker. Returns the
  // resolved effective value (true when no record exists — that's the
  // server-side resolver default for legacy stakers).
  const loadPrefs = useCallback(async () => {
    if (!pk) {
      setPrefs(null);
      return;
    }
    setPrefsLoading(true);
    try {
      const r = await fetch(apiUrl(`/api/user-prefs/${pk}`));
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setPrefs({
        autoPush: d.effectiveAutoPush !== false,
        hasRecord: !!d.prefs,
        source: d.prefs?.autoPushSource || null,
        updatedAt: d.prefs?.updatedAt || null,
      });
    } catch (e) {
      setPrefs(null);
      console.warn('user-prefs load failed', e);
    } finally {
      setPrefsLoading(false);
    }
  }, [pk]);

  useEffect(() => {
    loadPrefs();
  }, [loadPrefs]);

  // Toggle auto-push. Wallet must support signMessage (Phantom, Backpack,
  // Solflare all do; some hardware wallets don't — surface a helpful error).
  const onTogglePrefs = useCallback(
    async (next) => {
      setPrefsMsg(null);
      if (!pk) return;
      if (!fullWallet?.signMessage) {
        setPrefsMsg({ ok: false, text: 'This wallet does not support message signing — try Phantom, Backpack, or Solflare.' });
        return;
      }
      setPrefsBusy(true);
      try {
        const signedAt = new Date().toISOString();
        const message = `stakrr-prefs:${pk}:${signedAt}`;
        const sig = await fullWallet.signMessage(new TextEncoder().encode(message));
        const r = await fetch(apiUrl(`/api/user-prefs/${pk}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            autoPush: next,
            signedAt,
            signature: bs58.encode(sig),
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setPrefs({
          autoPush: d.effectiveAutoPush !== false,
          hasRecord: true,
          source: d.prefs?.autoPushSource || 'user_set',
          updatedAt: d.prefs?.updatedAt || null,
        });
        setPrefsMsg({ ok: true, text: next ? 'Auto-push enabled — rewards will land in your wallet automatically.' : 'Auto-push disabled — claim manually from the Rewards tab.' });
      } catch (e) {
        setPrefsMsg({ ok: false, text: e.message || String(e) });
      } finally {
        setPrefsBusy(false);
      }
    },
    [pk, fullWallet],
  );

  // Load pending KOL claims for this wallet. Returns only entries with
  // status='pending' AND not-yet-expired (server already filters); the
  // dashboard never surfaces claimed/expired rows since they're not
  // actionable.
  const loadKolClaims = useCallback(async () => {
    if (!pk) {
      setKolClaims([]);
      return;
    }
    setKolClaimsLoading(true);
    try {
      const r = await fetch(apiUrl(`/api/kol-claims/${pk}`));
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setKolClaims(Array.isArray(d.claims) ? d.claims : []);
    } catch (e) {
      console.warn('kol-claims load failed', e);
      setKolClaims([]);
    } finally {
      setKolClaimsLoading(false);
    }
  }, [pk]);

  useEffect(() => {
    loadKolClaims();
  }, [loadKolClaims]);

  // Accept a pending KOL claim. Wallet signs a canonical message; the
  // worker then signs + sends `stake_for(beneficiary=this wallet)` from
  // the dev's vault keypair, so the user pays no SOL and never sees a
  // wallet-adapter tx prompt — just a single message-sign prompt.
  const onAcceptKolClaim = useCallback(
    async (claim) => {
      setKolMsg(null);
      if (!pk) return;
      if (claim.wallet !== pk) {
        setKolMsg({ ok: false, text: 'Connected wallet does not match the claim' });
        return;
      }
      if (!fullWallet?.signMessage) {
        setKolMsg({ ok: false, text: 'This wallet does not support message signing — try Phantom, Backpack, or Solflare.' });
        return;
      }
      setKolAcceptBusy(claim.id);
      try {
        const signedAt = new Date().toISOString();
        const message = `stakrr-kol-accept:${claim.id}:${signedAt}`;
        const sig = await fullWallet.signMessage(new TextEncoder().encode(message));
        const r = await fetch(apiUrl(`/api/kol-claims/${claim.id}/accept`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ signedAt, signature: bs58.encode(sig) }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        setKolMsg({
          ok: true,
          text: `Accepted — staked position created (${d.txSig?.slice(0, 8) || '?'}…). Locked ${claim.stakeLockDays}d.`,
        });
        await Promise.all([loadKolClaims(), load()]);
      } catch (e) {
        setKolMsg({ ok: false, text: e.message || String(e) });
      } finally {
        setKolAcceptBusy(null);
      }
    },
    [pk, fullWallet, loadKolClaims, load],
  );

  if (!pk) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center', padding: '48px 16px' }}>
        <p style={{ fontWeight: 800, fontSize: 22, margin: '0 0 12px', fontFamily: "'Syne', sans-serif" }}>
          Connect your wallet
        </p>
        <p style={{ color: MUTED, fontSize: 15, margin: 0 }}>
          Your portfolio, launched tokens, and stake positions load here once a wallet is connected.
        </p>
      </div>
    );
  }

  const stats = data?.stats;
  const launched = data?.launched || [];
  const staked = data?.staked || [];
  const activity = data?.recentActivity || [];

  const tabBtn = (id, label) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      style={{
        padding: '10px 14px',
        borderRadius: 100,
        border: 'none',
        cursor: 'pointer',
        fontWeight: 700,
        fontSize: 13,
        fontFamily: "'Syne', sans-serif",
        background: tab === id ? INK : '#F0F0F0',
        color: tab === id ? '#fff' : INK,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="db-user-dashboard" style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div
        className="db-user-hero"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 12,
          marginBottom: 28,
        }}
      >
        <div style={{ gridColumn: '1 / -1', marginBottom: 4 }}>
          <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.15em', color: MUTED, textTransform: 'uppercase' }}>
            Wallet
          </p>
          <p style={{ margin: '6px 0 0', fontFamily: "'DM Mono', monospace", fontSize: 15, fontWeight: 700, wordBreak: 'break-all' }}>
            {pk}
          </p>
        </div>
        <div className="db-stat-card" style={statCardStyle}>
          <div style={statLabel}>Tokens launched</div>
          <div style={statValue}>{loading ? '—' : stats?.launchedCount ?? 0}</div>
        </div>
        <div className="db-stat-card" style={statCardStyle}>
          <div style={statLabel}>Staked in</div>
          <div style={statValue}>{loading ? '—' : stats?.stakedTokenCount ?? 0} mints</div>
        </div>
        <div className="db-stat-card" style={statCardStyle}>
          <div style={statLabel}>Open positions</div>
          <div style={statValue}>{loading ? '—' : stats?.positionCount ?? 0}</div>
        </div>
        <div className="db-stat-card" style={{ ...statCardStyle, borderColor: 'rgba(53,197,224,0.35)' }}>
          <div style={statLabel}>Fees earned (SOL pools)</div>
          <div style={statValue}>
            {loading ? '—' : `${fmtLamports(data?.totals?.lifetimeEarnedSolLamports || '0')} SOL`}
          </div>
          <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>
            {loading ? '' : `${fmtLamports(data?.totals?.pendingSolLamports || '0')} SOL pending · ${fmtLamports(data?.totals?.lifetimeClaimedSolLamports || '0')} SOL already claimed`}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {tabBtn('positions', 'Staked positions')}
        {tabBtn('launched', 'Launched tokens')}
        {tabBtn('rewards', 'Rewards')}
        {tabBtn('activity', 'Activity')}
        {tabBtn('kolClaims', kolClaims.length > 0 ? `KOL Claims (${kolClaims.length})` : 'KOL Claims')}
        {tabBtn('settings', 'Settings')}
      </div>

      {error && (
        <div style={{ background: '#FFF0F0', border: '1px solid #FFCDD2', borderRadius: 12, padding: 12, marginBottom: 16, fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading && <p className="muted" style={{ fontSize: 14 }}>Loading your data…</p>}

      {!loading && data && tab === 'positions' && (
        <div className="db-user-table-wrap">
          {staked.length === 0 ? (
            <p style={{ color: MUTED, fontSize: 15 }}>No open stake positions for this wallet.</p>
          ) : (
            <table className="db-user-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Staked</th>
                  <th>Lock</th>
                  <th>Weight</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {staked.flatMap((row) =>
                  row.positions.map((pos) => (
                    <tr key={`${row.stakeMint}-${pos.position}`}>
                      <td>
                        <button
                          type="button"
                          className="db-user-token-link"
                          onClick={() => onSelectToken(row.stakeMint)}
                          style={{
                            background: 'none',
                            border: 'none',
                            cursor: 'pointer',
                            textAlign: 'left',
                            padding: 0,
                            fontWeight: 700,
                            fontFamily: "'Syne', sans-serif",
                            color: SKY,
                          }}
                        >
                          ${row.symbol || 'TKN'}
                        </button>
                        <div style={{ fontSize: 11, color: MUTED, fontFamily: "'DM Mono', monospace" }}>{shorten(row.stakeMint, 5, 5)}</div>
                      </td>
                      <td style={{ fontFamily: "'DM Mono', monospace", fontSize: 13 }}>{fmtRaw(pos.amount, 6)}</td>
                      <td>{pos.lockDays}d</td>
                      <td>{(Number(pos.multiplierBps || 0) / 100).toFixed(2)}×</td>
                      <td>
                        <button type="button" className="db-user-row-btn" onClick={() => onSelectToken(row.stakeMint)}>
                          Manage
                        </button>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!loading && data && tab === 'launched' && (
        <div className="db-user-table-wrap">
          {launched.length === 0 ? (
            <p style={{ color: MUTED, fontSize: 15 }}>You have not launched any tokens with this wallet yet.</p>
          ) : (
            <table className="db-user-table">
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Reward</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {launched.map((row) => (
                  <tr key={row.stakeMint}>
                    <td>
                      <div style={{ fontWeight: 700 }}>${row.symbol || 'TKN'}</div>
                      <div style={{ fontSize: 11, color: MUTED, fontFamily: "'DM Mono', monospace" }}>{shorten(row.stakeMint, 5, 5)}</div>
                    </td>
                    <td>{row.rewardMode === 'token' ? `$${row.symbol || 'TKN'}` : 'SOL'}</td>
                    <td style={{ fontSize: 13, color: MUTED }}>{row.createdAt ? new Date(row.createdAt).toLocaleDateString() : '—'}</td>
                    <td>
                      <button type="button" className="db-user-row-btn" onClick={() => onSelectToken(row.stakeMint)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {!loading && data && tab === 'rewards' && (
        <div>
          <p style={{ margin: '0 0 16px', fontSize: 15, lineHeight: 1.6, color: '#444' }}>
            Claim accrued rewards for each open position. SOL pools unwrap wSOL to your wallet; token pools credit your
            token ATA. You can still open a token for stake / unstake.
          </p>
          {claimMsg && (
            <div
              style={{
                marginBottom: 14,
                padding: '12px 14px',
                borderRadius: 12,
                fontSize: 13,
                background: claimMsg.ok ? '#E8FFF4' : '#FFF0F0',
                border: `1px solid ${claimMsg.ok ? '#A7E9C4' : '#FFCDD2'}`,
                color: claimMsg.ok ? '#065f46' : '#991b1b',
              }}
            >
              {claimMsg.text}
            </div>
          )}
          {rewardRows.length === 0 ? (
            <p style={{ color: MUTED, fontSize: 15 }}>No open stake positions — nothing to claim here yet.</p>
          ) : (
            <div className="db-user-table-wrap">
              <table className="db-user-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Reward</th>
                    <th>Staked</th>
                    <th>Lock</th>
                    <th style={{ textAlign: 'right' }}>Earned</th>
                    <th style={{ textAlign: 'right' }}>Pending</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rewardRows.map((r) => {
                    const pos = r.pos;
                    const isSol = (r.rewardMode || 'sol') !== 'token';
                    const claimLabel = isSol ? 'Claim SOL' : `Claim $${r.symbol || 'TKN'}`;
                    const busy = claimBusyKey === r.key;
                    const earnedRaw = pos.earnedRaw || '0';
                    const pendingRaw = pos.claimableRaw || '0';
                    const earnedTxt = isSol
                      ? `${fmtLamports(earnedRaw)} SOL`
                      : `${fmtRaw(earnedRaw, 6)} $${r.symbol || 'TKN'}`;
                    const pendingTxt = isSol
                      ? `${fmtLamports(pendingRaw)} SOL`
                      : `${fmtRaw(pendingRaw, 6)} $${r.symbol || 'TKN'}`;
                    const claimedRaw = pos.totalClaimedRaw || '0';
                    const claimedNote = isSol
                      ? `${fmtLamports(claimedRaw)} SOL claimed`
                      : `${fmtRaw(claimedRaw, 6)} claimed`;
                    return (
                      <tr key={r.key}>
                        <td>
                          <button
                            type="button"
                            className="db-user-token-link"
                            onClick={() => onSelectToken(r.stakeMint)}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              textAlign: 'left',
                              padding: 0,
                              fontWeight: 700,
                              fontFamily: "'Syne', sans-serif",
                              color: SKY,
                            }}
                          >
                            ${r.symbol || 'TKN'}
                          </button>
                          <div style={{ fontSize: 11, color: MUTED, fontFamily: "'DM Mono', monospace" }}>
                            {shorten(r.stakeMint, 5, 5)}
                          </div>
                        </td>
                        <td style={{ fontSize: 13 }}>{isSol ? 'SOL' : `Token ($${r.symbol || 'TKN'})`}</td>
                        <td style={{ fontFamily: "'DM Mono', monospace", fontSize: 13 }}>{fmtRaw(pos.amount, 6)}</td>
                        <td>{pos.lockDays}d</td>
                        <td style={{ textAlign: 'right', fontFamily: "'DM Mono', monospace", fontSize: 13 }}>
                          <div style={{ fontWeight: 700 }}>{earnedTxt}</div>
                          <div style={{ fontSize: 11, color: MUTED, fontWeight: 500 }}>{claimedNote}</div>
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: "'DM Mono', monospace", fontSize: 13, color: pendingRaw === '0' ? MUTED : INK, fontWeight: pendingRaw === '0' ? 500 : 700 }}>
                          {pendingTxt}
                        </td>
                        <td>
                          <button
                            type="button"
                            className="db-user-row-btn"
                            disabled={!!claimBusyKey || !anchorWallet?.signTransaction}
                            onClick={() => onClaimReward(r, pos)}
                          >
                            {busy ? 'Signing…' : claimLabel}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {!loading && data && tab === 'activity' && (
        <div style={{ display: 'grid', gap: 10 }}>
          {activity.length === 0 ? (
            <p style={{ color: MUTED }}>No recent worker events tied to this wallet yet.</p>
          ) : (
            activity.map((ev, i) => (
              <div
                key={i}
                style={{
                  background: '#FAFAFA',
                  borderRadius: 12,
                  padding: '12px 14px',
                  border: '1px solid #E8E8E8',
                  fontSize: 13,
                  fontFamily: "'DM Mono', monospace",
                }}
              >
                <span style={{ color: SKY, fontWeight: 700 }}>{ev.type || 'event'}</span>
                <span style={{ color: MUTED, marginLeft: 8 }}>{ev.ts}</span>
                {ev.stakeMint && (
                  <div style={{ marginTop: 6, wordBreak: 'break-all' }}>
                    mint {shorten(ev.stakeMint, 8, 8)}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {!loading && data && tab === 'kolClaims' && (
        <div style={{ display: 'grid', gap: 12, maxWidth: 860 }}>
          <div style={{ background: '#fff', border: '1px solid #E8E8E8', borderRadius: 12, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 8 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Pending KOL Allocations</h3>
              <button
                onClick={loadKolClaims}
                disabled={kolClaimsLoading}
                style={{
                  background: 'transparent', border: 'none', color: '#666',
                  fontSize: 12, cursor: 'pointer', textDecoration: 'underline',
                }}
              >
                {kolClaimsLoading ? 'refreshing…' : 'refresh'}
              </button>
            </div>
            <p style={{ fontSize: 12, color: MUTED, margin: '0 0 12px 0' }}>
              You've been allocated a slice of one or more token launches by the team. Sign once below to materialise the staked position; you'll never be prompted to send a transaction (we sign + pay from the dev wallet). Unclaimed slots auto-expire after the listed window and revert to the dev — review terms before accepting.
            </p>

            {kolMsg && (
              <div style={{
                marginBottom: 12, padding: 10, borderRadius: 8, fontSize: 12,
                background: kolMsg.ok ? '#dcfce7' : '#fee2e2',
                color: kolMsg.ok ? '#166534' : '#991b1b',
              }}>
                {kolMsg.text}
              </div>
            )}

            {kolClaims.length === 0 ? (
              <div style={{ fontSize: 13, color: MUTED, padding: 20, textAlign: 'center' }}>
                No pending KOL allocations for this wallet.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {kolClaims.map((c) => {
                  const expiresMs = new Date(c.expiresAt).getTime();
                  const daysLeft = Math.max(0, Math.ceil((expiresMs - Date.now()) / 86400000));
                  return (
                    <div
                      key={c.id}
                      style={{
                        border: '1px solid #E8E8E8',
                        borderRadius: 10,
                        padding: 12,
                        display: 'grid',
                        gridTemplateColumns: '1fr auto',
                        gap: 12,
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
                          {c.symbol || 'Token'} <span style={{ color: MUTED, fontSize: 12 }}>· {shorten(c.mint, 4, 4)}</span>
                        </div>
                        <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.6 }}>
                          {fmtRaw(c.tokensRaw, 6)} tokens · stakes for {c.stakeLockDays} days on accept
                          <br />
                          Window: <strong style={{ color: daysLeft <= 3 ? '#991b1b' : '#374151' }}>{daysLeft}d left</strong> (expires {new Date(c.expiresAt).toLocaleDateString()})
                          {c.label && <> · {c.label}</>}
                        </div>
                      </div>
                      <button
                        onClick={() => onAcceptKolClaim(c)}
                        disabled={kolAcceptBusy === c.id}
                        style={{
                          padding: '10px 18px',
                          border: 'none',
                          borderRadius: 8,
                          background: '#000',
                          color: '#fff',
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: kolAcceptBusy === c.id ? 'wait' : 'pointer',
                          opacity: kolAcceptBusy === c.id ? 0.6 : 1,
                        }}
                      >
                        {kolAcceptBusy === c.id ? 'Signing…' : 'Accept & stake'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {!loading && data && tab === 'settings' && (
        <div style={{ display: 'grid', gap: 16, maxWidth: 720 }}>
          <div
            style={{
              background: '#fff',
              border: '1px solid #E8E8E8',
              borderRadius: 16,
              padding: '20px 22px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
              <div style={{ flex: 1 }}>
                <p
                  style={{
                    margin: 0,
                    fontSize: 11,
                    fontWeight: 700,
                    letterSpacing: '0.15em',
                    color: MUTED,
                    textTransform: 'uppercase',
                  }}
                >
                  Auto-claim rewards
                </p>
                <p style={{ margin: '8px 0 4px', fontSize: 17, fontWeight: 800, fontFamily: "'Syne', sans-serif" }}>
                  {prefsLoading ? 'Loading…' : prefs?.autoPush ? 'Enabled' : 'Disabled'}
                </p>
                <p style={{ margin: 0, fontSize: 13, color: '#555', lineHeight: 1.55 }}>
                  When enabled, the worker pushes any rewards you've earned directly to your wallet shortly after each
                  cycle settles. SOL rewards arrive as <strong>wrapped SOL</strong> (wSOL); your wallet (Phantom,
                  Backpack, Jupiter, etc.) lets you unwrap to native SOL with one click. Token rewards land in the
                  matching token ATA. Disable to claim manually from the Rewards tab whenever you want.
                </p>
                {prefs?.source && (
                  <p style={{ margin: '8px 0 0', fontSize: 12, color: MUTED }}>
                    Source: {prefs.source === 'stake_for_default' ? 'auto-staked on your behalf (presale / airdrop)' : 'set by you'}
                    {prefs.updatedAt ? ` · updated ${new Date(prefs.updatedAt).toLocaleString()}` : ''}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onTogglePrefs(!prefs?.autoPush)}
                disabled={prefsBusy || prefsLoading}
                style={{
                  background: prefs?.autoPush ? INK : SKY,
                  color: '#fff',
                  border: 'none',
                  borderRadius: 100,
                  padding: '12px 20px',
                  fontWeight: 800,
                  fontFamily: "'Syne', sans-serif",
                  fontSize: 13,
                  cursor: prefsBusy ? 'wait' : 'pointer',
                  opacity: prefsBusy || prefsLoading ? 0.6 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {prefsBusy ? 'Signing…' : prefs?.autoPush ? 'Switch to manual' : 'Switch to auto'}
              </button>
            </div>
            {prefsMsg && (
              <div
                style={{
                  marginTop: 14,
                  padding: '10px 12px',
                  borderRadius: 10,
                  fontSize: 13,
                  background: prefsMsg.ok ? '#E8FFF4' : '#FFF0F0',
                  border: `1px solid ${prefsMsg.ok ? '#A7E9C4' : '#FFCDD2'}`,
                  color: prefsMsg.ok ? '#065f46' : '#991b1b',
                }}
              >
                {prefsMsg.text}
              </div>
            )}
            <p style={{ margin: '14px 0 0', fontSize: 12, color: '#888', lineHeight: 1.5 }}>
              You'll be prompted to sign a short message to authorise the change. No tokens move and no transaction is
              broadcast — the signature just proves you control this wallet.
            </p>
          </div>
        </div>
      )}

      <p style={{ marginTop: 28, fontSize: 12, color: '#aaa' }}>
        <button
          type="button"
          onClick={load}
          style={{
            background: 'none',
            border: 'none',
            color: SKY,
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: "'Syne', sans-serif",
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          Refresh
        </button>
      </p>
    </div>
  );
}

const statCardStyle = {
  background: '#fff',
  border: '1px solid #E8E8E8',
  borderRadius: 16,
  padding: '16px 18px',
};

const statLabel = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: MUTED,
  marginBottom: 8,
};

const statValue = {
  fontSize: 26,
  fontWeight: 800,
  letterSpacing: '-0.5px',
  fontFamily: "'Syne', sans-serif",
};
