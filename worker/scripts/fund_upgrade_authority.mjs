/**
 * One-shot helper: send 3.5 SOL from the SQWARK POOL_AUTH wallet
 * (Aik2nZeQ…) to the program upgrade authority (bankUKL…) so the v2
 * pob-index-stake upgrade can be deployed.
 *
 * Why we need to do this: pool authority and program upgrade authority
 * are deliberately different keys. We have POOL_AUTH in worker/.env for
 * the SQWARK remediation, and it happens to be funded with the SOL we
 * need. After this transfer:
 *   - Aik2nZeQ… retains ~0.13 SOL (more than enough for the 12-tx
 *     remediation it has to run later)
 *   - bankUKL… holds ~3.5 SOL, of which ~3.2 is reclaimed when the
 *     write-buffer closes after `solana program deploy`. Net permanent
 *     burn for the upgrade is ~0.21 SOL (program-data extend rent).
 *
 * Usage:
 *   node scripts/fund_upgrade_authority.mjs           # dry-run (default)
 *   node scripts/fund_upgrade_authority.mjs --execute # send the tx
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import bs58 from 'bs58';
import 'dotenv/config';

const UPGRADE_AUTHORITY = new PublicKey('bankUKLhk6C4dzMnWopd2umgstLH9Y1oTWAxDw94Cgp');
const TRANSFER_LAMPORTS = Math.floor(3.5 * LAMPORTS_PER_SOL); // 3.5 SOL

const args = new Set(process.argv.slice(2));
const EXECUTE = args.has('--execute');

const RPC = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

function loadPoolAuth() {
  const raw = (process.env.POOL_AUTH || '').trim();
  if (!raw) throw new Error('POOL_AUTH env var missing');
  const secret = bs58.decode(raw);
  if (secret.length !== 64) throw new Error(`POOL_AUTH decoded to ${secret.length} bytes (expected 64)`);
  return Keypair.fromSecretKey(secret);
}

const sender = loadPoolAuth();
console.log(`  RPC:        ${RPC}`);
console.log(`  From:       ${sender.publicKey.toBase58()}  (POOL_AUTH)`);
console.log(`  To:         ${UPGRADE_AUTHORITY.toBase58()}  (program upgrade authority)`);
console.log(`  Amount:     ${TRANSFER_LAMPORTS / LAMPORTS_PER_SOL} SOL`);

const senderBalBefore = await connection.getBalance(sender.publicKey);
const recipientBalBefore = await connection.getBalance(UPGRADE_AUTHORITY);
console.log(`  Sender balance:    ${(senderBalBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log(`  Recipient balance: ${(recipientBalBefore / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

if (senderBalBefore < TRANSFER_LAMPORTS + 5_000) {
  throw new Error(
    `Insufficient sender balance: have ${senderBalBefore} lamports, need ${TRANSFER_LAMPORTS + 5_000}`,
  );
}

if (!EXECUTE) {
  console.log('\n  [DRY-RUN] Re-run with --execute to send.');
  process.exit(0);
}

const tx = new Transaction().add(
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }),
  SystemProgram.transfer({
    fromPubkey: sender.publicKey,
    toPubkey: UPGRADE_AUTHORITY,
    lamports: TRANSFER_LAMPORTS,
  }),
);
tx.feePayer = sender.publicKey;
const { blockhash } = await connection.getLatestBlockhash('confirmed');
tx.recentBlockhash = blockhash;

const sig = await sendAndConfirmTransaction(connection, tx, [sender], {
  commitment: 'confirmed',
});
console.log(`\n  ✓ tx confirmed: ${sig}`);
console.log(`    https://solscan.io/tx/${sig}`);

const recipientBalAfter = await connection.getBalance(UPGRADE_AUTHORITY);
console.log(`\n  Recipient new balance: ${(recipientBalAfter / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log('\n  Ready to deploy:');
console.log('    cd <pob500-repo>/staking-program');
console.log('    ./scripts/deploy_v2_upgrade.sh');
