import React, { useEffect, useMemo, useState } from 'react';
import { apiUrl } from '../apiBase.js';

const ACCENTS = ['#35C5E0', '#F4C542', '#FF6B6B', '#7C45F3', '#2ECC71', '#FF9500'];

function fmtSol(v) {
  if (!v) return '0';
  try {
    const n = Number(BigInt(v)) / 1e9;
    return n.toFixed(3).replace(/\.?0+$/, '') || '0';
  } catch {
    return '0';
  }
}

function shorten(a) {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

function SkeletonCard() {
  return (
    <div style={{ borderRadius: 20, border: '1.5px solid #F0F0F0', overflow: 'hidden' }}>
      <div style={{ height: 80, background: '#F8F8F8' }} />
      <div style={{ padding: '16px 20px' }}>
        <div style={{ height: 18, width: 80, background: '#F0F0F0', borderRadius: 6, marginBottom: 8 }} />
        <div style={{ height: 12, width: 140, background: '#F0F0F0', borderRadius: 6 }} />
      </div>
    </div>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" aria-hidden>
      <path d="M7 17L17 7M17 7H7M17 7V17" />
    </svg>
  );
}

export default function DirectoryBoostView({ onSelectToken }) {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tokens;
    return tokens.filter((p) => {
      const sym = (p.metadata?.symbol || '').toLowerCase();
      const name = (p.metadata?.name || '').toLowerCase();
      const mint = (p.stakeMint || '').toLowerCase();
      return sym.includes(q) || name.includes(q) || mint.includes(q);
    });
  }, [tokens, query]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const r = await fetch(apiUrl('/api/tokens'));
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (!cancelled) setTokens(d.tokens || []);
      } catch (e) {
        if (!cancelled) setError(e.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16 }}>
          <div>
            <h2 style={{ fontWeight: 800, fontSize: 28, margin: 0, letterSpacing: '-0.5px' }}>Active tokens</h2>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: '#888', fontWeight: 500 }}>
              Lock tokens · earn creator fees as SOL · 1.0×–3.0× multiplier
            </p>
          </div>
          {!loading && !error && tokens.length > 0 && (
            <span
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: '#35C5E0',
                background: 'rgba(53,197,224,0.1)',
                padding: '4px 12px',
                borderRadius: 100,
              }}
            >
              {query ? `${filtered.length} match` : `${tokens.length} token${tokens.length !== 1 ? 's' : ''}`}
            </span>
          )}
        </div>
        {!loading && !error && tokens.length > 0 && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, symbol, or mint…"
            aria-label="Search tokens"
            style={{
              width: '100%',
              maxWidth: 420,
              padding: '12px 16px',
              borderRadius: 14,
              border: '1.5px solid #E8E8E8',
              fontSize: 14,
              fontFamily: "'Syne', sans-serif",
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        )}
      </div>

      {loading && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {error && (
        <div
          style={{
            background: '#FFF0F0',
            border: '1px solid #FFCDD2',
            borderRadius: 16,
            padding: 16,
            fontSize: 13,
            fontFamily: 'DM Mono, monospace',
            color: '#C62828',
          }}
        >
          {error}
        </div>
      )}

      {!loading && !error && tokens.length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px 40px', border: '2px dashed #E8E8E8', borderRadius: 24 }}>
          <p style={{ fontWeight: 800, fontSize: 24, margin: '0 0 8px' }}>No tokens yet.</p>
          <p style={{ color: '#888', fontSize: 15, margin: 0, fontWeight: 500 }}>
            Be the first — click <strong style={{ color: '#35C5E0' }}>Launch</strong> in the nav.
          </p>
        </div>
      )}

      {!loading && !error && tokens.length > 0 && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px 24px', border: '2px dashed #E8E8E8', borderRadius: 24 }}>
          <p style={{ fontWeight: 700, fontSize: 16, margin: 0, color: '#666' }}>No tokens match your search.</p>
        </div>
      )}

      {!loading && !error && tokens.length > 0 && filtered.length > 0 && (
        <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {filtered.map((p, i) => {
            const color = ACCENTS[i % ACCENTS.length];
            const sym = p.metadata?.symbol || 'TKN';
            return (
              <button
                key={p.stakeMint}
                type="button"
                onClick={() => onSelectToken(p.stakeMint)}
                style={{
                  border: '1.5px solid #F0F0F0',
                  borderRadius: 20,
                  background: 'white',
                  cursor: 'pointer',
                  textAlign: 'left',
                  padding: 0,
                  overflow: 'hidden',
                  transition: 'transform 0.15s, box-shadow 0.15s',
                  fontFamily: "'Syne', sans-serif",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-3px)';
                  e.currentTarget.style.boxShadow = '0 12px 40px rgba(0,0,0,0.1)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <div
                  style={{
                    background: color,
                    padding: '20px 20px 16px',
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    {p.metadata?.image ? (
                      <img
                        src={p.metadata.image}
                        alt={sym}
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 12,
                          objectFit: 'cover',
                          border: '2.5px solid rgba(255,255,255,0.6)',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          width: 44,
                          height: 44,
                          borderRadius: 12,
                          background: 'rgba(255,255,255,0.35)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          border: '2.5px solid rgba(255,255,255,0.5)',
                        }}
                      >
                        <span style={{ fontWeight: 800, fontSize: 13, color: 'white' }}>{sym.slice(0, 3)}</span>
                      </div>
                    )}
                    <div>
                      <div style={{ fontWeight: 800, fontSize: 20, color: 'white', lineHeight: 1 }}>${sym}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)', fontWeight: 600, marginTop: 2 }}>
                        {p.metadata?.name || shorten(p.stakeMint)}
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: '50%',
                      background: 'rgba(255,255,255,0.3)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <ArrowUpIcon />
                  </div>
                </div>

                <div style={{ padding: '14px 20px 16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                    <span style={{ color: '#999', fontWeight: 600 }}>Fees claimed</span>
                    <span style={{ fontFamily: 'DM Mono, monospace', fontWeight: 500 }}>
                      {fmtSol(p.totalCreatorFeesClaimedLamports)} SOL
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                    <span style={{ color: '#999', fontWeight: 600 }}>Distributed</span>
                    <span style={{ fontFamily: 'DM Mono, monospace', fontWeight: 700, color }}>
                      {fmtSol(p.totalRewardsDistributedLamports)} SOL
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
