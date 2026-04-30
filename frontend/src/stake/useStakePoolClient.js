import { useEffect, useMemo, useState } from 'react';
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { StakeClient, getStakeProgram, makeProvider } from '../staking-sdk/index.js';

const PROGRAM_ID = new PublicKey(
  import.meta.env.VITE_STAKE_PROGRAM_ID || '65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA',
);

function parsePk(value) {
  try { return new PublicKey(value); } catch { return null; }
}

export function useStakePoolClient(stakeMintB58) {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const stakeMint = useMemo(() => parsePk(stakeMintB58), [stakeMintB58]);

  const [stakeTokenProgram, setStakeTokenProgram] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setStakeTokenProgram(null);
    if (!connection || !stakeMint) return undefined;
    (async () => {
      try {
        const info = await connection.getAccountInfo(stakeMint);
        if (cancelled) return;
        if (info?.owner?.equals?.(TOKEN_2022_PROGRAM_ID)) {
          setStakeTokenProgram(TOKEN_2022_PROGRAM_ID);
        } else {
          setStakeTokenProgram(TOKEN_PROGRAM_ID);
        }
      } catch {
        if (!cancelled) setStakeTokenProgram(TOKEN_PROGRAM_ID);
      }
    })();
    return () => { cancelled = true; };
  }, [connection, stakeMint]);

  const ready = !!(connection && wallet && stakeMint && stakeTokenProgram);

  const client = useMemo(() => {
    if (!ready) return null;
    const provider = makeProvider(connection, wallet);
    const program = getStakeProgram(provider, PROGRAM_ID);
    return new StakeClient({ program, programId: PROGRAM_ID, stakeMint, stakeTokenProgram });
  }, [ready, connection, wallet, stakeMint, stakeTokenProgram]);

  return {
    client,
    ready,
    wallet,
    connection,
    programId: PROGRAM_ID,
    stakeMint,
    stakeTokenProgram,
  };
}
