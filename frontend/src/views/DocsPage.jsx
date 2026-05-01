import React, { useEffect, useState } from 'react';
import { apiUrl } from '../apiBase.js';

const SKY = '#35C5E0';
const INK = '#0C0C0C';
const SUB = '#444';
const MUTED = '#888';
const CARD_BG = '#FAFAFA';
const REPO_FALLBACK = 'https://github.com/scufffd/stakrr';
const GITHUB = import.meta.env.VITE_GITHUB_URL || REPO_FALLBACK;

// Static fallbacks so the page renders something sensible even if /api/info
// is unreachable. Mirrored from worker/src/{config,pump-fees}.js.
const FALLBACK = {
  treasury: '9sfK1heMLLBCaYhUEH7C2ZsRtQYDCGpa956HEVS6TgWu',
  feeRecipient: '9sfK1heMLLBCaYhUEH7C2ZsRtQYDCGpa956HEVS6TgWu',
  programs: {
    stake: '65YrGaBL5ukm4SVcsEBoUgnqTrNXy2pDiPKeQKjSexVA',
    pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
    pumpBondingCurve: '6EF8rrecthR5Dkzon8NwuZ78hRvfCKubJ14M5uBEwF6P',
  },
  platformFeeBps: 200,
  minDistributeLamports: 2_000_000,
  loopIntervalMs: 600_000,
  lockFeesEnabled: true,
  repo: REPO_FALLBACK,
};

const mono = {
  fontFamily: "'DM Mono', monospace",
  fontSize: 13,
  background: '#f4f4f4',
  padding: '2px 6px',
  borderRadius: 6,
  wordBreak: 'break-all',
};

function H3({ children }) {
  return <h3 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 12px', letterSpacing: '-0.3px' }}>{children}</h3>;
}

function P({ children }) {
  return <p style={{ color: SUB, lineHeight: 1.65, fontSize: 15, margin: '0 0 10px' }}>{children}</p>;
}

function Section({ children, last = false }) {
  return <section style={{ marginBottom: last ? 8 : 32 }}>{children}</section>;
}

function Solscan({ pubkey, label }) {
  return (
    <a
      href={`https://solscan.io/account/${pubkey}`}
      target="_blank"
      rel="noreferrer"
      style={{ ...mono, color: INK, textDecoration: 'none', borderBottom: `1px dotted ${MUTED}` }}
      title="View on Solscan"
    >
      {label || pubkey}
    </a>
  );
}

