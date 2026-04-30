// pump_fees integration — locks creator fee routing to a fixed recipient set.
//
// Pump's `pump_fees` program (https://github.com/pump-fun/pump-public-docs)
// owns FeeSharingConfig PDAs seeded by ["sharing-config", mint]. After the
// config is created, the BondingCurve.creator field on the Pump BC program is
// migrated from the deployer to that PDA, so creator royalties stop accruing
// to a single wallet and instead flow to the configured shareholders.
//
// This module:
//   * builds the unsigned lock-fees tx (create_fee_sharing_config +
//     update_fee_shares) for a freshly-deployed mint
//   * derives the FeeSharingConfig PDA so the worker can detect locked tokens
//   * builds the distribute_creator_fees ix the worker uses to settle claims
//
// Reference: vendored official IDL at src/idl/pump_fees.json. Anchor IDLs
// describe the struct fields; we hand-build TransactionInstructions to keep
// the dependency surface small (no Anchor Program needed here).

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

export const PUMP_FEES_PROGRAM_ID = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_BC_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
export const PUMP_AMM_PROGRAM_ID = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

// Anchor instruction discriminators (vendored from official IDL).
const IX_CREATE_FEE_SHARING_CONFIG = Buffer.from([195, 78, 86, 76, 111, 52, 251, 213]);
const IX_UPDATE_FEE_SHARES = Buffer.from([189, 13, 136, 99, 187, 164, 237, 35]);
// distribute_creator_fees discriminator confirmed via mainnet tx 2ksJ594Y… (j7 lock).
// Used by the worker to settle creator-fee splits. Not yet implemented here:
// the worker keeps using PumpDev /api/claim-distribute as the entry point until
// we stop depending on PumpDev for that path.

// Anchor account discriminator for FeeSharingConfig (vendored from official IDL via:
// `jq '.accounts[] | select(.name == "FeeSharingConfig")' pump_fees.json`).
// Used by the worker to detect locked tokens cheaply (single getAccountInfo).
export const FEE_SHARING_CONFIG_DISCRIMINATOR = Buffer.from([216, 74, 9, 0, 56, 140, 93, 75]);

const SHARING_CONFIG_SEED = Buffer.from('sharing-config');
const BONDING_CURVE_SEED = Buffer.from('bonding-curve');
const GLOBAL_SEED = Buffer.from('global');
const EVENT_AUTHORITY_SEED = Buffer.from('__event_authority');
const PUMP_CREATOR_VAULT_SEED = Buffer.from('creator-vault');      // pump BC seed
const COIN_CREATOR_VAULT_SEED = Buffer.from('creator_vault');      // pump AMM seed (note underscore)

function findPda(seeds, programId) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

export function findFeeSharingConfigPda(mint) {
  return findPda([SHARING_CONFIG_SEED, mint.toBuffer()], PUMP_FEES_PROGRAM_ID);
}

export function findBondingCurvePda(mint) {
  return findPda([BONDING_CURVE_SEED, mint.toBuffer()], PUMP_BC_PROGRAM_ID);
}

// `global` PDA in the IDL is seeded by ["global"] under the PUMP BC program
// (the IDL bytes [1, 86, 224, ...] decode to 6EF8rrec…), NOT pump_fees.
// Confirmed against j7 lock tx (mainnet 2ksJ594Y…): account index 3 of
// create_fee_sharing_config = 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf,
// which only matches PublicKey.findProgramAddressSync(["global"], PUMP_BC).
// Previously deriving under pump_fees produced RybKkJ… and made every Phantom
// simulation revert (manifested as the "spammed prompts that look like errors"
// UX seen on the IDK launch).
export function findGlobalPda() {
  return findPda([GLOBAL_SEED], PUMP_BC_PROGRAM_ID);
}

export function findFeesEventAuthorityPda() {
  return findPda([EVENT_AUTHORITY_SEED], PUMP_FEES_PROGRAM_ID);
}

export function findPumpEventAuthorityPda() {
  return findPda([EVENT_AUTHORITY_SEED], PUMP_BC_PROGRAM_ID);
}

export function findAmmEventAuthorityPda() {
  return findPda([EVENT_AUTHORITY_SEED], PUMP_AMM_PROGRAM_ID);
}

export function findPumpCreatorVaultPda(sharingConfig) {
  return findPda([PUMP_CREATOR_VAULT_SEED, sharingConfig.toBuffer()], PUMP_BC_PROGRAM_ID);
}

