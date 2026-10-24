// The forward log: snapshot predictions before tip-off, grade them once games end, and keep a
// running list of final scores. Storage is abstracted so the GitHub job uses files and the tests
// use memory. Predictions are never written after tip, and never backfilled.
import { LEAGUES } from '../model/leagues';
import { buildSpec } from '../model/build';
import type { LeagueId, ScoreboardGame } from '../model/types';
import { MODEL_VERSION } from '../model/version';
import { runSims } from '../sim/run';
import { getJson, requestCount, sitePath } from '../data/espn/client';
import { loadGame, loadScoreboard } from '../data/espn/load';
import { num, parseOdds, periodOf, phaseOf, seasonYear } from '../data/espn/parse';
import { predictionFrom } from './predict';
import type { Entry, LogFile } from './types';

export interface LogIO {
  read<T>(path: string): T | undefined;
  write(path: string, data: unknown): void;
}

export interface JobOptions {
  now: Date;
  io: LogIO;
  leagues: LeagueId[];
  /** Stop starting new snapshots once this many ESPN requests have been made in this run. */
  budget: number;
  sims: number;
  sampleGames: number;
  log?: (msg: string) => void;
}

export interface JobReport {
  snapshots: number;
  refreshed: number;
  graded: number;
  voided: number;
  results: number;
  errors: string[];
}

const FIRST_SNAPSHOT_MIN = 12 * 60;
const REFRESH_WITHIN_MIN = 90;
const REFRESH_AFTER_MIN = 25;
const GRADE_AFTER_MIN = 120;
const GIVE_UP_AFTER_MIN = 72 * 60;

/** yyyymmdd of an instant in US Eastern time, which is how ESPN's scoreboard splits days. */
export function easternYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}

export const logPath = (league: LeagueId, season: number, ymd: string) => `${league}/${season}/${ymd.slice(0, 4)}-${ymd.slice(4, 6)}.json`;
export const resultsPath = (league: LeagueId, season: number) => `results/${league}/${season}.json`;

/** One row per final: [yyyymmdd, homeId, awayId, homeScore, awayScore, neutral, overtime]. */
export type ResultRow = [string, string, string, number, number, boolean, boolean];

