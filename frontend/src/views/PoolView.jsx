import React, { useEffect, useMemo, useState } from 'react';
import StakePoolView from '../stake/StakePoolView.jsx';

const LAMPORTS = 1_000_000_000n;

function shorten(addr, head = 4, tail = 4) {
  if (!addr) return '';
  return addr.length > head + tail + 3 ? `${addr.slice(0, head)}…${addr.slice(-tail)}` : addr;
}

function fmtSol(lamportsStr, digits = 4) {
  if (!lamportsStr) return '0';
  try {
    const n = BigInt(lamportsStr);
    const whole = n / LAMPORTS;
    const frac = n % LAMPORTS;
    const fracStr = frac.toString().padStart(9, '0').slice(0, digits).replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return String(lamportsStr);
  }
}

function fmtRaw(rawStr, decimals = 6) {
  if (!rawStr || rawStr === '0') return '0';
  try {
    const n = BigInt(rawStr);
    const d = BigInt(10) ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    const wholeStr = whole.toLocaleString('en-US');
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr ? `${wholeStr}.${fracStr.slice(0, 3)}` : wholeStr;
  } catch {
    return rawStr;
  }
}

export default function PoolView({ mint, onBack }) {
  const [pool, setPool] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);

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
  }, [mint, refreshTick]);

  const meta = pool?.metadata || {};
  const pumpfunUrl = useMemo(() => `https://pump.fun/${pool?.stakeMint || ''}`, [pool]);

  const copy = (text) => {
    if (!text) return;
    if (navigator?.clipboard?.writeText) navigator.clipboard.writeText(text);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>← back to pools</button>
        <button onClick={() => setRefreshTick((t) => t + 1)} style={backBtnStyle}>refresh</button>
      </div>

      {loading && <div style={mutedTextStyle}>loading pool…</div>}
      {error && <div style={errorBoxStyle}>error: {error}</div>}

      {pool && (
        <div style={{ display: 'grid', gap: 16 }}>
          {/* HEADER */}
          <div style={panelStyle}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {meta.image && (
                <img
                  src={meta.image}
                  alt={meta.symbol || 'token'}
                  style={{ width: 72, height: 72, borderRadius: 12, objectFit: 'cover', border: '1px solid var(--border)' }}
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div style={{ flex: 1, minWidth: 240 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 26, fontWeight: 800 }}>{meta.name || 'Untitled'}</span>
                  <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 16 }}>${meta.symbol || 'TKN'}</span>
                  <span style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    background: 'rgba(255,255,255,0.04)',
                    padding: '2px 8px',
                    borderRadius: 999,
                    border: '1px solid var(--border)',
                  }}>
                    {pool.initialized ? 'POB STAKING · LIVE' : 'POOL UNINITIALIZED'}
                  </span>
                  {pool.initialized && (
                    <span style={{
                      fontSize: 11,
                      color: pool.rewardMode === 'token' ? '#a78bfa' : '#4ade80',
                      background: 'rgba(255,255,255,0.04)',
                      padding: '2px 8px',
                      borderRadius: 999,
                      border: '1px solid var(--border)',
                    }}>
                      REWARDS · {pool.rewardMode === 'token' ? `$${meta.symbol || 'TKN'}` : 'SOL'}
                    </span>
                  )}
                </div>
                {meta.description && (
                  <div style={{ color: 'var(--muted)', marginTop: 6, fontSize: 13, maxWidth: 720 }}>
                    {meta.description}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10, alignItems: 'center' }}>
                  <button
                    onClick={() => copy(pool.stakeMint)}
                    title="click to copy"
                    style={chipBtnStyle}
                  >
                    CA: {shorten(pool.stakeMint, 6, 6)}
                  </button>
                  {pool.creatorWallet && (
                    <button
                      onClick={() => copy(pool.creatorWallet)}
                      title="launcher (informational)"
                      style={chipBtnStyle}
                    >
                      launcher: {shorten(pool.creatorWallet)}
                    </button>
                  )}
                  {meta.twitter && <a href={meta.twitter} target="_blank" rel="noreferrer" style={linkChipStyle}>twitter</a>}
                  {meta.telegram && <a href={meta.telegram} target="_blank" rel="noreferrer" style={linkChipStyle}>telegram</a>}
                  {meta.website && <a href={meta.website} target="_blank" rel="noreferrer" style={linkChipStyle}>site</a>}
                  <a href={pumpfunUrl} target="_blank" rel="noreferrer" style={pumpBtnStyle}>
                    buy on pump.fun ↗
                  </a>
                </div>
              </div>
            </div>
          </div>

          {/* STATS STRIP */}
          <div style={statsRowStyle}>
            <Stat
              label="Total staked"
              value={pool.totalStaked && pool.totalStaked !== '0'
                ? fmtRaw(pool.totalStaked, 6)
                : '0'}
              suffix={meta.symbol || ''}
            />
            <Stat label="Active positions" value={String(pool.activePositions ?? '—')} />
            <Stat label="Unique stakers" value={String(pool.uniqueStakers ?? '—')} />
            <Stat
              label="Fees claimed (SOL)"
              value={fmtSol(pool.totalCreatorFeesClaimedLamports || '0')}
            />
            {pool.rewardMode === 'token' ? (
              <>
                <Stat
                  label={`Rewards deposited ($${meta.symbol || 'TKN'})`}
                  value={fmtRaw(pool.rewardToken?.totalDeposited || '0', 6)}
                />
                <Stat
                  label={`Pending claim ($${meta.symbol || 'TKN'})`}
                  value={fmtRaw(
                    String(
                      BigInt(pool.rewardToken?.totalDeposited || '0') -
                        BigInt(pool.rewardToken?.totalClaimed || '0'),
                    ),
                    6,
                  )}
                />
              </>
            ) : (
              <>
                <Stat
                  label="Stakers earned (SOL)"
                  value={fmtSol(pool.rewardWsol?.totalDeposited || '0')}
                />
                <Stat
                  label="Pending claim (SOL)"
                  value={fmtSol(
                    String(
                      BigInt(pool.rewardWsol?.totalDeposited || '0') -
                        BigInt(pool.rewardWsol?.totalClaimed || '0'),
                    ),
                  )}
                />
              </>
            )}
          </div>

          {!pool.initialized && (
            <div style={errorBoxStyle}>
              this pool's on-chain state isn't initialized yet — try again in a few seconds.
            </div>
          )}

          {/* TWO-COLUMN BODY */}
          <div style={twoColStyle}>
            <div style={{ display: 'grid', gap: 16 }}>
              <div style={panelStyle}>
                <h3 style={{ marginTop: 0 }}>How this pool works</h3>
                <ul style={{ color: 'var(--muted)', fontSize: 13, lineHeight: 1.6, paddingLeft: 18, margin: 0 }}>
                  <li>Buy ${meta.symbol || 'TKN'} on pump.fun (link top-right) to start.</li>
                  <li>Stake your tokens here for a lock tier — longer locks earn higher reward weight.</li>
                  {pool.rewardMode === 'token' ? (
                    <>
                      <li>The platform treasury claims pump.fun creator fees periodically. <strong>2%</strong> stays as platform fee. The remaining SOL is <strong>swapped to ${meta.symbol || 'TKN'}</strong> via Pump.fun and deposited into this pool as rewards (buyback-and-distribute).</li>
                      <li>Stakers earn ${meta.symbol || 'TKN'} proportionally. The worker pushes claims automatically; you can also claim from your position card.</li>
                      <li>Rewards arrive in your wallet as ${meta.symbol || 'TKN'}.</li>
                    </>
                  ) : (
                    <>
                      <li>The platform treasury claims pump.fun creator fees periodically. <strong>2%</strong> stays as platform fee, <strong>98%</strong> is wrapped to wSOL and deposited into this pool.</li>
                      <li>Stakers earn proportionally. The worker pushes claims automatically; you can also claim from your position card.</li>
                      <li>Rewards arrive in your wallet as native SOL (wSOL is auto-unwrapped on claim).</li>
                    </>
                  )}
                </ul>
              </div>

              <div style={panelStyle}>
                <h3 style={{ marginTop: 0 }}>Pool details</h3>
                <DetailRow label="Stake mint" value={pool.stakeMint} mono />
                <DetailRow label="Reward mode" value={pool.rewardMode === 'token' ? `$${meta.symbol || 'TKN'} (buyback)` : 'SOL (wSOL → SOL on claim)'} />
                <DetailRow label="Reward mint" value={pool.rewardMint} mono />
                <DetailRow label="Platform fee" value={`${(pool.platformFeeBps || 200) / 100}%`} />
                {pool.rewardMode === 'token' ? (
                  <>
                    <DetailRow
                      label={`Total deposited ($${meta.symbol || 'TKN'})`}
                      value={fmtRaw(pool.rewardToken?.totalDeposited || '0', 6) + ` $${meta.symbol || 'TKN'}`}
                    />
                    <DetailRow
                      label={`Total claimed ($${meta.symbol || 'TKN'})`}
                      value={fmtRaw(pool.rewardToken?.totalClaimed || '0', 6) + ` $${meta.symbol || 'TKN'}`}
                    />
                    {pool.rewardToken?.lastDepositTs && pool.rewardToken.lastDepositTs !== '0' && (
                      <DetailRow
                        label="Last deposit"
                        value={new Date(Number(pool.rewardToken.lastDepositTs) * 1000).toLocaleString()}
                      />
                    )}
                  </>
                ) : (
                  <>
                    <DetailRow label="Total deposited (wSOL)" value={fmtSol(pool.rewardWsol?.totalDeposited || '0') + ' SOL'} />
                    <DetailRow label="Total claimed (wSOL)" value={fmtSol(pool.rewardWsol?.totalClaimed || '0') + ' SOL'} />
                    {pool.rewardWsol?.lastDepositTs && pool.rewardWsol.lastDepositTs !== '0' && (
                      <DetailRow
                        label="Last deposit"
                        value={new Date(Number(pool.rewardWsol.lastDepositTs) * 1000).toLocaleString()}
                      />
                    )}
                  </>
                )}
                <DetailRow label="Created" value={pool.createdAt ? new Date(pool.createdAt).toLocaleString() : '—'} />
              </div>
            </div>

            <div style={{ display: 'grid', gap: 16 }}>
              {pool.initialized ? (
                <StakePoolView
                  stakeMintB58={pool.stakeMint}
                  symbol={meta.symbol}
                  rewardMode={pool.rewardMode || 'sol'}
                  rewardMintB58={pool.rewardMint}
                />
              ) : (
                <div style={panelStyle}>
                  staking client unavailable — pool not initialized yet.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, suffix }) {
  return (
    <div style={statBoxStyle}>
      <div style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 20, marginTop: 6, wordBreak: 'break-all' }}>
        {value}
        {suffix && <span style={{ marginLeft: 6, fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>{suffix}</span>}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '6px 0', fontSize: 13, borderBottom: '1px dashed rgba(255,255,255,0.05)' }}>
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span style={{ fontFamily: mono ? 'ui-monospace, SF Mono, Menlo, monospace' : 'inherit', textAlign: 'right', wordBreak: 'break-all', maxWidth: '60%' }}>
        {value}
      </span>
    </div>
  );
}

