import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { LOCK_TIERS } from '../staking-sdk/index.js';
import { claimPositionRewards } from './claimPosition.js';
import { useStakePoolClient } from './useStakePoolClient.js';
import { confirmWithFallback } from '../lib/confirm.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

function fmtAmount(rawStr, decimals) {
  if (!rawStr) return '0';
  try {
    const n = BigInt(rawStr);
    const d = BigInt(10) ** BigInt(decimals);
    const whole = n / d;
    const frac = n % d;
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return rawStr;
  }
}

function fmtSol(rawStr) {
  return fmtAmount(rawStr, 9);
}

// Compact "1.23M" / "456.7K" / "789" formatter for display-only numbers.
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Inline disclosure shown wherever the user is about to stake. Explains
 * that re-staking creates a fresh position alongside any existing ones,
 * with its own lock timer. The "Why?" <details> gives the rationale —
 * each stake = its own lock = independently unstakeable.
 *
 * Reused in LaunchView's auto-stake card and AdminPresaleView's launch
 * step so the message is identical everywhere staking happens.
 */
function NewPositionNotice({ existingCount = 0, contextLabel = 'staking' }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        padding: '10px 12px',
        background: '#F0F9FF',
        border: '1px solid #BAE6FD',
        borderRadius: 10,
        fontSize: 12.5,
        color: '#075985',
        lineHeight: 1.5,
      }}
    >
      <span aria-hidden style={{ fontSize: 14, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>i</span>
      <div>
        <strong>{contextLabel} creates a new position</strong> with its own lock timer.
        {existingCount > 0 && (
          <> You currently have {existingCount} active position{existingCount === 1 ? '' : 's'} — this adds another.</>
        )}{' '}
        <details style={{ display: 'inline' }}>
          <summary style={{ display: 'inline', cursor: 'pointer', textDecoration: 'underline', color: '#0369A1' }}>
            Why?
          </summary>
          <span style={{ display: 'block', marginTop: 6, color: '#0369A1' }}>
            Each stake locks tokens with its own timer — re-staking never extends an existing lock,
            so a 7-day stake added to a 30-day stake stays as two separate positions you can
            unstake independently when each lock ends. This prevents anyone from gaming the
            multiplier by topping up a long-locked position with new tokens.
          </span>
        </details>
      </div>
    </div>
  );
}

