// Reads the forward log the scheduled job writes to the `data` branch.
import type { LeagueId } from '../model/types';
import type { FitFile } from './fit';
import type { Entry, InjuryLog, LogFile, PropEntry, PropLogFile } from './types';

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

/** The player-prop log: posted lines with the sim's chances, before tip-off and mid-game. */
export async function loadPropLog(league: LeagueId, signal?: AbortSignal): Promise<PropEntry[]> {
  const index = await getData<{ files: string[] }>('index.json', signal);
  const files = (index?.files ?? []).filter((f) => f.startsWith(`props/${league}/`));
  const logs = await Promise.all(files.map((f) => getData<PropLogFile>(f, signal)));
  return logs.flatMap((l) => Object.values(l ?? {})).sort((a, b) => Date.parse(b.tip) - Date.parse(a.tip));
}

/** The last injury report the scheduled job saw, and the news it found (NBA). */
export async function loadInjuryLog(league: LeagueId, signal?: AbortSignal): Promise<InjuryLog | undefined> {
  return getData<InjuryLog>(`injuries/${league}.json`, signal);
}

/** The pick model the scheduled job fits to the graded props, with its out-of-sample record. */
export async function loadFit(league: LeagueId, signal?: AbortSignal): Promise<FitFile | undefined> {
  return getData<FitFile>(`fit/${league}.json`, signal);
}
