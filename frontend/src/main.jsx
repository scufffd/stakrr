import React, { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { WalletAdapterNetwork } from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import {
  CoinbaseWalletAdapter,
  TrustWalletAdapter,
  WalletConnectWalletAdapter,
} from '@solana/wallet-adapter-wallets';
import '@solana/wallet-adapter-react-ui/styles.css';
import './styles/global.css';
import './styles/design-boost.css';
import App from './App.jsx';

const RPC_URL = import.meta.env.VITE_RPC_URL || 'https://api.mainnet-beta.solana.com';

function Root() {
  const wallets = useMemo(() => {
    const list = [
      new CoinbaseWalletAdapter(),
      new TrustWalletAdapter(),
    ];
    const wcProjectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
    if (wcProjectId) {
      list.push(
        new WalletConnectWalletAdapter({
          network: WalletAdapterNetwork.Mainnet,
          options: { projectId: wcProjectId },
        }),
      );
    }
    return list;
  }, []);

  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
