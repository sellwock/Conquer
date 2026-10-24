// Reads the forward log the scheduled job writes to the `data` branch.
import type { LeagueId } from '../model/types';
import type { Entry, LogFile } from './types';

const BASES = ['https://raw.githubusercontent.com/sellwock/Conquer/data/v1', 'https://cdn.jsdelivr.net/gh/sellwock/Conquer@data/v1'];

export interface LogStatus {
  lastRun: string | null;
  model: string | null;
  snapshots?: number;
  refreshed?: number;
  graded?: number;
  errors?: string[];
}

export interface ForwardLog {
  status?: LogStatus;
  entries: Entry[];
}

async function getData<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
  let lastError: unknown;
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${path}`, { signal });
      if (res.status === 404) return undefined;
      if (res.ok) return (await res.json()) as T;
      lastError = new Error(`The log returned ${res.status}`);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not reach the prediction log.');
}

export async function loadForwardLog(league: LeagueId, signal?: AbortSignal): Promise<ForwardLog> {
  const [index, status] = await Promise.all([getData<{ files: string[] }>('index.json', signal), getData<LogStatus>('status.json', signal)]);
  const files = (index?.files ?? []).filter((f) => f.startsWith(`${league}/`));
  const logs = await Promise.all(files.map((f) => getData<LogFile>(f, signal)));
  const entries = logs.flatMap((l) => Object.values(l ?? {})).sort((a, b) => Date.parse(b.tip) - Date.parse(a.tip));
  return { status, entries };
}
