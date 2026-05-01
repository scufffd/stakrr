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

/**
 * Comma-separated list of fallback RPCs (public — no API key). These are tried
 * in order if the primary returns 429/401/403/5xx. Same idea as the worker's
 * RPC_URL_FALLBACKS but evaluated in the browser for wallet-adapter calls.
 */
const RPC_FALLBACKS = (import.meta.env.VITE_RPC_URL_FALLBACKS || 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com,https://solana.drpc.org')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .filter((u) => u !== RPC_URL);

const FALLBACK_STATUSES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);

/**
 * Build a fetch wrapper that retargets the URL across [primary, ...fallbacks]
 * on retryable errors. Passed to ConnectionProvider via `config.fetch`.
 */
function buildResilientFetch(primary, fallbacks) {
  const endpoints = [primary, ...fallbacks];
  if (endpoints.length === 1) return undefined; // no fallback configured → use default fetch
  return async (input, init) => {
    const requestedUrl = typeof input === 'string' ? input : input?.url || endpoints[0];
    let lastErr = null;
    for (let i = 0; i < endpoints.length; i++) {
      const target = requestedUrl.startsWith(endpoints[0])
        ? endpoints[i] + requestedUrl.slice(endpoints[0].length)
        : endpoints[i];
      try {
        const res = await fetch(target, init);
        if (!FALLBACK_STATUSES.has(res.status) || i === endpoints.length - 1) return res;
        try { await res.arrayBuffer(); } catch { /* drain */ }
      } catch (err) {
        lastErr = err;
        if (i === endpoints.length - 1) throw err;
      }
    }
    throw lastErr || new Error('all RPC endpoints exhausted');
  };
}

function Root() {
  const connectionConfig = useMemo(() => {
    const customFetch = buildResilientFetch(RPC_URL, RPC_FALLBACKS);
    return customFetch ? { commitment: 'confirmed', fetch: customFetch } : { commitment: 'confirmed' };
  }, []);

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
    <ConnectionProvider endpoint={RPC_URL} config={connectionConfig}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <App />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById('root')).render(<Root />);
