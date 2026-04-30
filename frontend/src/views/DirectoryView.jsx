import React, { useEffect, useState } from 'react';

export default function DirectoryView({ onSelectPool }) {
  const [pools, setPools] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/pools');
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) setPools(data.pools || []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Active pools</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Every Stakrr token has a public staking pool. Lock to earn 1.0x &ndash; 3.0x of the
        token's creator fees, paid out as SOL.
      </p>
      {loading && <div style={mutedTextStyle}>loading…</div>}
      {error && <div style={mutedTextStyle}>error: {error}</div>}
      {!loading && !error && pools.length === 0 && (
        <div style={emptyStyle}>
          <strong>No pools yet.</strong>
          <div style={{ color: 'var(--muted)', marginTop: 4 }}>
            Be the first &mdash; click <em>Launch</em> in the nav.
          </div>
        </div>
      )}
      <div style={gridStyle}>
        {pools.map((p) => (
          <button key={p.stakeMint} onClick={() => onSelectPool(p.stakeMint)} style={cardStyle}>
            <div style={{ fontWeight: 700, fontSize: 18 }}>{p.metadata?.symbol || 'TKN'}</div>
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>{p.metadata?.name || p.stakeMint.slice(0, 8) + '...'}</div>
            <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)' }}>
              fees claimed: {(BigInt(p.totalCreatorFeesClaimedLamports || '0') / 10n ** 9n).toString()} SOL
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>
              distributed: {(BigInt(p.totalRewardsDistributedLamports || '0') / 10n ** 9n).toString()} SOL
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
  gap: 12,
  marginTop: 16,
};

const cardStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
  textAlign: 'left',
  color: 'var(--text)',
  cursor: 'pointer',
};

const mutedTextStyle = { color: 'var(--muted)', padding: 16 };

const emptyStyle = {
  padding: 24,
  border: '1px dashed var(--border)',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.02)',
};
