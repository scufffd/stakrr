import React from 'react';

const SKY = '#35C5E0';
const INK = '#0C0C0C';

const GITHUB = import.meta.env.VITE_GITHUB_URL || 'https://github.com/scufffd';

export default function DocsPage() {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto', fontFamily: "'Syne', sans-serif" }}>
      <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#888', margin: '0 0 12px' }}>
        Reference
      </p>
      <h2 style={{ fontWeight: 800, fontSize: 28, margin: '0 0 24px', letterSpacing: '-0.5px' }}>Documentation</h2>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 10px' }}>What is Stakrr?</h3>
        <p style={{ color: '#444', lineHeight: 1.65, fontSize: 15, margin: 0 }}>
          Stakrr launches tokens on <strong>pump.fun</strong> with a matching on-chain <strong>staking pool</strong> on
          the pob-index-stake program. Creator fees are claimed by the platform treasury; after a small platform share,
          rewards flow to stakers who lock the token for higher weight.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 10px' }}>Fee lock & 1-click launch</h3>
        <p style={{ color: '#444', lineHeight: 1.65, fontSize: 15, margin: 0 }}>
          Every Stakrr launch bundles three transactions into a single Phantom approval via
          {' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>signAllTransactions</code>:
          {' '}
          (1) Pump.fun create + dev buy, (2) <code style={{ fontFamily: 'DM Mono, monospace' }}>pump_fees</code> lock-fees, and (3) Stakrr pool init + reward-mint registration.
          The lock-fees tx calls <code style={{ fontFamily: 'DM Mono, monospace' }}>create_fee_sharing_config</code>
          {' '} + {' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>update_fee_shares</code> against
          {' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ</code>,
          migrating the on-chain <code style={{ fontFamily: 'DM Mono, monospace' }}>BondingCurve.creator</code> from the deployer wallet to a
          {' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>FeeSharingConfig</code> PDA seeded by
          {' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>["sharing-config", mint]</code>.
          From that moment on, 100% of creator royalties accrue to the Stakrr staking pool — verifiable on-chain by inspecting the
          {' '}
          <code style={{ fontFamily: 'DM Mono, monospace' }}>FeeSharingConfig</code> account on Solscan.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 10px' }}>Launch & metadata</h3>
        <p style={{ color: '#444', lineHeight: 1.65, fontSize: 15, margin: 0 }}>
          The app tries to pin metadata from <strong>your browser</strong> to pump.fun first. If that fails (403, VPN,
          datacenter), the worker uses <strong>Pinata</strong> when <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>PINATA_JWT</code> is set.
          Optional vanity mints: set <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>VANITY_MINT_POOL_FILE</code> and{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>VANITY_MINT_SUFFIX</code> (e.g. <code style={{ fontFamily: 'DM Mono, monospace' }}>STK</code>) on the worker; each launch pops the next matching keypair and passes it to PumpDev as <code style={{ fontFamily: 'DM Mono, monospace' }}>mintKeypair</code>.
        </p>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 10px' }}>Reward modes</h3>
        <ul style={{ color: '#444', lineHeight: 1.65, fontSize: 15, paddingLeft: 20, margin: 0 }}>
          <li>
            <strong>SOL</strong> — fees (after platform share) are wrapped to wSOL and deposited; stakers claim as native SOL.
          </li>
          <li>
            <strong>Token</strong> — the worker swaps the stakers&apos; share to your token and deposits token rewards.
          </li>
        </ul>
      </section>

      <section style={{ marginBottom: 32 }}>
        <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 10px' }}>API</h3>
        <p style={{ color: '#444', lineHeight: 1.65, fontSize: 15, margin: 0 }}>
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>GET /api/tokens</code>,{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>GET /api/tokens/:mint/public</code>,{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>POST /api/launch/prepare</code> (returns create + lock-fees + pool txs together),{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>POST /api/launch/lock-fees-finalize</code> (retro-lock for unlocked tokens),{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>POST /api/launch/auto-stake-tx</code>,{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>POST /api/launch/finalize</code>,{' '}
          <code style={{ fontFamily: 'DM Mono, monospace', background: '#f4f4f4', padding: '2px 6px', borderRadius: 6 }}>GET /api/wallet/:pubkey/summary</code>.
          Legacy <code style={{ fontFamily: 'DM Mono, monospace' }}>/api/pools</code> routes remain for compatibility.
        </p>
      </section>

      <a
        href={GITHUB}
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          background: INK,
          color: '#fff',
          fontWeight: 800,
          fontSize: 15,
          padding: '14px 22px',
          borderRadius: 100,
          textDecoration: 'none',
        }}
      >
        View on GitHub
        <span style={{ color: SKY }}>↗</span>
      </a>
      <p style={{ marginTop: 14, fontSize: 12, color: '#999' }}>
        Set <code style={{ fontFamily: 'DM Mono, monospace' }}>VITE_GITHUB_URL</code> in <code style={{ fontFamily: 'DM Mono, monospace' }}>.env</code> to point this button at your repo.
      </p>
    </div>
  );
}
