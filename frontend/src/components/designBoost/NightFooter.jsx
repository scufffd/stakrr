import React, { useId } from 'react';
import BluebirdMark from './BluebirdMark.jsx';

const NIGHT = '#0D1829';
const NIGHT_CLOUD = '#162035';
const NIGHT_CLOUD_EDGE = '#1E2D48';
const CYAN = '#35C5E0';
const GITHUB_URL = import.meta.env.VITE_GITHUB_URL || 'https://github.com/scufffd/stakrr';
// Official $STAKRR token CA. Override via VITE_STAKRR_CA so future
// re-launches (or testnet builds) can swap without a code change.
const STAKRR_CA = import.meta.env.VITE_STAKRR_CA || 'yks7qyAPonTPAkiRXaGsKHinGNcpyQZK12HseDApump';
const STAKRR_TOKEN_PATH = `/token/${STAKRR_CA}`;
const STAKRR_SOLSCAN = `https://solscan.io/token/${STAKRR_CA}`;
const STAKRR_PUMP = `https://pump.fun/coin/${STAKRR_CA}`;

function ContractAddressPill() {
  const [copied, setCopied] = React.useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(STAKRR_CA);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Older browsers / iOS Safari without permission — fall back to a
      // textarea selection so the user can still ⌘C.
      const ta = document.createElement('textarea');
      ta.value = STAKRR_CA;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };

  return (
    <div
      className="db-night-footer-ca"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        margin: '60px auto 0',
        padding: '20px 24px',
        maxWidth: 720,
        background: 'rgba(53,197,224,0.04)',
        border: '1px solid rgba(53,197,224,0.18)',
        borderRadius: 18,
        backdropFilter: 'blur(8px)',
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 800,
          color: 'rgba(53,197,224,0.85)',
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          fontFamily: "'Syne', sans-serif",
        }}
      >
        $STAKRR · official token contract
      </span>
      <button
        type="button"
        onClick={onCopy}
        title="Click to copy"
        style={{
          all: 'unset',
          cursor: 'pointer',
          fontFamily: "'DM Mono', monospace",
          fontSize: 14,
          fontWeight: 700,
          color: 'white',
          padding: '6px 14px',
          borderRadius: 10,
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          wordBreak: 'break-all',
          textAlign: 'center',
          maxWidth: '100%',
          boxSizing: 'border-box',
        }}
      >
        {STAKRR_CA}
      </button>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
        <button
          type="button"
          onClick={onCopy}
          style={{
            ...socialLink,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: copied ? CYAN : 'rgba(255,255,255,0.55)',
            padding: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {copied ? (
              <polyline points="20 6 9 17 4 12" />
            ) : (
              <>
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
            )}
          </svg>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <a href={STAKRR_TOKEN_PATH} style={socialLink}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3" y="3" width="7" height="7" />
            <rect x="14" y="3" width="7" height="7" />
            <rect x="14" y="14" width="7" height="7" />
            <rect x="3" y="14" width="7" height="7" />
          </svg>
          Stake on Stakrr
        </a>
        <a href={STAKRR_SOLSCAN} target="_blank" rel="noreferrer" style={socialLink}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Solscan
        </a>
        <a href={STAKRR_PUMP} target="_blank" rel="noreferrer" style={socialLink}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
          Pump.fun
        </a>
      </div>
    </div>
  );
}

