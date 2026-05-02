// Tiny path-based router. Replaces (and is compatible with) the previous
// state-based "tab" navigation in App.jsx. Goals:
//   - real URLs in the address bar so users can deep-link & share
//   - back/forward browser buttons work
//   - SPA-only: nginx falls back any unknown path to /index.html
//   - no extra runtime dependency (vs. react-router-dom, which would bring
//     ~30kb gzipped for what amounts to one dynamic segment)
//
// Routes:
//   /                  → home tab
//   /launch            → launch tab
//   /me                → profile tab
//   /docs              → docs tab
//   /token/:mint       → token detail tab (PoolView wrapper)
//
// Anything else falls back to home. Unknown :mint values render a 404 inside
// the token tab.

import { useEffect, useState, useCallback } from 'react';

const VALID_TABS = new Set(['home', 'launch', 'profile', 'docs', 'token', 'admin-presale', 'admin-snipe']);

/**
 * Parse a pathname into { tab, mint }. Pure function — easy to test.
 */
export function parsePath(pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '') return { tab: 'home', mint: null };
  if (clean === '/launch') return { tab: 'launch', mint: null };
  if (clean === '/me' || clean === '/profile') return { tab: 'profile', mint: null };
  if (clean === '/docs') return { tab: 'docs', mint: null };
  if (clean === '/admin/presale') return { tab: 'admin-presale', mint: null };
  const adminPresaleMint = clean.match(/^\/admin\/presale\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (adminPresaleMint) return { tab: 'admin-presale', mint: adminPresaleMint[1] };
  if (clean === '/admin/snipe') return { tab: 'admin-snipe', mint: null };
  const tokenMatch = clean.match(/^\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
  if (tokenMatch) return { tab: 'token', mint: tokenMatch[1] };
  return { tab: 'home', mint: null };
}

/**
 * Inverse of parsePath. Used by `navigate({ tab, mint })` and link href props
 * so we have a single source of truth.
 */
export function buildPath({ tab, mint } = {}) {
  if (!tab || !VALID_TABS.has(tab)) return '/';
  if (tab === 'home') return '/';
  if (tab === 'launch') return '/launch';
  if (tab === 'profile') return '/me';
  if (tab === 'docs') return '/docs';
  if (tab === 'admin-presale') return mint ? `/admin/presale/${mint}` : '/admin/presale';
  if (tab === 'admin-snipe') return '/admin/snipe';
  if (tab === 'token' && mint) return `/token/${mint}`;
  return '/';
}

/**
 * Hook returning the current route + a `navigate` helper. Listens to popstate
 * so back/forward keep state in sync.
 */
export function useRouter() {
  const [route, setRoute] = useState(() =>
    parsePath(typeof window !== 'undefined' ? window.location.pathname : '/'),
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handler = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  const navigate = useCallback((next, opts = {}) => {
    const target = buildPath(next);
    if (typeof window === 'undefined') return;
    if (window.location.pathname === target) return;
    if (opts.replace) {
      window.history.replaceState(null, '', target);
    } else {
      window.history.pushState(null, '', target);
    }
    setRoute(parsePath(target));
    if (opts.scrollTop !== false) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  return { route, navigate };
}
