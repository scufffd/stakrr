// Admin-only "Launch + auto-stake presale" view.
//
// One motion:
//   1. Admin fills the presale config (wallet / cutoff sig / lock days / dust min)
//   2. Admin fills the launch form (LaunchView, embedded, with deployer
//      auto-stake disabled — the entire dev-buy bag goes to presalers).
//   3. Admin hits LaunchView's submit button. Once the launch finalises,
//      this view captures the new mint and automatically chains:
//        wait-for-ATA → /scan → /auto-stake-prepare → signAllTransactions
//        → sendRawTransaction + confirmWithFallback per batch.
//
// The "Admin" pill no longer appears in the header — admins reach this
// page directly via /admin/presale.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PublicKey, Transaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { Buffer } from 'buffer';
import { apiUrl } from '../apiBase.js';
import { confirmWithFallback } from '../lib/confirm.js';
import LaunchView from './LaunchView.jsx';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const ERR = '#dc2626';

const VALID_LOCK_DAYS = [1, 3, 7, 14, 21, 30];

// 0.01 SOL in lamports — anything smaller is a wallet ping / fee dust.
const DEFAULT_MIN_TRANSFER_LAMPORTS = 10_000_000;

// Default presale wallet & cutoff signature for this round; admin can
// override either field before launching.
const DEFAULT_PRESALE_WALLET = 'AVhaEWooja5nUuihbYNs1oVDHFb2Y3oAZ3bu6SZApAS4';
const DEFAULT_CUTOFF_SIG =
  '5ETwZm7w6Si59i4Qirwqo5desoMgFYhqo4vQuFLQGgJ8Xrfvwr3ZCisc7FuDJ8UNP8qerxFFDEFATHXWxr6fXWcS';

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
  if (!acc) return TOKEN_PROGRAM_ID;
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