export function findCoinCreatorVaultAuthorityPda(sharingConfig) {
  return findPda([COIN_CREATOR_VAULT_SEED, sharingConfig.toBuffer()], PUMP_AMM_PROGRAM_ID);
}

function findAtaPda(mint, owner) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Build create_fee_sharing_config ix.
 *
 * Per the IDL, only `payer` is a signer. The Pump BC `MigrateBondingCurveCreator`
 * CPI inside this ix runs as the pump_fees program — the deployer's signature
 * is not in the IDL accounts but the j7 lock tx (mainnet 2ksJ594Y…) shows that
 * having the deployer (= current BC creator) sign the outer tx is the safe
 * pattern. The caller should add the deployer as a tx signer if they're not
 * already the payer.
 */
export function buildCreateFeeSharingConfigIx({ payer, mint }) {
  const sharingConfig = findFeeSharingConfigPda(mint);
  const bondingCurve = findBondingCurvePda(mint);
  const global = findGlobalPda();
  const eventAuthority = findFeesEventAuthorityPda();
  const pumpEventAuthority = findPumpEventAuthorityPda();

  // IDL order matters. The trailing 3 accounts (`pool`, `pump_amm_program`,
  // `pump_amm_event_authority`) are marked optional in the IDL but Anchor's
  // generated client still expects a slot for each — passing the pump_fees
  // program id itself signals "None" (j7 uses the same trick: positions
  // 10/11/12 of its create_fee_sharing_config ix are all `pfeeUx…`).
  // Omitting them yields AnchorError 3005 "AccountNotEnoughKeys", which is
  // what Phantom surfaced as the scary failed simulation.
  const keys = [
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: sharingConfig, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: PUMP_BC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false }, // pool = None
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false }, // pump_amm_program = None
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false }, // pump_amm_event_authority = None
  ];

  return new TransactionInstruction({
    programId: PUMP_FEES_PROGRAM_ID,
    keys,
    data: IX_CREATE_FEE_SHARING_CONFIG,
  });
}

/**
 * Encode `Vec<Shareholder>` per Anchor's Borsh layout:
 *   u32 little-endian length, then [pubkey(32) || share_bps(u16)] repeated.
 */
function encodeShareholders(shareholders) {
  const totalBps = shareholders.reduce((acc, s) => acc + s.shareBps, 0);
  if (totalBps !== 10_000) {
    throw new Error(`shareholders share_bps must sum to 10000 (got ${totalBps})`);
  }
  const buf = Buffer.alloc(4 + shareholders.length * (32 + 2));
  buf.writeUInt32LE(shareholders.length, 0);
  let off = 4;
  for (const s of shareholders) {
    s.address.toBuffer().copy(buf, off);
    off += 32;
    buf.writeUInt16LE(s.shareBps, off);
    off += 2;
  }
  return buf;
}

/**
 * Build update_fee_shares ix.
 *
 * `authority` must equal the current update_authority stored on the
 * FeeSharingConfig (set to the payer of create_fee_sharing_config — see j7
 * lock tx for evidence). Updating shares re-derives the pump BC + AMM
 * creator-vault PDAs, so we pass them all even when the AMM ones are unused.
 *
 * Two important deviations from the IDL, both observed on the j7 lock tx
 * (mainnet 2ksJ594Y…):
 *   * `bonding_curve` is writable (IDL says read-only). The on-chain program
 *     does in fact write to it during share migration; tx fails simulation
 *     without this.
 *   * `remaining_accounts` must include `[authority, ...shareholders.address]`
 *     as writable, non-signer accounts. The program iterates these to
 *     credit/move funds to each recipient. Skipping them yields
 *     "AccountNotMutable" or "MissingAccount" sim errors which Phantom
 *     surfaces as "this transaction may fail" — exactly the prompts that
 *     burned the IDK launch.
 */
