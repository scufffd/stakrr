// Helpers to wrap native SOL into wSOL (and unwrap on payout).
//
// Pump.fun pays creator fees in native SOL. The staking program rewards mints
// — including wSOL — must be deposited as SPL tokens. This module gives us:
//   - wrapSol(connection, owner, lamports)        -> Promise<{ ata, ixs, signers }>
//   - unwrapAllSol(connection, owner)             -> Promise<TransactionInstruction[]>
//
// The worker calls wrapSol() before deposit_rewards on the wSOL reward vault,
// and the user (or claim_push) handles unwrap on the receiving side via a
// regular closeAccount on the recipient's wSOL ATA when desired.

import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { config } from './config.js';

const WSOL = config.wsolMint;

export async function ensureWsolAtaIxs(payer, owner) {
  const ata = await getAssociatedTokenAddress(WSOL, owner, true);
  const ix = createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, WSOL);
  return { ata, ixs: [ix] };
}

export async function wrapSolIxs({ payer, owner, lamports }) {
  const ata = await getAssociatedTokenAddress(WSOL, owner, true);
  const create = createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, WSOL);
  const transfer = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: ata,
    lamports: BigInt(lamports),
  });
  const sync = createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID);
  return { ata, ixs: [create, transfer, sync] };
}

export async function unwrapAllSolIxs({ owner, payer = owner }) {
  const ata = await getAssociatedTokenAddress(WSOL, owner, true);
  const close = createCloseAccountInstruction(ata, payer, owner, [], TOKEN_PROGRAM_ID);
  return { ata, ixs: [close] };
}

export function wsolMint() {
  return WSOL;
}

export const ATA_PROGRAM_ID = ASSOCIATED_TOKEN_PROGRAM_ID;