function DarkCloud({ width = 280, style = {}, className = '' }) {
  const uid = useId().replace(/:/g, '');
  const h = width * 0.55;
  const gid = `dc-${uid}`;
  return (
    <svg
      width={width}
      height={h}
      viewBox="0 0 280 154"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={style}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${gid}-grad`} cx="50%" cy="30%" r="65%">
          <stop offset="0%" stopColor={NIGHT_CLOUD_EDGE} />
          <stop offset="100%" stopColor={NIGHT_CLOUD} />
        </radialGradient>
        <filter id={`${gid}-shadow`} x="-10%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="0" dy="8" stdDeviation="14" floodColor="rgba(0,0,0,0.4)" />
        </filter>
      </defs>
      <g filter={`url(#${gid}-shadow)`}>
        <ellipse cx="140" cy="120" rx="130" ry="34" fill={`url(#${gid}-grad)`} />
        <ellipse cx="60" cy="105" rx="52" ry="44" fill={`url(#${gid}-grad)`} />
        <ellipse cx="138" cy="80" rx="68" ry="60" fill={`url(#${gid}-grad)`} />
        <ellipse cx="218" cy="100" rx="48" ry="42" fill={`url(#${gid}-grad)`} />
        <ellipse cx="95" cy="94" rx="40" ry="38" fill={`url(#${gid}-grad)`} />
        <ellipse cx="180" cy="88" rx="44" ry="40" fill={`url(#${gid}-grad)`} />
      </g>
    </svg>
  );
}

function Moon({ size = 220 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 220 220"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      style={{
        filter:
          'drop-shadow(0 0 40px rgba(53,197,224,0.35)) drop-shadow(0 0 80px rgba(180,120,255,0.2))',
      }}
    >
      <defs>
        <radialGradient id="moon-grad-nf" cx="35%" cy="30%" r="70%">
          <stop offset="0%" stopColor="#F0F8FF" />
          <stop offset="25%" stopColor="#C8ECFF" />
          <stop offset="55%" stopColor="#A8D8F8" />
          <stop offset="75%" stopColor="#C5B8F5" />
          <stop offset="100%" stopColor="#E8C8FF" />
        </radialGradient>
        <radialGradient id="moon-inner-dark-nf" cx="80%" cy="55%" r="60%">
          <stop offset="0%" stopColor={NIGHT} stopOpacity="0.95" />
          <stop offset="100%" stopColor={NIGHT} stopOpacity="0" />
        </radialGradient>
        <mask id="crescent-mask-nf">
          <rect width="220" height="220" fill="white" />
          <circle cx="148" cy="90" r="90" fill="black" />
        </mask>
      </defs>
      <circle cx="105" cy="110" r="95" fill="url(#moon-grad-nf)" mask="url(#crescent-mask-nf)" />
      <ellipse cx="78" cy="72" rx="28" ry="16" fill="white" fillOpacity="0.25" />
    </svg>
  );
}

function Star({ size = 32, color = '#FF8FD4', style = {}, delay = '0s' }) {
  const sid = useId().replace(/:/g, '');
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="design-boost-star"
      style={{ ...style, animationDelay: delay }}
      aria-hidden
    >
      <defs>
        <radialGradient id={`${sid}-g`} cx="40%" cy="30%" r="60%">
          <stop offset="0%" stopColor="white" stopOpacity="0.8" />
          <stop offset="100%" stopColor={color} />
        </radialGradient>
        <filter id={`${sid}-glow`}>
          <feGaussianBlur stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <polygon
        points="16,2 19.5,12 30,12 21.5,18.5 24.5,29 16,22.5 7.5,29 10.5,18.5 2,12 12.5,12"
        fill={`url(#${sid}-g)`}
        filter={`url(#${sid}-glow)`}
      />
    </svg>
  );
}

function DarkCloudStrip() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 160,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      <DarkCloud width={380} style={{ position: 'absolute', top: -60, left: -40 }} className="cloud-drift2" />
      <DarkCloud width={340} style={{ position: 'absolute', top: -50, left: 200 }} className="cloud-drift" />
      <DarkCloud width={420} style={{ position: 'absolute', top: -80, left: 480 }} className="cloud-drift3" />
      <DarkCloud width={360} style={{ position: 'absolute', top: -55, left: 820 }} className="cloud-drift2" />
      <DarkCloud width={400} style={{ position: 'absolute', top: -70, right: -20 }} className="cloud-drift" />
      <DarkCloud width={280} style={{ position: 'absolute', top: -30, left: 360 }} className="cloud-drift3" />
    </div>
  );
}

function DarkCloudStripBottom() {
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 180,
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      <DarkCloud width={400} style={{ position: 'absolute', bottom: -80, left: -60 }} className="cloud-drift" />
      <DarkCloud width={340} style={{ position: 'absolute', bottom: -55, left: 240 }} className="cloud-drift3" />
      <DarkCloud width={460} style={{ position: 'absolute', bottom: -90, left: 520 }} className="cloud-drift2" />
      <DarkCloud width={380} style={{ position: 'absolute', bottom: -65, right: -30 }} className="cloud-drift" />
    </div>
  );
}

const socialLink = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  color: 'rgba(255,255,255,0.45)',
  fontSize: 13,
  fontWeight: 700,
  textDecoration: 'none',
  fontFamily: "'Syne', sans-serif",
  transition: 'color 0.15s',
};

