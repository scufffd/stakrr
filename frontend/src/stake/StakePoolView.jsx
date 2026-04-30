import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import BN from 'bn.js';
import { LOCK_TIERS } from '../staking-sdk/index.js';
import { useStakePoolClient } from './useStakePoolClient.js';

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
  const [userBalanceRaw, setUserBalanceRaw] = useState('0');
  const [positions, setPositions] = useState([]);
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
        // mint decimals
        const mintInfo = await connection.getParsedAccountInfo(stakeMint);
        if (cancelled) return;
        const dec = mintInfo?.value?.data?.parsed?.info?.decimals ?? 9;
        setDecimals(dec);
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
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
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
      if (isSolReward) {
        // SOL mode: build an ATA-create + claim + close (auto-unwrap to SOL).
        const userWsolAta = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM_ID);
        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, userWsolAta, wallet.publicKey, WSOL, TOKEN_PROGRAM_ID,
        );
        const claimIx = await client.claimIx({
          owner: wallet.publicKey,
          position: position.publicKey,
          rewardTokenMint: WSOL,
          userTokenAccount: userWsolAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        });
        const closeIx = createCloseAccountInstruction(
          userWsolAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID,
        );
        const sig = await sendTx([ataIx, claimIx, closeIx]);
        setLastSig(sig);
      } else {
        // Token mode: rewards are paid in the launched mint itself, so the
        // user's reward ATA is the same as their stake-mint ATA. No unwrap.
        // CRITICAL: pump.fun tokens are Token-2022, so we MUST pass the
        // correct token program (`stakeTokenProgram`) to claimIx so the SDK
        // derives the right vault & user ATA. The SDK's param is
        // `tokenProgram` (not `rewardTokenProgram`); a typo here silently
        // falls back to legacy SPL and the on-chain `vault` account lookup
        // fails with AccountNotInitialized (0xbc4 / 3012).
        const tokenMint = rewardMintPk || stakeMint;
        const tokenProgram = stakeTokenProgram;
        const userAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, tokenProgram);
        const ataIx = createAssociatedTokenAccountIdempotentInstruction(
          wallet.publicKey, userAta, wallet.publicKey, tokenMint, tokenProgram,
        );
        const claimIx = await client.claimIx({
          owner: wallet.publicKey,
          position: position.publicKey,
          rewardTokenMint: tokenMint,
          userTokenAccount: userAta,
          tokenProgram,
        });
        const sig = await sendTx([ataIx, claimIx]);
        setLastSig(sig);
      }
      reload();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }, [client, wallet, reload, sendTx, isSolReward, rewardMintPk, stakeMint, stakeTokenProgram]);

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
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake</h3>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          connect a wallet (top-right) to stake, claim, or unstake.
        </div>
      </div>
    );
  }
  if (!ready) {
    return (
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake</h3>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>resolving stake mint…</div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake</h3>
        <div style={errorStyle}>
          failed to load pool from RPC: {loadError}
        </div>
        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
          if you see &quot;429&quot; or rate-limit errors, set <code>VITE_RPC_URL</code> in
          <code> frontend/.env</code> to a private endpoint (Helius / QuickNode) and reload.
        </div>
        <button onClick={reload} style={{ ...smallBtn, marginTop: 10 }}>retry</button>
      </div>
    );
  }
  if (loadingPool && !pool) {
    return (
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake</h3>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>loading on-chain pool state…</div>
      </div>
    );
  }
  if (!pool) {
    return (
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake</h3>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          this pool isn't initialized on-chain yet. give it a few seconds and refresh.
        </div>
        <button onClick={reload} style={{ ...smallBtn, marginTop: 10 }}>refresh</button>
      </div>
    );
  }

  const balanceFmt = decimals != null ? fmtAmount(userBalanceRaw, decimals) : '—';

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Stake {tickerLabel}</h3>
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          your balance: <strong>{balanceFmt} {symbol ? `$${symbol}` : ''}</strong>
        </div>
        <form onSubmit={onStake} style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <div style={field}>
            <label style={label}>Amount</label>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                style={{ ...input, flex: 1 }}
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
                style={maxBtn}
              >
                max
              </button>
            </div>
          </div>
          <div style={field}>
            <label style={label}>Lock</label>
            <select style={input} value={lockDays} onChange={(e) => setLockDays(Number(e.target.value))}>
              {LOCK_TIERS.map((t) => (
                <option key={t.days} value={t.days}>{t.label}</option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={busy} style={primaryBtn(busy)}>
            {busy ? 'submitting…' : `stake ${tickerLabel}`}
          </button>
        </form>
      </div>

      <div style={panel}>
        <h3 style={{ marginTop: 0 }}>Your positions</h3>
        {positions.length === 0 && <div style={{ color: 'var(--muted)' }}>no active positions yet.</div>}
        <div style={{ display: 'grid', gap: 10 }}>
          {positions.map((p) => {
            const a = p.account;
            const lockEnd = Number(a.lockEnd?.toString?.() || a.lockEnd || 0);
            const now = Math.floor(Date.now() / 1000);
            const expired = lockEnd > 0 && now >= lockEnd;
            const dec = decimals ?? 9;
            return (
              <div key={p.publicKey.toBase58()} style={{ ...panelInset }}>
                <div style={{ fontSize: 13 }}>
                  amount: <strong>{fmtAmount(a.amount?.toString?.() || '0', dec)}</strong>
                  {' · '}
                  lock: <strong>{a.lockDays} days</strong>
                  {' · '}
                  multiplier: <strong>{(Number(a.multiplierBps || 0) / 10_000).toFixed(2)}×</strong>
                </div>
                <div style={{ color: 'var(--muted)', fontSize: 12 }}>
                  ends: {lockEnd ? new Date(lockEnd * 1000).toLocaleString() : '—'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <button onClick={() => onClaim(p)} disabled={busy} style={smallBtn}>
                    {isSolReward ? 'claim wSOL → SOL' : `claim ${rewardLabel}`}
                  </button>
                  {expired ? (
                    <button onClick={() => onUnstake(p, false)} disabled={busy} style={smallBtn}>
                      unstake
                    </button>
                  ) : (
                    <button onClick={() => onUnstake(p, true)} disabled={busy} style={smallBtnDanger}>
                      unstake early (10% penalty)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {error && <div style={errorStyle}>error: {error}</div>}
      {lastSig && <div style={successStyle}>sig: <code>{lastSig}</code></div>}
    </div>
  );
}

const panel = {
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 16,
};

const panelInset = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 12,
};

const field = { display: 'flex', flexDirection: 'column', gap: 6 };
const label = { color: 'var(--muted)', fontSize: 13 };
const input = {
  background: '#1a1a25',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  padding: '10px 12px',
  borderRadius: 8,
  fontSize: 14,
};

function primaryBtn(disabled) {
  return {
    background: disabled ? '#3a3a4a' : 'var(--accent)',
    color: '#0a0a0f',
    border: 'none',
    padding: '10px 16px',
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

const smallBtn = {
  background: '#1a1a25',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  padding: '6px 12px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
};

const maxBtn = {
  background: 'rgba(255,255,255,0.04)',
  color: 'var(--accent)',
  border: '1px solid var(--border)',
  padding: '0 14px',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 700,
};

const smallBtnDanger = {
  ...smallBtn,
  borderColor: '#6a2c2c',
  color: '#ffb4b4',
};

const errorStyle = {
  padding: 12,
  background: '#3a1c1c',
  border: '1px solid #6a2c2c',
  borderRadius: 8,
  color: '#ffb4b4',
  fontSize: 13,
};

const successStyle = {
  padding: 12,
  background: '#1a3a1a',
  border: '1px solid #2c6a2c',
  borderRadius: 8,
  color: '#b4ffb4',
  fontSize: 12,
  wordBreak: 'break-all',
};
