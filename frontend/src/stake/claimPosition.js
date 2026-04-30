import { PublicKey, Transaction } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  StakeClient,
  DEFAULT_PROGRAM_ID,
  detectMintTokenProgram,
  getStakeProgram,
  makeProvider,
} from '../staking-sdk/index.js';

const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

/**
 * Same claim path as StakePoolView: wSOL claim + close for SOL pools, or token ATA + claim for token rewards.
 * @param {import('@solana/web3.js').Connection} connection
 * @param {import('@coral-xyz/anchor').Wallet} wallet Anchor wallet (useAnchorWallet)
 * @param {(tx: Transaction) => Promise<Transaction>} signTransaction usually from useWallet().signTransaction
 */
export async function claimPositionRewards({
  connection,
  wallet,
  signTransaction,
  stakeMintB58,
  rewardMode,
  rewardMintB58,
  positionB58,
  programId = DEFAULT_PROGRAM_ID,
}) {
  if (!wallet?.publicKey) throw new Error('wallet not connected');
  if (!signTransaction) throw new Error('wallet cannot sign transactions');

  const stakeMint = new PublicKey(stakeMintB58);
  const stakeTokenProgram = await detectMintTokenProgram(connection, stakeMint);
  const provider = makeProvider(connection, wallet);
  const program = getStakeProgram(provider, programId);
  const client = new StakeClient({ program, programId, stakeMint, stakeTokenProgram });
  const position = new PublicKey(positionB58);
  const isSolReward = rewardMode !== 'token';

  let rewardMintPk = null;
  if (rewardMintB58) {
    try {
      rewardMintPk = new PublicKey(rewardMintB58);
    } catch {
      rewardMintPk = null;
    }
  }

  const ixs = [];
  if (isSolReward) {
    const userWsolAta = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, false, TOKEN_PROGRAM_ID);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userWsolAta,
        wallet.publicKey,
        WSOL,
        TOKEN_PROGRAM_ID,
      ),
    );
    ixs.push(
      await client.claimIx({
        owner: wallet.publicKey,
        position,
        rewardTokenMint: WSOL,
        userTokenAccount: userWsolAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      }),
    );
    ixs.push(
      createCloseAccountInstruction(userWsolAta, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID),
    );
  } else {
    const tokenMint = rewardMintPk || stakeMint;
    const tokenProgram = stakeTokenProgram;
    const userAta = getAssociatedTokenAddressSync(tokenMint, wallet.publicKey, false, tokenProgram);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey,
        userAta,
        wallet.publicKey,
        tokenMint,
        tokenProgram,
      ),
    );
    ixs.push(
      await client.claimIx({
        owner: wallet.publicKey,
        position,
        rewardTokenMint: tokenMint,
        userTokenAccount: userAta,
        tokenProgram,
      }),
    );
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction();
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = blockhash;
  for (const ix of ixs) tx.add(ix);
  const signed = await signTransaction(tx);
  const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return sig;
}
