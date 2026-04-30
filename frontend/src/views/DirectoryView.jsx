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
      <h2 className="section-title">Active pools</h2>
      <p className="section-lead">
        Every Stakrr token has a public staking pool. Lock to earn up to 3× weight on the token&apos;s
        creator fees, paid out as SOL or the token itself.
      </p>
      {loading && <div className="muted" style={{ padding: '16px 0' }}>Loading…</div>}
      {error && <div className="alert alert--error" style={{ marginBottom: 16 }}>{error}</div>}
      {!loading && !error && pools.length === 0 && (
        <div className="empty-state">
          <strong>No pools yet.</strong>
          <div className="muted" style={{ marginTop: 8 }}>
            Be the first — open <strong>Launch</strong> in the nav.
          </div>
        </div>
      )}
      <div className="pool-grid">
        {pools.map((p) => (
          <button
            key={p.stakeMint}
            type="button"
            onClick={() => onSelectPool(p.stakeMint)}
            className="pool-card"
          >
            <div className="pool-card__sym">{p.metadata?.symbol || 'TKN'}</div>
            <div className="pool-card__name">{p.metadata?.name || `${p.stakeMint.slice(0, 8)}…`}</div>
            <div className="pool-card__meta">
              <div>
                Fees claimed:{' '}
                {(BigInt(p.totalCreatorFeesClaimedLamports || '0') / 10n ** 9n).toString()} SOL
              </div>
              <div>
                Distributed: {(BigInt(p.totalRewardsDistributedLamports || '0') / 10n ** 9n).toString()} SOL
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