export default function DocsPage() {
  const [info, setInfo] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/info'))
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!cancelled && j && j.ok) setInfo(j);
      })
      .catch(() => {});
    return () => {
      cancelled = false;
    };
  }, []);

  const cfg = info || FALLBACK;
  const repoUrl = cfg.repo || GITHUB;
  const platformPct = (cfg.platformFeeBps / 100).toFixed(2).replace(/\.?0+$/, '');
  const stakerPct = ((10000 - cfg.platformFeeBps) / 100).toFixed(2).replace(/\.?0+$/, '');
  const minDistributeSol = (cfg.minDistributeLamports / 1e9).toLocaleString(undefined, { maximumFractionDigits: 6 });
  const loopMin = Math.round(cfg.loopIntervalMs / 60_000);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', fontFamily: "'Syne', sans-serif" }}>
      <p style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: MUTED, margin: '0 0 12px' }}>
        Reference
      </p>
      <h2 style={{ fontWeight: 800, fontSize: 32, margin: '0 0 8px', letterSpacing: '-0.5px' }}>Documentation</h2>
      <p style={{ color: MUTED, fontSize: 14, margin: '0 0 32px' }}>
        How Stakrr works, where the money goes, and how to verify it on-chain.
      </p>

      <Section>
        <H3>What is Stakrr?</H3>
        <P>
          Stakrr is a proof-of-belief launchpad on top of <strong>pump.fun</strong>. Every token launched through
          Stakrr gets a matching on-chain staking pool: lock the token for 1–30 days and earn a share of the
          creator&apos;s pump.fun fees, paid as SOL. Nothing about the flow is custodial &mdash; tokens, fees, and rewards
          are all held by Solana programs you can audit on Solscan.
        </P>
      </Section>

      <Section>
        <H3>Fee lock — how the creator&apos;s royalties get redirected</H3>
        <P>
          On every Stakrr launch, the deployer signs <em>three</em> transactions in a single Phantom prompt:
        </P>
        <ol style={{ color: SUB, lineHeight: 1.65, fontSize: 15, paddingLeft: 22, margin: '0 0 12px' }}>
          <li>Pump.fun create + dev buy.</li>
          <li>
            <code style={mono}>pump_fees::create_fee_sharing_config</code> + <code style={mono}>update_fee_shares</code>{' '}
            against <Solscan pubkey={cfg.programs.pumpFees} />, which migrates the on-chain{' '}
            <code style={mono}>BondingCurve.creator</code> from the deployer wallet to a program-owned{' '}
            <code style={mono}>FeeSharingConfig</code> PDA seeded by <code style={mono}>[&quot;sharing-config&quot;, mint]</code>.
            Recipient is set to <Solscan pubkey={cfg.feeRecipient} label="Stakrr treasury" /> at <strong>100% (10,000 bps)</strong>.
          </li>
          <li>
            Stakrr <code style={mono}>initialize_pool</code> + <code style={mono}>add_reward_mint</code> against{' '}
            <Solscan pubkey={cfg.programs.stake} label="pob-index-stake" />.
          </li>
        </ol>
        <P>
          {cfg.lockFeesEnabled
            ? 'Once locked, the deployer cannot redirect fees — the pump.fun creator field is now a PDA, not a wallet, and the fee-share config is set to revoke its own update authority. This is verifiable on Solscan by inspecting the FeeSharingConfig account for any Stakrr launch.'
            : 'Note: fee-locking is currently disabled in this environment, so the deployer wallet can still redirect creator fees. Set LOCK_FEES_ENABLED=true on the worker to enforce the lock.'}
        </P>
      </Section>

      <Section>
        <H3>Where does the money go?</H3>
        <P>
          Every <code style={mono}>~{loopMin} min</code> the worker runs a claim cycle per token:
        </P>
        <ol style={{ color: SUB, lineHeight: 1.65, fontSize: 15, paddingLeft: 22, margin: '0 0 12px' }}>
          <li>
            Calls <code style={mono}>DistributeCreatorFees</code> on{' '}
            <Solscan pubkey={cfg.programs.pumpBondingCurve} label="pump bonding-curve" />, which moves the bonding
            curve&apos;s accrued creator fees from the on-chain creator vault to the FeeSharingConfig recipient — i.e.{' '}
            <Solscan pubkey={cfg.feeRecipient} label="Stakrr treasury" />.
          </li>
          <li>
            If the cycle pulled in &ge; <strong>{minDistributeSol} SOL</strong>{' '}
            (<code style={mono}>MIN_DISTRIBUTE_LAMPORTS</code>), the worker splits:
            <ul style={{ margin: '6px 0 6px 0', paddingLeft: 20 }}>
              <li>
                <strong>{stakerPct}%</strong> wrapped to wSOL and{' '}
                <code style={mono}>deposit_rewards</code>&apos;d into that token&apos;s reward vault, where stakers can claim it.
              </li>
              <li>
                <strong>{platformPct}%</strong> stays in the treasury wallet to cover RPC, claim-cycle network fees,
                and platform operations.
              </li>
            </ul>
          </li>
          <li>
            If the cycle is below the threshold, <em>nothing is moved out</em> &mdash; the SOL accumulates in the
            treasury until a future cycle crosses the threshold. This avoids burning more in network fees than the
            cycle actually distributes.
          </li>
        </ol>
        <div
          style={{
            background: CARD_BG,
            border: '1px solid #eee',
            borderRadius: 14,
            padding: '14px 18px',
            marginTop: 14,
            fontSize: 13.5,
            color: SUB,
            lineHeight: 1.6,
          }}
        >
          <strong style={{ color: INK }}>Verify it yourself.</strong> Watch{' '}
          <Solscan pubkey={cfg.feeRecipient} /> on Solscan: every credit you see comes from a{' '}
          <code style={mono}>DistributeCreatorFees</code> tx; every debit you see is either (a) a{' '}
          <code style={mono}>deposit_rewards</code> tx into a Stakrr pool&apos;s reward vault, or (b) a Solana network
          fee from running the claim cycle itself. There is no third path.
        </div>
      </Section>

      <Section>
        <H3>Reward modes</H3>
        <ul style={{ color: SUB, lineHeight: 1.65, fontSize: 15, paddingLeft: 22, margin: 0 }}>
          <li>
            <strong>SOL</strong> (default) — the staker share is wrapped to wSOL and deposited; stakers claim native
            SOL via the UI. Best when SOL is the universal denominator.
          </li>
          <li>
            <strong>Token</strong> — the worker buys the launched token from the bonding curve with the staker share
            and deposits the token; stakers claim more of the same token. Best for &ldquo;dividend&rdquo; tokens that
            want internal compounding.
          </li>
        </ul>
      </Section>

      <Section>
        <H3>Stake multipliers</H3>
        <P>
          Lock duration determines your share of each <code style={mono}>deposit_rewards</code> distribution. Longer
          locks earn proportionally more.
        </P>
        <ul style={{ color: SUB, lineHeight: 1.65, fontSize: 14, paddingLeft: 22, margin: 0 }}>
          <li>1 day — 1.0x · 3 day — 1.25x · 7 day — 1.5x</li>
          <li>14 day — 2.0x · 21 day — 2.5x · 30 day — 3.0x</li>
        </ul>
      </Section>

      <Section>
        <H3>On-chain identifiers</H3>
        <table style={{ width: '100%', fontSize: 13.5, borderCollapse: 'collapse' }}>
          <tbody>
            {[
              ['Stake program (pob-index-stake)', cfg.programs.stake],
              ['pump_fees program', cfg.programs.pumpFees],
              ['pump bonding-curve program', cfg.programs.pumpBondingCurve],
              ['Stakrr treasury / fee recipient', cfg.feeRecipient],
            ].map(([label, value]) => (
              <tr key={label} style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '10px 8px 10px 0', color: MUTED, fontWeight: 600, whiteSpace: 'nowrap', verticalAlign: 'top' }}>{label}</td>
                <td style={{ padding: '10px 0', wordBreak: 'break-all' }}>
                  <Solscan pubkey={value} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section>
        <H3>API</H3>
        <P>
          <code style={mono}>GET /api/tokens</code>, <code style={mono}>GET /api/tokens/:mint/public</code>,{' '}
          <code style={mono}>GET /api/info</code> (live config),{' '}
          <code style={mono}>POST /api/launch/prepare</code> (returns the create + lock-fees + pool txs together),{' '}
          <code style={mono}>POST /api/launch/lock-fees-finalize</code> (retro-lock for unlocked tokens),{' '}
          <code style={mono}>POST /api/launch/auto-stake-tx</code>,{' '}
          <code style={mono}>POST /api/launch/finalize</code>,{' '}
          <code style={mono}>GET /api/wallet/:pubkey/summary</code>. Legacy <code style={mono}>/api/pools</code> routes
          remain for compatibility.
        </P>
      </Section>

      <Section last>
        <a
          href={repoUrl}
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
          View source on GitHub
          <span style={{ color: SKY }}>↗</span>
        </a>
        <p style={{ marginTop: 14, fontSize: 12, color: MUTED }}>
          Stakrr deploys nothing new on-chain. The staking program <code style={mono}>{cfg.programs.stake}</code> was
          already deployed and audited as part of pob-index-stake; each launch creates a fresh{' '}
          <code style={mono}>StakePool</code> for that token&apos;s mint, fully isolated from other pools.
        </p>
      </Section>
    </div>
  );
}
