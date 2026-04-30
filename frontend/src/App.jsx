import React, { useCallback, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import LaunchView from './views/LaunchView.jsx';
import DirectoryView from './views/DirectoryView.jsx';
import PoolView from './views/PoolView.jsx';

const TABS = [
  { id: 'directory', label: 'Pools' },
  { id: 'launch', label: 'Launch' },
];

function HeroGraphic() {
  return (
    <svg
      className="hero__svg"
      viewBox="0 0 400 320"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id="stakrrGradA" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c45c26" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3d5a80" stopOpacity="0.25" />
        </linearGradient>
        <linearGradient id="stakrrGradB" x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#faf8f5" />
          <stop offset="100%" stopColor="#e8e4df" />
        </linearGradient>
      </defs>
      <rect x="40" y="48" width="320" height="224" rx="28" fill="url(#stakrrGradB)" stroke="rgba(20,18,15,0.08)" strokeWidth="1" />
      <ellipse cx="200" cy="260" rx="140" ry="12" fill="rgba(20,18,15,0.04)" />
      <path
        d="M88 200 Q 200 80 312 200"
        stroke="url(#stakrrGradA)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="120" cy="140" r="36" fill="#fff" stroke="rgba(196,92,38,0.35)" strokeWidth="2" />
      <circle cx="280" cy="120" r="28" fill="#fff" stroke="rgba(61,90,128,0.35)" strokeWidth="2" />
      <circle cx="200" cy="200" r="22" fill="#c45c26" opacity="0.9" />
      <path d="M108 132h24M108 148h16" stroke="#c45c26" strokeWidth="3" strokeLinecap="round" />
      <path d="M268 112h20M268 126h14" stroke="#3d5a80" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="168" y="96" width="64" height="40" rx="12" fill="rgba(61,90,128,0.12)" stroke="rgba(61,90,128,0.2)" />
    </svg>
  );
}

export default function App() {
  const wallet = useWallet();
  const [tab, setTab] = useState('directory');
  const [selectedMint, setSelectedMint] = useState(null);

  const onSelectPool = useCallback((mint) => {
    setSelectedMint(mint);
    setTab('pool');
  }, []);

  const showHero = tab === 'directory' || tab === 'launch';

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="site-brand">
          <span className="site-brand__name">stakrr</span>
          <span className="site-brand__tag">proof of belief · Pump.fun launchpad</span>
        </div>
        <nav className="site-nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setTab(t.id);
                setSelectedMint(null);
              }}
              className={`nav-pill${tab === t.id ? ' nav-pill--active' : ''}`}
            >
              {t.label}
            </button>
          ))}
          <WalletMultiButton />
        </nav>
      </header>

      {showHero && (
        <section className="hero" aria-labelledby="hero-heading">
          <div className="hero__graphic">
            <HeroGraphic />
          </div>
          <div className="hero__copy">
            <h1 id="hero-heading" className="hero__title">
              <span className="hero__title-line">proof</span>
              <span className="hero__title-line hero__title-line--accent">of belief</span>
            </h1>
            <p className="hero__lead">
              Launch a token on Pump.fun with a staking pool in one flow. Creator fees route to your
              community — paid as SOL or as your token — while the interface stays bright, legible, and calm.
            </p>
          </div>
        </section>
      )}

      <main className="site-main">
        {tab === 'directory' && <DirectoryView onSelectPool={onSelectPool} />}
        {tab === 'launch' && <LaunchView wallet={wallet} onLaunched={onSelectPool} />}
        {tab === 'pool' && selectedMint && (
          <PoolView mint={selectedMint} onBack={() => setTab('directory')} />
        )}
      </main>

      <footer className="site-footer">
        <span className="muted">
          Built on the pob-index-stake program · Pump.fun creator fees → stakers
        </span>
      </footer>
    </div>
  );
}