export function buildUpdateFeeSharesIx({ authority, mint, shareholders }) {
  const sharingConfig = findFeeSharingConfigPda(mint);
  const bondingCurve = findBondingCurvePda(mint);
  const global = findGlobalPda();
  const eventAuthority = findFeesEventAuthorityPda();
  const pumpEventAuthority = findPumpEventAuthorityPda();
  const ammEventAuthority = findAmmEventAuthorityPda();
  const pumpCreatorVault = findPumpCreatorVaultPda(sharingConfig);
  const coinCreatorVaultAuthority = findCoinCreatorVaultAuthorityPda(sharingConfig);
  const coinCreatorVaultAta = findAtaPda(WSOL_MINT, coinCreatorVaultAuthority);

  const keys = [
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEES_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: authority, isSigner: true, isWritable: true },
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: sharingConfig, isSigner: false, isWritable: true },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: pumpCreatorVault, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PUMP_BC_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: pumpEventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ammEventAuthority, isSigner: false, isWritable: false },
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: coinCreatorVaultAuthority, isSigner: false, isWritable: true },
    { pubkey: coinCreatorVaultAta, isSigner: false, isWritable: true },
    // remaining_accounts: [previous recipient, ...new recipients]
    // j7 reference appended [deployer/authority, recipient]; we follow the same
    // ordering. Duplicates with earlier positions are deduplicated by Solana's
    // tx encoder, so listing `authority` twice is safe.
    { pubkey: authority, isSigner: false, isWritable: true },
    ...shareholders.map((s) => ({ pubkey: s.address, isSigner: false, isWritable: true })),
  ];

  const data = Buffer.concat([IX_UPDATE_FEE_SHARES, encodeShareholders(shareholders)]);
  return new TransactionInstruction({ programId: PUMP_FEES_PROGRAM_ID, keys, data });
}

/**
 * Read the on-chain FeeSharingConfig for `mint`, if any. Returns null when
 * the PDA hasn't been allocated (token is not Stakrr-locked).
 *
 * Layout per the j7 mainnet account dump (G7pH…SWW):
 *   [0..8]    discriminator
 *   [8..40]   mint
 *   [40..72]  update_authority
 *   [72..76]  flags / version (u32 LE)
 *   [76..80]  shareholders count (u32 LE)
 *   [80..]    repeating: pubkey(32) || u64-padded share_bps (8 bytes)
 *
 * The on-chain layout pads each share_bps to 8 bytes (likely for forward-compat
 * with bigger share fields). The IDL's Vec<Shareholder> serialization for
 * `update_fee_shares` args still uses tight u16 — they differ.
 */
export async function fetchFeeSharingConfig(connection, mint) {
  const pda = findFeeSharingConfigPda(mint);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info || !info.owner.equals(PUMP_FEES_PROGRAM_ID)) return null;
  const data = info.data;
  if (data.length < 80) return null;
  if (!data.subarray(0, 8).equals(FEE_SHARING_CONFIG_DISCRIMINATOR)) return null;

  const onchainMint = new PublicKey(data.subarray(8, 40));
  const updateAuthority = new PublicKey(data.subarray(40, 72));
  const count = data.readUInt32LE(76);
  const recordSize = 32 + 8;
  const shareholders = [];
  for (let i = 0; i < count; i++) {
    const base = 80 + i * recordSize;
    if (base + recordSize > data.length) break;
    const addr = new PublicKey(data.subarray(base, base + 32));
    const shareBps = data.readUInt16LE(base + 32);
    shareholders.push({ address: addr, shareBps });
  }
  return {
    pda,
    mint: onchainMint,
    updateAuthority,
    shareholders,
  };
}

/**
 * Build an unsigned legacy tx that:
 *   1. create_fee_sharing_config(mint)       — migrates BC.creator → FeeSharingConfig PDA
 *   2. update_fee_shares([{ recipient, 10000 }])  — sets the share table
 *
 * `feePayer` signs as the IDL `payer` of (1) and the `authority` of (2). For
 * Stakrr's Phase 1 lock this is the deployer wallet (= initial authority),
 * matching the j7 lock pattern. The caller is responsible for adding the
 * priority-fee compute budget ix and a recent blockhash if needed.
 */
export function buildLockFeesIxs({ deployer, mint, shareholders }) {
  const ixs = [
    buildCreateFeeSharingConfigIx({ payer: deployer, mint }),
    buildUpdateFeeSharesIx({ authority: deployer, mint, shareholders }),
  ];
  return ixs;
}

export async function buildLockFeesUnsignedTx({
  connection,
  deployer,
  mint,
  shareholders,
  priorityFeeMicroLamports = 0,
}) {
  const tx = new Transaction();
  if (priorityFeeMicroLamports > 0) {
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  }
  for (const ix of buildLockFeesIxs({ deployer, mint, shareholders })) tx.add(ix);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = deployer;
  return { tx, blockhash, lastValidBlockHeight };
}
