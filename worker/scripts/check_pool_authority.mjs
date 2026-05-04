import { Connection, PublicKey } from '@solana/web3.js';
import { fetchPool, findRewardMintPda } from '../src/stake-program.js';
import { config } from '../src/config.js';

const c = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const STAKE_PROGRAM = new PublicKey('65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA');
const mints = [
  'yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump',
  'FLfR1oidByB8pgX2zy4MqgUH5VsKEoKbKEcgyRKpump',
  '5WgksY8MV7At1dwU12LSvgmiERgqrvB4RbWXzaXpump',
  'C46SZwScp67uF51iNeAvNGnGsto5rumJuNtPk4Epump',
  'pfv6o2p5LzMdVpgwYsNqp9WAyJC9W7DXH5JFT5cpump',
];
for (const mintB58 of mints) {
  const mint = new PublicKey(mintB58);
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from('pool'), mint.toBuffer()], STAKE_PROGRAM);
  const acct = await c.getAccountInfo(pool);
  if (!acct) { console.log(`${mintB58}  pool=NOT FOUND`); continue; }
  // Pool layout: 8 disc + 32 authority + 32 stakeMint + ...
  const authority = new PublicKey(acct.data.subarray(8, 40));
  // Check reward mints (filter by pool offset 9).
  const rewardMints = await c.getProgramAccounts(STAKE_PROGRAM, {
    filters: [
      { dataSize: 209 }, // RewardMint account size verified on-chain
      { memcmp: { offset: 8 + 1, bytes: pool.toBase58() } },
    ],
  });
  // Decode reward mints to find their token mints
  const rewardTokenMints = rewardMints.map(r => {
    // RewardMint struct: bump(u8) + pool(32) + token_mint(32) + ...
    const tokenMint = new PublicKey(r.account.data.subarray(8 + 1 + 32, 8 + 1 + 32 + 32));
    return tokenMint.toBase58();
  });
  const stakeMintRegistered = rewardTokenMints.includes(mintB58);
  console.log(`${mintB58}`);
  console.log(`  pool authority   : ${authority.toBase58()}`);
  console.log(`  reward lines     : ${rewardTokenMints.length}  ${stakeMintRegistered ? '(stake mint REGISTERED ✓)' : '(stake mint MISSING ✗ — early unstake broken)'}`);
  for (const m of rewardTokenMints) {
    const isStake = m === mintB58;
    console.log(`    - ${m}  ${isStake ? '(self - stake mint)' : '(WSOL/quote)'}`);
  }
}
