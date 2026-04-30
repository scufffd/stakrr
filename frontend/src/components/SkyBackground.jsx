import React from 'react';

/** Pixel-style cumulus (original SVG — evokes convodesign101 sky clouds). */
function PixelCloud({ className = '', style = {} }) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 120 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <title hidden>cloud</title>
      <g fill="#ffffff">
        <rect x="8" y="32" width="8" height="8" />
        <rect x="16" y="24" width="8" height="8" />
        <rect x="24" y="24" width="8" height="8" />
        <rect x="32" y="16" width="8" height="8" />
        <rect x="40" y="16" width="8" height="8" />
        <rect x="48" y="16" width="8" height="8" />
        <rect x="56" y="16" width="8" height="8" />
        <rect x="64" y="16" width="8" height="8" />
        <rect x="72" y="24" width="8" height="8" />
        <rect x="80" y="24" width="8" height="8" />
        <rect x="88" y="32" width="8" height="8" />
        <rect x="24" y="32" width="8" height="8" />
        <rect x="32" y="32" width="8" height="8" />
        <rect x="40" y="32" width="8" height="8" />
        <rect x="48" y="32" width="8" height="8" />
        <rect x="56" y="32" width="8" height="8" />
        <rect x="64" y="32" width="8" height="8" />
        <rect x="72" y="32" width="8" height="8" />
        <rect x="40" y="40" width="8" height="8" />
        <rect x="48" y="40" width="8" height="8" />
        <rect x="56" y="40" width="8" height="8" />
        <rect x="64" y="40" width="8" height="8" />
      </g>
    </svg>
  );
}

function PixelCloudSmall({ className = '', style = {} }) {
  return (
    <svg className={className} style={style} viewBox="0 0 72 40" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <g fill="#ffffff">
        <rect x="4" y="20" width="6" height="6" />
        <rect x="10" y="14" width="6" height="6" />
        <rect x="16" y="14" width="6" height="6" />
        <rect x="22" y="8" width="6" height="6" />
        <rect x="28" y="8" width="6" height="6" />
        <rect x="34" y="8" width="6" height="6" />
        <rect x="40" y="8" width="6" height="6" />
        <rect x="46" y="14" width="6" height="6" />
        <rect x="52" y="20" width="6" height="6" />
        <rect x="16" y="20" width="6" height="6" />
        <rect x="22" y="20" width="6" height="6" />
        <rect x="28" y="20" width="6" height="6" />
        <rect x="34" y="20" width="6" height="6" />
        <rect x="40" y="20" width="6" height="6" />
        <rect x="28" y="26" width="6" height="6" />
        <rect x="34" y="26" width="6" height="6" />
      </g>
    </svg>
  );
}

/**
 * Fixed decorative layer: sky colour + scattered pixel clouds.
 * Does not include main sky body colour (that’s on `body`) so content can scroll over consistent blue.
 */
export default function SkyBackground() {
  return (
    <div className="sky-background" aria-hidden>
      <PixelCloud className="sky-cloud sky-cloud--a" />
      <PixelCloudSmall className="sky-cloud sky-cloud--b" />
      <PixelCloud className="sky-cloud sky-cloud--c" />
      <PixelCloudSmall className="sky-cloud sky-cloud--d" />
      <PixelCloud className="sky-cloud sky-cloud--e" />
    </div>
  );
}
