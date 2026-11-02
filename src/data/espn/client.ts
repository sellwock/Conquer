// Thin fetch layer over ESPN's public JSON API, with in-memory de-duplication, a small persistent
// cache for immutable responses, retries, and an optional proxy prefix. Runs in the browser and,
// for the forward-log job, under Node (which swaps in its own store with setStore).
import type { LeagueId } from '../../model/types';
import { LEAGUES } from '../../model/leagues';

const SITE = 'https://site.api.espn.com';
const WEB = 'https://site.web.api.espn.com';
const CORE = 'https://sports.core.api.espn.com';
const HOSTS = { site: SITE, web: WEB, core: CORE };
export type Host = keyof typeof HOSTS;

// --- Pluggable storage and fetch --------------------------------------------------------------

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  /** Drops every key with this prefix (used when the store is full). */
  clearPrefix(prefix: string): void;
}

const browserStore: KeyValueStore = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    localStorage.setItem(key, value);
  },
  clearPrefix(prefix) {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(prefix)) localStorage.removeItem(k);
      }
    } catch {
      /* storage unavailable */
    }
  },
};

let store: KeyValueStore = browserStore;
let fetchImpl: typeof fetch = (...args) => fetch(...args);
let requests = 0;

export function setStore(s: KeyValueStore) {
  store = s;
}
export function setFetch(f: typeof fetch) {
  fetchImpl = f;
}
/** Network requests made so far (the forward-log job budgets these). */
export const requestCount = () => requests;

// --- Proxy ------------------------------------------------------------------------------------

let proxyPrefix = store.get('conquer.proxy') ?? '';

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

function resolve(host: Host, path: string): string {
  // Vite's dev server proxies ESPN; only a browser page served by it can use that path.
  if (import.meta.env?.DEV && typeof window !== 'undefined' && !proxyPrefix) return `/espn-${host}${path}`;
  const url = HOSTS[host] + path;
  if (!proxyPrefix) return url;
  return proxyPrefix.includes('{url}') ? proxyPrefix.replace('{url}', encodeURIComponent(url)) : proxyPrefix + url;
}

export class DataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface GetOptions {
  signal?: AbortSignal;
  cacheKey?: string;
  /** Skip HTTP caches (live refresh). */
  noStore?: boolean;
}

const inflight = new Map<string, Promise<unknown>>();
const RETRY_DELAYS = [600, 1800];

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/**
 * GET a JSON document. `site` paths fall back to ESPN's mirror host (site.web.api.espn.com
 * serves the same /apis/site/v2 paths) when the primary host can't be reached.
 */
export async function getJson<T = any>(host: Host, path: string, opts: GetOptions = {}): Promise<T> {
  try {
    return await getJsonFrom<T>(host, path, opts);
  } catch (e) {
    if (host === 'site' && e instanceof DataError && e.status == null) return getJsonFrom<T>('web', path, opts);
    throw e;
  }
}

async function getJsonFrom<T>(host: Host, path: string, opts: GetOptions): Promise<T> {
  const url = resolve(host, path);
  if (opts.cacheKey) {
    const hit = readCache<T>(opts.cacheKey);
    if (hit !== undefined) return hit;
  }
  const key = opts.noStore ? `${url}#live` : url;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        requests++;
        res = await fetchImpl(url, { signal: opts.signal, cache: opts.noStore ? 'no-store' : undefined });
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        throw new DataError('Could not reach ESPN. Check your connection, or set a data proxy under Data connection at the bottom of the page.');
      }
      // Vite's dev proxy answers 5xx when it can't reach ESPN at all: treat that as offline.
      if (!res.ok && url.startsWith('/espn-') && res.status >= 500) {
        throw new DataError('Could not reach ESPN from the dev server. Check your connection, or set a data proxy under Data connection at the bottom of the page.');
      }
      // Rate limits and server hiccups get a couple of spaced retries.
      if ((res.status === 429 || res.status >= 500) && attempt < RETRY_DELAYS.length) {
        await sleep(RETRY_DELAYS[attempt] * (1 + Math.random() * 0.3), opts.signal);
        continue;
      }
      if (!res.ok) throw new DataError(`ESPN returned ${res.status} for ${path}`, res.status);
      return (await res.json()) as T;
    }
  })();
  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

export const sitePath = (league: LeagueId, rest: string) => `/apis/site/v2/sports/basketball/${LEAGUES[league].espnPath}${rest}`;
export const webPath = (league: LeagueId, rest: string) => `/apis/common/v3/sports/basketball/${LEAGUES[league].espnPath}${rest}`;
export const corePath = (league: LeagueId, rest: string) => `/v2/sports/basketball/leagues/${LEAGUES[league].espnPath}${rest}`;

// --- Small persistent cache for derived, immutable data (completed-game extracts) ---------------
const CACHE_PREFIX = 'conquer.c1.';

export function readCache<T>(key: string): T | undefined {
  try {
    const raw = store.get(CACHE_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function writeCache(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  try {
    store.set(CACHE_PREFIX + key, raw);
  } catch {
    // Quota exceeded: drop our old entries and try once more.
    try {
      store.clearPrefix(CACHE_PREFIX);
      store.set(CACHE_PREFIX + key, raw);
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
