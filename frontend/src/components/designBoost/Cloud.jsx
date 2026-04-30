import React, { useId } from 'react';

export default function Cloud({ width = 280, style = {}, className = '' }) {
  const uid = useId().replace(/:/g, '');
  const h = width * 0.55;
  const id = `c-${width}-${uid}`;

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
        <filter id={`${id}-shadow`} x="-10%" y="-10%" width="120%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="12" floodColor="rgba(0,100,130,0.15)" />
        </filter>
        <radialGradient id={`${id}-grad`} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#e8f8ff" />
        </radialGradient>
      </defs>
      <g filter={`url(#${id}-shadow)`}>
        <ellipse cx="140" cy="120" rx="130" ry="34" fill={`url(#${id}-grad)`} />
        <ellipse cx="60" cy="105" rx="52" ry="44" fill={`url(#${id}-grad)`} />
        <ellipse cx="138" cy="80" rx="68" ry="60" fill={`url(#${id}-grad)`} />
        <ellipse cx="218" cy="100" rx="48" ry="42" fill={`url(#${id}-grad)`} />
        <ellipse cx="95" cy="94" rx="40" ry="38" fill={`url(#${id}-grad)`} />
        <ellipse cx="180" cy="88" rx="44" ry="40" fill={`url(#${id}-grad)`} />
      </g>
    </svg>
  );
}

export function CloudStrip() {
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
      <Cloud width={380} style={{ position: 'absolute', top: -60, left: -40 }} className="cloud-drift" />
      <Cloud width={340} style={{ position: 'absolute', top: -50, left: 200 }} className="cloud-drift2" />
      <Cloud width={420} style={{ position: 'absolute', top: -80, left: 480 }} className="cloud-drift" />
      <Cloud width={360} style={{ position: 'absolute', top: -55, left: 820 }} className="cloud-drift2" />
      <Cloud width={400} style={{ position: 'absolute', top: -70, right: -20 }} className="cloud-drift" />
      <Cloud width={280} style={{ position: 'absolute', top: -30, left: 350 }} className="cloud-drift3" />
    </div>
  );
}
