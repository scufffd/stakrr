import React, { useState } from 'react';

const LOCK_TIERS = [
  { days: 1, label: '1 day · 1.00×' },
  { days: 3, label: '3 days · 1.25×' },
  { days: 7, label: '7 days · 1.50×' },
  { days: 14, label: '14 days · 2.00×' },
  { days: 21, label: '21 days · 2.50×' },
  { days: 30, label: '30 days · 3.00×' },
];

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
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const [initialBuy, setInitialBuy] = useState('0');
  const [autoStake, setAutoStake] = useState(false);
  const [lockDays, setLockDays] = useState(7);
  // 7 picks the 1.50× tier as a sensible default (mirrors StakeView)
  const [rewardMode, setRewardMode] = useState('sol'); // 'sol' | 'token'
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const walletConnected = !!wallet?.publicKey;
  const buyAmount = Number(initialBuy || 0);
  const canAutoStake = walletConnected && buyAmount > 0;
  const autoStakeActive = canAutoStake && autoStake;

  const onPickImage = (e) => {
    const f = e.target.files?.[0];
    setImageFile(f || null);
    if (f) {
      const url = URL.createObjectURL(f);
      setImagePreview(url);
    } else {
      setImagePreview('');
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      if (!imageFile) throw new Error('please pick an image for the token');
      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('symbol', symbol.trim().toUpperCase());
      fd.append('description', description.trim());
      if (twitter.trim()) fd.append('twitter', twitter.trim());
      if (telegram.trim()) fd.append('telegram', telegram.trim());
      if (website.trim()) fd.append('website', website.trim());
      fd.append('initialBuySol', String(Number(initialBuy || 0)));
      if (wallet?.publicKey?.toBase58) fd.append('creatorWallet', wallet.publicKey.toBase58());
      if (autoStakeActive) {
        fd.append('autoStake', 'true');
        fd.append('lockDays', String(lockDays));
      }
      fd.append('rewardMode', rewardMode);
      fd.append('image', imageFile);

      const res = await fetch('/api/launch', { method: 'POST', body: fd });
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
        <div style={{ gridColumn: '1 / -1' }}>
          <label style={LABEL}>Stakers earn rewards in</label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
            <RewardOption
              active={rewardMode === 'sol'}
              onClick={() => setRewardMode('sol')}
              title="SOL"
              subtitle="Native SOL (auto-unwrapped from wSOL on claim)"
              detail="Each cycle the worker claims creator fees, takes the 2% platform fee, wraps the rest to wSOL and deposits it as rewards. Stakers get SOL when they claim."
            />
            <RewardOption
              active={rewardMode === 'token'}
              onClick={() => setRewardMode('token')}
              title={`$${(symbol || 'TOKEN').toUpperCase() || 'TOKEN'}`}
              subtitle="Buyback-and-distribute"
              detail="Each cycle the worker claims creator fees, takes the 2% platform fee, then swaps the rest to your token via Pump.fun and deposits the tokens as rewards. Stakers earn the token itself."
            />
          </div>
        </div>

        <div style={{ ...FIELD, gridColumn: '1 / -1' }}>
          <label style={LABEL}>Token image (PNG / JPG / GIF / WEBP, max 5MB)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={onPickImage}
              style={{ ...INPUT, padding: 8, flex: 1 }}
              required
            />
            {imagePreview && (
              <img src={imagePreview} alt="preview" style={{ width: 56, height: 56, borderRadius: 8, objectFit: 'cover', border: '1px solid var(--border)' }} />
            )}
          </div>
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Initial dev buy (SOL)</label>
          <input style={INPUT} type="number" min="0" step="0.01" value={initialBuy} onChange={(e) => setInitialBuy(e.target.value)} />
        </div>
        <div style={FIELD}>
          <label style={LABEL}>Auto-stake lock</label>
          <select
            style={{ ...INPUT, opacity: autoStakeActive ? 1 : 0.5 }}
            value={lockDays}
            onChange={(e) => setLockDays(Number(e.target.value))}
            disabled={!autoStakeActive}
          >
            {LOCK_TIERS.map((t) => (
              <option key={t.days} value={t.days}>{t.label}</option>
            ))}
          </select>
        </div>

        <div style={{ gridColumn: '1 / -1' }}>
          <label style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: 12,
            border: '1px solid var(--border)',
            borderRadius: 10,
            background: autoStakeActive ? 'rgba(140, 110, 255, 0.08)' : 'rgba(255,255,255,0.02)',
            cursor: canAutoStake ? 'pointer' : 'not-allowed',
            opacity: canAutoStake ? 1 : 0.6,
          }}>
            <input
              type="checkbox"
              checked={autoStake}
              onChange={(e) => setAutoStake(e.target.checked)}
              disabled={!canAutoStake}
              style={{ marginTop: 3 }}
            />
            <div style={{ display: 'grid', gap: 4 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                Atomically stake the dev buy on launch
              </div>
              <div style={{ color: 'var(--muted)', fontSize: 12, lineHeight: 1.45 }}>
                {!walletConnected
                  ? 'Connect a wallet first — the position will be owned by the connected wallet.'
                  : buyAmount <= 0
                    ? 'Enter an initial dev buy above to enable atomic auto-staking.'
                    : `Treasury buys ${buyAmount} SOL of tokens during create, then immediately calls stake_for(beneficiary=your wallet). You'll have an open position the moment the launch confirms.`}
              </div>
            </div>
          </label>
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
          <div>reward mode: <strong>{result.pool?.rewardMode === 'token' ? `$${symbol.toUpperCase()}` : 'SOL'}</strong></div>
          <div>create sig: <code>{result.sigs?.create}</code></div>
          <div>pool init: <code>{result.sigs?.poolInit}</code></div>
          <div>reward registered: <code>{result.sigs?.rewardInit}</code></div>
          {result.sigs?.autoStake && (
            <div>auto-stake sig: <code>{result.sigs.autoStake}</code></div>
          )}
          {result.autoStake?.error && (
            <div style={{ color: '#ffd28a' }}>
              auto-stake skipped: {result.autoStake.error} — you can stake manually from the pool page.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RewardOption({ active, onClick, title, subtitle, detail }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: active ? 'rgba(140, 110, 255, 0.10)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: 14,
        cursor: 'pointer',
        color: 'var(--text)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 16, fontWeight: 700 }}>{title}</span>
        <span style={{ fontSize: 11, color: active ? 'var(--accent)' : 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {active ? 'selected' : 'click to select'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>{subtitle}</div>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, marginTop: 4 }}>{detail}</div>
    </button>
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
