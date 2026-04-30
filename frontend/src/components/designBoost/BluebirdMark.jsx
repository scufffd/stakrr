import React from 'react';

/** Public asset — also used as favicon in `index.html`. */
export const BLUEBIRD_SRC = '/bluebird.png';

/**
 * Square mascot mark (cyan field + cloud character). Use next to the wordmark or alone as an icon.
 * Pass `fluid` so the image scales to the parent width (e.g. hero).
 */
export default function BluebirdMark({ size = 40, fluid = false, className = '', style = {}, alt = 'Stakrr mascot', ...rest }) {
  const radius = fluid ? '18%' : Math.max(8, size * 0.22);
  const base = {
    borderRadius: radius,
    objectFit: 'cover',
    flexShrink: 0,
    boxShadow: '0 4px 14px rgba(0, 60, 80, 0.18)',
    ...style,
  };
  if (fluid) {
    return (
      <img
        src={BLUEBIRD_SRC}
        alt={alt}
        className={className}
        style={{ width: '100%', height: 'auto', aspectRatio: '1', display: 'block', ...base }}
        {...rest}
      />
    );
  }
  return (
    <img
      src={BLUEBIRD_SRC}
      alt={alt}
      width={size}
      height={size}
      className={className}
      style={base}
      {...rest}
    />
  );
}
