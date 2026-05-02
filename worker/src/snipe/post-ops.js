// Post-launch operations on sniper wallets.
//
// All operations are admin-gated and act on a wallet that lives inside the
// vault — the sniper keypair is decrypted server-side, signs the tx, and we
// poll-confirm. The admin UI exposes one button per op:
//
//   sellSniperBag      — pumpdev /api/trade-local sell of X% (or all) tokens
//   transferTokens     — SPL transfer of N tokens to an arbitrary recipient
//   sweepSol           — empty all SOL except a small rent buffer to recipient
//   stakeSniperBag     — wrap the bag into a Stakrr stake position (admin owns it)

import {
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token';
import { getConnection, config } from '../config.js';
import { sendAndPollConfirm, signAndPollConfirm } from '../confirm.js';
import { buildBuyTokenTx, buildTradeTx } from '../pumpdev.js';
import { getKeypairById, listWallets } from './wallet-vault.js';
import { getSnipe, updateSnipeWallet } from './snipe-store.js';

const RENT_BUFFER_LAMPORTS = 5_000; // ~ tx fee allowance, leaves the wallet usable

async function detectTokenProgram(connection, mintPk) {
  const acc = await connection.getAccountInfo(mintPk);
  if (!acc) return TOKEN_PROGRAM_ID;
  if (acc.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/**
 * Read SOL + token holdings for a sniper wallet. Used by the admin UI table.
 */
export async function readSniperHoldings({ walletId, mint }) {
  const all = listWallets();
  const w = all.find((x) => x.id === walletId);
  if (!w) throw new Error(`wallet ${walletId} not in vault`);
  const connection = getConnection();
  const owner = new PublicKey(w.publicKey);
  const out = {
    walletId,
    publicKey: w.publicKey,
    label: w.label,
    sol: 0,
    solLamports: 0,
    mint: mint || null,
    tokens: null,
  };
  const [solInfo, mintAcc] = await Promise.all([
    connection.getAccountInfo(owner, 'confirmed').catch(() => null),
    mint ? connection.getAccountInfo(new PublicKey(mint), 'confirmed').catch(() => null) : null,
  ]);
  out.solLamports = solInfo?.lamports || 0;
  out.sol = out.solLamports / LAMPORTS_PER_SOL;
  if (mint && mintAcc) {
    const mintPk = new PublicKey(mint);
    const programId = mintAcc.owner.equals(TOKEN_2022_PROGRAM_ID)
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID;
    const ata = getAssociatedTokenAddressSync(mintPk, owner, false, programId);
    try {
      const tok = await getAccount(connection, ata, 'confirmed', programId);
      const m = await getMint(connection, mintPk, 'confirmed', programId);
      out.tokens = {
        ata: ata.toBase58(),
        amountRaw: tok.amount.toString(),
        decimals: m.decimals,
        amount: Number(tok.amount) / 10 ** m.decimals,
        programId: programId.toBase58(),
      };
    } catch {
      out.tokens = { ata: ata.toBase58(), amountRaw: '0', decimals: null, amount: 0, programId: programId.toBase58() };
    }
  }
  return out;
}

// ── Sell ─────────────────────────────────────────────────────────────────────

/**
 * Sell tokens from a sniper wallet via pumpdev /api/trade-local.
 *
 * `sellPct` (1–100) — fraction of the wallet's current balance to sell.
 * `slippage` is in percent (NOT bps) — pumpdev expects a number 1–99.
 */
export async function sellSniperBag({
  walletId, mint, sellPct = 100, slippage = 10, pool = 'auto',
}) {
  if (!mint) throw new Error('mint required');
  const pct = Math.max(1, Math.min(100, Number(sellPct) || 100));
  const slip = Math.max(1, Math.min(99, Number(slippage) || 10));
  const connection = getConnection();
  const kp = getKeypairById(walletId);
  const mintPk = new PublicKey(mint);

  const programId = await detectTokenProgram(connection, mintPk);
  const ata = getAssociatedTokenAddressSync(mintPk, kp.publicKey, false, programId);
  const tok = await getAccount(connection, ata, 'confirmed', programId);
  if (tok.amount <= 0n) {
    throw new Error('sniper wallet has no tokens to sell');
  }
  const m = await getMint(connection, mintPk, 'confirmed', programId);
  // PumpDev's trade-local accepts amount as raw token units when denominatedInSol='false'.
  // Convert pct of raw amount to UI tokens (decimals applied) — pumpdev expects float.
  const sellRaw = (tok.amount * BigInt(Math.round(pct))) / 100n;
  const sellUi = Number(sellRaw) / 10 ** m.decimals;
  if (!(sellUi > 0)) throw new Error(`computed sell amount is 0 (raw=${sellRaw}, decimals=${m.decimals})`);

  const tx = await buildTradeTx({
    publicKey: kp.publicKey.toBase58(),
    action: 'sell',
    mint: mintPk.toBase58(),
    amount: sellUi,
    denominatedInSol: 'false',
    slippage: slip,
    pool,
  });
  tx.sign([kp]);
  const sig = await sendAndPollConfirm(connection, tx, {
    label: 'snipe:sell',
    timeoutMs: 60_000,
  });
  return { ok: true, sig, walletId, mint, sellPct: pct, sellRaw: sellRaw.toString(), sellUi };
}

// ── Buy more (top-up, manual market making) ───────────────────────────────────

export async function buyMoreFromSniper({ walletId, mint, solAmount, slippage = 10, pool = 'auto' }) {
  if (!mint) throw new Error('mint required');
  if (!(solAmount > 0)) throw new Error('solAmount must be > 0');
  const slip = Math.max(1, Math.min(99, Number(slippage) || 10));
  const connection = getConnection();
  const kp = getKeypairById(walletId);
  const tx = await buildBuyTokenTx({
    publicKey: kp.publicKey.toBase58(),
    mint,
    solAmount: Number(solAmount),
    slippage: slip,
    pool,
  });
  tx.sign([kp]);
  const sig = await sendAndPollConfirm(connection, tx, {
    label: 'snipe:buy-more',
    timeoutMs: 60_000,
  });
  return { ok: true, sig, walletId, mint, solAmount: Number(solAmount) };
}

// ── Transfer tokens ──────────────────────────────────────────────────────────

/**
 * Transfer raw token units from a sniper wallet to an arbitrary recipient.
 * Auto-creates the recipient ATA if missing.
 */
export async function transferSniperTokens({ walletId, mint, toAddress, amountRaw }) {
  if (!mint || !toAddress) throw new Error('mint and toAddress required');
  const amt = BigInt(amountRaw);
  if (amt <= 0n) throw new Error('amountRaw must be > 0');
  const connection = getConnection();
  const kp = getKeypairById(walletId);
  const mintPk = new PublicKey(mint);
  const toPk = new PublicKey(toAddress);
  const programId = await detectTokenProgram(connection, mintPk);
  const fromAta = getAssociatedTokenAddressSync(mintPk, kp.publicKey, false, programId);
  const toAta = getAssociatedTokenAddressSync(mintPk, toPk, true, programId);
  const fromTok = await getAccount(connection, fromAta, 'confirmed', programId);
  if (fromTok.amount < amt) {
    throw new Error(`insufficient balance: have ${fromTok.amount}, need ${amt}`);
  }
  const m = await getMint(connection, mintPk, 'confirmed', programId);
  const tx = new Transaction();

  // Create destination ATA if absent (payer = sniper)
  const toInfo = await connection.getAccountInfo(toAta).catch(() => null);
  if (!toInfo) {
    tx.add(
      createAssociatedTokenAccountInstruction(
        kp.publicKey,
        toAta,
        toPk,
        mintPk,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
  }

  tx.add(
    createTransferCheckedInstruction(
      fromAta,
      mintPk,
      toAta,
      kp.publicKey,
      amt,
      m.decimals,
      [],
      programId,
    ),
  );

  const sig = await signAndPollConfirm(connection, tx, [kp], {
    label: 'snipe:transfer-tokens',
    timeoutMs: 60_000,
  });
  return { ok: true, sig, walletId, mint, to: toPk.toBase58(), amountRaw: amt.toString() };
}

// ── Sweep SOL ────────────────────────────────────────────────────────────────

/**
 * Sweep SOL from a sniper wallet back to a recipient (defaults to platform
 * treasury). Leaves a small rent buffer so the wallet remains usable.
 */
export async function sweepSniperSol({ walletId, toAddress = null, leaveLamports = RENT_BUFFER_LAMPORTS }) {
  const connection = getConnection();
  const kp = getKeypairById(walletId);
  const recipient = toAddress
    ? new PublicKey(toAddress)
    : config.treasuryKeypair.publicKey;
  const bal = await connection.getBalance(kp.publicKey, 'confirmed');
  const fee = 5000; // tx fee
  const sweep = bal - leaveLamports - fee;
  if (sweep <= 0) {
    throw new Error(`sweep amount ${sweep} lamports is non-positive (balance ${bal})`);
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: recipient,
      lamports: sweep,
    }),
  );
  const sig = await signAndPollConfirm(connection, tx, [kp], {
    label: 'snipe:sweep-sol',
    timeoutMs: 60_000,
  });
  return {
    ok: true,
    sig,
    walletId,
    to: recipient.toBase58(),
    sweptLamports: sweep,
    sweptSol: sweep / LAMPORTS_PER_SOL,
  };
}

// ── Mark a sniper wallet as resolved (UI bookkeeping) ─────────────────────────

export function markSniperResolved({ snipeId, walletId, action }) {
  const snipe = getSnipe(snipeId);
  if (!snipe) throw new Error('snipe not found');
  const ts = new Date().toISOString();
  const patch = {};
  if (action === 'sold') patch.soldAt = ts;
  else if (action === 'swept') patch.sweptAt = ts;
  else if (action === 'transferred') patch.transferredAt = ts;
  else if (action === 'staked') patch.stakedAt = ts;
  else throw new Error(`unknown action ${action}`);
  return updateSnipeWallet(snipeId, walletId, patch);
}
