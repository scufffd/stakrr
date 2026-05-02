// Single-token MM strategy step.
//
// Honest framing: on a Pump.fun bonding curve, every round trip costs ≥2%
// in fees + slippage. Even owning 100% of creator share, the curve's 0.05%
// creator fee per external trade means we'd need ~40× organic copy-volume
// to break even on round-tripping. So this strategy is best understood as
// an ADVERTISING EXPENSE — small, frequent buys that make a chart look
// active and (hopefully) seed organic interest. We track every lamport
// spent so the admin can see the true cost.
//
// Strategy: "subtle ladder + bounded inventory"
//   - Read current token bag (server-side via getAccount on the dev wallet
//     — same vault keypair pattern as the snipe drawer).
//   - If bag <= rebalanceLowerPct of target → buy random [minBuy, maxBuy] SOL.
//   - If bag >= rebalanceUpperPct of target → sell ~50% of overage back.
//   - Otherwise → small random buy ⅔ of the time, small rebalance sell ⅓.
//   - Choose the next interval as random uniform [minInterval, maxInterval]
//     so the buy cadence doesn't look botted.
//
// Kill switches (checked BEFORE every action, NOT after):
//   - Net spent (totalSpent - totalReceived) >= bankrollSol → pause "bankroll"
//   - Drawdown from peak P&L > drawdownPct → pause "drawdown"
//   - maxTradesPerHour exceeded in the last 60min sliding window → skip tick
//
// Returns: { action: 'buy'|'sell'|'wait'|'pause', reason, sig?, error? }

