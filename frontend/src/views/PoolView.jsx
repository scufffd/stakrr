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
      <div className="pool-toolbar">
        <button type="button" onClick={onBack} className="btn-ghost">← Back to pools</button>
        <button type="button" onClick={() => setRefreshTick((t) => t + 1)} className="btn-ghost">Refresh</button>
      </div>

      {loading && <div className="muted" style={{ padding: 16 }}>Loading pool…</div>}
      {error && <div className="alert alert--error" style={{ marginBottom: 16 }}>{error}</div>}

      {pool && (
        <div style={{ display: 'grid', gap: 20 }}>
          <div className="panel panel--tight">
            <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              {meta.image && (
                <img
                  src={meta.image}
                  alt={meta.symbol || 'token'}
                  className="token-avatar"
                  onError={(e) => { e.currentTarget.style.display = 'none'; }}
                />
              )}
              <div style={{ flex: 1, minWidth: 240 }}>
                <div className="pool-header__title-row">
                  <span className="pool-header__name">{meta.name || 'Untitled'}</span>
                  <span className="pool-header__sym">${meta.symbol || 'TKN'}</span>
                  <span className="badge">
                    {pool.initialized ? 'Staking live' : 'Pool uninitialized'}
                  </span>
                  {pool.initialized && (
                    <span className={`badge ${pool.rewardMode === 'token' ? 'badge--token' : 'badge--sol'}`}>
                      Rewards · {pool.rewardMode === 'token' ? `$${meta.symbol || 'TKN'}` : 'SOL'}
                    </span>
                  )}
                </div>
                {meta.description && (
                  <div className="muted" style={{ marginTop: 10, fontSize: '0.9375rem', maxWidth: 720, lineHeight: 1.55 }}>
                    {meta.description}
                  </div>
                )}
                <div className="chips-row">
                  <button type="button" onClick={() => copy(pool.stakeMint)} className="btn-chip" title="Copy mint">
                    CA {shorten(pool.stakeMint, 6, 6)}
                  </button>
                  {pool.creatorWallet && (
                    <button type="button" onClick={() => copy(pool.creatorWallet)} className="btn-chip" title="Copy launcher">
                      Launcher {shorten(pool.creatorWallet)}
                    </button>
                  )}
                  {meta.twitter && <a href={meta.twitter} target="_blank" rel="noreferrer" className="link-chip">Twitter</a>}
                  {meta.telegram && <a href={meta.telegram} target="_blank" rel="noreferrer" className="link-chip">Telegram</a>}
                  {meta.website && <a href={meta.website} target="_blank" rel="noreferrer" className="link-chip">Site</a>}
                  <a href={pumpfunUrl} target="_blank" rel="noreferrer" className="btn-pump" style={{ marginLeft: 'auto' }}>
                    Buy on Pump.fun ↗
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div className="stats-row">
            <Stat
              label="Total staked"
              value={pool.totalStaked && pool.totalStaked !== '0' ? fmtRaw(pool.totalStaked, 6) : '0'}
              suffix={meta.symbol || ''}
            />
            <Stat label="Active positions" value={String(pool.activePositions ?? '—')} />
            <Stat label="Unique stakers" value={String(pool.uniqueStakers ?? '—')} />
            <Stat label="Fees claimed (SOL)" value={fmtSol(pool.totalCreatorFeesClaimedLamports || '0')} />
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
                <Stat label="Stakers earned (SOL)" value={fmtSol(pool.rewardWsol?.totalDeposited || '0')} />
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
            <div className="alert alert--error">
              This pool&apos;s on-chain state isn&apos;t initialized yet — try again in a few seconds.
            </div>
          )}

          <div className="two-col">
            <div style={{ display: 'grid', gap: 20 }}>
              <div className="panel panel--tight">
                <h3 className="section-title" style={{ fontSize: '1.35rem', marginBottom: 12 }}>How this pool works</h3>
                <ul className="muted" style={{ fontSize: '0.875rem', lineHeight: 1.65, paddingLeft: 20, margin: 0 }}>
                  <li>Buy ${meta.symbol || 'TKN'} on Pump.fun (link above) to start.</li>
                  <li>Stake your tokens for a lock tier — longer locks earn higher reward weight.</li>
                  {pool.rewardMode === 'token' ? (
                    <>
                      <li>
                        The treasury claims Pump.fun creator fees on a schedule. <strong>2%</strong> is platform fee.
                        The rest is <strong>swapped to ${meta.symbol || 'TKN'}</strong> and deposited as rewards.
                      </li>
                      <li>Stakers earn ${meta.symbol || 'TKN'} proportionally; you can claim from your position card.</li>
                    </>
                  ) : (
                    <>
                      <li>
                        The treasury claims creator fees periodically. <strong>2%</strong> platform fee,{' '}
                        <strong>98%</strong> wrapped to wSOL and deposited.
                      </li>
                      <li>Stakers earn proportionally; rewards arrive as native SOL (unwrap on claim).</li>
                    </>
                  )}
                </ul>
              </div>

              <div className="panel panel--tight">
                <h3 className="section-title" style={{ fontSize: '1.35rem', marginBottom: 12 }}>Pool details</h3>
                <DetailRow label="Stake mint" value={pool.stakeMint} mono />
                <DetailRow
                  label="Reward mode"
                  value={pool.rewardMode === 'token' ? `$${meta.symbol || 'TKN'} (buyback)` : 'SOL (wSOL → SOL on claim)'}
                />
                <DetailRow label="Reward mint" value={pool.rewardMint} mono />
                <DetailRow label="Platform fee" value={`${(pool.platformFeeBps || 200) / 100}%`} />
                {pool.rewardMode === 'token' ? (
                  <>
                    <DetailRow
                      label={`Total deposited ($${meta.symbol || 'TKN'})`}
                      value={`${fmtRaw(pool.rewardToken?.totalDeposited || '0', 6)} $${meta.symbol || 'TKN'}`}
                    />
                    <DetailRow
                      label={`Total claimed ($${meta.symbol || 'TKN'})`}
                      value={`${fmtRaw(pool.rewardToken?.totalClaimed || '0', 6)} $${meta.symbol || 'TKN'}`}
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
                    <DetailRow label="Total deposited (wSOL)" value={`${fmtSol(pool.rewardWsol?.totalDeposited || '0')} SOL`} />
                    <DetailRow label="Total claimed (wSOL)" value={`${fmtSol(pool.rewardWsol?.totalClaimed || '0')} SOL`} />
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

            <div style={{ display: 'grid', gap: 20 }}>
              {pool.initialized ? (
                <StakePoolView
                  stakeMintB58={pool.stakeMint}
                  symbol={meta.symbol}
                  rewardMode={pool.rewardMode || 'sol'}
                  rewardMintB58={pool.rewardMint}
                />
              ) : (
                <div className="panel panel--tight muted">
                  Staking client unavailable — pool not initialized yet.
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
    <div className="stat-box">
      <div className="stat-box__label">{label}</div>
      <div className="stat-box__value">
        {value}
        {suffix && (
          <span className="muted" style={{ marginLeft: 6, fontSize: '0.875rem', fontWeight: 600 }}>
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }) {
  return (
    <div className="detail-row">
      <span className="detail-row__label">{label}</span>
      <span className={`detail-row__value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}
