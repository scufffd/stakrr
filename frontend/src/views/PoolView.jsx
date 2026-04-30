import React, { useEffect, useState } from 'react';
import StakePoolView from '../stake/StakePoolView.jsx';

export default function PoolView({ mint, onBack }) {
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch(`/api/pools/${mint}/public`);
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setPool(data.pool);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [mint]);

  return (
    <div>
      <button onClick={onBack} style={backBtnStyle}>← back to pools</button>

      {loading && <div style={mutedTextStyle}>loading…</div>}
      {error && <div style={mutedTextStyle}>error: {error}</div>}

      {pool && (
        <div style={{ display: 'grid', gap: 16 }}>
          <div style={panelStyle}>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{pool.metadata?.symbol || 'TKN'}</div>
            <div style={{ color: 'var(--muted)' }}>{pool.metadata?.name}</div>
            <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 12, wordBreak: 'break-all' }}>{pool.stakeMint}</div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
            <Stat label="Total staked (raw)" value={pool.totalStaked || '0'} />
            <Stat label="Active positions" value={String(pool.activePositions ?? '—')} />
            <Stat label="Unique stakers" value={String(pool.uniqueStakers ?? '—')} />
            <Stat label="wSOL deposited" value={pool.rewardWsol?.totalDeposited || '0'} />
            <Stat label="wSOL claimed" value={pool.rewardWsol?.totalClaimed || '0'} />
          </div>

          <StakePoolView stakeMintB58={pool.stakeMint} />
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div style={panelStyle}>
      <div style={{ color: 'var(--muted)', fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 18, marginTop: 4, wordBreak: 'break-all' }}>{value}</div>
    </div>
  );
}

const panelStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
};

const mutedTextStyle = { color: 'var(--muted)', padding: 16 };

const backBtnStyle = {
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  padding: '6px 12px',
  borderRadius: 8,
  cursor: 'pointer',
  marginBottom: 16,
};