import {
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { getConnection } from '../config.js';
import { sendAndPollConfirm } from '../confirm.js';
import { buildBuyTokenTx, buildTradeTx } from '../pumpdev.js';
import { getKeypairById } from '../snipe/wallet-vault.js';
import { appendTrade, getTokenInternal, noteTick, pauseToken } from './store.js';

function randIn(min, max) {
  if (min >= max) return min;
  return min + Math.random() * (max - min);
}

function randSecondsToMs(minSec, maxSec) {
  return Math.round(randIn(minSec, maxSec) * 1000);
}

async function detectMintProgram(connection, mintPk) {
  const acc = await connection.getAccountInfo(mintPk);
  if (!acc) throw new Error(`mint ${mintPk.toBase58()} not found`);
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (acc.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`mint ${mintPk.toBase58()} owned by ${acc.owner.toBase58()} (not SPL/Token-2022)`);
}

async function readBag(connection, walletPk, mintPk) {
  const programId = await detectMintProgram(connection, mintPk);
  const ata = getAssociatedTokenAddressSync(mintPk, walletPk, false, programId);
  const m = await getMint(connection, mintPk, 'confirmed', programId);
  try {
    const acc = await getAccount(connection, ata, 'confirmed', programId);
    return {
      programId, ata,
      decimals: m.decimals,
      raw: acc.amount,
      ui: Number(acc.amount) / 10 ** m.decimals,
    };
  } catch {
    return {
      programId, ata,
      decimals: m.decimals,
      raw: 0n,
      ui: 0,
    };
  }
}

/** Count trades in the last `windowMs` ms (cheap O(N) scan). */
function recentTradesCount(token, windowMs = 60 * 60_000) {
  const cutoff = Date.now() - windowMs;
  let n = 0;
  for (let i = (token.trades?.length || 0) - 1; i >= 0; i -= 1) {
    const ts = Date.parse(token.trades[i].ts);
    if (Number.isFinite(ts) && ts >= cutoff) n += 1;
    else break;
  }
  return n;
}

/**
 * Check kill switches against current state. Returns reason string if we
 * should pause (and pauses on the spot), or null otherwise.
 */
function maybeTripKillSwitch(token) {
  const cfg = token.config;
  const st = token.state;
  const spent = BigInt(st.totalSpentLamports || '0');
  const received = BigInt(st.totalReceivedLamports || '0');
  const netSpentLamports = spent > received ? spent - received : 0n;
  const bankrollLamports = BigInt(Math.round((cfg.bankrollSol || 0) * LAMPORTS_PER_SOL));
  if (bankrollLamports > 0n && netSpentLamports >= bankrollLamports) {
    pauseToken(token.mint, `bankroll exhausted: net spent ${(Number(netSpentLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL >= ${cfg.bankrollSol} SOL cap`);
    return 'bankroll';
  }
  const peak = BigInt(st.peakPnlLamports || '0');
  const cur = BigInt(st.currentPnlLamports || '0');
  if (peak > 0n && cur < peak) {
    const drawLamports = peak - cur;
    const drawPct = Number(drawLamports * 10_000n / peak) / 100;
    if (drawPct >= (cfg.drawdownPct || 100)) {
      pauseToken(token.mint, `drawdown ${drawPct.toFixed(1)}% from peak >= ${cfg.drawdownPct}% cap`);
      return 'drawdown';
    }
  }
  return null;
}

/**
 * One strategy tick — execute at most one trade for this mint. Caller
 * (the daemon loop) decides timing; this function is purely "given that
 * it's time to act, decide what to do and do it."
 */
export async function strategyStep(mint) {
  const token = getTokenInternal(mint);
  if (!token) return { action: 'wait', reason: 'token not found in mm.json' };
  if (!token.enabled) return { action: 'wait', reason: 'disabled' };

  const trip = maybeTripKillSwitch(token);
  if (trip) return { action: 'pause', reason: trip };

  const cfg = token.config;
  const recent = recentTradesCount(token);
  if (recent >= (cfg.maxTradesPerHour || 30)) {
    noteTick(mint, new Date(Date.now() + 5 * 60_000).toISOString());
    return { action: 'wait', reason: `rate-limit: ${recent} trades in last hour >= ${cfg.maxTradesPerHour}` };
  }

  const connection = getConnection();
  const kp = getKeypairById(token.walletId);
  const mintPk = new PublicKey(mint);

  let bag;
  try {
    bag = await readBag(connection, kp.publicKey, mintPk);
  } catch (e) {
    return { action: 'wait', reason: `bag read failed: ${e.message}` };
  }

  const target = (cfg.targetBagTokens != null && cfg.targetBagTokens > 0)
    ? Number(cfg.targetBagTokens)
    : null;

  // Decide buy vs sell.
  // No target set → bias to buy with light periodic rebalances when bag grows.
  // Target set → enforce upper/lower bands strictly.
  let kind;
  if (target == null) {
    // Without an explicit target, do small buys 70% of the time and sell-to-rebalance 30%.
    kind = bag.ui > 0 && Math.random() < 0.3 ? 'sell' : 'buy';
  } else {
    if (bag.ui <= target * (cfg.rebalanceLowerPct / 100)) {
      kind = 'buy';
    } else if (bag.ui >= target * (cfg.rebalanceUpperPct / 100)) {
      kind = 'sell';
    } else {
      kind = Math.random() < 0.66 ? 'buy' : 'sell';
    }
  }

  const ts = new Date().toISOString();
  let entry;

  if (kind === 'buy') {
    // Don't buy if we'd blow the bankroll on this single trade.
    const spent = BigInt(token.state.totalSpentLamports || '0');
    const received = BigInt(token.state.totalReceivedLamports || '0');
    const netSpentLamports = spent > received ? spent - received : 0n;
    const bankrollLamports = BigInt(Math.round((cfg.bankrollSol || 0) * LAMPORTS_PER_SOL));
    const remainingLamports = bankrollLamports > netSpentLamports ? bankrollLamports - netSpentLamports : 0n;
    if (remainingLamports <= BigInt(Math.round(cfg.minBuySol * LAMPORTS_PER_SOL))) {
      pauseToken(mint, `would exceed bankroll on next buy (remaining ${(Number(remainingLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`);
      return { action: 'pause', reason: 'bankroll-near-exhausted' };
    }
    const maxLamports = BigInt(Math.round(cfg.maxBuySol * LAMPORTS_PER_SOL));
    const cap = remainingLamports < maxLamports ? remainingLamports : maxLamports;
    const minLamports = BigInt(Math.round(cfg.minBuySol * LAMPORTS_PER_SOL));
    if (cap < minLamports) {
      pauseToken(mint, 'remaining bankroll below minBuy');
      return { action: 'pause', reason: 'bankroll-below-minBuy' };
    }
    const sizeLamports = BigInt(Math.round(randIn(Number(minLamports), Number(cap))));
    const sizeSol = Number(sizeLamports) / LAMPORTS_PER_SOL;
    try {
      const tx = await buildBuyTokenTx({
        publicKey: kp.publicKey.toBase58(),
        mint,
        solAmount: sizeSol,
        slippage: cfg.slippage,
        pool: 'auto',
      });
      tx.sign([kp]);
      const sig = await sendAndPollConfirm(connection, tx, { label: 'mm:buy', timeoutMs: 60_000 });
      // Read post-trade bag to compute tokens received.
      let tokensIn = 0n;
      try {
        const post = await readBag(connection, kp.publicKey, mintPk);
        tokensIn = post.raw - bag.raw;
        if (tokensIn < 0n) tokensIn = 0n;
      } catch { /* non-fatal */ }
      entry = {
        ts,
        type: 'buy',
        solSpentLamports: sizeLamports.toString(),
        solReceivedLamports: '0',
        tokensInRaw: tokensIn.toString(),
        tokensOutRaw: '0',
        sig,
        error: null,
      };
      appendTrade(mint, entry);
      return { action: 'buy', sizeSol, sig };
    } catch (e) {
      appendTrade(mint, { ts, type: 'buy', solSpentLamports: '0', solReceivedLamports: '0', tokensInRaw: '0', tokensOutRaw: '0', sig: null, error: e.message });
      return { action: 'buy', error: e.message };
    }
  }

  // SELL
  if (bag.raw <= 0n) {
    return { action: 'wait', reason: 'no bag to sell' };
  }
  // Sell ~30-60% of bag (bounded so we don't dump-and-restart). Tunable later.
  const sellPct = Math.max(20, Math.min(80, Math.round(randIn(30, 60))));
  const sellRaw = (bag.raw * BigInt(sellPct)) / 100n;
  const sellUi = Number(sellRaw) / 10 ** bag.decimals;
  if (sellUi <= 0) {
    return { action: 'wait', reason: 'computed sellUi=0' };
  }
  try {
    const tx = await buildTradeTx({
      publicKey: kp.publicKey.toBase58(),
      action: 'sell',
      mint,
      amount: sellUi,
      denominatedInSol: 'false',
      slippage: cfg.slippage,
      pool: 'auto',
    });
    tx.sign([kp]);
    // Snapshot SOL before to compute received.
    const solBefore = await connection.getBalance(kp.publicKey, 'confirmed');
    const sig = await sendAndPollConfirm(connection, tx, { label: 'mm:sell', timeoutMs: 60_000 });
    const solAfter = await connection.getBalance(kp.publicKey, 'confirmed').catch(() => solBefore);
    // delta is post - pre + tx-fee paid; pumpdev's tx-fee is small, just credit
    // the positive delta. (negative would mean fee > received which we treat as 0)
    const recv = Math.max(0, solAfter - solBefore);
    entry = {
      ts,
      type: 'sell',
      solSpentLamports: '0',
      solReceivedLamports: String(recv),
      tokensInRaw: '0',
      tokensOutRaw: sellRaw.toString(),
      sig,
      error: null,
    };
    appendTrade(mint, entry);
    return { action: 'sell', sellPct, sellUi, sig };
  } catch (e) {
    appendTrade(mint, { ts, type: 'sell', solSpentLamports: '0', solReceivedLamports: '0', tokensInRaw: '0', tokensOutRaw: '0', sig: null, error: e.message });
    return { action: 'sell', error: e.message };
  }
}

/** Compute when this token is next allowed to act (sets nextActionAt). */
export function scheduleNext(mint) {
  const token = getTokenInternal(mint);
  if (!token) return null;
  const ms = randSecondsToMs(token.config.minIntervalSec, token.config.maxIntervalSec);
  const nextAt = new Date(Date.now() + ms).toISOString();
  noteTick(mint, nextAt);
  return nextAt;
}
