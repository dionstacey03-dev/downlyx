const configuredBase = import.meta.env.VITE_API_BASE_URL?.trim() || '';

function normalizeApiBase(value: string): string {
  if (!value) return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

const API_BASE = normalizeApiBase(configuredBase);

/**
 * Resolve same-origin API paths or an explicitly configured external API host.
 * Configure VITE_API_BASE_URL (e.g. https://api.example.com) at build time
 * when the frontend and Express API are deployed separately.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith('/api/')) {
    throw new Error('apiUrl only accepts /api/ paths.');
  }
  return API_BASE ? `${API_BASE}${path}` : path;
}

export const isApiBaseConfigured = Boolean(API_BASE);
