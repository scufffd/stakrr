/**
 * Stakrr REST API base URL.
 * - Leave `VITE_API_URL` unset to use same-origin paths like `/api/tokens` (Vite dev
 *   `server.proxy` or production same host).
 * - Set `VITE_API_URL=http://127.0.0.1:3060` when the proxy is unavailable (worker must
 *   send `Access-Control-Allow-Origin` — Stakrr worker already uses `*`).
 */
export function apiUrl(path) {
  const raw = (import.meta.env.VITE_API_URL || '').trim().replace(/\/$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  if (!raw) return p;
  return `${raw}${p}`;
}
