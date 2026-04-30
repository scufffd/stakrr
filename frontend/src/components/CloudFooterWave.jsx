import React from 'react';

/** White “cloud bank” transition between sky and footer (original path art). */
export default function CloudFooterWave() {
  return (
    <div className="cloud-footer-wave" aria-hidden>
      <svg
        className="cloud-footer-wave__svg"
        viewBox="0 0 1440 120"
        preserveAspectRatio="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          fill="#ffffff"
          d="M0,80 L0,120 L1440,120 L1440,80
             C1380,55 1320,90 1260,70 C1200,50 1140,85 1080,65 C1020,45 960,75 900,60
             C840,45 780,80 720,55 C660,30 600,70 540,50 C480,30 420,65 360,48
             C300,30 240,72 180,55 C120,38 60,78 0,80 Z"
        />
        <g fill="#ffffff">
          <rect x="40" y="40" width="14" height="14" />
          <rect x="54" y="32" width="14" height="14" />
          <rect x="68" y="32" width="14" height="14" />
          <rect x="82" y="24" width="14" height="14" />
          <rect x="96" y="24" width="14" height="14" />
          <rect x="110" y="24" width="14" height="14" />
          <rect x="124" y="32" width="14" height="14" />
          <rect x="68" y="46" width="14" height="14" />
          <rect x="82" y="46" width="14" height="14" />
          <rect x="96" y="46" width="14" height="14" />
          <rect x="200" y="50" width="12" height="12" />
          <rect x="212" y="44" width="12" height="12" />
          <rect x="224" y="44" width="12" height="12" />
          <rect x="236" y="38" width="12" height="12" />
          <rect x="248" y="44" width="12" height="12" />
          <rect x="260" y="50" width="12" height="12" />
          <rect x="1100" y="35" width="16" height="16" />
          <rect x="1116" y="26" width="16" height="16" />
          <rect x="1132" y="26" width="16" height="16" />
          <rect x="1148" y="18" width="16" height="16" />
          <rect x="1164" y="18" width="16" height="16" />
          <rect x="1180" y="26" width="16" height="16" />
          <rect x="1196" y="35" width="16" height="16" />
          <rect x="1132" y="42" width="16" height="16" />
          <rect x="1148" y="42" width="16" height="16" />
          <rect x="1280" y="48" width="14" height="14" />
          <rect x="1294" y="40" width="14" height="14" />
          <rect x="1308" y="40" width="14" height="14" />
          <rect x="1322" y="32" width="14" height="14" />
          <rect x="1336" y="40" width="14" height="14" />
        </g>
      </svg>
    </div>
  );
}
