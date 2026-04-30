import React, { useEffect, useState } from 'react';
import { WalletMultiButton } from '@solana/wallet-adapter-react-ui';
import Cloud, { CloudStrip } from './Cloud.jsx';
import BluebirdMark from './BluebirdMark.jsx';
import DirectoryBoostView from '../../views/DirectoryBoostView.jsx';
import { useReveal, revealStyle } from '../../hooks/useReveal.js';
import NightFooter from './NightFooter.jsx';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const WHITE = '#FFFFFF';

const TIERS = [
  { days: 1, mult: '1.0×', color: '#94A3B8' },
  { days: 3, mult: '1.25×', color: '#60A5FA' },
  { days: 7, mult: '1.5×', color: SKY },
  { days: 14, mult: '2.0×', color: '#7C45F3' },
  { days: 21, mult: '2.5×', color: '#A855F7' },
  { days: 30, mult: '3.0×', color: '#EC4899' },
];

const STEPS = [
  {
    n: '01',
    title: 'Find a token',
    body: 'Browse tokens launched with stakrr on pump.fun. Each one has on-chain staking — lock to earn a share of creator fees.',
  },
  {
    n: '02',
    title: 'Stake & Lock',
    body: 'Deposit your tokens and choose a lock duration from 1 to 30 days. Longer locks earn a higher multiplier on creator-fee rewards.',
  },
  {
    n: '03',
    title: 'Earn SOL',
    body: 'Every time the creator collects pump.fun fees, stakers receive a proportional share — distributed on-chain, non-custodially.',
  },
];

