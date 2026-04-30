import React, { useCallback, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import { useWallet } from '@solana/wallet-adapter-react';
import LaunchView from './views/LaunchView.jsx';
import PoolView from './views/PoolView.jsx';
import UserDashboardView from './views/UserDashboardView.jsx';
import DocsPage from './views/DocsPage.jsx';
import HomePage from './components/designBoost/HomePage.jsx';
import BluebirdMark from './components/designBoost/BluebirdMark.jsx';
import Cloud, { CloudStrip } from './components/designBoost/Cloud.jsx';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const WHITE = '#FFFFFF';
const GITHUB = import.meta.env.VITE_GITHUB_URL || 'https://github.com/scufffd';

function NavPill({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? INK : 'rgba(0,0,0,0.1)',
        color: active ? WHITE : INK,
        border: 'none',
        borderRadius: 100,
        padding: '8px 14px',
        fontWeight: 700,
        fontSize: 13,
        cursor: 'pointer',
        fontFamily: "'Syne', sans-serif",
        transition: 'all 0.15s',
        backdropFilter: 'blur(8px)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function Nav({ tab, onHome, onLaunch, onProfile, onDocs, position }) {
  return (
    <nav
      className="db-nav"
      style={{
        position,
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '22px 48px',
      }}
    >
      <button
        type="button"
        onClick={onHome}
        aria-label="Stakrr home"
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <BluebirdMark size={36} alt="" />
        <span style={{ fontWeight: 800, fontSize: 20, color: INK, letterSpacing: '-0.5px' }}>stakrr</span>
      </button>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 6, flex: 1 }}>
        <NavPill active={tab === 'home'} onClick={onHome}>
          Tokens
        </NavPill>
        <NavPill active={tab === 'launch'} onClick={onLaunch}>
          Launch
        </NavPill>
        <NavPill active={tab === 'profile'} onClick={onProfile}>
          Me
        </NavPill>
        <NavPill active={tab === 'docs'} onClick={onDocs}>
          Docs
        </NavPill>
        <div className="design-boost-wallet-wrap">
          <WalletMultiButton />
        </div>
      </div>
    </nav>
  );
}

function innerHeroTitle(tab) {
  if (tab === 'launch') return 'launch.';
  if (tab === 'docs') return 'docs.';
  if (tab === 'profile') return 'me.';
  return 'token.';
}

export default function App() {
  const wallet = useWallet();
  const [tab, setTab] = useState('home');
  const [selectedMint, setSelectedMint] = useState(null);

  const onSelectToken = useCallback((mint) => {
    setSelectedMint(mint);
    setTab('token');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goHome = useCallback(() => {
    setTab('home');
    setSelectedMint(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goLaunch = useCallback(() => {
    setTab('launch');
    setSelectedMint(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goProfile = useCallback(() => {
    setTab('profile');
    setSelectedMint(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const goDocs = useCallback(() => {
    setTab('docs');
    setSelectedMint(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const isHome = tab === 'home';

  const navSlot = (
    <Nav tab={tab} onHome={goHome} onLaunch={goLaunch} onProfile={goProfile} onDocs={goDocs} position="relative" />
  );

  return (
    <div className="sky-grain design-boost-shell" style={{ minHeight: '100vh', background: SKY, color: INK }}>
      {isHome && (
        <HomePage onSelectToken={onSelectToken} onLaunch={goLaunch} onProfile={goProfile} onDocs={goDocs} navSlot={navSlot} />
      )}

      {!isHome && (
        <div className="design-boost-inner">
          <div style={{ position: 'relative', overflow: 'hidden', background: SKY, minHeight: 240 }}>
            <CloudStrip />
            <Cloud
              width={160}
              className="cloud cloud-drift2"
              style={{ position: 'absolute', left: '2%', top: 72, zIndex: 1, opacity: 0.85 }}
            />
            <Cloud
              width={200}
              className="cloud cloud-drift"
              style={{ position: 'absolute', right: '3%', top: 52, zIndex: 1, opacity: 0.85 }}
            />

            <Nav tab={tab} onHome={goHome} onLaunch={goLaunch} onProfile={goProfile} onDocs={goDocs} position="relative" />

            <div className="db-inner-hero" style={{ textAlign: 'center', position: 'relative', zIndex: 5 }}>
              <BluebirdMark
                size={44}
                alt=""
                aria-hidden
                style={{ margin: '0 auto 10px', display: 'block' }}
              />
              <h1
                style={{
                  fontWeight: 800,
                  fontSize: 'clamp(44px, 9vw, 110px)',
                  lineHeight: 0.88,
                  letterSpacing: '-3px',
                  color: INK,
                  margin: 0,
                  fontFamily: "'Syne', sans-serif",
                }}
              >
                {innerHeroTitle(tab)}
              </h1>
            </div>
          </div>

          <div
            className="db-content-shell"
            style={{
              background: WHITE,
              borderRadius: '40px 40px 0 0',
              marginTop: -28,
              position: 'relative',
              zIndex: 6,
              boxShadow: '0 -12px 60px rgba(0,100,130,0.12)',
              minHeight: '55vh',
            }}
          >
            {tab === 'launch' && <LaunchView wallet={wallet} onLaunched={onSelectToken} />}
            {tab === 'token' && selectedMint && <PoolView mint={selectedMint} onBack={goHome} />}
            {tab === 'profile' && <UserDashboardView wallet={wallet} onSelectToken={onSelectToken} />}
            {tab === 'docs' && <DocsPage />}
          </div>

          <footer className="db-footer-inner" style={{ background: INK, display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BluebirdMark size={32} alt="" style={{ boxShadow: '0 2px 10px rgba(53,197,224,0.25)' }} />
              <span style={{ fontWeight: 800, fontSize: 18, color: WHITE, letterSpacing: '-0.5px' }}>stakrr</span>
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
              <a href={GITHUB} target="_blank" rel="noreferrer" style={{ fontSize: 13, color: '#888', fontFamily: "'DM Mono', monospace", textDecoration: 'none' }}>
                GitHub ↗
              </a>
              <button
                type="button"
                onClick={goDocs}
                style={{ background: 'none', border: 'none', color: '#888', fontSize: 13, fontFamily: "'DM Mono', monospace", cursor: 'pointer', padding: 0, textDecoration: 'underline' }}
              >
                Docs
              </button>
              <span style={{ fontSize: 13, color: '#555', fontFamily: "'DM Mono', monospace" }}>proof-of-belief · pump.fun staking</span>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}