export async function runJob(o: JobOptions): Promise<JobReport> {
  const report: JobReport = { snapshots: 0, refreshed: 0, graded: 0, voided: 0, results: 0, errors: [] };
  const say = o.log ?? (() => {});
  const files = new Map<string, LogFile>();
  const dirty = new Set<string>();
  const file = (path: string) => {
    if (!files.has(path)) files.set(path, o.io.read<LogFile>(path) ?? {});
    return files.get(path)!;
  };
  const put = (path: string, e: Entry) => {
    file(path)[e.id] = e;
    dirty.add(path);
  };
  const minutesUntil = (iso: string) => (Date.parse(iso) - o.now.getTime()) / 60000;

  for (const league of o.leagues) {
    const today = easternYmd(o.now);
    const tomorrow = easternYmd(new Date(o.now.getTime() + 86_400_000));
    const yesterday = easternYmd(new Date(o.now.getTime() - 86_400_000));

    // --- Snapshots ---------------------------------------------------------------------------
    const slate = new Map<string, ScoreboardGame>();
    for (const ymd of [today, tomorrow]) {
      try {
        for (const g of await loadScoreboard(league, ymd)) slate.set(g.id, g);
      } catch (e) {
        report.errors.push(`${league} scoreboard ${ymd}: ${(e as Error).message}`);
      }
    }
    const upcoming = [...slate.values()]
      .filter((g) => g.phase === 'pre' && minutesUntil(g.date) > 0)
      // College logs only games with a posted line; there are too many otherwise.
      .filter((g) => league === 'nba' || !!g.odds)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (const g of upcoming) {
      const mins = minutesUntil(g.date);
      const ymd = easternYmd(new Date(g.date));
      const path = logPath(league, seasonYear(g.date, league), ymd);
      const prev = file(path)[g.id];
      const first = !prev?.pred && mins <= FIRST_SNAPSHOT_MIN;
      const refresh = !!prev?.pred && mins <= REFRESH_WITHIN_MIN && (o.now.getTime() - Date.parse(prev.pred.takenAt)) / 60000 > REFRESH_AFTER_MIN;
      if (!first && !refresh) continue;
      if (requestCount() > o.budget) {
        report.errors.push(`${league}: request budget reached; ${g.away.abbr} @ ${g.home.abbr} skipped`);
        break;
      }
      try {
        const gd = await loadGame(league, g.id, { sampleGames: o.sampleGames });
        if (gd.phase !== 'pre' || minutesUntil(gd.date) <= 0) continue;
        const built = buildSpec(gd, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
        const s = runSims(built.spec, o.sims, g.id);
        put(path, {
          id: g.id,
          league,
          season: seasonYear(gd.date, league),
          tip: gd.date,
          home: { id: gd.home.id, abbr: gd.home.abbr },
          away: { id: gd.away.id, abbr: gd.away.abbr },
          neutral: gd.neutral,
          status: 'open',
          pred: predictionFrom(s, built, o.now, gd.date),
          line: gd.odds ? { ...gd.odds, fetchedAt: o.now.toISOString() } : undefined,
        });
        if (first) report.snapshots++;
        else report.refreshed++;
        say(`${first ? 'snapshot' : 'refresh '} ${league} ${g.away.abbr} @ ${g.home.abbr} (${Math.round(mins)} min to tip)`);
      } catch (e) {
        report.errors.push(`${league} ${g.id}: ${(e as Error).message}`);
      }
    }

    // --- Grading -----------------------------------------------------------------------------
    // Open entries live in this month's file or last month's.
    const months = new Set([today, easternYmd(new Date(o.now.getTime() - 4 * 86_400_000))].map((d) => logPath(league, seasonYear(isoOf(d), league), d)));
    for (const path of months) {
      for (const e of Object.values(file(path))) {
        if (e.status !== 'open') continue;
        const since = -minutesUntil(e.tip);
        if (since < GRADE_AFTER_MIN) continue;
        try {
          const summary = await getJson('site', sitePath(league, `/summary?event=${e.id}`), { noStore: true });
          const comp = summary?.header?.competitions?.[0];
          const st = comp?.status?.type ?? {};
          const name = String(st.name ?? '');
          if (/POSTPONED|CANCELED|CANCELLED|FORFEIT/i.test(name)) {
            put(path, { ...e, status: 'void' });
            report.voided++;
            continue;
          }
          if (phaseOf(st.state) === 'post' && st.completed !== false) {
            const cs: { homeAway?: string; score?: unknown }[] = comp?.competitors ?? [];
            const home = num(cs.find((c) => c.homeAway === 'home')?.score);
            const away = num(cs.find((c) => c.homeAway === 'away')?.score);
            const close = parseOdds(summary, e.home.id);
            put(path, {
              ...e,
              status: 'final',
              result: { home, away, ot: periodOf(comp, LEAGUES[league].periods) > LEAGUES[league].periods, gradedAt: o.now.toISOString() },
              closeReported: close ? { ...close, fetchedAt: o.now.toISOString() } : undefined,
            });
            report.graded++;
            continue;
          }
          if (since > GIVE_UP_AFTER_MIN) {
            put(path, { ...e, status: 'void' });
            report.voided++;
          }
        } catch (err) {
          report.errors.push(`grade ${league} ${e.id}: ${(err as Error).message}`);
        }
      }
    }

    // --- Results ----------------------------------------------------------------------------
    try {
      const finals = (await loadScoreboard(league, yesterday)).filter((g) => g.phase === 'post' && g.home.score != null && g.away.score != null);
      if (finals.length) {
        const path = resultsPath(league, seasonYear(isoOf(yesterday), league));
        const rows = o.io.read<ResultRow[]>(path) ?? [];
        const have = new Set(rows.map((r) => `${r[0]}|${r[1]}|${r[2]}`));
        let added = 0;
        for (const g of finals) {
          const key = `${yesterday}|${g.home.id}|${g.away.id}`;
          if (have.has(key)) continue;
          rows.push([yesterday, g.home.id, g.away.id, g.home.score!, g.away.score!, g.neutral, /OT/i.test(g.statusText)]);
          have.add(key);
          added++;
        }
        if (added) {
          o.io.write(path, rows);
          report.results += added;
        }
      }
    } catch (e) {
      report.errors.push(`${league} results ${yesterday}: ${(e as Error).message}`);
    }
  }

  for (const path of dirty) o.io.write(path, sortKeys(files.get(path)!));
  // The site can't list folders on raw.githubusercontent.com, so keep an index of log files.
  const index = o.io.read<{ files: string[] }>('index.json') ?? { files: [] };
  const all = [...new Set([...index.files, ...dirty])].sort();
  if (all.length !== index.files.length) o.io.write('index.json', { files: all });
  o.io.write('status.json', { lastRun: o.now.toISOString(), model: MODEL_VERSION, requests: requestCount(), ...report });
  return report;
}

const isoOf = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T17:00:00Z`;

function sortKeys(f: LogFile): LogFile {
  return Object.fromEntries(Object.entries(f).sort(([a], [b]) => a.localeCompare(b)));
}