function MarqueeStrip() {
  const items = [
    'proof of belief',
    '✦',
    'stake tokens',
    '✦',
    'earn SOL',
    '✦',
    'non-custodial',
    '✦',
    'pump.fun',
    '✦',
    'on-chain rewards',
    '✦',
    'up to 3×',
    '✦',
    'lock to earn',
    '✦',
  ];
  const repeated = [...items, ...items, ...items];
  return (
    <div style={{ overflow: 'hidden', padding: 0 }}>
      <div className="design-boost-marquee">
        {repeated.map((t, i) => (
          <span key={i} style={{ flexShrink: 0, color: t === '✦' ? SKY : INK }}>
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function HomePage({ onSelectToken, onLaunch, navSlot }) {
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    const h = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, []);

  const r1 = useReveal();
  const r2 = useReveal();
  const r3 = useReveal();
  const r4 = useReveal(0.08);
  const r5 = useReveal();
  const r6 = useReveal();

  return (
    <div style={{ fontFamily: "'Syne', sans-serif", background: SKY }}>
      <section
        style={{
          position: 'relative',
          height: '100vh',
          minHeight: 600,
          overflow: 'hidden',
          background: SKY,
        }}
      >
        <CloudStrip />

        <Cloud
          width={230}
          className="cloud cloud-drift2"
          style={{
            position: 'absolute',
            left: '5%',
            top: '30%',
            zIndex: 1,
            transform: `translateY(${scrollY * 0.08}px)`,
          }}
        />
        <Cloud
          width={310}
          className="cloud cloud-drift"
          style={{
            position: 'absolute',
            right: '3%',
            top: '22%',
            zIndex: 1,
            transform: `translateY(${scrollY * 0.06}px)`,
          }}
        />
        <Cloud
          width={180}
          className="cloud cloud-drift3"
          style={{
            position: 'absolute',
            right: '22%',
            top: '55%',
            zIndex: 1,
            opacity: 0.7,
            transform: `translateY(${scrollY * 0.1}px)`,
          }}
        />

        {navSlot}

        <div
          style={{
            position: 'absolute',
            right: 'clamp(12px, 6vw, 56px)',
            top: 'max(100px, 16vh)',
            zIndex: 4,
            width: 'clamp(76px, 12vw, 120px)',
            pointerEvents: 'none',
            transform: `translateY(${scrollY * 0.045}px)`,
          }}
        >
          <div className="db-bluebird-hero">
            <BluebirdMark fluid alt="Bluebird — Stakrr mascot" />
          </div>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: '16%',
            left: 0,
            right: 0,
            zIndex: 3,
            padding: '0 48px',
            transform: `translateY(${-scrollY * 0.18}px)`,
          }}
        >
          <h1
            style={{
              fontWeight: 800,
              fontSize: 'clamp(72px, 13vw, 155px)',
              lineHeight: 0.88,
              letterSpacing: '-4px',
              color: INK,
              margin: 0,
              userSelect: 'none',
            }}
          >
            proof of
            <br />
            belief
          </h1>
        </div>

        <div
          className="float-card"
          style={{
            position: 'absolute',
            bottom: '26%',
            left: '37%',
            zIndex: 5,
            background: WHITE,
            borderRadius: 14,
            padding: '16px 20px',
            maxWidth: 230,
            boxShadow: '0 8px 40px rgba(0,100,130,0.2)',
            transform: 'rotate(-4deg)',
          }}
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#333', fontWeight: 500 }}>
            stake pump.fun tokens. lock to earn up to <strong style={{ color: INK }}>3×</strong> creator fees as SOL —
            non-custodial, on-chain.
          </p>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: '5%',
            left: 0,
            right: 0,
            zIndex: 3,
            padding: '0 48px',
            transform: `translateY(${-scrollY * 0.12}px)`,
          }}
        >
          <span
            style={{
              fontWeight: 800,
              fontSize: 'clamp(72px, 13vw, 155px)',
              lineHeight: 0.88,
              letterSpacing: '-4px',
              color: INK,
            }}
          >
            launchpad
          </span>
        </div>

        <div
          style={{
            position: 'absolute',
            bottom: 28,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 6,
            opacity: scrollY > 40 ? 0 : 1,
            transition: 'opacity 0.4s',
          }}
        >
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'rgba(0,0,0,0.35)',
              textTransform: 'uppercase',
              letterSpacing: '0.15em',
            }}
          >
            scroll
          </span>
          <div className="design-boost-scroll-line" />
        </div>
      </section>

      <section
        ref={r1.ref}
        style={{
          position: 'relative',
          background: SKY,
          padding: '120px 48px',
          overflow: 'hidden',
          minHeight: '80vh',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Cloud
          width={400}
          className="cloud cloud-drift"
          style={{ position: 'absolute', right: '-80px', top: '10%', opacity: 0.55, zIndex: 0 }}
        />
        <Cloud
          width={260}
          className="cloud cloud-drift2"
          style={{ position: 'absolute', left: '-60px', bottom: '12%', opacity: 0.45, zIndex: 0 }}
        />

        <div style={{ position: 'relative', zIndex: 2, maxWidth: 1200, margin: '0 auto', width: '100%' }}>
          <div style={revealStyle(r1.visible, 0, 'up')}>
            <p
              style={{
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'rgba(0,0,0,0.4)',
                margin: '0 0 24px',
              }}
            >
              what is stakrr
            </p>
          </div>

          <div style={revealStyle(r1.visible, 80, 'up')}>
            <h2
              style={{
                fontWeight: 800,
                fontSize: 'clamp(52px, 9vw, 110px)',
                lineHeight: 0.9,
                letterSpacing: '-3px',
                color: INK,
                margin: 0,
                maxWidth: 900,
              }}
            >
              stake to
              <br />
              earn.
            </h2>
          </div>

          <div style={{ display: 'flex', gap: 40, marginTop: 64, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ ...revealStyle(r1.visible, 200, 'up'), flex: '0 0 auto', maxWidth: 420 }}>
              <p style={{ fontSize: 18, lineHeight: 1.7, color: 'rgba(0,0,0,0.65)', fontWeight: 500, margin: 0 }}>
                stakrr is a proof-of-belief launchpad built on top of pump.fun. when a creator launches through stakrr,
                believers can lock tokens to earn a share of the creator&apos;s fees — redistributed on-chain as SOL.
              </p>
            </div>
            <div style={{ ...revealStyle(r1.visible, 320, 'up'), flex: '0 0 auto' }}>
              <div
                style={{
                  background: WHITE,
                  borderRadius: 20,
                  padding: '28px 32px',
                  boxShadow: '0 16px 60px rgba(0,100,130,0.2)',
                  transform: 'rotate(2deg)',
                  minWidth: 240,
                }}
              >
                <p
                  style={{
                    margin: '0 0 20px',
                    fontSize: 12,
                    fontWeight: 700,
                    color: '#AAA',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                  }}
                >
                  Multipliers
                </p>
                {TIERS.slice(2).map((t) => (
                  <div
                    key={t.days}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}
                  >
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#555' }}>{t.days} days</span>
                    <span style={{ fontFamily: "'DM Mono', monospace", fontWeight: 700, fontSize: 16, color: t.color }}>
                      {t.mult}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section
        ref={r2.ref}
        style={{
          background: WHITE,
          padding: '120px 48px',
          borderRadius: '48px 48px 0 0',
          position: 'relative',
          zIndex: 4,
          boxShadow: '0 -16px 60px rgba(0,100,130,0.1)',
        }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={revealStyle(r2.visible, 0, 'up')}>
            <p
              style={{
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: '#AAA',
                margin: '0 0 16px',
              }}
            >
              how it works
            </p>
            <h2
              style={{
                fontWeight: 800,
                fontSize: 'clamp(40px, 7vw, 80px)',
                lineHeight: 0.9,
                letterSpacing: '-2px',
                color: INK,
                margin: '0 0 72px',
              }}
            >
              three steps.
            </h2>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 24 }}>
            {STEPS.map((step, i) => (
              <div key={step.n} style={revealStyle(r2.visible, 100 + i * 120, 'up')}>
                <div
                  style={{
                    border: '1.5px solid #F0F0F0',
                    borderRadius: 28,
                    padding: '36px 32px',
                    height: '100%',
                    boxSizing: 'border-box',
                    transition: 'box-shadow 0.2s',
                    background: 'white',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = '0 12px 48px rgba(0,0,0,0.08)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'DM Mono', monospace",
                      fontSize: 13,
                      fontWeight: 700,
                      color: SKY,
                      marginBottom: 24,
                    }}
                  >
                    {step.n}
                  </div>
                  <h3
                    style={{
                      fontWeight: 800,
                      fontSize: 28,
                      color: INK,
                      margin: '0 0 16px',
                      letterSpacing: '-0.5px',
                      lineHeight: 1.1,
                    }}
                  >
                    {step.title}
                  </h3>
                  <p style={{ color: '#888', fontSize: 15, lineHeight: 1.7, margin: 0, fontWeight: 500 }}>{step.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section
        ref={r3.ref}
        style={{ background: SKY, padding: '140px 48px', position: 'relative', overflow: 'hidden' }}
      >
        <Cloud
          width={500}
          className="cloud cloud-drift3"
          style={{ position: 'absolute', right: '-120px', bottom: '-60px', opacity: 0.4, zIndex: 0 }}
        />

        <div style={{ maxWidth: 1200, margin: '0 auto', position: 'relative', zIndex: 2 }}>
          <div style={revealStyle(r3.visible, 0, 'up')}>
            <p
              style={{
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'rgba(0,0,0,0.4)',
                margin: '0 0 16px',
              }}
            >
              the multiplier
            </p>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32, flexWrap: 'wrap', marginBottom: 64 }}>
            <div style={revealStyle(r3.visible, 60, 'up')}>
              <p
                style={{
                  fontWeight: 800,
                  fontSize: 'clamp(120px, 22vw, 260px)',
                  lineHeight: 0.82,
                  letterSpacing: '-8px',
                  color: INK,
                  margin: 0,
                }}
              >
                3×
              </p>
            </div>
            <div style={{ ...revealStyle(r3.visible, 180, 'up'), paddingBottom: '1.5rem', maxWidth: 320 }}>
              <p style={{ fontSize: 20, fontWeight: 600, color: 'rgba(0,0,0,0.55)', lineHeight: 1.6, margin: 0 }}>
                maximum multiplier on creator fee rewards, earned by locking for 30 days.
              </p>
            </div>
          </div>

          <div style={revealStyle(r3.visible, 280, 'up')}>
            <div className="home-boost-tier-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 12 }}>
              {TIERS.map((t, i) => (
                <div
                  key={t.days}
                  style={{
                    ...revealStyle(r3.visible, 300 + i * 60, 'up'),
                    background: WHITE,
                    borderRadius: 20,
                    padding: '24px 16px',
                    textAlign: 'center',
                    boxShadow: '0 4px 24px rgba(0,100,130,0.12)',
                  }}
                >
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 700,
                      color: '#AAA',
                      marginBottom: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {t.days === 1 ? '1 day' : `${t.days} days`}
                  </div>
                  <div style={{ fontFamily: "'DM Mono', monospace", fontWeight: 800, fontSize: 22, color: t.color }}>
                    {t.mult}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section
        ref={r4.ref}
        style={{
          background: WHITE,
          padding: '80px 0',
          overflow: 'hidden',
          position: 'relative',
          zIndex: 4,
          borderRadius: '48px 48px 0 0',
          boxShadow: '0 -16px 60px rgba(0,100,130,0.08)',
        }}
      >
        <MarqueeStrip />
      </section>

      <section ref={r5.ref} style={{ background: WHITE, padding: '20px 48px 100px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div style={revealStyle(r5.visible, 0, 'up')}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-between',
                marginBottom: 48,
                flexWrap: 'wrap',
                gap: 16,
              }}
            >
              <div>
                <p
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    letterSpacing: '0.2em',
                    textTransform: 'uppercase',
                    color: '#AAA',
                    margin: '0 0 12px',
                  }}
                >
                  explore
                </p>
                <h2
                  style={{
                    fontWeight: 800,
                    fontSize: 'clamp(40px, 6vw, 72px)',
                    lineHeight: 0.9,
                    letterSpacing: '-2px',
                    color: INK,
                    margin: 0,
                  }}
                >
                  active tokens.
                </h2>
              </div>
              <button
                type="button"
                onClick={onLaunch}
                style={{
                  background: INK,
                  color: WHITE,
                  border: 'none',
                  borderRadius: 100,
                  padding: '14px 28px',
                  fontWeight: 800,
                  fontSize: 15,
                  cursor: 'pointer',
                  fontFamily: "'Syne', sans-serif",
                  letterSpacing: '-0.3px',
                }}
              >
                Launch a Token →
              </button>
            </div>
          </div>
          <div style={revealStyle(r5.visible, 120, 'up')}>
            <DirectoryBoostView onSelectToken={onSelectToken} />
          </div>
        </div>
      </section>

      <section
        ref={r6.ref}
        style={{ background: SKY, padding: '140px 48px 160px', position: 'relative', overflow: 'hidden' }}
      >
        <CloudStrip />
        <Cloud
          width={350}
          className="cloud cloud-drift2"
          style={{ position: 'absolute', left: '-60px', bottom: '5%', opacity: 0.5, zIndex: 0 }}
        />
        <Cloud
          width={280}
          className="cloud cloud-drift"
          style={{ position: 'absolute', right: '5%', top: '30%', opacity: 0.6, zIndex: 0 }}
        />

        <div style={{ maxWidth: 1200, margin: '0 auto', position: 'relative', zIndex: 2 }}>
          <div style={revealStyle(r6.visible, 0, 'up')}>
            <p
              style={{
                fontWeight: 700,
                fontSize: 13,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'rgba(0,0,0,0.4)',
                margin: '0 0 24px',
              }}
            >
              get started
            </p>
          </div>
          <div style={revealStyle(r6.visible, 80, 'up')}>
            <h2
              style={{
                fontWeight: 800,
                fontSize: 'clamp(72px, 14vw, 160px)',
                lineHeight: 0.88,
                letterSpacing: '-4px',
                color: INK,
                margin: '0 0 60px',
              }}
            >
              launch.
            </h2>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', ...revealStyle(r6.visible, 200, 'up') }}>
            <button
              type="button"
              onClick={onLaunch}
              style={{
                background: INK,
                color: WHITE,
                border: 'none',
                borderRadius: 100,
                padding: '18px 40px',
                fontWeight: 800,
                fontSize: 18,
                cursor: 'pointer',
                fontFamily: "'Syne', sans-serif",
                letterSpacing: '-0.3px',
                boxShadow: '0 8px 40px rgba(0,0,0,0.25)',
              }}
            >
              Launch your token →
            </button>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <WalletMultiButton />
            </div>
          </div>

          <div
            style={{
              position: 'absolute',
              top: '20%',
              right: '8%',
              zIndex: 5,
              background: WHITE,
              borderRadius: 16,
              padding: '18px 22px',
              maxWidth: 200,
              boxShadow: '0 12px 48px rgba(0,100,130,0.2)',
              transform: 'rotate(3deg)',
            }}
          >
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: '#444', fontWeight: 500 }}>
              built on <strong style={{ color: INK }}>solana</strong>.
              <br />
              non-custodial.
              <br />
              open source.
            </p>
          </div>
        </div>
      </section>

      <NightFooter onLaunch={onLaunch} />
    </div>
  );
}
