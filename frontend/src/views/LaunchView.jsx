import React, { useState, useRef, useMemo } from 'react';
import { Buffer } from 'buffer';
import { Transaction, VersionedTransaction } from '@solana/web3.js';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { apiUrl } from '../apiBase.js';
import { confirmWithFallback } from '../lib/confirm.js';
import { estimateBuyImpact } from '../lib/pump-curve.js';
import { RewardLinesPicker, useRewardLinesState } from './RewardLinesPicker.jsx';

const LOCK_TIERS = [
  { days: 1, mult: '1.00×', color: '#94A3B8' },
  { days: 3, mult: '1.25×', color: '#60A5FA' },
  { days: 7, mult: '1.50×', color: '#35C5E0' },
  { days: 14, mult: '2.00×', color: '#7C45F3' },
  { days: 21, mult: '2.50×', color: '#A855F7' },
  { days: 30, mult: '3.00×', color: '#EC4899' },
];

const INP = {
  width: '100%',
  background: 'white',
  border: '1.5px solid #E8E8E8',
  borderRadius: 12,
  padding: '12px 16px',
  fontSize: 14,
  fontFamily: "'Syne', sans-serif",
  outline: 'none',
  boxSizing: 'border-box',
  color: '#0C0C0C',
};

function IconUpload({ size = 22, color = '#35C5E0' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheckCircle({ size = 32, color = 'white' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconExternalLink({ size = 14, color = '#35C5E0' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLoader({ size = 18, color = 'white' }) {
  return (
    <svg
      className="db-spin"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconRocket({ size = 18, color = 'white' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2zM9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PUMPFUN_IPFS_URL = 'https://pump.fun/api/ipfs';

/**
 * Pump.fun often returns 403 for /api/ipfs when the request comes from a server
 * datacenter. The same upload from the user's browser (residential IP) may work.
 * On failure, the launch API falls back to server-side Pinata / pump.
 */
async function tryClientPumpfunMetadata({ name, symbol, description, twitter, telegram, website, imageFile }) {
  const form = new FormData();
  form.append('file', imageFile);
  form.append('name', name.trim());
  form.append('symbol', symbol.trim().toUpperCase());
  form.append('description', description.trim());
  if (twitter.trim()) form.append('twitter', twitter.trim());
  if (telegram.trim()) form.append('telegram', telegram.trim());
  if (website.trim()) form.append('website', website.trim());
  form.append('showName', 'true');
  const res = await fetch(PUMPFUN_IPFS_URL, { method: 'POST', body: form });
  const text = await res.text();
  if (!res.ok) throw new Error(`pump.fun /api/ipfs ${res.status}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error('non-JSON');
  }
  const uri = json.metadataUri || json.metadata_uri || json.uri;
  if (!uri || typeof uri !== 'string' || !uri.startsWith('https://')) {
    throw new Error('missing metadataUri');
  }
  const rawImg = json.metadata?.image || json.image || '';
  const imageUrl =
    typeof rawImg === 'string' && (rawImg.startsWith('https://') || rawImg.startsWith('http://'))
      ? rawImg
      : '';
  return { uri, imageUrl };
}

/**
 * Props:
 *   onLaunched(mint)        — called once the launch finalises on-chain.
 *   inline                  — when true, skip the success screen entirely
 *                             and call onLaunched immediately. Used by the
 *                             admin presale view, which embeds this form
 *                             and chains its own UI off onLaunched.
 *   forceAutoStakeOff       — when true, hide the deployer auto-stake
 *                             checkbox and never auto-stake the deployer.
 *                             The admin presale flow needs this because
 *                             the entire dev-buy bag goes to presale
 *                             contributors, not the deployer.
 *   submitLabel             — optional override for the submit button text
 *                             (e.g. "Launch & auto-stake presale").
 *   gateMessage             — optional message shown above the form
 *                             (e.g. "Step 1: Launch the token").
 */
/**
 * `recoverMint` — when set, this LaunchView renders in recovery mode for
 * a stuck launch (mint exists on-chain but no Stakrr registry row). The
 * user re-enters metadata, signs ONLY the pool-init tx, and we finalize
 * via /api/launch/recover-finalize. Mounted by the parent route via the
 * `?recover=<mint>` query param so users can recover from a fresh page
 * load (no need for in-component state to survive the failure).
 */
export default function LaunchView({
  onLaunched,
  inline = false,
  forceAutoStakeOff = false,
  submitLabel,
  gateMessage,
  recoverMint = null,
}) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const { publicKey, signTransaction, signAllTransactions } = wallet;
  const isRecoverMode = !!recoverMint?.trim();
  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [website, setWebsite] = useState('');
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');
  const [initialBuy, setInitialBuy] = useState('0');
  // Live "% of supply" estimate for the dev's first buy. Pump's bonding
  // curve is fixed at launch, so this is a closed-form calc — purely
  // informational, not validated server-side.
  const initialBuyImpact = useMemo(() => estimateBuyImpact(initialBuy), [initialBuy]);
  const [autoStake, setAutoStake] = useState(false);
  const [lockDays, setLockDays] = useState(7);
  const [rewardMode, setRewardMode] = useState('sol');
  // Launch venue. `pumpfun` = pump.fun bonding curve (default, full feature
  // parity with previous releases). `meteora` = Meteora Dynamic Bonding Curve
  // memecoin preset (3k MC start → 69k MC migration, fees in SOL, all flow
  // to stakers). The two venues are wire-compatible from the staking pool's
  // perspective — only the upstream curve / fee-claim mechanism differs.
  const [launchSource, setLaunchSource] = useState('pumpfun');
  // Multi-reward (advanced): when `rewardLines.enabled` is true, the SOL/Token
  // toggle is informational only and `rewardLines.payload` is sent to the
  // server as the canonical `rewardLines` payload. Each cycle's claimed wSOL
  // fees are split by `weightBps`, then for non-wSOL lines auto-swapped via
  // Jupiter before deposit_rewards. See worker/src/reward-lines.js for the
  // full schema.
  const rewardLines = useRewardLinesState();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const fileRef = useRef(null);

  const walletConnected = !!publicKey;
  const buyAmount = Number(initialBuy || 0);
  const canAutoStake = !forceAutoStakeOff && walletConnected && buyAmount > 0;
  const autoStakeActive = canAutoStake && autoStake;

  const onPickImage = (e) => {
    const f = e.target.files?.[0];
    setImageFile(f || null);
    if (f) setImagePreview(URL.createObjectURL(f));
    else setImagePreview('');
  };

  const submit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      if (!publicKey || !signTransaction || !signAllTransactions) {
        throw new Error('Connect your Solana wallet — you sign and pay all launch transactions');
      }

      // Recovery mode short-circuits the whole create flow. We sign ONLY the
      // pool-init tx (creator wallet is the original launch authority) and
      // ask the worker to verify on-chain state + write the registry row.
      if (isRecoverMode) {
        const rmRecover = rewardMode === 'token' ? 'token' : 'sol';
        if (rewardLines.enabled && !rewardLines.isValid) {
          throw new Error(`Reward split is invalid — weights must sum to 100% (currently ${(rewardLines.totalWeightBps / 100).toFixed(2)}%)`);
        }

        const poolReqBody = {
          creatorWallet: publicKey.toBase58(),
          mint: recoverMint.trim(),
          rewardMode: rmRecover,
        };
        if (rewardLines.enabled) poolReqBody.rewardLines = rewardLines.payload;
        const poolRes = await fetch(apiUrl('/api/launch/pool-tx'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(poolReqBody),
        });
        const poolJson = await poolRes.json();
        if (!poolRes.ok || poolJson.error) {
          throw new Error(poolJson.error || `pool-tx HTTP ${poolRes.status}`);
        }
        const poolTx = Transaction.from(Buffer.from(poolJson.poolRewardTxBase64, 'base64'));
        const signedPool = await signTransaction(poolTx);
        const bhPool = await connection.getLatestBlockhash('confirmed');
        const poolSig = await connection.sendRawTransaction(signedPool.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmWithFallback(
          connection,
          poolSig,
          { blockhash: bhPool.blockhash, lastValidBlockHeight: bhPool.lastValidBlockHeight },
          { commitment: 'confirmed' },
        );

        const persistedMetadata = {
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          description: description.trim(),
          twitter: twitter.trim() || undefined,
          telegram: telegram.trim() || undefined,
          website: website.trim() || undefined,
        };
        const finRes = await fetch(apiUrl('/api/launch/recover-finalize'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mint: recoverMint.trim(),
            creatorWallet: publicKey.toBase58(),
            poolRewardSig: poolSig,
            rewardMode: rmRecover,
            rewardLines: rewardLines.enabled ? rewardLines.payload : null,
            persistedMetadata,
            launchSource: 'meteora', // recovery only supports meteora today
          }),
        });
        const data = await finRes.json();
        if (!finRes.ok || data.error) throw new Error(data.error || `HTTP ${finRes.status}`);
        setResult(data);
        const mint = data.stakeMint || data.mint;
        if (typeof onLaunched === 'function' && mint) {
          if (inline) onLaunched(mint, data);
          else setTimeout(() => onLaunched(mint), 2000);
        }
        return;
      }

      if (!imageFile) throw new Error('Please pick an image for the token');

      // When the deployer leaves website blank we *want* the worker to pin
      // metadata so it can substitute https://stakrr.xyz/token/<mint> as the
      // website. Pre-pinning in the browser would lock in an empty website
      // before the worker knows the mint. So: only pre-pin when the user
      // explicitly typed a website URL.
      let clientPin = null;
      if (website.trim()) {
        try {
          clientPin = await tryClientPumpfunMetadata({
            name,
            symbol,
            description,
            twitter,
            telegram,
            website,
            imageFile,
          });
        } catch {
          /* CORS, 403, or offline — server pins with Pinata / pump */
        }
      }

      const fd = new FormData();
      fd.append('name', name.trim());
      fd.append('symbol', symbol.trim().toUpperCase());
      fd.append('description', description.trim());
      if (twitter.trim()) fd.append('twitter', twitter.trim());
      if (telegram.trim()) fd.append('telegram', telegram.trim());
      if (website.trim()) fd.append('website', website.trim());
      fd.append('initialBuySol', String(Number(initialBuy || 0)));
      fd.append('creatorWallet', publicKey.toBase58());
      if (autoStakeActive) {
        fd.append('autoStake', 'true');
        fd.append('lockDays', String(lockDays));
      }
      fd.append('rewardMode', rewardMode);
      fd.append('launchSource', launchSource);
      // Multi-reward (advanced): when enabled, the worker uses `rewardLines`
      // for both pool init (one add_reward_mint per line) and cycle dispatch
      // (split + Jupiter-swap + deposit per line). `rewardMode` is left in
      // the payload for backwards-compat with the registry primary-mint
      // mirror but is otherwise ignored when `rewardLines` is present.
      if (rewardLines.enabled) {
        if (!rewardLines.isValid) {
          throw new Error(`Reward split is invalid — weights must sum to 100% (currently ${(rewardLines.totalWeightBps / 100).toFixed(2)}%)`);
        }
        fd.append('rewardLines', JSON.stringify(rewardLines.payload));
      }
      if (clientPin) {
        fd.append('metadataUri', clientPin.uri);
        if (clientPin.imageUrl) fd.append('metadataImageUrl', clientPin.imageUrl);
      } else {
        fd.append('image', imageFile);
      }

      const prepRes = await fetch(apiUrl('/api/launch/prepare'), { method: 'POST', body: fd });
      const prep = await prepRes.json();
      if (!prepRes.ok) throw new Error(prep.error || `prepare failed (${prepRes.status})`);

      // Two flows depending on venue:
      //
      //   pumpfun: 1-click bundle — create + lock-fees + pool-init signed in
      //            one Phantom approval, then sent sequentially. Works because
      //            pump.fun's create tx lands in 1-3s, well within the
      //            ~150-slot blockhash window of the bundled pool tx.
      //
      //   meteora: 2-stage signing — sign create alone, send + confirm,
      //            THEN re-fetch a fresh pool tx (with a current blockhash)
      //            and have the user sign that separately. Required because
      //            Meteora's createPool tx is large and can take >30s to
      //            confirm on busy slots, by which time the pool tx's
      //            original blockhash has expired and RPC rejects the
      //            send with "Blockhash not found". Trades 1 extra Phantom
      //            dialog for guaranteed pool-init landing.
      //
      // Pump.fun returns a VersionedTransaction; Meteora returns a legacy
      // Transaction. Branch on `prep.launchSource` so the wallet adapter
      // serialises each correctly.
      const isMeteora = (prep.launchSource || launchSource) === 'meteora';
      const rm = prep.rewardMode || rewardMode;
      let createSig;
      let lockFeesSig = null;
      let poolSig;

      if (isMeteora) {
        // STAGE 1 — sign + send + confirm the create tx alone.
        const createTx = Transaction.from(Buffer.from(prep.createTxBase64, 'base64'));
        const signedCreate = await signTransaction(createTx);
        const bhCreate = await connection.getLatestBlockhash('confirmed');
        createSig = await connection.sendRawTransaction(signedCreate.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmWithFallback(
          connection,
          createSig,
          { blockhash: bhCreate.blockhash, lastValidBlockHeight: bhCreate.lastValidBlockHeight },
          { commitment: 'confirmed' },
        );

        // STAGE 2 — fetch a fresh pool-init tx (current blockhash) and sign it.
        // If something blows up between here and finalize we surface a
        // "Recover failed launch" handle so the user can resume without
        // having to re-create the token.
        const poolReqBody = {
          creatorWallet: publicKey.toBase58(),
          mint: prep.mint,
          rewardMode: rm,
        };
        if (rewardLines.enabled) {
          poolReqBody.rewardLines = rewardLines.payload;
        }
        let poolJson;
        try {
          const poolRes = await fetch(apiUrl('/api/launch/pool-tx'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(poolReqBody),
          });
          poolJson = await poolRes.json();
          if (!poolRes.ok || poolJson.error) {
            throw new Error(poolJson.error || `pool-tx HTTP ${poolRes.status}`);
          }
        } catch (err) {
          throw new Error(
            `Token created (${prep.mint}) but failed to build pool tx: ${err.message}. `
            + `Recover at /launch?recover=${prep.mint}`,
          );
        }
        const poolTx = Transaction.from(Buffer.from(poolJson.poolRewardTxBase64, 'base64'));
        let signedPool;
        try {
          signedPool = await signTransaction(poolTx);
        } catch (err) {
          throw new Error(
            `Token created (${prep.mint}) but pool-init signing was rejected. `
            + `Recover at /launch?recover=${prep.mint}`,
          );
        }
        try {
          const bhPool = await connection.getLatestBlockhash('confirmed');
          poolSig = await connection.sendRawTransaction(signedPool.serialize(), {
            skipPreflight: false,
            maxRetries: 3,
          });
          await confirmWithFallback(
            connection,
            poolSig,
            { blockhash: bhPool.blockhash, lastValidBlockHeight: bhPool.lastValidBlockHeight },
            { commitment: 'confirmed' },
          );
        } catch (err) {
          throw new Error(
            `Token created (${prep.mint}) but pool-init send failed: ${err.message}. `
            + `Recover at /launch?recover=${prep.mint}`,
          );
        }
      } else {
        // Pump.fun bundle path — unchanged.
        const createTx = VersionedTransaction.deserialize(Buffer.from(prep.createTxBase64, 'base64'));
        const lockTx = prep.lockFeesEnabled && prep.lockFeesTxBase64
          ? Transaction.from(Buffer.from(prep.lockFeesTxBase64, 'base64'))
          : null;
        const poolTx = Transaction.from(Buffer.from(prep.poolRewardTxBase64, 'base64'));
        const toSign = [createTx, lockTx, poolTx].filter(Boolean);
        const signed = await signAllTransactions(toSign);
        let cursor = 0;
        const signedCreate = signed[cursor++];
        const signedLock = lockTx ? signed[cursor++] : null;
        const signedPool = signed[cursor++];

        const bhCreate = await connection.getLatestBlockhash('confirmed');
        createSig = await connection.sendRawTransaction(signedCreate.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmWithFallback(
          connection,
          createSig,
          { blockhash: bhCreate.blockhash, lastValidBlockHeight: bhCreate.lastValidBlockHeight },
          { commitment: 'confirmed' },
        );

        if (signedLock) {
          try {
            const bhLock = await connection.getLatestBlockhash('confirmed');
            lockFeesSig = await connection.sendRawTransaction(signedLock.serialize(), {
              skipPreflight: false,
              maxRetries: 3,
            });
            await confirmWithFallback(
              connection,
              lockFeesSig,
              { blockhash: bhLock.blockhash, lastValidBlockHeight: bhLock.lastValidBlockHeight },
              { commitment: 'confirmed' },
            );
          } catch (err) {
            // Don't hard-fail the whole launch — surface a warning so the
            // user knows fees are not yet locked and can retry from the
            // token page. The pool tx still goes through; an unlocked
            // token just keeps the deployer wallet as BC.creator (worker
            // will warn).
            console.warn('[stakrr] lock-fees send failed (continuing):', err);
          }
        }

        const bhPool = await connection.getLatestBlockhash('confirmed');
        poolSig = await connection.sendRawTransaction(signedPool.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await confirmWithFallback(
          connection,
          poolSig,
          { blockhash: bhPool.blockhash, lastValidBlockHeight: bhPool.lastValidBlockHeight },
          { commitment: 'confirmed' },
        );
      }

      let autoStakeSig = null;
      if (autoStakeActive) {
        const nonce = Date.now();
        let lastAsErr = null;
        for (let j = 0; j < 12; j++) {
          try {
            const asRes = await fetch(apiUrl('/api/launch/auto-stake-tx'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                creatorWallet: publicKey.toBase58(),
                mint: prep.mint,
                rewardMode: rm,
                lockDays,
                nonce,
              }),
            });
            const asJson = await asRes.json();
            if (!asRes.ok || asJson.error) {
              lastAsErr = asJson.error || `HTTP ${asRes.status}`;
              await new Promise((r) => setTimeout(r, 800));
              continue;
            }
            const asTx = Transaction.from(Buffer.from(asJson.autoStakeTxBase64, 'base64'));
            const signedAs = await signTransaction(asTx);
            const bhAs = await connection.getLatestBlockhash('confirmed');
            autoStakeSig = await connection.sendRawTransaction(signedAs.serialize(), {
              skipPreflight: false,
              maxRetries: 3,
            });
            await confirmWithFallback(
              connection,
              autoStakeSig,
              { blockhash: bhAs.blockhash, lastValidBlockHeight: bhAs.lastValidBlockHeight },
              { commitment: 'confirmed' },
            );
            break;
          } catch (err) {
            lastAsErr = err.message || String(err);
            await new Promise((r) => setTimeout(r, 800));
          }
        }
        if (!autoStakeSig) throw new Error(lastAsErr || 'Auto-stake failed — you can stake manually from the pool page');
      }

      const finRes = await fetch(apiUrl('/api/launch/finalize'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          createSig,
          lockFeesSig,
          poolRewardSig: poolSig,
          autoStakeSig,
          mint: prep.mint,
          creatorWallet: publicKey.toBase58(),
          rewardMode: rm,
          rewardLines: rewardLines.payload,
          persistedMetadata: prep.persistedMetadata,
          metadataUri: prep.metadataUri,
          metadataSource: prep.metadataSource,
          initialBuySol: prep.initialBuySol ?? Number(initialBuy || 0),
          autoStake: autoStakeActive,
          lockDays,
          launchSource: prep.launchSource || launchSource,
        }),
      });
      const data = await finRes.json();
      if (!finRes.ok || data.error) throw new Error(data.error || `HTTP ${finRes.status}`);
      setResult(data);
      const mint = data.stakeMint || data.mint;
      if (typeof onLaunched === 'function' && mint) {
        // In inline mode (admin presale view) the parent immediately
        // chains into the next step — no 2s "opening your token" delay.
        if (inline) onLaunched(mint, data);
        else setTimeout(() => onLaunched(mint), 2000);
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const launchedMint = result?.stakeMint || result?.mint;

  // Inline mode: skip the success screen entirely. The parent (admin
  // presale view) renders its own combined progress UI.
  if (result && inline) {
    return (
      <div style={{ background: '#ECFDF5', border: '1px solid #BBF7D0', borderRadius: 12, padding: '14px 18px', color: '#065f46' }}>
        <strong>Launched.</strong>{' '}
        <code style={{ fontFamily: "'DM Mono', monospace", fontSize: 13 }}>
          {launchedMint?.slice(0, 6)}…{launchedMint?.slice(-6)}
        </code>{' '}
        — proceeding to presale auto-stake.
      </div>
    );
  }

  if (result) {
    return (
      <div style={{ maxWidth: 520, margin: '0 auto', textAlign: 'center', padding: '24px 0 40px' }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 24,
            background: '#35C5E0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 24px',
          }}
        >
          <IconCheckCircle size={32} color="white" />
        </div>
        <h2
          style={{
            fontWeight: 800,
            fontSize: 32,
            margin: '0 0 16px',
            letterSpacing: '-1px',
            fontFamily: "'Syne', sans-serif",
          }}
        >
          Token launched!
        </h2>
        {launchedMint && (
          <div style={{ background: '#F8F8F8', borderRadius: 12, padding: '12px 16px', marginBottom: 16 }}>
            <p style={{ margin: 0, fontSize: 12, color: '#999', marginBottom: 4 }}>Mint address</p>
            <p style={{ margin: 0, fontFamily: "'DM Mono', monospace", fontSize: 14, fontWeight: 700 }}>
              {launchedMint.slice(0, 4)}…{launchedMint.slice(-4)}
            </p>
          </div>
        )}
        <p style={{ color: '#999', fontSize: 14, margin: '0 0 16px' }}>Opening your token…</p>
        {launchedMint && (
          <a
            href={`https://pump.fun/${launchedMint}`}
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: '#35C5E0',
              fontWeight: 700,
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            View on Pump.fun <IconExternalLink size={14} />
          </a>
        )}

        <details
          style={{
            marginTop: 28,
            textAlign: 'left',
            background: '#FAFAFA',
            borderRadius: 12,
            border: '1px solid #E8E8E8',
            padding: '12px 16px',
          }}
        >
          <summary style={{ fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: "'Syne', sans-serif" }}>
            Transaction details
          </summary>
          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gap: 8,
              wordBreak: 'break-all',
              fontSize: 12,
              fontFamily: "'DM Mono', monospace",
              color: '#444',
            }}
          >
            <div>
              <span style={{ color: '#888' }}>Reward mode: </span>
              <strong>{(result.token || result.pool)?.rewardMode === 'token' ? `$${symbol.toUpperCase() || 'TOKEN'}` : 'SOL'}</strong>
            </div>
            {launchedMint && (
              <div>
                <span style={{ color: '#888' }}>Mint: </span>
                {launchedMint}
              </div>
            )}
            {result.sigs?.create && (
              <div>
                <span style={{ color: '#888' }}>Create: </span>
                {result.sigs.create}
              </div>
            )}
            {result.sigs?.lockFees && (
              <div>
                <span style={{ color: '#888' }}>Fee lock: </span>
                {result.sigs.lockFees}
              </div>
            )}
            {result.feeLock?.shareholders?.[0]?.address && (
              <div>
                <span style={{ color: '#888' }}>Fees → </span>
                {result.feeLock.shareholders[0].address}
                {' '}
                ({(result.feeLock.shareholders[0].shareBps / 100).toFixed(0)}%)
              </div>
            )}
            {result.sigs?.poolInit && (
              <div>
                <span style={{ color: '#888' }}>Staking init: </span>
                {result.sigs.poolInit}
              </div>
            )}
            {result.sigs?.rewardInit && (
              <div>
                <span style={{ color: '#888' }}>Reward: </span>
                {result.sigs.rewardInit}
              </div>
            )}
            {result.sigs?.autoStake && (
              <div>
                <span style={{ color: '#888' }}>Auto-stake: </span>
                {result.sigs.autoStake}
              </div>
            )}
            {result.autoStake?.error && (
              <div style={{ color: '#C62828' }}>
                Auto-stake skipped: {result.autoStake.error} — you can stake manually from the token page.
              </div>
            )}
          </div>
        </details>
      </div>
    );
  }

  const socialFields = [
    { l: 'Twitter', v: twitter, s: setTwitter, p: '@handle or URL' },
    { l: 'Telegram', v: telegram, s: setTelegram, p: 't.me/…' },
    { l: 'Website', v: website, s: setWebsite, p: 'leave blank → stakrr.xyz/token/…' },
  ];

  return (
    <div style={{ maxWidth: 640, margin: inline ? 0 : '0 auto' }}>
      {!inline && !isRecoverMode && (
        <>
          <h2
            style={{
              fontWeight: 800,
              fontSize: 28,
              margin: '0 0 4px',
              letterSpacing: '-0.5px',
              fontFamily: "'Syne', sans-serif",
            }}
          >
            Launch a token
          </h2>
          <p style={{ color: '#888', fontSize: 14, margin: '0 0 32px', fontWeight: 500 }}>
            Deploy to Pump.fun with built-in staking for holders.
          </p>
        </>
      )}
      {!inline && isRecoverMode && (
        <>
          <h2
            style={{
              fontWeight: 800,
              fontSize: 28,
              margin: '0 0 4px',
              letterSpacing: '-0.5px',
              fontFamily: "'Syne', sans-serif",
            }}
          >
            Recover stuck launch
          </h2>
          <p style={{ color: '#888', fontSize: 14, margin: '0 0 16px', fontWeight: 500 }}>
            Your token was created on-chain but the staking pool init transaction
            didn’t land. Sign one transaction to finish setup — no new SOL spent on
            the bonding curve.
          </p>
          <div
            style={{
              padding: '10px 14px',
              background: '#F0F9FF',
              border: '1px solid #BAE6FD',
              borderRadius: 12,
              marginBottom: 20,
              fontSize: 12.5,
              color: '#075985',
              lineHeight: 1.5,
              fontFamily: "'DM Mono', monospace",
              wordBreak: 'break-all',
            }}
          >
            Mint: <strong>{recoverMint}</strong>
          </div>
        </>
      )}
      {gateMessage && (
        <p style={{ color: '#666', fontSize: 13, margin: '0 0 20px', fontFamily: "'DM Mono', monospace" }}>
          {gateMessage}
        </p>
      )}

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {!isRecoverMode && (
        <div>
          <label style={{ display: 'block', fontWeight: 700, fontSize: 14, marginBottom: 8 }}>
            Token image <span style={{ color: 'red' }}>*</span>
          </label>
          <div
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                fileRef.current?.click();
              }
            }}
            onClick={() => fileRef.current?.click()}
            style={{
              position: 'relative',
              border: '2px dashed #E0E0E0',
              borderRadius: 20,
              padding: 40,
              cursor: 'pointer',
              textAlign: 'center',
              background: imagePreview ? 'transparent' : '#FAFAFA',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            {imagePreview ? (
              <img
                src={imagePreview}
                alt="Token preview"
                style={{ width: 96, height: 96, borderRadius: 20, objectFit: 'cover' }}
              />
            ) : (
              <>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 16,
                    background: 'rgba(53,197,224,0.12)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <IconUpload size={22} />
                </div>
                <span style={{ fontSize: 14, color: '#999', fontWeight: 500 }}>Click to upload image</span>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={onPickImage}
              style={{ display: 'none' }}
            />
          </div>
        </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
          <div>
            <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Name *</label>
            <input
              style={INP}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="My Token"
              maxLength={32}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Symbol *</label>
            <input
              style={{ ...INP, fontFamily: "'DM Mono', monospace", textTransform: 'uppercase' }}
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              required
              placeholder="TKN"
              maxLength={10}
            />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Description</label>
          <textarea
            style={{ ...INP, resize: 'none' }}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Describe your token…"
          />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: 10,
          }}
        >
          {socialFields.map((f) => (
            <div key={f.l}>
              <label
                style={{
                  display: 'block',
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#999',
                  marginBottom: 6,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                {f.l}
              </label>
              <input style={INP} type="text" value={f.v} onChange={(e) => f.s(e.target.value)} placeholder={f.p} />
            </div>
          ))}
        </div>

        {!isRecoverMode && (
        <div>
          <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Initial buy (SOL)</label>
          <input
            style={{ ...INP, fontFamily: "'DM Mono', monospace" }}
            type="number"
            value={initialBuy}
            onChange={(e) => setInitialBuy(e.target.value)}
            min={0}
            step={0.01}
            placeholder="0"
          />
          {initialBuyImpact.tokensOut > 0n && (
            <div style={{ marginTop: 6, fontSize: 12, color: '#666', fontFamily: "'DM Mono', monospace" }}>
              {initialBuyImpact.label} <span style={{ color: '#999' }}>· fresh-curve estimate, after Pump's 1% fee</span>
            </div>
          )}
        </div>
        )}

        {!forceAutoStakeOff && !isRecoverMode && (
        <div
          style={{
            border: '1.5px solid',
            borderColor: autoStakeActive ? '#35C5E0' : '#E8E8E8',
            borderRadius: 20,
            padding: 20,
            background: autoStakeActive ? 'rgba(53,197,224,0.04)' : 'white',
            opacity: !canAutoStake ? 0.5 : 1,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: autoStakeActive ? 16 : 0,
            }}
          >
            <div>
              <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>Auto-stake initial buy</p>
              <p style={{ margin: '2px 0 0', fontSize: 13, color: '#999' }}>
                {canAutoStake ? 'Stake tokens immediately on launch' : 'Connect wallet and set initial buy > 0'}
              </p>
            </div>
            <button
              type="button"
              disabled={!canAutoStake}
              onClick={() => setAutoStake((v) => !v)}
              aria-pressed={autoStakeActive}
              style={{
                width: 44,
                height: 24,
                borderRadius: 100,
                border: 'none',
                cursor: canAutoStake ? 'pointer' : 'not-allowed',
                background: autoStake && canAutoStake ? '#35C5E0' : '#E0E0E0',
                position: 'relative',
                transition: 'background 0.2s',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  left: autoStake && canAutoStake ? 22 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'white',
                  boxShadow: '0 1px 4px rgba(0,0,0,0.2)',
                  transition: 'left 0.2s',
                }}
              />
            </button>
          </div>

          {autoStakeActive && (
            <div>
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: '#999',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  marginBottom: 10,
                }}
              >
                Lock duration
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
                {LOCK_TIERS.map((t) => (
                  <button
                    key={t.days}
                    type="button"
                    onClick={() => setLockDays(t.days)}
                    style={{
                      border: '2px solid',
                      borderColor: lockDays === t.days ? t.color : '#E8E8E8',
                      borderRadius: 12,
                      padding: '10px 8px',
                      textAlign: 'center',
                      cursor: 'pointer',
                      background: lockDays === t.days ? t.color : 'white',
                      color: lockDays === t.days ? 'white' : '#555',
                      fontFamily: "'Syne', sans-serif",
                      transition: 'all 0.15s',
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 700 }}>{t.days === 1 ? '1 day' : `${t.days} days`}</div>
                    <div style={{ fontSize: 13, fontFamily: "'DM Mono', monospace" }}>{t.mult}</div>
                  </button>
                ))}
              </div>
              <div
                style={{
                  marginTop: 12,
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
                  <strong>Auto-stake creates a new position</strong> with its own lock timer. You can
                  stake again later from the token page — every stake stays as a separate, independently
                  unstakeable position.{' '}
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
            </div>
          )}
        </div>
        )}

        {!isRecoverMode && (
        <div>
          <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            Launch venue
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
            {[
              { id: 'pumpfun', label: 'Pump.fun', sub: 'Bonding curve · large memecoin audience' },
              { id: 'meteora', label: 'Meteora DBC', sub: 'Memecoin preset · 3k → 69k MC · post-grad fees → stakers' },
            ].map((v) => {
              const isActive = launchSource === v.id;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setLaunchSource(v.id)}
                  style={{
                    flex: '1 1 240px',
                    padding: '12px',
                    borderRadius: 14,
                    border: '2px solid',
                    borderColor: isActive ? '#35C5E0' : '#E8E8E8',
                    background: isActive ? '#35C5E0' : 'white',
                    color: isActive ? 'white' : '#555',
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: 'pointer',
                    fontFamily: "'Syne', sans-serif",
                    textAlign: 'left',
                  }}
                >
                  <div>{v.label}</div>
                  <div style={{ fontSize: 11.5, fontWeight: 500, marginTop: 4, opacity: 0.85 }}>
                    {v.sub}
                  </div>
                </button>
              );
            })}
          </div>
          {launchSource === 'meteora' && (
            <div
              style={{
                padding: '8px 12px',
                background: '#F0F9FF',
                border: '1px solid #BAE6FD',
                borderRadius: 10,
                fontSize: 12,
                color: '#075985',
                marginBottom: 14,
                lineHeight: 1.5,
              }}
            >
              Meteora launches use a Stakrr-owned bonding curve config. 100% of trading
              fees flow back to stakers in SOL, both pre-graduation (partner-fee claim
              on the virtual pool) and post-graduation (locked LP fees on the migrated
              DAMM v2 pool). No fee-lock signature step — the on-chain config enforces it.
            </div>
          )}
        </div>
        )}

        <div>
          <label style={{ display: 'block', fontWeight: 700, fontSize: 13, marginBottom: 8 }}>
            Reward mode {rewardLines.enabled && (
              <span style={{ fontWeight: 500, fontSize: 11, color: '#999' }}>
                — overridden by custom split below
              </span>
            )}
          </label>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {['sol', 'token'].map((m) => {
              // When the custom multi-reward picker is enabled, the SOL/Token
              // toggle is informational only — the active value is ignored
              // by the launch flow. We mute the buttons so users don't
              // think the cyan highlight on "SOL rewards" is fighting their
              // multi-reward setup.
              const isActive = rewardMode === m;
              const muted = rewardLines.enabled;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setRewardMode(m)}
                  disabled={muted}
                  style={{
                    flex: '1 1 200px',
                    padding: '12px',
                    borderRadius: 14,
                    border: '2px solid',
                    borderColor: muted ? '#E8E8E8' : (isActive ? '#35C5E0' : '#E8E8E8'),
                    background: muted ? '#F5F5F5' : (isActive ? '#35C5E0' : 'white'),
                    color: muted ? '#AAA' : (isActive ? 'white' : '#555'),
                    fontWeight: 700,
                    fontSize: 14,
                    cursor: muted ? 'not-allowed' : 'pointer',
                    fontFamily: "'Syne', sans-serif",
                    opacity: muted ? 0.6 : 1,
                  }}
                >
                  {m === 'sol' ? 'SOL rewards' : 'Token rewards'}
                </button>
              );
            })}
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 12, color: '#999', lineHeight: 1.45 }}>
            {rewardLines.enabled
              ? 'Custom split below overrides this mode — fees are auto-swapped via Jupiter into the tokens you pick.'
              : rewardMode === 'sol'
                ? 'Stakers claim native SOL from creator fees (after the 2% platform share).'
                : 'Each cycle swaps remaining fees to your token for staker rewards.'}
          </p>
        </div>

        <RewardLinesPicker {...rewardLines} />

        {error && (
          <div
            style={{
              background: '#FFF0F0',
              border: '1px solid #FFCDD2',
              borderRadius: 12,
              padding: 12,
              fontSize: 13,
              fontFamily: "'DM Mono', monospace",
              color: '#C62828',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !walletConnected || !rewardLines.isValid}
          style={{
            width: '100%',
            padding: '16px',
            background: '#0C0C0C',
            color: 'white',
            border: 'none',
            borderRadius: 16,
            fontWeight: 800,
            fontSize: 16,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
            fontFamily: "'Syne', sans-serif",
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {submitting ? (
            <>
              <IconLoader /> {isRecoverMode ? 'Recovering…' : 'Launching…'}
            </>
          ) : (
            <>
              <IconRocket />
              {' '}
              {isRecoverMode
                ? 'Finish setup'
                : (submitLabel || 'Launch token')}
            </>
          )}
        </button>
        <p style={{ margin: 0, textAlign: 'center', fontSize: 12, color: '#999' }}>
          {isRecoverMode
            ? 'One Phantom approval to initialise the staking pool for your existing token.'
            : 'One Phantom approval covers create + fee lock + staking pool · 100% of creator royalties route on-chain to the Stakrr staking pool via Pump\'s '}
          {!isRecoverMode && (
            <>
              <code style={{ fontFamily: "'DM Mono', monospace" }}>pump_fees</code> program · Fee lock is verifiable on Solscan
            </>
          )}
        </p>
      </form>
    </div>
  );
}