const panelStyle = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 18,
};

const statsRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
  gap: 10,
};

const statBoxStyle = {
  ...panelStyle,
  padding: 14,
};

const twoColStyle = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.4fr) minmax(320px, 1fr)',
  gap: 16,
};

const mutedTextStyle = { color: 'var(--muted)', padding: 16 };

const backBtnStyle = {
  background: 'transparent',
  color: 'var(--muted)',
  border: '1px solid var(--border)',
  padding: '6px 12px',
  borderRadius: 8,
  cursor: 'pointer',
};

const chipBtnStyle = {
  background: 'rgba(255,255,255,0.03)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 999,
  padding: '4px 10px',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
};

const linkChipStyle = {
  ...chipBtnStyle,
  textDecoration: 'none',
  display: 'inline-block',
};

const pumpBtnStyle = {
  background: 'linear-gradient(135deg, #4ade80, #16a34a)',
  color: '#0a0a0f',
  border: 'none',
  borderRadius: 999,
  padding: '6px 14px',
  fontSize: 12,
  fontWeight: 700,
  textDecoration: 'none',
  marginLeft: 'auto',
};

const errorBoxStyle = {
  padding: 12,
  background: '#3a1c1c',
  border: '1px solid #6a2c2c',
  borderRadius: 8,
  color: '#ffb4b4',
  fontSize: 13,
};
