import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import LaunchView from './views/LaunchView.jsx';
import DirectoryView from './views/DirectoryView.jsx';
import PoolView from './views/PoolView.jsx';

const TABS = [
  { id: 'directory', label: 'Pools' },
  { id: 'launch', label: 'Launch' },
];

export default function App() {
  const wallet = useWallet();
  const [tab, setTab] = useState('directory');
  const [selectedMint, setSelectedMint] = useState(null);

  const onSelectPool = useCallback((mint) => {
    setSelectedMint(mint);
    setTab('pool');
  }, []);

  return (
    <div style={shellStyle}>
      <header style={headerStyle}>
        <div style={brandStyle}>
          <span style={{ fontSize: 22, fontWeight: 700 }}>stakrr</span>
          <span style={mutedStyle}>proof of belief launchpad</span>
        </div>
        <nav style={navStyle}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); setSelectedMint(null); }}
              style={tabBtnStyle(tab === t.id)}
            >
              {t.label}
            </button>
          ))}
          <WalletMultiButton style={{ background: '#1a1a25', borderRadius: 8 }} />
        </nav>
      </header>

      <main style={mainStyle}>
        {tab === 'directory' && <DirectoryView onSelectPool={onSelectPool} />}
        {tab === 'launch' && <LaunchView wallet={wallet} onLaunched={onSelectPool} />}
        {tab === 'pool' && selectedMint && <PoolView mint={selectedMint} onBack={() => setTab('directory')} />}
      </main>

      <footer style={footerStyle}>
        <span style={mutedStyle}>built on the pob-index-stake program · pump.fun fees -&gt; stakers</span>
      </footer>
    </div>
  );
}

const shellStyle = {
  minHeight: '100vh',
  display: 'flex',
  flexDirection: 'column',
  maxWidth: 1080,
  margin: '0 auto',
  padding: '0 16px',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '20px 0',
  borderBottom: '1px solid var(--border)',
  flexWrap: 'wrap',
  gap: 12,
};

const brandStyle = { display: 'flex', alignItems: 'baseline', gap: 12 };
const mutedStyle = { color: 'var(--muted)' };
const navStyle = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' };
const mainStyle = { flex: 1, padding: '32px 0' };
const footerStyle = { padding: '16px 0', borderTop: '1px solid var(--border)', color: 'var(--muted)', fontSize: 13 };

function tabBtnStyle(active) {
  return {
    background: active ? 'var(--accent)' : '#1a1a25',
    color: active ? '#0a0a0f' : '#f5f5f7',
    border: '1px solid var(--border)',
    padding: '8px 14px',
    borderRadius: 8,
    cursor: 'pointer',
    fontWeight: active ? 700 : 500,
  };
}
