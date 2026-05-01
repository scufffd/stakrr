import React, { useEffect, useMemo, useState } from 'react';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { apiUrl } from '../apiBase.js';
import { confirmWithFallback } from '../lib/confirm.js';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const ERR = '#dc2626';

const VALID_LOCK_DAYS = [1, 3, 7, 14, 21, 30];

function shortPk(s, n = 4) {
  if (!s) return '';
  return `${s.slice(0, n)}…${s.slice(-n)}`;
}

function fmtSol(lamports) {
  if (lamports == null) return '—';
  return (Number(lamports) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
}

async function detectTokenProgram(connection, mintPk) {
  const acc = await connection.getAccountInfo(mintPk);
  if (!acc) throw new Error('mint account not found on chain');
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export default function AdminPresaleView({ initialMint, adminWallet }) {
  const wallet = useWallet();
  const { connection } = useConnection();

  const [mint, setMint] = useState(initialMint || '');
  const [presaleWallet, setPresaleWallet] = useState('AVhaEWooja5nUuihbYNs1oVDHFb2Y3oAZ3bu6SZApAS4');
  const [cutoffSig, setCutoffSig] = useState('5ETwZm7w6Si59i4Qirwqo5desoMgFYhqo4vQuFLQGgJ8Xrfvwr3ZCisc7FuDJ8UNP8qerxFFDEFATHXWxr6fXWcS');
  const [lockDays, setLockDays] = useState(3);
  const [excludeRaw, setExcludeRaw] = useState('');
  const [tokensManualRaw, setTokensManualRaw] = useState('');

  const [scan, setScan] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [tokenInfo, setTokenInfo] = useState(null); // { decimals, atadBalanceRaw, programId }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMsg, setStatusMsg] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0, sigs: [] });

  const isAdmin = useMemo(() => {
    if (!adminWallet || !wallet.publicKey) return false;
    return wallet.publicKey.toBase58() === adminWallet;
  }, [adminWallet, wallet.publicKey]);

  // Refresh dev-buy ATA balance so admin can see the available pool of
  // tokens to distribute.
  async function refreshTokenInfo() {
    try {
      if (!mint || !wallet.publicKey) return;
      const mintPk = new PublicKey(mint.trim());
      const program = await detectTokenProgram(connection, mintPk);
      const mi = await getMint(connection, mintPk, 'confirmed', program);
      const ata = getAssociatedTokenAddressSync(mintPk, wallet.publicKey, false, program);
      let bal = 0n;
      try {
        const a = await getAccount(connection, ata, 'confirmed', program);
        bal = a.amount;
      } catch {
        bal = 0n;
      }
      setTokenInfo({ decimals: mi.decimals, ataBalanceRaw: bal.toString(), programId: program.toBase58() });
    } catch (e) {
      setTokenInfo(null);
      console.warn('[admin-presale] token info refresh failed', e.message);
    }
  }

  useEffect(() => {
    refreshTokenInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mint, wallet.publicKey]);

  function getExcludeWallets() {
    return excludeRaw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function getTokensTotalRaw() {
    if (tokensManualRaw && tokensManualRaw.trim()) return tokensManualRaw.trim();
    if (tokenInfo) return tokenInfo.ataBalanceRaw;
    return null;
  }

  async function adminFetch(path, body) {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-wallet': wallet.publicKey?.toBase58() || '',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  }

  async function onScan() {
    setError('');
    setStatusMsg('');
    setBusy(true);
    setScan(null);
    setPrepared(null);
    try {
      const json = await adminFetch('/api/admin/presale/scan', {
        presaleWallet: presaleWallet.trim(),
        cutoffSignature: cutoffSig.trim(),
        excludeWallets: getExcludeWallets(),
      });
      setScan(json);
      setStatusMsg(`Scanned ${json.scanned} txs · ${json.contributorCount} unique contributors · ${fmtSol(json.totalLamports)} SOL total`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    setError('');
    setStatusMsg('');
    setPrepared(null);
    setBusy(true);
    try {
      const tokensTotalRaw = getTokensTotalRaw();
      if (!tokensTotalRaw || tokensTotalRaw === '0') throw new Error('Need tokens to distribute. Set total manually or wait for ATA balance to load.');
      const json = await adminFetch('/api/admin/presale/auto-stake-prepare', {
        mint: mint.trim(),
        devWallet: wallet.publicKey.toBase58(),
        presaleWallet: presaleWallet.trim(),
        cutoffSignature: cutoffSig.trim(),
        lockDays: Number(lockDays),
        tokenTotalRaw: String(tokensTotalRaw),
        excludeWallets: getExcludeWallets(),
      });
      setPrepared(json);
      setStatusMsg(`Prepared ${json.totals.batchCount} batches for ${json.totals.contributorCount} contributors. Click "Sign & send" to distribute.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function onSignSend() {
    setError('');
    setStatusMsg('');
    setBusy(true);
    setProgress({ done: 0, total: prepared.batches.length, sigs: [] });
    try {
      const txs = prepared.batches.map((b) => Transaction.from(Buffer.from(b.base64, 'base64')));
      const signed = await wallet.signAllTransactions(txs);
      const sigs = [];
      for (let i = 0; i < signed.length; i += 1) {
        const bh = await connection.getLatestBlockhash('confirmed');
        const sig = await connection.sendRawTransaction(signed[i].serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmWithFallback(
          connection,
          sig,
          { blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
          { commitment: 'confirmed' },
        );
        sigs.push({ index: i, signature: sig, beneficiaries: prepared.batches[i].beneficiaries });
        setProgress({ done: i + 1, total: signed.length, sigs: [...sigs] });
      }
      setStatusMsg(`All ${signed.length} batches confirmed. Stakers can now see their positions in /me.`);
      // Refresh ATA balance so admin can see how much they have left.
      refreshTokenInfo();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!wallet.publicKey) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: SUB, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12 }}>Admin · presale auto-stake</h2>
        <p>Connect a wallet to continue.</p>
      </div>
    );
  }

  if (adminWallet && !isAdmin) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: ERR, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12, color: INK }}>Admin · presale auto-stake</h2>
        <p>
          Connected wallet is not the configured admin. Required:{' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>{shortPk(adminWallet)}</code>
        </p>
      </div>
    );
  }

  if (!adminWallet) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: ERR, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12, color: INK }}>Admin · presale auto-stake</h2>
        <p>ADMIN_WALLET is not configured on the worker. Set it in the .env and restart.</p>
      </div>
    );
  }

  const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 };
  const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10, border: '1px solid #e2e2e2', fontFamily: "'DM Mono', monospace", fontSize: 13 };
  const btn = { background: INK, color: '#fff', fontWeight: 800, fontSize: 14, padding: '12px 22px', borderRadius: 100, border: 'none', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 };
  const btnGhost = { background: 'transparent', color: INK, fontWeight: 700, fontSize: 14, padding: '12px 22px', borderRadius: 100, border: '1.5px solid #d4d4d4', cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', fontFamily: "'Syne', sans-serif" }}>
      <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: MUTED, margin: '0 0 12px' }}>Admin only</p>
      <h2 style={{ fontWeight: 800, fontSize: 28, margin: '0 0 8px', letterSpacing: '-0.5px' }}>Presale auto-stake</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: '0 0 28px' }}>
        Scan a presale wallet for inbound SOL since a cutoff tx, then distribute the dev-buy bag pro-rata as on-chain
        staked positions. Each contributor will own their position and can unstake / claim from the normal user UI.
      </p>

      <div style={{ display: 'grid', gap: 14, marginBottom: 18 }}>
        <div>
          <label style={labelStyle}>Token mint (launched via Stakrr)</label>
          <input style={inputStyle} value={mint} onChange={(e) => setMint(e.target.value)} placeholder="<launched mint address>" />
          {tokenInfo && (
            <p style={{ fontSize: 12, color: MUTED, margin: '6px 0 0' }}>
              Your wallet&apos;s ATA balance: <strong style={{ color: INK }}>{(Number(BigInt(tokenInfo.ataBalanceRaw)) / 10 ** tokenInfo.decimals).toLocaleString(undefined, { maximumFractionDigits: tokenInfo.decimals })}</strong>{' '}
              tokens (raw <code style={{ fontFamily: 'DM Mono, monospace' }}>{tokenInfo.ataBalanceRaw}</code>) · decimals {tokenInfo.decimals}
            </p>
          )}
        </div>

        <div>
          <label style={labelStyle}>Presale wallet (receives SOL contributions)</label>
          <input style={inputStyle} value={presaleWallet} onChange={(e) => setPresaleWallet(e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Cutoff signature (inclusive — only contributions at or after this tx count)</label>
          <input style={inputStyle} value={cutoffSig} onChange={(e) => setCutoffSig(e.target.value)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div>
            <label style={labelStyle}>Lock duration</label>
            <select style={{ ...inputStyle, fontFamily: "'Syne', sans-serif" }} value={lockDays} onChange={(e) => setLockDays(Number(e.target.value))}>
              {VALID_LOCK_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d} day{d !== 1 ? 's' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Total tokens to distribute (raw, optional)</label>
            <input style={inputStyle} value={tokensManualRaw} onChange={(e) => setTokensManualRaw(e.target.value)} placeholder="defaults to your ATA balance" />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Exclude wallets (one per line / comma-separated)</label>
          <textarea
            style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
            value={excludeRaw}
            onChange={(e) => setExcludeRaw(e.target.value)}
            placeholder="optional — wallets to skip (e.g. the dev wallet itself if it self-funded)"
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 22 }}>
        <button type="button" style={btnGhost} onClick={onScan} disabled={busy}>
          1 · Scan contributors
        </button>
        <button type="button" style={btnGhost} onClick={onPrepare} disabled={busy || !scan}>
          2 · Prepare allocations
        </button>
        <button type="button" style={btn} onClick={onSignSend} disabled={busy || !prepared}>
          3 · Sign &amp; send
        </button>
      </div>

      {error && (
        <div style={{ background: '#fee2e2', color: ERR, padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>{error}</div>
      )}
      {statusMsg && !error && (
        <div style={{ background: '#ecfdf5', color: '#065f46', padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 13 }}>{statusMsg}</div>
      )}

      {scan && (
        <details open style={{ marginBottom: 18, background: '#fafafa', borderRadius: 12, padding: '14px 18px', border: '1px solid #eee' }}>
          <summary style={{ fontWeight: 800, cursor: 'pointer' }}>Contributors ({scan.contributorCount}) · {fmtSol(scan.totalLamports)} SOL</summary>
          <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Wallet</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>SOL</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>tx#</th>
                </tr>
              </thead>
              <tbody>
                {scan.contributors.map((c) => (
                  <tr key={c.wallet} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'DM Mono, monospace' }}>
                      <a href={`https://solscan.io/account/${c.wallet}`} target="_blank" rel="noreferrer" style={{ color: INK, textDecoration: 'none', borderBottom: `1px dotted ${MUTED}` }}>
                        {shortPk(c.wallet, 6)}
                      </a>
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{fmtSol(c.totalLamports)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: MUTED }}>{c.txCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {prepared && (
        <details open style={{ marginBottom: 18, background: '#fafafa', borderRadius: 12, padding: '14px 18px', border: '1px solid #eee' }}>
          <summary style={{ fontWeight: 800, cursor: 'pointer' }}>
            Allocations ({prepared.totals.contributorCount}) · {prepared.totals.batchCount} txs · lock {prepared.totals.lockDays}d
          </summary>
          <div style={{ marginTop: 12, maxHeight: 320, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: MUTED, textAlign: 'left' }}>
                  <th style={{ padding: '6px 8px' }}>Wallet</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Share %</th>
                  <th style={{ padding: '6px 8px', textAlign: 'right' }}>Tokens (raw)</th>
                </tr>
              </thead>
              <tbody>
                {prepared.allocations.map((a) => (
                  <tr key={a.wallet} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'DM Mono, monospace' }}>{shortPk(a.wallet, 6)}</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>{(a.shareBps / 100).toFixed(2)}%</td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>{a.tokensRaw}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {progress.total > 0 && (
        <div style={{ background: '#FAFAFA', borderRadius: 12, padding: '14px 18px', border: '1px solid #eee', marginBottom: 16 }}>
          <p style={{ margin: 0, fontWeight: 800 }}>
            Confirming batches: {progress.done} / {progress.total}
          </p>
          {progress.sigs.length > 0 && (
            <ul style={{ margin: '10px 0 0', paddingLeft: 20, fontSize: 12, fontFamily: 'DM Mono, monospace' }}>
              {progress.sigs.slice(-5).map((s) => (
                <li key={s.signature}>
                  <a href={`https://solscan.io/tx/${s.signature}`} target="_blank" rel="noreferrer" style={{ color: SKY, textDecoration: 'none' }}>
                    {shortPk(s.signature, 6)} ({s.beneficiaries.length} stakers)
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