export default function NightFooter({ onLaunch }) {
  return (
    <section
      style={{
        position: 'relative',
        background: NIGHT,
        minHeight: '92vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
      className="db-night-footer-section"
    >
      <DarkCloudStrip />
      <DarkCloudStripBottom />

      <DarkCloud
        width={220}
        className="cloud cloud-drift3"
        style={{ position: 'absolute', left: '2%', top: '35%', opacity: 0.85, zIndex: 1 }}
      />
      <DarkCloud
        width={260}
        className="cloud cloud-drift2"
        style={{ position: 'absolute', right: '2%', top: '28%', opacity: 0.85, zIndex: 1 }}
      />
      <DarkCloud
        width={160}
        className="cloud cloud-drift"
        style={{ position: 'absolute', left: '8%', bottom: '22%', opacity: 0.6, zIndex: 1 }}
      />
      <DarkCloud
        width={200}
        className="cloud cloud-drift3"
        style={{ position: 'absolute', right: '10%', bottom: '18%', opacity: 0.6, zIndex: 1 }}
      />

      <Star size={28} color="#FF8FD4" style={{ position: 'absolute', left: '4%', bottom: '14%', zIndex: 3 }} delay="0s" />
      <Star size={20} color="#FFB0E0" style={{ position: 'absolute', left: '12%', bottom: '10%', zIndex: 3 }} delay="1s" />
      <Star size={36} color="#FF7EC7" style={{ position: 'absolute', left: '22%', bottom: '8%', zIndex: 3 }} delay="0.5s" />
      <Star size={24} color="#FF9FD6" style={{ position: 'absolute', right: '8%', bottom: '12%', zIndex: 3 }} delay="1.5s" />
      <Star size={18} color="#FFB8E8" style={{ position: 'absolute', right: '18%', bottom: '9%', zIndex: 3 }} delay="0.8s" />
      <Star size={14} color="#FFD0F0" style={{ position: 'absolute', right: '30%', bottom: '7%', zIndex: 3 }} delay="2s" />

      <div
        style={{
          position: 'absolute',
          top: '40%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 600,
          height: 400,
          borderRadius: '50%',
          background: 'radial-gradient(ellipse, rgba(53,197,224,0.06) 0%, transparent 70%)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      <div style={{ position: 'relative', zIndex: 4, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
        <h2
          className="db-night-footer-h2"
          style={{
            fontWeight: 800,
            color: CYAN,
            margin: '0 0 64px',
          }}
        >
          stake
          <br />
          it
        </h2>

        <div
          className="db-night-footer-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 40,
            alignItems: 'end',
          }}
        >
          <div>
            <p
              style={{
                color: 'rgba(255,255,255,0.55)',
                fontSize: 14,
                lineHeight: 1.8,
                margin: '0 0 24px',
                fontWeight: 500,
              }}
            >
              stakrr was built to put creator value back in stakers&apos; hands — a proof-of-belief protocol for the
              pump.fun economy. lock tokens, earn SOL, align incentives.
            </p>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
              <a href="https://twitter.com" target="_blank" rel="noreferrer" style={socialLink}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                X / Twitter
              </a>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer" style={socialLink}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.154-1.11-1.461-1.11-1.461-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.268 2.75 1.026A9.578 9.578 0 0 1 12 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.026 2.747-1.026.546 1.377.202 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.741 0 .267.18.578.688.48C19.138 20.161 22 16.418 22 12c0-5.523-4.477-10-10-10z" />
                </svg>
                GitHub
              </a>
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'flex-end' }}>
            <div className="design-boost-moon-bob">
              <Moon size={230} />
            </div>
          </div>

          <div>
            <p
              style={{
                color: 'rgba(255,255,255,0.55)',
                fontSize: 14,
                lineHeight: 1.8,
                margin: '0 0 24px',
                fontWeight: 500,
              }}
            >
              built on solana. non-custodial. all staking is handled by immutable on-chain programs — stakrr never
              touches your tokens. contributions and feedback are welcome.
            </p>
            <button
              type="button"
              onClick={onLaunch}
              style={{
                background: 'none',
                border: '1.5px solid rgba(53,197,224,0.4)',
                borderRadius: 100,
                padding: '10px 22px',
                color: CYAN,
                fontWeight: 700,
                fontSize: 14,
                cursor: 'pointer',
                fontFamily: "'Syne', sans-serif",
                letterSpacing: '-0.3px',
                transition: 'all 0.2s',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'rgba(53,197,224,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'none';
              }}
            >
              Launch a token →
            </button>
          </div>
        </div>

        <ContractAddressPill />

        <div
          style={{
            marginTop: 40,
            paddingTop: 24,
            borderTop: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <BluebirdMark size={28} alt="" style={{ boxShadow: '0 2px 12px rgba(0,0,0,0.35)' }} />
            <span style={{ fontWeight: 800, fontSize: 16, color: CYAN, letterSpacing: '-0.5px' }}>stakrr</span>
          </span>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', fontFamily: "'DM Mono', monospace" }}>
            proof-of-belief · pump.fun staking · built on solana
          </span>
        </div>
      </div>
    </section>
  );
}
