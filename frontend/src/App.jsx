import React, { useCallback, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import LaunchView from './views/LaunchView.jsx';
import DirectoryView from './views/DirectoryView.jsx';
import PoolView from './views/PoolView.jsx';
import SkyBackground from './components/SkyBackground.jsx';
import CloudFooterWave from './components/CloudFooterWave.jsx';

const TABS = [
  { id: 'directory', label: 'pools' },
  { id: 'launch', label: 'launch' },
];

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
    <>
      <SkyBackground />
      <div className="sky-app-wrapper">
        <div className="app-shell">
          <header className="site-header">
            <div className="site-brand">
              <span className="site-brand__name">stakrr</span>
              <span className="site-brand__tag">
                proof of belief — launch on Pump.fun, stake, route creator fees to holders.
              </span>
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
              <div className="hero__copy">
                <h1 id="hero-heading" className="hero__title">
                  <span className="hero__title-line">proof</span>
                  <span className="hero__title-line hero__title-line--second">of belief</span>
                </h1>
                <p className="hero__lead">
                  <strong>Launch</strong> a Pump.fun token and open a staking pool in one flow.{' '}
                  <strong>Believers</strong> lock the token; creator fees flow back as SOL or as the token itself — flat, legible, on-chain.
                </p>
              </div>
              <aside className="hero__note" aria-label="Summary">
                the discipline of routing pump.fun creator fees to the people who actually hold the line.
              </aside>
            </section>
          )}

          <main className="site-main">
            {tab === 'directory' && <DirectoryView onSelectPool={onSelectPool} />}
            {tab === 'launch' && <LaunchView wallet={wallet} onLaunched={onSelectPool} />}
            {tab === 'pool' && selectedMint && (
              <PoolView mint={selectedMint} onBack={() => setTab('directory')} />
            )}
          </main>
        </div>

        <footer className="sky-footer-block">
          <CloudFooterWave />
          <div className="site-footer">
            <p className="site-footer__quote">
              the new era is about sending fees to humans who stake
              {' '}
              <span style={{ fontStyle: 'italic' }}>human</span>
              .
            </p>
            <p className="site-footer__sub">
              pob-index-stake · Pump.fun creator fees → stakers
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