export default function StakePoolView({ stakeMintB58, symbol, rewardMode = 'sol', rewardMintB58 }) {
  const { client, ready, wallet, connection, stakeMint, stakeTokenProgram } = useStakePoolClient(stakeMintB58);
  const walletState = useWallet();
  const isSolReward = rewardMode !== 'token';
  const rewardMintPk = useMemo(() => {
    if (rewardMintB58) {
      try { return new PublicKey(rewardMintB58); } catch {}
    }
    return isSolReward ? WSOL : null;
  }, [rewardMintB58, isSolReward]);
  const tickerLabel = symbol ? `$${symbol}` : 'tokens';
  const rewardLabel = isSolReward ? 'SOL' : (symbol ? `$${symbol}` : 'tokens');

  const [pool, setPool] = useState(null);
  const [decimals, setDecimals] = useState(null);
  const [supplyRaw, setSupplyRaw] = useState(null);
  const [userBalanceRaw, setUserBalanceRaw] = useState('0');
  const [positions, setPositions] = useState([]);
  // Reward mints registered on the pool (each row = one mint enabled as a
  // payout line). We watch this to detect the "stake mint missing as a
  // reward line" case which breaks unstake_early — see backfill banner below.
  const [rewardTokenMints, setRewardTokenMints] = useState([]);
  const [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loadingPool, setLoadingPool] = useState(false);
  const [lastSig, setLastSig] = useState(null);

  // form state
  const [amount, setAmount] = useState('');
  const [lockDays, setLockDays] = useState(7);

  const reload = useCallback(() => setRefreshTick((t) => t + 1), []);

  useEffect(() => {
    if (!ready || !client) return;
    let cancelled = false;
    setLoadingPool(true);
    setLoadError(null);
    (async () => {
      try {
        // Use direct fetch (not the SDK's silent-null wrapper) so RPC errors
        // surface to the user instead of leaving us stuck on "loading".
        let p = null;
        try {
          p = await client.program.account.stakePool.fetch(client.pool);
        } catch (e) {
          // "Account does not exist" is a real "not initialized" state; any
          // other error is an RPC issue worth surfacing.
          if (e?.message && /Account does not exist/i.test(e.message)) {
            p = null;
          } else {
            throw e;
          }
        }
        if (cancelled) return;
        setPool(p);
        // mint decimals + circulating supply (raw units of `decimals`)
        const mintInfo = await connection.getParsedAccountInfo(stakeMint);
        if (cancelled) return;
        const dec = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
        setDecimals(dec);
        // Pump-launched mints typically report supply in two places — Anchor
        // exposes `supply` as a string of raw atoms (no decimals applied).
        const sup = mintInfo?.value?.data?.parsed?.info?.supply;
        setSupplyRaw(sup ? String(sup) : null);
        // user wallet balance
        try {
          const ata = getAssociatedTokenAddressSync(stakeMint, wallet.publicKey, false, stakeTokenProgram);
          const acc = await getAccount(connection, ata, 'confirmed', stakeTokenProgram);
          setUserBalanceRaw(acc.amount.toString());
        } catch {
          setUserBalanceRaw('0');
        }
        // positions
        const owned = await client.fetchAllPositionsByOwner(wallet.publicKey);
        if (cancelled) return;
        setPositions(owned);
        // Reward mints registered on the pool — used to surface the
        // "stake mint isn't a reward line" backfill prompt for the deployer.
        try {
          const rms = await client.fetchAllRewardMints();
          if (cancelled) return;
          setRewardTokenMints(rms.map((r) => r.account.tokenMint.toBase58()));
        } catch {
          if (!cancelled) setRewardTokenMints([]);
        }
      } catch (e) {
        if (!cancelled) setLoadError(e.message || String(e));
      } finally {
        if (!cancelled) setLoadingPool(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, client, connection, stakeMint, stakeTokenProgram, wallet, refreshTick]);

  const sendTx = useCallback(async (ixs) => {
    if (!walletState?.signTransaction) throw new Error('wallet not connected');
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction();
    tx.feePayer = wallet.publicKey;
    tx.recentBlockhash = blockhash;
    for (const ix of ixs) tx.add(ix);
    const signed = await walletState.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
    await confirmWithFallback(connection, sig, { blockhash, lastValidBlockHeight }, { commitment: 'confirmed' });
    return sig;
  }, [walletState, connection, wallet]);

  const onStake = useCallback(async (e) => {
    e.preventDefault();
    setBusy(true); setError(null); setLastSig(null);
    try {
      if (!amount || Number(amount) <= 0) throw new Error('enter an amount');
      if (decimals == null) throw new Error('mint decimals not loaded');
      const raw = BigInt(Math.floor(Number(amount) * 10 ** decimals));
      const nonce = new BN(Date.now());
      const userTokenAccount = getAssociatedTokenAddressSync(stakeMint, wallet.publicKey, false, stakeTokenProgram);
      const stakeIx = await client.stakeIx({
        owner: wallet.publicKey,
        amount: raw,
        lockDays,
        nonce,
        userTokenAccount,
      });
      // also prime checkpoint for wSOL reward so first claim baselines correctly
      const position = client.positionPda(wallet.publicKey, nonce);
      const primeIx = await client.primeCheckpointIx({
        payer: wallet.publicKey,
        position,
        rewardTokenMint: WSOL,
      }).catch(() => null);
      const ixs = [stakeIx];
      if (primeIx) ixs.push(primeIx);
      const sig = await sendTx(ixs);
      setLastSig(sig);
      setAmount('');
      reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [client, decimals, amount, lockDays, stakeMint, stakeTokenProgram, wallet, reload, sendTx]);

  const onClaim = useCallback(async (position) => {
    setBusy(true); setError(null); setLastSig(null);
    try {
      const sig = await claimPositionRewards({
        connection,
        wallet,
        signTransaction: walletState.signTransaction,
        stakeMintB58: stakeMint.toBase58(),
        rewardMode: isSolReward ? 'sol' : 'token',
        rewardMintB58: rewardMintPk ? rewardMintPk.toBase58() : undefined,
        positionB58: position.publicKey.toBase58(),
        programId: client.programId,
      });
      setLastSig(sig);
      reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [
    connection,
    wallet,
    walletState,
    client,
    reload,
    isSolReward,
    rewardMintPk,
    stakeMint,
  ]);

  /**
   * Pool-authority-only backfill: registers the **stake mint itself** as a
   * reward line. The on-chain program needs this to route the 10% early-unstake
   * penalty back to remaining stakers; without it the program fails with
   * `AccountNotInitialized` (Anchor 3012, error 6005 `StakeRewardLineMissing`).
   *
   * Old launches (pre-fix) only registered WSOL as a reward, so every existing
   * pool needs a one-time backfill from its deployer wallet. New launches
   * include this in the bundle automatically (worker/src/launch.js).
   */
  const onBackfillStakeRewardLine = useCallback(async () => {
    setBusy(true); setError(null); setLastSig(null);
    try {
      const ix = await client.addRewardMintIx(wallet.publicKey, stakeMint, stakeTokenProgram);
      const sig = await sendTx([ix]);
      setLastSig(sig);
      reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [client, wallet, stakeMint, stakeTokenProgram, reload, sendTx]);

  const onUnstake = useCallback(async (position, early) => {
    setBusy(true); setError(null); setLastSig(null);
    try {
      const userTokenAccount = getAssociatedTokenAddressSync(stakeMint, wallet.publicKey, false, stakeTokenProgram);
      const ataIx = createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, userTokenAccount, wallet.publicKey, stakeMint, stakeTokenProgram,
      );
      const ixBuilder = early ? client.unstakeEarlyIx : client.unstakeIx;
      const ix = await ixBuilder.call(client, {
        owner: wallet.publicKey,
        position: position.publicKey,
        userTokenAccount,
      });
      const sig = await sendTx([ataIx, ix]);
      setLastSig(sig);
      reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [client, stakeMint, stakeTokenProgram, wallet, reload, sendTx]);

  if (!walletState?.connected) {
    return (
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake</h3>
        <p className="muted" style={{ fontSize: '0.875rem', margin: 0 }}>
          Connect a wallet (top right) to stake, claim, or unstake.
        </p>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake</h3>
        <p className="muted" style={{ fontSize: '0.875rem', margin: 0 }}>Resolving stake mint…</p>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake</h3>
        <div className="alert alert--error" style={{ marginBottom: 12 }}>
          Failed to load staking data from RPC: {loadError}
        </div>
        <p className="muted" style={{ fontSize: '0.8125rem', lineHeight: 1.55, margin: 0 }}>
          If you see 429 or rate limits, set <code className="mono">VITE_RPC_URL</code> in{' '}
          <code className="mono">frontend/.env</code> to a private RPC (Helius / QuickNode) and reload.
        </p>
        <button type="button" onClick={reload} className="btn-small" style={{ marginTop: 12 }}>Retry</button>
      </div>
    );
  }
  if (loadingPool && !pool) {
    return (
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake</h3>
        <p className="muted" style={{ fontSize: '0.875rem', margin: 0 }}>Loading on-chain staking…</p>
      </div>
    );
  }
  if (!pool) {
    return (
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake</h3>
        <p className="muted" style={{ fontSize: '0.875rem', margin: 0 }}>
          Staking isn&apos;t initialized on-chain yet. Wait a few seconds and refresh.
        </p>
        <button type="button" onClick={reload} className="btn-small" style={{ marginTop: 12 }}>Refresh</button>
      </div>
    );
  }

  const balanceFmt = decimals != null ? fmtAmount(userBalanceRaw, decimals) : '—';

  // Backfill banner gating: the program rejects unstake_early when the stake
  // mint isn't registered as a reward line. We only show the fix-it CTA to
  // the pool authority (the original deployer); regular users get a plain
  // explanation + a disabled early-unstake button so they don't waste fees.
  const stakeMintB58Lower = stakeMint.toBase58();
  const stakeMintIsRewardLine = rewardTokenMints.includes(stakeMintB58Lower);
  const poolAuthorityB58 = pool?.authority?.toBase58?.() || null;
  const isPoolAuthority = !!poolAuthorityB58 && wallet?.publicKey?.toBase58?.() === poolAuthorityB58;
  const earlyUnstakeReady = stakeMintIsRewardLine;

  // Total staked across the pool, expressed as raw atoms (BN.toString())
  // and as a percentage of circulating supply. `pool.totalStaked` is the
  // canonical truth — counts every active position regardless of owner.
  const totalStakedRawStr = pool?.totalStaked?.toString?.() || '0';
  const totalStakedNum = decimals != null ? Number(totalStakedRawStr) / 10 ** decimals : null;
  const supplyNum = decimals != null && supplyRaw ? Number(supplyRaw) / 10 ** decimals : null;
  // Use BigInt for the percentage to preserve precision on 1B-supply tokens.
  let pctOfSupply = null;
  try {
    if (supplyRaw && BigInt(supplyRaw) > 0n) {
      pctOfSupply = Number((BigInt(totalStakedRawStr) * 1_000_000n) / BigInt(supplyRaw)) / 10_000;
    }
  } catch { /* totalStaked or supply not a valid bigint */ }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Stake {tickerLabel}</h3>

        {/* Pool stats — total staked + share of circulating supply */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
            gap: 10,
            margin: '0 0 14px',
            padding: '10px 12px',
            background: '#FAFAFA',
            border: '1px solid #EEE',
            borderRadius: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Total staked
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2 }}>
              {totalStakedNum != null ? fmtCompact(totalStakedNum) : '—'}{' '}
              <span style={{ fontSize: 11, fontWeight: 600, color: '#888' }}>{symbol ? `$${symbol}` : ''}</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              % of supply
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2, color: pctOfSupply != null ? '#0C0C0C' : '#888' }}>
              {pctOfSupply != null ? `${pctOfSupply.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: '#888', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Supply
            </div>
            <div style={{ fontSize: 16, fontWeight: 800, marginTop: 2, color: supplyNum != null ? '#0C0C0C' : '#888' }}>
              {supplyNum != null ? fmtCompact(supplyNum) : '—'}
            </div>
          </div>
        </div>

        <p className="muted" style={{ fontSize: '0.875rem', margin: '0 0 12px' }}>
          Your balance: <strong>{balanceFmt} {symbol ? `$${symbol}` : ''}</strong>
        </p>
        <form onSubmit={onStake} className="form-grid" style={{ gap: 12 }}>
          <div className="form-field">
            <label className="form-label" htmlFor="stake-amt">Amount</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                id="stake-amt"
                className="input"
                style={{ flex: 1 }}
                type="number"
                step="0.000001"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => {
                  if (decimals == null) return;
                  setAmount(fmtAmount(userBalanceRaw, decimals));
                }}
                className="btn-max"
              >
                Max
              </button>
            </div>
          </div>
          <div className="form-field">
            <label className="form-label" htmlFor="stake-lock">Lock</label>
            <select id="stake-lock" className="select" value={lockDays} onChange={(e) => setLockDays(Number(e.target.value))}>
              {LOCK_TIERS.map((t) => (
                <option key={t.days} value={t.days}>{t.label}</option>
              ))}
            </select>
          </div>
          <NewPositionNotice existingCount={positions.length} contextLabel="Staking" />
          <button type="submit" disabled={busy} className="btn-primary" style={{ justifySelf: 'start' }}>
            {busy ? 'Submitting…' : `Stake ${tickerLabel}`}
          </button>
        </form>
      </div>

      {!earlyUnstakeReady && (
        <div
          className="panel panel--tight"
          style={{
            background: isPoolAuthority ? '#FFFBEB' : '#F8FAFC',
            border: `1px solid ${isPoolAuthority ? '#FCD34D' : '#E2E8F0'}`,
          }}
        >
          <h3 className="section-title" style={{ fontSize: '1rem', marginBottom: 6 }}>
            Early unstake disabled
          </h3>
          <p className="muted" style={{ fontSize: '0.8125rem', margin: 0, lineHeight: 1.55 }}>
            This pool was launched before the stake-mint reward line was bundled into the
            initial pool tx. The on-chain program needs that line registered before
            anyone can pay the 10% early-unstake penalty.{' '}
            {isPoolAuthority ? (
              <strong>You&apos;re the pool authority — one click below registers it.</strong>
            ) : (
              <>Holders can still <strong>regular-unstake</strong> after lock expiry. Only the
              pool deployer can enable early unstakes.</>
            )}
          </p>
          {isPoolAuthority && (
            <button
              type="button"
              onClick={onBackfillStakeRewardLine}
              disabled={busy}
              className="btn-primary"
              style={{ marginTop: 12 }}
            >
              {busy ? 'Submitting…' : 'Enable early unstakes'}
            </button>
          )}
        </div>
      )}

      <div className="panel panel--tight">
        <h3 className="section-title" style={{ fontSize: '1.25rem', marginBottom: 8 }}>Your positions</h3>
        {positions.length === 0 && <p className="muted" style={{ fontSize: '0.875rem', margin: 0 }}>No active positions yet.</p>}
        <div style={{ display: 'grid', gap: 12, marginTop: positions.length ? 12 : 0 }}>
          {positions.map((p) => {
            const a = p.account;
            const lockEnd = Number(a.lockEnd?.toString?.() || a.lockEnd || 0);
            const now = Math.floor(Date.now() / 1000);
            const expired = lockEnd > 0 && now >= lockEnd;
            const dec = decimals ?? 9;
            return (
              <div key={p.publicKey.toBase58()} className="position-card">
                <div style={{ fontSize: '0.875rem' }}>
                  Amount: <strong>{fmtAmount(a.amount?.toString?.() || '0', dec)}</strong>
                  {' · '}
                  Lock: <strong>{a.lockDays} days</strong>
                  {' · '}
                  Multiplier: <strong>{(Number(a.multiplierBps || 0) / 10_000).toFixed(2)}×</strong>
                </div>
                <div className="muted" style={{ fontSize: '0.8125rem', marginTop: 4 }}>
                  Ends: {lockEnd ? new Date(lockEnd * 1000).toLocaleString() : '—'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button type="button" onClick={() => onClaim(p)} disabled={busy} className="btn-small">
                    {isSolReward ? 'Claim wSOL → SOL' : `Claim ${rewardLabel}`}
                  </button>
                  {expired ? (
                    <button type="button" onClick={() => onUnstake(p, false)} disabled={busy} className="btn-small">
                      Unstake
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onUnstake(p, true)}
                      disabled={busy || !earlyUnstakeReady}
                      className="btn-small btn-small--danger"
                      title={
                        earlyUnstakeReady
                          ? 'Exit before lock end with a 10% principal penalty (redistributed to remaining stakers).'
                          : 'Early unstake is unavailable until the pool deployer enables it (see banner above).'
                      }
                    >
                      Unstake early (10% penalty)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && <div className="alert alert--error">Error: {error}</div>}
      {lastSig && (
        <div className="alert alert--success mono" style={{ fontSize: '0.8125rem', wordBreak: 'break-all' }}>
          Signature: {lastSig}
        </div>
      )}
    </div>
  );
}
