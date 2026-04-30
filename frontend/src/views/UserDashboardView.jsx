import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
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

export default function UserDashboardView({ wallet, onSelectToken }) {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();
  const [tab, setTab] = useState('positions');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [claimBusyKey, setClaimBusyKey] = useState(null);
  const [claimMsg, setClaimMsg] = useState(null);

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
          <div style={statLabel}>Trading PnL</div>
          <div style={{ ...statValue, fontSize: 16, color: MUTED }}>Not tracked</div>
          <div style={{ fontSize: 11, color: '#aaa', marginTop: 6 }}>Use Pump.fun / explorers for buys & sells.</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
        {tabBtn('positions', 'Staked positions')}
        {tabBtn('launched', 'Launched tokens')}
        {tabBtn('rewards', 'Rewards')}
        {tabBtn('activity', 'Activity')}
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
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rewardRows.map((r) => {
                    const pos = r.pos;
                    const isSol = (r.rewardMode || 'sol') !== 'token';
                    const claimLabel = isSol ? 'Claim SOL' : `Claim $${r.symbol || 'TKN'}`;
                    const busy = claimBusyKey === r.key;
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
