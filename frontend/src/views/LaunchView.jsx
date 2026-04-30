import React, { useState } from 'react';

const FIELD = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const INPUT = {
  background: '#1a1a25',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '10px 12px',
  borderRadius: 8,
  fontSize: 14,
};
const LABEL = { color: 'var(--muted)', fontSize: 13 };

export default function LaunchView({ wallet, onLaunched }) {
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [initialBuy, setInitialBuy] = useState('0');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const body = {
        metadata: {
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          description: description.trim(),
          twitter: twitter.trim() || undefined,
          telegram: telegram.trim() || undefined,
          website: website.trim() || undefined,
          image: imageUrl.trim() || undefined,
        },
        initialBuySol: Number(initialBuy || 0),
        creatorWallet: wallet?.publicKey?.toBase58?.() || null,
      };
      const res = await fetch('/api/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      if (typeof onLaunched === 'function') {
        setTimeout(() => onLaunched(data.stakeMint), 800);
      }
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={panelStyle}>
      <h2 style={{ marginTop: 0 }}>Launch a token</h2>
      <p style={{ color: 'var(--muted)', marginTop: 0 }}>
        Stakrr launches your token on Pump.fun and instantly creates a staking pool.
        The platform treasury is set as the on-chain creator-fee receiver. Each cycle,
        2% of the claimed fees are kept as a platform fee and 98% are wrapped to wSOL
        and distributed to stakers via the pob-index-stake program.
      </p>

      <form onSubmit={submit} style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
        <div style={FIELD}>
          <label style={LABEL}>Name</label>
          <input style={INPUT} required value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Ticker</label>
          <input style={INPUT} required value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
        </div>
        <div style={{ ...FIELD, gridColumn: '1 / -1' }}>
          <label style={LABEL}>Description</label>
          <textarea style={{ ...INPUT, minHeight: 90, resize: 'vertical' }} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Twitter</label>
          <input style={INPUT} value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/..." />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Telegram</label>
          <input style={INPUT} value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/..." />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Website</label>
          <input style={INPUT} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Image URL</label>
          <input style={INPUT} value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://..." />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Initial dev buy (SOL)</label>
          <input style={INPUT} type="number" min="0" step="0.01" value={initialBuy} onChange={(e) => setInitialBuy(e.target.value)} />
        </div>

        <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="submit" disabled={submitting} style={launchBtnStyle(submitting)}>
            {submitting ? 'launching...' : 'launch token + open pool'}
          </button>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>
            no platform launch fee · 2% of creator fees go to platform
          </span>
        </div>
      </form>

      {error && (
        <div style={errorStyle}>error: {error}</div>
      )}

      {result && (
        <div style={successStyle}>
          <div><strong>token launched ✦</strong></div>
          <div>mint: <code>{result.stakeMint}</code></div>
          <div>create sig: <code>{result.sigs?.create}</code></div>
          <div>pool init: <code>{result.sigs?.poolInit}</code></div>
          <div>wsol reward: <code>{result.sigs?.rewardInit}</code></div>
        </div>
      )}
    </div>
  );
}

const panelStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 24,
};

function launchBtnStyle(disabled) {
  return {
    background: disabled ? '#3a3a4a' : 'var(--accent)',
    color: '#0a0a0f',
    border: 'none',
    padding: '12px 20px',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

const errorStyle = {
  marginTop: 16,
  padding: 12,
  background: '#3a1c1c',
  border: '1px solid #6a2c2c',
  borderRadius: 8,
  color: '#ffb4b4',
  fontSize: 14,
};

const successStyle = {
  marginTop: 16,
  padding: 12,
  background: '#1a3a1a',
  border: '1px solid #2c6a2c',
  borderRadius: 8,
  color: '#b4ffb4',
  fontSize: 13,
  display: 'grid',
  gap: 4,
  wordBreak: 'break-all',
};