// Poll the dev-buy ATA after launch until the bag has actually credited
// (RPC indexer lag means the ATA may show 0 for a few seconds even after
// finalisation). Returns { decimals, ataBalanceRaw, programId }.
async function waitForDevBuyBag({ connection, mint, owner, attempts = 12, delayMs = 2000 }) {
  const mintPk = new PublicKey(mint);
  const programId = await detectTokenProgram(connection, mintPk);
  const mi = await getMint(connection, mintPk, 'confirmed', programId);
  const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
  for (let i = 0; i < attempts; i += 1) {
    try {
      const a = await getAccount(connection, ata, 'confirmed', programId);
      if (a.amount > 0n) {
        return {
          decimals: mi.decimals,
          ataBalanceRaw: a.amount.toString(),
          programId: programId.toBase58(),
        };
      }
    } catch {
      /* ATA may not exist yet — keep polling */
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return { decimals: mi.decimals, ataBalanceRaw: '0', programId: programId.toBase58() };
}

export default function AdminPresaleView({ adminWallets = [] }) {
  const wallet = useWallet();
  const { connection } = useConnection();

  // Presale config — entered BEFORE launching so the chain runs unattended.
  const [presaleWallet, setPresaleWallet] = useState(DEFAULT_PRESALE_WALLET);
  const [cutoffSig, setCutoffSig] = useState(DEFAULT_CUTOFF_SIG);
  const [lockDays, setLockDays] = useState(3);
  const [excludeRaw, setExcludeRaw] = useState('');
  const [minTransferSol, setMinTransferSol] = useState('0.01');
  // v4: optional per-position early-unstake bps override for the auto-staked
  // presale positions. Empty string = no override (use pool default 10%).
  // Numeric value 0..5000 (capped at 50% by the on-chain program).
  // Bundled in the same browser-signed tx as stake_for, so applying it costs
  // nothing extra in user friction (one signature for both ixs).
  const [earlyUnstakeBpsStr, setEarlyUnstakeBpsStr] = useState('');

  // Live progress state for the chained pipeline.
  const [phase, setPhase] = useState('idle'); // idle | scanning | preparing | signing | sending | done | error
  const [phaseLog, setPhaseLog] = useState([]); // [{ when, msg, level }]
  const [error, setError] = useState('');
  const [launchedMint, setLaunchedMint] = useState('');
  const [scanResult, setScanResult] = useState(null);
  const [prepared, setPrepared] = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0, sigs: [] });

  // Guard against double-firing the chain (LaunchView setTimeout could
  // theoretically fire twice in dev/StrictMode without this).
  const chainStartedRef = useRef(false);

  const isAdmin = useMemo(() => {
    if (!adminWallets.length || !wallet.publicKey) return false;
    return adminWallets.includes(wallet.publicKey.toBase58());
  }, [adminWallets, wallet.publicKey]);

  function appendLog(msg, level = 'info') {
    setPhaseLog((prev) => [...prev, { when: Date.now(), msg, level }]);
  }

  function getExcludeWallets() {
    const list = excludeRaw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Always exclude the dev wallet itself: it can't stake the dev-buy
    // bag for itself, and any "internal" SOL hops to/from it shouldn't
    // count as presale contributions.
    if (wallet.publicKey) list.push(wallet.publicKey.toBase58());
    return Array.from(new Set(list));
  }

  function minTransferLamports() {
    const n = Number(minTransferSol);
    if (!isFinite(n) || n < 0) return DEFAULT_MIN_TRANSFER_LAMPORTS;
    return Math.round(n * 1e9);
  }

  /**
   * Parse the early-unstake bps input. Empty / whitespace = "no override".
   * Returns either an integer 0..5000 or `null` (omit from payload).
   * Throws (caller catches in validation) if the value is non-numeric or
   * outside the allowed range. Accepts either basis-points (e.g. 500 for 5%)
   * or a percent value with a trailing `%` (e.g. `5%`).
   */
  function parseEarlyUnstakeBps(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const isPct = s.endsWith('%');
    const numStr = isPct ? s.slice(0, -1).trim() : s;
    const n = Number(numStr);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error('Early-unstake penalty must be a non-negative number');
    }
    const bps = Math.round(isPct ? n * 100 : n);
    if (bps > 5000) {
      throw new Error('Early-unstake penalty capped at 50% (5000 bps)');
    }
    return bps;
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

  // Validate presale config before allowing the launch button to fire,
  // so we don't burn a launch and then fail at the scan step.
  function validatePresaleConfig() {
    try {
      new PublicKey(presaleWallet.trim());
    } catch {
      throw new Error('Invalid presale wallet address');
    }
    if (cutoffSig.trim().length < 60) {
      throw new Error('Cutoff signature looks too short');
    }
    if (!VALID_LOCK_DAYS.includes(Number(lockDays))) {
      throw new Error('Lock duration must be one of 1, 3, 7, 14, 21, 30');
    }
    // Re-uses parseEarlyUnstakeBps so the same validation message wins.
    parseEarlyUnstakeBps(earlyUnstakeBpsStr);
  }

  // --- Chained pipeline -----------------------------------------------------
  async function runAutoStakeChain(mint) {
    if (chainStartedRef.current) return;
    chainStartedRef.current = true;
    setError('');
    setLaunchedMint(mint);
    appendLog(`Token launched: ${mint}`);
    appendLog('Waiting for dev-buy bag to credit on-chain...');

    try {
      setPhase('scanning');
      const bag = await waitForDevBuyBag({
        connection,
        mint,
        owner: wallet.publicKey,
      });
      if (bag.ataBalanceRaw === '0') {
        throw new Error(
          'Dev-buy bag not credited within timeout — was Initial buy = 0? ' +
            'Set an initial buy on the launch form so the dev wallet has tokens to distribute.',
        );
      }
      appendLog(
        `Dev-buy bag detected: ${(Number(BigInt(bag.ataBalanceRaw)) / 10 ** bag.decimals).toLocaleString(undefined, {
          maximumFractionDigits: bag.decimals,
        })} tokens (raw ${bag.ataBalanceRaw})`,
      );

      appendLog('Scanning presale wallet for inbound SOL since cutoff...');
      const scan = await adminFetch('/api/admin/presale/scan', {
        presaleWallet: presaleWallet.trim(),
        cutoffSignature: cutoffSig.trim(),
        excludeWallets: getExcludeWallets(),
        minTransferLamports: String(minTransferLamports()),
      });
      setScanResult(scan);
      appendLog(
        `Scanned ${scan.scanned} txs · ${scan.contributorCount} contributors · ${fmtSol(scan.totalLamports)} SOL total (after dust filter)`,
      );
      if (scan.contributorCount === 0) {
        throw new Error('No contributors found above the dust threshold — nothing to stake.');
      }

      setPhase('preparing');
      appendLog(`Preparing ${scan.contributorCount} stake_for instructions...`);
      const earlyBps = parseEarlyUnstakeBps(earlyUnstakeBpsStr);
      const prep = await adminFetch('/api/admin/presale/auto-stake-prepare', {
        mint,
        devWallet: wallet.publicKey.toBase58(),
        presaleWallet: presaleWallet.trim(),
        cutoffSignature: cutoffSig.trim(),
        lockDays: Number(lockDays),
        tokenTotalRaw: bag.ataBalanceRaw,
        excludeWallets: getExcludeWallets(),
        minTransferLamports: String(minTransferLamports()),
        ...(earlyBps != null && { earlyUnstakeBps: earlyBps }),
      });
      setPrepared(prep);
      appendLog(
        `Prepared ${prep.totals.batchCount} txs for ${prep.totals.contributorCount} contributors at lock=${prep.totals.lockDays}d`,
      );

      setPhase('signing');
      const txs = prep.batches.map((b) =>
        Transaction.from(Buffer.from(b.base64, 'base64')),
      );
      appendLog(`Asking Phantom to sign all ${txs.length} batches in one prompt...`);
      const signed = await wallet.signAllTransactions(txs);

      setPhase('sending');
      setProgress({ done: 0, total: signed.length, sigs: [] });
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
        sigs.push({ index: i, signature: sig, beneficiaries: prep.batches[i].beneficiaries });
        setProgress({ done: i + 1, total: signed.length, sigs: [...sigs] });
        appendLog(`Batch ${i + 1}/${signed.length} confirmed: ${shortPk(sig, 6)}`);
      }

      setPhase('done');
      appendLog(
        `Done. ${signed.length} batches confirmed. ${prep.totals.contributorCount} contributors now hold staked positions.`,
        'success',
      );
    } catch (e) {
      setPhase('error');
      setError(e.message || String(e));
      appendLog(`Error: ${e.message || String(e)}`, 'error');
      // Allow re-running by resetting the guard once the user fixes the
      // input (e.g. funds the wallet for the rerun signing fees).
      chainStartedRef.current = false;
    }
  }

  // --- Pre-launch validation hook for LaunchView ---------------------------
  // We can't intercept LaunchView's submit, but we can fail-fast in the
  // onLaunched callback; presale config validation runs there too as a
  // last safety net even though the launch already happened. To prevent
  // a wasted launch, render the launch button disabled at the form level
  // by surfacing a validation error above LaunchView.
  let presaleValidationError = '';
  try {
    validatePresaleConfig();
  } catch (e) {
    presaleValidationError = e.message;
  }

  // --- Auth & connect gates ------------------------------------------------
  if (!wallet.publicKey) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: SUB, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12 }}>Admin · launch + presale auto-stake</h2>
        <p>Connect a wallet to continue.</p>
      </div>
    );
  }
  if (adminWallets.length === 0) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: ERR, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12, color: INK }}>Admin · launch + presale auto-stake</h2>
        <p>ADMIN_WALLET is not configured on the worker. Set it in the .env and restart.</p>
      </div>
    );
  }
  if (!isAdmin) {
    return (
      <div style={{ maxWidth: 640, margin: '0 auto', textAlign: 'center', color: ERR, padding: '40px 0' }}>
        <h2 style={{ fontWeight: 800, fontSize: 24, marginBottom: 12, color: INK }}>Admin · launch + presale auto-stake</h2>
        <p>
          Connected wallet is not in the admin list. Allowed admin{adminWallets.length === 1 ? '' : 's'}:{' '}
          {adminWallets.map((w, i) => (
            <React.Fragment key={w}>
              {i > 0 && ', '}
              <code style={{ fontFamily: 'DM Mono, monospace' }}>{shortPk(w)}</code>
            </React.Fragment>
          ))}
        </p>
      </div>
    );
  }

  const labelStyle = {
    display: 'block',
    fontSize: 12,
    fontWeight: 700,
    color: MUTED,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 6,
  };
  const inputStyle = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #e2e2e2',
    fontFamily: "'DM Mono', monospace",
    fontSize: 13,
  };

  const sectionCard = {
    background: 'white',
    border: '1px solid #eee',
    borderRadius: 16,
    padding: '20px 22px',
    marginBottom: 18,
  };

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', fontFamily: "'Syne', sans-serif" }}>
      <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: MUTED, margin: '0 0 12px' }}>
        Admin only
      </p>
      <h2 style={{ fontWeight: 800, fontSize: 28, margin: '0 0 8px', letterSpacing: '-0.5px' }}>
        Launch + auto-stake presale
      </h2>
      <p style={{ color: MUTED, fontSize: 14, margin: '0 0 28px' }}>
        Fill the presale config, then launch. Once the launch finalises, the dev-buy bag
        is automatically distributed pro-rata to all wallets that funded the presale wallet
        since the cutoff signature, as on-chain staked positions they own.
      </p>

      {/* ---------------- Step 1: Presale config ---------------- */}
      <div style={sectionCard}>
        <p style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 12px' }}>
          Step 1 · Presale configuration
        </p>

        <div style={{ display: 'grid', gap: 14 }}>
          <div>
            <label style={labelStyle}>Presale wallet (where contributors sent SOL)</label>
            <input style={inputStyle} value={presaleWallet} onChange={(e) => setPresaleWallet(e.target.value)} />
          </div>

          <div>
            <label style={labelStyle}>Cutoff signature (only count contributions at or after this tx)</label>
            <input style={inputStyle} value={cutoffSig} onChange={(e) => setCutoffSig(e.target.value)} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={labelStyle}>Lock duration</label>
              <select
                style={{ ...inputStyle, fontFamily: "'Syne', sans-serif" }}
                value={lockDays}
                onChange={(e) => setLockDays(Number(e.target.value))}
              >
                {VALID_LOCK_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d} day{d !== 1 ? 's' : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelStyle}>Min transfer (SOL) · dust filter</label>
              <input
                style={inputStyle}
                value={minTransferSol}
                onChange={(e) => setMinTransferSol(e.target.value)}
                placeholder="0.01"
                inputMode="decimal"
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>Exclude wallets (comma / newline separated · dev wallet is auto-excluded)</label>
            <textarea
              style={{ ...inputStyle, minHeight: 60, resize: 'vertical' }}
              value={excludeRaw}
              onChange={(e) => setExcludeRaw(e.target.value)}
              placeholder="optional — extra wallets to skip (e.g. team / treasury / market-maker)"
            />
          </div>

          {/*
            v4 per-position early-unstake penalty override. Empty = leave at
            the pool default (10%). Bundled with stake_for in the same browser
            signature, so applying it costs zero additional UX friction. Cap
            of 5000 bps is enforced both client-side (this function) and
            on-chain (MAX_EARLY_UNSTAKE_BPS).
          */}
          <div>
            <label style={labelStyle}>
              Early-unstake penalty override · presale positions <span style={{ color: SUB, fontWeight: 400 }}>(optional)</span>
            </label>
            <input
              style={inputStyle}
              value={earlyUnstakeBpsStr}
              onChange={(e) => setEarlyUnstakeBpsStr(e.target.value)}
              placeholder="leave blank for pool default (10%) · e.g. 500 for 5% or '5%' for 5%"
              inputMode="decimal"
            />
            <div style={{ marginTop: 6, fontSize: 11.5, color: SUB, lineHeight: 1.5 }}>
              Applied to <strong>presale-staked positions only</strong> when a contributor unstakes
              before their lock expires. Penalty redistributes to remaining stakers via the
              stake-mint reward line. Capped at 50% (5000 bps). Existing stakes from prior
              launches are unaffected.
            </div>
          </div>
        </div>

        {presaleValidationError && (
          <div style={{ marginTop: 14, background: '#fff7ed', color: '#9a3412', padding: '10px 14px', borderRadius: 10, fontSize: 13 }}>
            Fix before launching: {presaleValidationError}
          </div>
        )}
      </div>

      {/* ---------------- Step 2: Launch token ---------------- */}
      <div style={sectionCard}>
        <p style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 12px' }}>
          Step 2 · Launch the token
        </p>
        <p style={{ fontSize: 13, color: SUB, margin: '0 0 14px' }}>
          Set <strong>Initial buy</strong> &gt; 0 — that&apos;s the bag distributed to presale contributors.
          Auto-stake-for-deployer is disabled in this mode (the entire bag goes to presalers).
        </p>
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
            margin: '0 0 18px',
          }}
        >
          <span aria-hidden style={{ fontSize: 14, lineHeight: 1, flexShrink: 0, marginTop: 1 }}>i</span>
          <div>
            <strong>Each contributor receives a new position</strong> with its own lock timer
            (default {lockDays} day{lockDays === 1 ? '' : 's'}). Contributors can stake more tokens
            themselves later from the token page — every stake stays as an independently
            unstakeable position alongside what we auto-stake here.{' '}
            <details style={{ display: 'inline' }}>
              <summary style={{ display: 'inline', cursor: 'pointer', textDecoration: 'underline', color: '#0369A1' }}>
                Why?
              </summary>
              <span style={{ display: 'block', marginTop: 6, color: '#0369A1' }}>
                Each stake locks tokens with its own timer — re-staking never extends an existing lock,
                so this auto-stake doesn&apos;t collide with any positions a contributor already holds.
                Their new presale position will sit alongside any prior ones, each with its own
                independent unlock date.
              </span>
            </details>
          </div>
        </div>
        <LaunchView
          inline
          forceAutoStakeOff
          submitLabel="Launch + auto-stake presale"
          onLaunched={(mint) => runAutoStakeChain(mint)}
        />
      </div>

      {/* ---------------- Live progress ---------------- */}
      {(phase !== 'idle' || phaseLog.length > 0) && (
        <div style={sectionCard}>
          <p style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: '0.1em', textTransform: 'uppercase', margin: '0 0 12px' }}>
            Live progress
          </p>
          <p style={{ margin: '0 0 10px', fontWeight: 800, fontSize: 15 }}>
            Phase: <span style={{ color: phase === 'error' ? ERR : phase === 'done' ? '#15803d' : SKY }}>{phase}</span>
            {launchedMint && (
              <>
                {' · '}
                <a
                  href={`https://stakrr.xyz/token/${launchedMint}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: SKY, textDecoration: 'none', fontFamily: 'DM Mono, monospace', fontSize: 13 }}
                >
                  {shortPk(launchedMint, 6)}
                </a>
              </>
            )}
          </p>
          {progress.total > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(progress.done / progress.total) * 100}%`,
                    background: phase === 'error' ? ERR : SKY,
                    transition: 'width 0.2s',
                  }}
                />
              </div>
              <p style={{ margin: '6px 0 0', fontSize: 12, color: MUTED }}>
                Confirmed {progress.done} / {progress.total} batches
              </p>
            </div>
          )}
          {error && (
            <div style={{ background: '#fee2e2', color: ERR, padding: '10px 14px', borderRadius: 10, marginBottom: 12, fontSize: 13 }}>
              {error}
            </div>
          )}
          {phaseLog.length > 0 && (
            <ul
              style={{
                margin: 0,
                padding: 0,
                listStyle: 'none',
                fontSize: 12.5,
                fontFamily: "'DM Mono', monospace",
                background: '#fafafa',
                border: '1px solid #eee',
                borderRadius: 10,
                maxHeight: 220,
                overflowY: 'auto',
              }}
            >
              {phaseLog.map((l, idx) => (
                <li
                  key={idx}
                  style={{
                    padding: '6px 12px',
                    borderTop: idx === 0 ? 'none' : '1px solid #f0f0f0',
                    color: l.level === 'error' ? ERR : l.level === 'success' ? '#15803d' : SUB,
                  }}
                >
                  {l.msg}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ---------------- Scan & allocation breakdowns (collapsible) ---------------- */}
      {scanResult && (
        <details style={sectionCard}>
          <summary style={{ fontWeight: 800, cursor: 'pointer' }}>
            Contributors ({scanResult.contributorCount}) · {fmtSol(scanResult.totalLamports)} SOL
          </summary>
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
                {scanResult.contributors.map((c) => (
                  <tr key={c.wallet} style={{ borderTop: '1px solid #eee' }}>
                    <td style={{ padding: '6px 8px', fontFamily: 'DM Mono, monospace' }}>
                      <a
                        href={`https://solscan.io/account/${c.wallet}`}
                        target="_blank"
                        rel="noreferrer"
                        style={{ color: INK, textDecoration: 'none', borderBottom: `1px dotted ${MUTED}` }}
                      >
                        {shortPk(c.wallet, 6)}
                      </a>
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontFamily: 'DM Mono, monospace' }}>
                      {fmtSol(c.totalLamports)}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', color: MUTED }}>{c.txCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {prepared && (
        <details style={sectionCard}>
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
    </div>
  );
}
