import React, { useState } from 'react';

const LOCK_TIERS = [
  { days: 1, label: '1 day · 1.00×' },
  { days: 3, label: '3 days · 1.25×' },
  { days: 7, label: '7 days · 1.50×' },
  { days: 14, label: '14 days · 2.00×' },
  { days: 21, label: '21 days · 2.50×' },
  { days: 30, label: '30 days · 3.00×' },
];

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
  const [rewardMode, setRewardMode] = useState('sol');
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
      if (!imageFile) throw new Error('Please pick an image for the token.');
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
    <div className="panel">
      <h2 className="section-title">launch a token</h2>
      <p className="section-lead" style={{ marginBottom: 0 }}>
        Stakrr launches your token on Pump.fun and opens a staking pool. The platform treasury is the
        on-chain creator-fee receiver. Each cycle, 2% of claimed fees are retained and the rest is
        distributed to stakers.
      </p>

      <form
        onSubmit={submit}
        className="form-grid form-grid--2"
        style={{ marginTop: 24 }}
      >
        <div className="form-field">
          <label className="form-label" htmlFor="launch-name">Name</label>
          <input
            id="launch-name"
            className="input"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="launch-symbol">Ticker</label>
          <input
            id="launch-symbol"
            className="input"
            required
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            maxLength={10}
          />
        </div>
        <div className="form-field form-field--full">
          <label className="form-label" htmlFor="launch-desc">Description</label>
          <textarea
            id="launch-desc"
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="launch-twitter">Twitter</label>
          <input
            id="launch-twitter"
            className="input"
            value={twitter}
            onChange={(e) => setTwitter(e.target.value)}
            placeholder="https://x.com/..."
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="launch-telegram">Telegram</label>
          <input
            id="launch-telegram"
            className="input"
            value={telegram}
            onChange={(e) => setTelegram(e.target.value)}
            placeholder="https://t.me/..."
          />
        </div>
        <div className="form-field form-field--full">
          <label className="form-label" htmlFor="launch-web">Website</label>
          <input
            id="launch-web"
            className="input"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div className="form-field form-field--full">
          <span className="form-label">Stakers earn rewards in</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginTop: 6 }}>
            <RewardOption
              active={rewardMode === 'sol'}
              onClick={() => setRewardMode('sol')}
              title="SOL"
              subtitle="Native SOL (auto-unwrapped from wSOL on claim)"
              detail="Each cycle the worker claims creator fees, takes the 2% platform fee, wraps the rest to wSOL and deposits it as rewards. Stakers receive SOL when they claim."
            />
            <RewardOption
              active={rewardMode === 'token'}
              onClick={() => setRewardMode('token')}
              title={`$${(symbol || 'TOKEN').toUpperCase() || 'TOKEN'}`}
              subtitle="Buyback-and-distribute"
              detail="Each cycle the worker claims creator fees, takes the 2% platform fee, swaps the rest to your token via Pump.fun, and deposits tokens as rewards."
            />
          </div>
        </div>

        <div className="form-field form-field--full">
          <label className="form-label" htmlFor="launch-image">Token image (PNG / JPG / GIF / WEBP, max 5MB)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <input
              id="launch-image"
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={onPickImage}
              className="input"
              style={{ flex: 1, minWidth: 200, padding: 10 }}
              required
            />
            {imagePreview && (
              <img
                src={imagePreview}
                alt=""
                className="token-avatar"
                style={{ width: 64, height: 64, borderRadius: 12 }}
              />
            )}
          </div>
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="launch-buy">Initial dev buy (SOL)</label>
          <input
            id="launch-buy"
            className="input"
            type="number"
            min="0"
            step="0.01"
            value={initialBuy}
            onChange={(e) => setInitialBuy(e.target.value)}
          />
        </div>
        <div className="form-field">
          <label className="form-label" htmlFor="launch-lock">Auto-stake lock</label>
          <select
            id="launch-lock"
            className="select"
            style={{ opacity: autoStakeActive ? 1 : 0.55 }}
            value={lockDays}
            onChange={(e) => setLockDays(Number(e.target.value))}
            disabled={!autoStakeActive}
          >
            {LOCK_TIERS.map((t) => (
              <option key={t.days} value={t.days}>{t.label}</option>
            ))}
          </select>
        </div>

        <div className="form-field form-field--full">
          <label
            className={`auto-stake-box${canAutoStake ? '' : ' auto-stake-box--inactive'}`}
            style={{ cursor: canAutoStake ? 'pointer' : 'not-allowed' }}
            htmlFor="auto-stake-cb"
          >
            <input
              id="auto-stake-cb"
              type="checkbox"
              checked={autoStake}
              onChange={(e) => setAutoStake(e.target.checked)}
              disabled={!canAutoStake}
              style={{ marginTop: 4 }}
            />
            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ fontWeight: 700, fontSize: '0.9375rem' }}>
                Atomically stake the dev buy on launch
              </div>
              <div className="muted" style={{ fontSize: '0.8125rem', lineHeight: 1.5 }}>
                {!walletConnected
                  ? 'Connect a wallet — the position will be owned by the connected wallet.'
                  : buyAmount <= 0
                    ? 'Enter an initial dev buy above to enable atomic auto-staking.'
                    : `Treasury buys ${buyAmount} SOL of tokens during create, then immediately stakes for your wallet with the lock you pick.`}
              </div>
            </div>
          </label>
        </div>

        <div className="form-field form-field--full" style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <button type="submit" disabled={submitting} className="btn-primary">
            {submitting ? 'Launching…' : 'Launch token + open pool'}
          </button>
          <span className="muted" style={{ fontSize: '0.8125rem' }}>
            No platform launch fee · 2% of creator fees to platform
          </span>
        </div>
      </form>

      {error && (
        <div className="alert alert--error" style={{ marginTop: 20 }}>
          {error}
        </div>
      )}

      {result && (
        <div className="alert alert--success" style={{ marginTop: 20, display: 'grid', gap: 8, wordBreak: 'break-all' }}>
          <div><strong>Token launched</strong></div>
          <div>Mint: <code className="mono">{result.stakeMint}</code></div>
          <div>
            Reward mode:{' '}
            <strong>{result.pool?.rewardMode === 'token' ? `$${symbol.toUpperCase()}` : 'SOL'}</strong>
          </div>
          <div>Create: <code className="mono">{result.sigs?.create}</code></div>
          <div>Pool init: <code className="mono">{result.sigs?.poolInit}</code></div>
          <div>Reward: <code className="mono">{result.sigs?.rewardInit}</code></div>
          {result.sigs?.autoStake && (
            <div>Auto-stake: <code className="mono">{result.sigs.autoStake}</code></div>
          )}
          {result.autoStake?.error && (
            <div style={{ color: 'var(--accent)' }}>
              Auto-stake skipped: {result.autoStake.error} — you can stake manually from the pool page.
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
      className={`reward-option${active ? ' reward-option--active' : ''}`}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span className="reward-option__title">{title}</span>
        <span className="reward-option__tag">{active ? 'Selected' : 'Tap to select'}</span>
      </div>
      <div className="muted" style={{ fontSize: '0.8125rem' }}>{subtitle}</div>
      <div className="muted" style={{ fontSize: '0.8125rem', lineHeight: 1.5, marginTop: 4 }}>{detail}</div>
    </button>
  );
}
