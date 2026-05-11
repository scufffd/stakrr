import React, { useMemo } from 'react';
import { apiUrl } from '../apiBase.js';

/**
 * Reusable multi-reward-line picker. Used by LaunchView and AdminSnipeView.
 *
 * Lifts state to the parent so submit logic stays in the parent. The hook
 * `useRewardLinesState()` is the recommended way to manage the state shape
 * — it returns `{ enabled, lines, setEnabled, setLines, isValid, payload }`.
 *
 *   const rl = useRewardLinesState();
 *   ...
 *   <RewardLinesPicker {...rl} />
 *
 * On submit, send `rl.payload` (or null when `!rl.enabled`) as the
 * `rewardLines` field. `rl.payload` strips the UI-only `probe` field and is
 * already the wire format the worker expects.
 *
 * Validation guarantees (when `enabled === true`):
 *   - 1..5 lines
 *   - every mint is base58 + unique
 *   - weights sum to exactly 10_000 bps
 */

export const REWARD_PRESETS = [
  { symbol: 'wSOL', mint: 'So11111111111111111111111111111111111111112', source: 'pump-fees-direct',  decimals: 9 },
  { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', source: 'pump-fees-swap-jup', decimals: 6 },
  { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', source: 'pump-fees-swap-jup', decimals: 6 },
  { symbol: 'GMEx', mint: 'Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc', source: 'pump-fees-swap-jup', decimals: 8 },
];

const DEFAULT_INITIAL_LINES = [
  { mint: 'So11111111111111111111111111111111111111112', weightBps: 5000, source: 'pump-fees-direct', label: 'wSOL', slippageBps: 100, probe: null },
  { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', weightBps: 5000, source: 'pump-fees-swap-jup', label: 'USDC', slippageBps: 100, probe: null },
];

/**
 * Hook: bundles the picker state + helpers used in both views. Returns
 * everything the parent needs to:
 *   - render `<RewardLinesPicker {...rl} />`
 *   - submit the payload (`rl.payload`)
 *   - gate the submit button (`!rl.isValid`)
 */
export function useRewardLinesState(initial = null) {
  const [enabled, setEnabled] = React.useState(false);
  const [lines, setLines] = React.useState(initial || DEFAULT_INITIAL_LINES);

  const totalWeightBps = useMemo(
    () => lines.reduce((acc, l) => acc + (Number(l.weightBps) || 0), 0),
    [lines],
  );
  const isValid = !enabled || (
    lines.length > 0
    && lines.length <= 5
    && totalWeightBps === 10_000
    && lines.every((l) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(l.mint))
    && new Set(lines.map((l) => l.mint)).size === lines.length
  );
  const payload = enabled
    ? lines.map((l) => ({
        mint: l.mint,
        weightBps: l.weightBps,
        source: l.source,
        slippageBps: l.slippageBps,
        label: l.label,
      }))
    : null;

  return { enabled, setEnabled, lines, setLines, totalWeightBps, isValid, payload };
}

const INP_SMALL = {
  width: '100%',
  background: 'white',
  border: '1.5px solid #E8E8E8',
  borderRadius: 12,
  fontSize: 12,
  fontFamily: "'DM Mono', monospace",
  padding: '8px 10px',
  outline: 'none',
  boxSizing: 'border-box',
  color: '#0C0C0C',
};

export function RewardLinesPicker({ enabled, setEnabled, lines, setLines, totalWeightBps, isValid }) {
  const updateLine = (idx, patch) => {
    setLines((prev) => prev.map((l, i) => (i === idx
      ? { ...l, ...patch, probe: patch.mint && patch.mint !== l.mint ? null : l.probe }
      : l)));
  };
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));
  const addLine = () => {
    setLines((prev) => prev.length >= 5 ? prev : [
      ...prev,
      { mint: '', weightBps: 0, source: 'pump-fees-swap-jup', label: '', slippageBps: 100, probe: null },
    ]);
  };
  const setLinePreset = (idx, preset) => updateLine(idx, {
    mint: preset.mint, source: preset.source, label: preset.symbol, probe: null,
  });
  const probeLine = async (idx) => {
    const line = lines[idx];
    if (!line?.mint) return;
    if (line.source === 'pump-fees-direct') {
      updateLine(idx, { probe: { ok: true, reason: 'direct (no swap)' } });
      return;
    }
    updateLine(idx, { probe: { loading: true } });
    try {
      const res = await fetch(apiUrl(`/api/jupiter/probe?mint=${line.mint}&slippageBps=${line.slippageBps || 100}`));
      const data = await res.json();
      updateLine(idx, { probe: data });
    } catch (e) {
      updateLine(idx, { probe: { ok: false, reason: e.message } });
    }
  };
  const equalWeights = () => {
    const n = lines.length;
    if (n === 0) return;
    const baseBps = Math.floor(10_000 / n);
    const remainder = 10_000 - baseBps * n;
    setLines((prev) => prev.map((l, i) => ({ ...l, weightBps: baseBps + (i < remainder ? 1 : 0) })));
  };

  return (
    <div style={{ border: '1.5px dashed #E8E8E8', borderRadius: 16, padding: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12, marginBottom: enabled ? 14 : 0,
      }}>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>Custom reward split (advanced)</p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: '#999' }}>
            Reward stakers in any combination of wSOL, USDC, USDT, GMEx, or any Jupiter-routable token. Weights sum to 100%.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          aria-pressed={enabled}
          style={{
            width: 44, height: 24, borderRadius: 100, border: 'none', cursor: 'pointer',
            background: enabled ? '#35C5E0' : '#E0E0E0', position: 'relative', flexShrink: 0,
          }}
        >
          <span style={{
            position: 'absolute', top: 2, left: enabled ? 22 : 2, width: 20, height: 20,
            borderRadius: '50%', background: 'white', boxShadow: '0 1px 4px rgba(0,0,0,0.2)', transition: 'left 0.2s',
          }} />
        </button>
      </div>

      {enabled && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {lines.map((line, idx) => (
            <div key={idx} style={{ border: '1px solid #E8E8E8', borderRadius: 12, padding: 12, background: '#FAFAFA' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                {REWARD_PRESETS.map((p) => (
                  <button
                    key={p.mint}
                    type="button"
                    onClick={() => setLinePreset(idx, p)}
                    style={{
                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontFamily: "'DM Mono', monospace",
                      border: '1px solid', borderColor: line.mint === p.mint ? '#35C5E0' : '#DDD',
                      background: line.mint === p.mint ? '#E0F7FB' : 'white',
                      color: line.mint === p.mint ? '#0369A1' : '#666', cursor: 'pointer',
                    }}
                  >
                    {p.symbol}
                  </button>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 80px 28px', gap: 6, alignItems: 'center' }}>
                <input
                  type="text"
                  value={line.mint}
                  onChange={(e) => updateLine(idx, { mint: e.target.value.trim() })}
                  placeholder="Mint pubkey"
                  style={{ ...INP_SMALL, fontSize: 11 }}
                />
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.01}
                  value={line.weightBps / 100}
                  onChange={(e) => updateLine(idx, { weightBps: Math.max(0, Math.min(10_000, Math.round((Number(e.target.value) || 0) * 100))) })}
                  style={{ ...INP_SMALL, textAlign: 'right' }}
                />
                <button
                  type="button"
                  onClick={() => removeLine(idx)}
                  disabled={lines.length === 1}
                  title="Remove this line"
                  style={{
                    width: 28, height: 28, borderRadius: 6, border: '1px solid #E0E0E0', background: 'white',
                    cursor: lines.length === 1 ? 'not-allowed' : 'pointer', opacity: lines.length === 1 ? 0.4 : 1,
                    fontSize: 14, color: '#888',
                  }}
                >
                  ×
                </button>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, fontSize: 11, color: '#666' }}>
                <span style={{ flex: 1 }}>
                  <select
                    value={line.source}
                    onChange={(e) => updateLine(idx, { source: e.target.value })}
                    style={{
                      fontSize: 11, fontFamily: "'DM Mono', monospace", padding: '4px 8px',
                      borderRadius: 6, border: '1px solid #DDD', background: 'white', color: '#666',
                    }}
                  >
                    <option value="pump-fees-direct">wSOL direct</option>
                    <option value="pump-fees-swap-jup">Swap (Jupiter)</option>
                    <option value="manual">Manual top-up</option>
                  </select>
                </span>
                {line.source === 'pump-fees-swap-jup' && (
                  <button
                    type="button"
                    onClick={() => probeLine(idx)}
                    disabled={!line.mint || line.probe?.loading}
                    style={{
                      padding: '3px 10px', borderRadius: 6, border: '1px solid #DDD', background: 'white',
                      fontSize: 11, fontFamily: "'DM Mono', monospace", cursor: 'pointer', color: '#666',
                    }}
                  >
                    {line.probe?.loading ? 'probing…' : 'probe route'}
                  </button>
                )}
                {line.probe && !line.probe.loading && (
                  <span style={{ color: line.probe.ok ? '#10b981' : '#EF4444', fontFamily: "'DM Mono', monospace" }}>
                    {line.probe.ok
                      ? line.probe.hops != null
                        ? `✓ route (${line.probe.hops} hop${line.probe.hops === 1 ? '' : 's'}, impact ${line.probe.priceImpactPct ?? '0'}%)`
                        : '✓ ok'
                      : `✗ ${(line.probe.reason || '').slice(0, 60)}`}
                  </span>
                )}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={addLine}
                disabled={lines.length >= 5}
                style={{
                  padding: '6px 14px', borderRadius: 8, border: '1px solid #DDD', background: 'white',
                  cursor: lines.length >= 5 ? 'not-allowed' : 'pointer',
                  opacity: lines.length >= 5 ? 0.4 : 1, fontSize: 12, fontFamily: "'Syne', sans-serif",
                }}
              >
                + Add reward token
              </button>
              <button
                type="button"
                onClick={equalWeights}
                style={{
                  padding: '6px 14px', borderRadius: 8, border: '1px solid #DDD', background: 'white',
                  cursor: 'pointer', fontSize: 12, fontFamily: "'Syne', sans-serif",
                }}
              >
                Equal weights
              </button>
            </div>
            <span style={{
              fontFamily: "'DM Mono', monospace", fontSize: 12,
              color: totalWeightBps === 10_000 ? '#10b981' : '#EF4444',
            }}>
              Total: {(totalWeightBps / 100).toFixed(2)}%
            </span>
          </div>
          {!isValid && (
            <p style={{ margin: 0, fontSize: 11, color: '#C62828', fontFamily: "'DM Mono', monospace" }}>
              {totalWeightBps !== 10_000
                ? `Weights must sum to exactly 100% (currently ${(totalWeightBps / 100).toFixed(2)}%).`
                : 'Each line needs a unique, valid mint.'}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
