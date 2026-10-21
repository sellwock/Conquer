// Thin fetch layer over ESPN's public JSON API, with in-memory de-duplication, a small
// localStorage cache for immutable responses, and an optional proxy prefix.
import type { LeagueId } from '../../model/types';
import { LEAGUES } from '../../model/leagues';

const SITE = 'https://site.api.espn.com';
const WEB = 'https://site.web.api.espn.com';

let proxyPrefix = '';
try {
  proxyPrefix = localStorage.getItem('conquer.proxy') ?? '';
} catch {
  /* storage unavailable */
}

export function setProxy(prefix: string) {
  proxyPrefix = prefix.trim();
  try {
    if (proxyPrefix) localStorage.setItem('conquer.proxy', proxyPrefix);
    else localStorage.removeItem('conquer.proxy');
  } catch {
    /* ignore */
  }
}
export const getProxy = () => proxyPrefix;

function resolve(host: 'site' | 'web', path: string): string {
  if (import.meta.env?.DEV && !proxyPrefix) return `/espn-${host}${path}`;
  const url = (host === 'site' ? SITE : WEB) + path;
  if (!proxyPrefix) return url;
  return proxyPrefix.includes('{url}') ? proxyPrefix.replace('{url}', encodeURIComponent(url)) : proxyPrefix + url;
}

export class DataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const inflight = new Map<string, Promise<unknown>>();

/**
 * GET a JSON document. `site` paths fall back to ESPN's mirror host (site.web.api.espn.com
 * serves the same /apis/site/v2 paths) when the primary host can't be reached.
 */
export async function getJson<T = any>(host: 'site' | 'web', path: string, opts: { signal?: AbortSignal; cacheKey?: string } = {}): Promise<T> {
  try {
    return await getJsonFrom<T>(host, path, opts);
  } catch (e) {
    if (host === 'site' && e instanceof DataError && e.status == null) return getJsonFrom<T>('web', path, opts);
    throw e;
  }
}

async function getJsonFrom<T>(host: 'site' | 'web', path: string, opts: { signal?: AbortSignal; cacheKey?: string }): Promise<T> {
  const url = resolve(host, path);
  if (opts.cacheKey) {
    const hit = readCache<T>(opts.cacheKey);
    if (hit !== undefined) return hit;
  }
  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    let res: Response;
    try {
      res = await fetch(url, { signal: opts.signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      throw new DataError('Could not reach ESPN. Check your connection, or set a data proxy under Data connection at the bottom of the page.');
    }
    // Vite's dev proxy answers 5xx when it can't reach ESPN at all: treat that as offline.
    if (!res.ok && url.startsWith('/espn-') && res.status >= 500) {
      throw new DataError('Could not reach ESPN from the dev server. Check your connection, or set a data proxy under Data connection at the bottom of the page.');
    }
    if (!res.ok) throw new DataError(`ESPN returned ${res.status} for ${path}`, res.status);
    return (await res.json()) as T;
  })();
  inflight.set(url, p);
  try {
    const v = await p;
    return v;
  } finally {
    inflight.delete(url);
  }
}

export const sitePath = (league: LeagueId, rest: string) => `/apis/site/v2/sports/basketball/${LEAGUES[league].espnPath}${rest}`;
export const webPath = (league: LeagueId, rest: string) => `/apis/common/v3/sports/basketball/${LEAGUES[league].espnPath}${rest}`;

// --- Small persistent cache for derived, immutable data (completed-game extracts) ---------------
const CACHE_PREFIX = 'conquer.c1.';

export function readCache<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeCache(key: string, value: unknown) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Quota exceeded: drop our old entries and try once more.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
      }
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value));
    } catch {
      /* give up silently */
    }
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
