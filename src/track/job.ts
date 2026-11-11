// The forward log: snapshot predictions before tip-off, grade them once games end, and keep a
// running list of final scores. Storage is abstracted so the GitHub job uses files and the tests
// use memory. Predictions are never written after tip, and never backfilled. Player props are
// logged alongside: the posted lines with the sim's chances before tip-off, and once more mid-game
// from the book's in-game feed, each saved once and graded from the final box score.
import { LEAGUES } from '../model/leagues';
import { buildSpec } from '../model/build';
import type { GameData, LeagueId, ScoreboardGame } from '../model/types';
import type { PropMarket } from '../model/parlays';
import { propMarkets, rosterNames } from '../model/props';
import { priceLiveGame } from '../model/liveMarket';
import { findNews, injuryState, priceNews } from '../model/news';
import { loadInjuries } from '../data/espn/injuries';
import { MODEL_VERSION } from '../model/version';
import { runSims } from '../sim/run';
import { runOutcomes } from '../sim/quick';
import { getJson, requestCount, sitePath } from '../data/espn/client';
import { loadGame, loadScoreboard } from '../data/espn/load';
import { loadProps } from '../data/espn/props';
import { num, parseBoxPlayers, parseOdds, periodOf, phaseOf, seasonYear } from '../data/espn/parse';
import { predictionFrom } from './predict';
import { easternYmd } from './dates';
import { buildFit, type FitFile, type PropHistory } from './fit';
import type { CloseLine, Entry, InjuryLog, LogFile, NewsSnap, PropEntry, PropLogFile, PropRow, PropSnap } from './types';

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
  /** Games whose pre-game prop lines were saved, live prop snapshots taken, and prop entries graded. */
  propsPre: number;
  propsLive: number;
  propsGraded: number;
  /** Games whose first prop snapshot was kept as their opening lines. */
  propsOpen: number;
  /** Players newly ruled out, news prop snapshots taken, and games whose closing lines were saved. */
  news: number;
  propsNews: number;
  propsClose: number;
  /** Pick-model fits rewritten (after new prop grades). */
  fit: number;
  errors: string[];
}

// GitHub runs scheduled jobs far less often than asked on quiet repos (hours apart, not every 15
// minutes), so the windows are wide: any run in the day before a game saves it, and any run in
// the last three hours refreshes it with the latest injuries and line.
const FIRST_SNAPSHOT_MIN = 30 * 60;
const REFRESH_WITHIN_MIN = 180;
const REFRESH_AFTER_MIN = 45;
const GRADE_AFTER_MIN = 120;
const GIVE_UP_AFTER_MIN = 72 * 60;
// Every game with logged props gets the pre-game book's lines once more, this close to tip, to see whether
// the lines moved after the news.
const CLOSE_WITHIN_MIN = 20;
// News the job found stays in its log this long, so the site can show it.
const NEWS_KEEP_MS = 48 * 3_600_000;
// Live props are saved once per game, mid-game: from a quarter of regulation played to three
// quarters (NBA: 2nd and 3rd quarters; college: 10:00 left in the 1st half to 10:00 left in the
// 2nd), so a run every 15 minutes or so catches each game.
const LIVE_FROM = 0.25;
const LIVE_TO = 0.75;

/** Share of regulation played; 1 once in overtime. */
export function playedShare(league: LeagueId, period: number, clockSec: number): number {
  const L = LEAGUES[league];
  if (period > L.periods) return 1;
  return ((Math.max(1, period) - 1) * L.periodSec + (L.periodSec - clockSec)) / (L.periods * L.periodSec);
}

const midGame = (league: LeagueId, period: number | undefined, clockSec: number | undefined) => {
  if (!period) return false;
  const x = playedShare(league, period, clockSec ?? 0);
  return x >= LIVE_FROM && x < LIVE_TO;
};

export { easternYmd };

export const logPath = (league: LeagueId, season: number, ymd: string) => `${league}/${season}/${ymd.slice(0, 4)}-${ymd.slice(4, 6)}.json`;
export const resultsPath = (league: LeagueId, season: number) => `results/${league}/${season}.json`;
export const propsPath = (league: LeagueId, season: number, ymd: string) => `props/${logPath(league, season, ymd)}`;
export const injuryLogPath = (league: LeagueId) => `injuries/${league}.json`;
export const fitPath = (league: LeagueId) => `fit/${league}.json`;
export const historyPath = (league: LeagueId) => `history/props/${league}.json`;

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Compact log rows from priced prop markets: the over's and the push's share of simulations. */
export function propRows(markets: PropMarket[]): PropRow[] {
  return markets.map((m) => {
    let over = 0, push = 0;
    for (const h of m.hits) {
      if (h === 1) over++;
      else if (h === 2) push++;
    }
    const n = Math.max(1, m.hits.length);
    const row: PropRow = [m.athleteId, m.stat, m.line, m.over, m.under, round(over / n, 3), round(push / n, 3), round(m.mean, 1)];
    if (m.now != null) row.push(m.now);
    return row;
  });
}

const propBase = (league: LeagueId, gd: GameData): PropEntry => ({
  id: gd.id,
  league,
  season: seasonYear(gd.date, league),
  tip: gd.date,
  home: { id: gd.home.id, abbr: gd.home.abbr },
  away: { id: gd.away.id, abbr: gd.away.abbr },
  status: 'open',
  players: {},
});

const withPlayers = (prev: PropEntry, markets: PropMarket[]): PropEntry => ({
  ...prev,
  players: { ...prev.players, ...Object.fromEntries(markets.map((m) => [m.athleteId, m.player])) },
});

/** A game's first pre-game snapshot is also kept as its opening lines; later refreshes replace only `pre`. */
const withSnap = (prev: PropEntry, markets: PropMarket[], key: 'pre' | 'live', snap: PropSnap): PropEntry => ({
  ...withPlayers(prev, markets),
  ...(key === 'pre' && !prev.pre && !prev.open ? { open: snap } : {}),
  [key]: snap,
});

/** One row per final: [yyyymmdd, homeId, awayId, homeScore, awayScore, neutral, overtime]. */
export type ResultRow = [string, string, string, number, number, boolean, boolean];

export async function runJob(o: JobOptions): Promise<JobReport> {
  const say = o.log ?? (() => {});
  const report: JobReport = { snapshots: 0, refreshed: 0, graded: 0, voided: 0, results: 0, propsPre: 0, propsLive: 0, propsGraded: 0, propsOpen: 0, news: 0, propsNews: 0, propsClose: 0, fit: 0, errors: [] };
  const files = new Map<string, Record<string, Entry | PropEntry>>();
  const dirty = new Set<string>();
  const load = (path: string) => {
    if (!files.has(path)) files.set(path, o.io.read<Record<string, Entry | PropEntry>>(path) ?? {});
    return files.get(path)!;
  };
  const file = (path: string) => load(path) as LogFile;
  const propFile = (path: string) => load(path) as PropLogFile;
  const put = (path: string, e: Entry | PropEntry) => {
    load(path)[e.id] = e;
    dirty.add(path);
  };
  const minutesUntil = (iso: string) => (Date.parse(iso) - o.now.getTime()) / 60000;
  // One summary per finished game per run, shared by the game and prop grading.
  const summaries = new Map<string, unknown>();
  const summaryOf = async (league: LeagueId, id: string) => {
    if (!summaries.has(id)) summaries.set(id, await getJson('site', sitePath(league, `/summary?event=${id}`), { noStore: true }));
    return summaries.get(id) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  };

  for (const league of o.leagues) {
    const gradedBefore = report.propsGraded;
    const today = easternYmd(o.now);
    const tomorrow = easternYmd(new Date(o.now.getTime() + 86_400_000));
    const yesterday = easternYmd(new Date(o.now.getTime() - 86_400_000));

    // --- Snapshots ---------------------------------------------------------------------------
    // Yesterday's games for live props: late tips run past midnight Eastern.
    const slate = new Map<string, ScoreboardGame>();
    for (const ymd of [yesterday, today, tomorrow]) {
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
      // A snapshot taken before the book posted a line is redone as soon as one appears, so the
      // entry can be graded against the market even if no run lands in the last three hours.
      const lineArrived = !prev?.line && !!g.odds;
      const refresh = !!prev?.pred && (mins <= REFRESH_WITHIN_MIN || lineArrived) && (o.now.getTime() - Date.parse(prev.pred.takenAt)) / 60000 > REFRESH_AFTER_MIN;
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
        // The posted prop lines, priced by the same simulation. A refresh that finds none keeps
        // what an earlier run saved, and a failure here never costs the game its snapshot.
        try {
          const po = s.outcomes.players;
          const board = po ? await loadProps(league, g.id) : undefined;
          const markets = po && board?.lines.length ? propMarkets(board.lines, po, rosterNames(gd)) : [];
          if (markets.length) {
            const pp = propsPath(league, seasonYear(gd.date, league), ymd);
            const prevP = propFile(pp)[g.id] ?? propBase(league, gd);
            const next = withSnap(prevP, markets, 'pre', { model: MODEL_VERSION, takenAt: o.now.toISOString(), provider: board!.provider, n: s.n, rows: propRows(markets) });
            put(pp, next);
            report.propsPre++;
            if (next.open && !prevP.open) report.propsOpen++;
          }
        } catch (e) {
          // No odds posted for the game reads as a 404, which just means no props.
          if ((e as { status?: number }).status !== 404) report.errors.push(`${league} ${g.id} props: ${(e as Error).message}`);
        }
      } catch (e) {
        report.errors.push(`${league} ${g.id}: ${(e as Error).message}`);
      }
    }

    // --- Live props --------------------------------------------------------------------------
    // College, as above, only with a posted line; and the in-game prop feed is checked (one or two
    // requests) before the game itself is loaded.
    const live = [...slate.values()]
      .filter((g) => g.phase === 'in' && midGame(league, g.period, g.clockSec) && (league === 'nba' || !!g.odds))
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
    for (const g of live) {
      const ymd = easternYmd(new Date(g.date));
      const pp = propsPath(league, seasonYear(g.date, league), ymd);
      const prevP = propFile(pp)[g.id];
      if (prevP?.live) continue;
      if (requestCount() > o.budget) {
        report.errors.push(`${league}: request budget reached; live props for ${g.away.abbr} @ ${g.home.abbr} skipped`);
        break;
      }
      try {
        if (!(await loadProps(league, g.id, undefined, true)).lines.length) continue;
        const loaded = await loadGame(league, g.id, { sampleGames: o.sampleGames });
        const r = await priceLiveGame(league, g.id, loaded, `${g.id}-live`, (spec, n, seed, opts) => runOutcomes(spec, n, seed, opts), undefined, o.sims);
        const gd = r.game;
        const markets = r.market?.props ?? [];
        if (gd.phase !== 'in' || !midGame(league, gd.period, gd.clockSec) || !markets.length) continue;
        put(
          pp,
          withSnap(prevP ?? propBase(league, gd), markets, 'live', {
            model: MODEL_VERSION,
            takenAt: o.now.toISOString(),
            provider: r.market!.propsProvider,
            n: r.market!.margin.length,
            rows: propRows(markets),
            at: { period: gd.period, clockSec: gd.clockSec, home: gd.homeScore ?? 0, away: gd.awayScore ?? 0 },
          }),
        );
        report.propsLive++;
        say(`live     ${league} ${g.away.abbr} @ ${g.home.abbr} (${gd.statusText}): ${markets.length} props`);
      } catch (e) {
        if ((e as { status?: number }).status !== 404) report.errors.push(`${league} ${g.id} live props: ${(e as Error).message}`);
      }
    }

    // --- Injury news (NBA) ---------------------------------------------------------------------
    // Players newly ruled out since the last run, for games that haven't tipped: their game's prop
    // lines priced right away with them out, and with them in, so the record can show whether the
    // book's props had caught up.
    if (league === 'nba') {
      try {
        const feed = await loadInjuries(league);
        const prevLog = o.io.read<InjuryLog>(injuryLogPath(league));
        const events = findNews(feed, prevLog?.players, [...slate.values()], o.now.getTime());
        const kept = (prevLog?.events ?? []).filter((e) => o.now.getTime() - Date.parse(e.seenAt) < NEWS_KEEP_MS);
        for (const e of events) {
          kept.push({ ...e, seenAt: o.now.toISOString() });
          report.news++;
          if (requestCount() > o.budget) {
            report.errors.push(`${league}: request budget reached; news for ${e.name} skipped`);
            continue;
          }
          try {
            const p = await priceNews(league, e, feed, (spec, n, seed, opts) => runOutcomes(spec, n, seed, opts), { sims: o.sims, sampleGames: o.sampleGames });
            if (!p || !p.out.length) continue;
            const pp = propsPath(league, seasonYear(p.game.date, league), easternYmd(new Date(p.game.date)));
            const prevP = propFile(pp)[e.gameId] ?? propBase(league, p.game);
            const rows = propRows(p.out);
            const snap: NewsSnap = {
              model: MODEL_VERSION,
              takenAt: o.now.toISOString(),
              provider: p.provider,
              n: p.sims,
              rows,
              out: { athleteId: e.athleteId, name: e.name, status: e.status, ...(e.since ? { since: e.since } : {}), minutes: round(p.minutes, 1) },
              meanWith: rows.map(([id, stat]) => round(p.withMeans.get(`${id}|${stat}`) ?? NaN, 1)),
            };
            put(pp, { ...withPlayers(prevP, p.out), news: [...(prevP.news ?? []).filter((n) => n.out.athleteId !== e.athleteId), snap] });
            report.propsNews++;
            say(`news     ${league} ${e.name} out for ${p.label}: ${rows.length} props, ${p.rows.filter((r) => r.pick).length} picks`);
          } catch (err) {
            if ((err as { status?: number }).status !== 404) report.errors.push(`${league} news ${e.name}: ${(err as Error).message}`);
          }
        }
        o.io.write(injuryLogPath(league), { updatedAt: o.now.toISOString(), players: injuryState(feed), events: kept } satisfies InjuryLog);
      } catch (e) {
        report.errors.push(`${league} injuries: ${(e as Error).message}`);
      }

    }

    // --- Closing lines -----------------------------------------------------------------------
    // Every game with logged props gets the book's lines once more just before tip: whether a
    // pick's line then moved its way is the quickest sign of an edge.
    for (const g of slate.values()) {
      const mins = minutesUntil(g.date);
      if (g.phase !== 'pre' || mins <= 0 || mins > CLOSE_WITHIN_MIN) continue;
      const pp = propsPath(league, seasonYear(g.date, league), easternYmd(new Date(g.date)));
      const entry = propFile(pp)[g.id];
      if (!entry || entry.close || !(entry.pre || entry.news?.length)) continue;
      if (requestCount() > o.budget) {
        report.errors.push(`${league}: request budget reached; closing props for ${g.away.abbr} @ ${g.home.abbr} skipped`);
        break;
      }
      try {
        const board = await loadProps(league, g.id);
        if (!board.lines.length) continue;
        const lines: CloseLine[] = board.lines.map((l) => [l.athleteId, l.stat, l.line, l.over, l.under]);
        put(pp, { ...entry, close: { takenAt: o.now.toISOString(), lines } });
        report.propsClose++;
      } catch (err) {
        if ((err as { status?: number }).status !== 404) report.errors.push(`${league} ${g.id} closing props: ${(err as Error).message}`);
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
          const summary = await summaryOf(league, e.id);
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

    // Prop entries: each logged player's final line from the box score, or void if they sat.
    for (const path of [...months].map((m) => `props/${m}`)) {
      for (const e of Object.values(propFile(path))) {
        if (e.status !== 'open') continue;
        const since = -minutesUntil(e.tip);
        if (since < GRADE_AFTER_MIN) continue;
        try {
          const summary = await summaryOf(league, e.id);
          const comp = summary?.header?.competitions?.[0];
          const st = comp?.status?.type ?? {};
          if (/POSTPONED|CANCELED|CANCELLED|FORFEIT/i.test(String(st.name ?? ''))) {
            put(path, { ...e, status: 'void' });
            continue;
          }
          if (phaseOf(st.state) === 'post' && st.completed !== false) {
            const lines = new Map(Object.values(parseBoxPlayers(summary)).flat().map((b) => [b.id, b]));
            const box: NonNullable<PropEntry['box']> = {};
            for (const id of Object.keys(e.players)) {
              const b = lines.get(id);
              box[id] = b?.played ? [b.box.pts, b.box.oreb + b.box.dreb, b.box.ast, b.box.tpm] : null;
            }
            put(path, { ...e, status: 'final', box, gradedAt: o.now.toISOString() });
            report.propsGraded++;
            continue;
          }
          if (since > GIVE_UP_AFTER_MIN) put(path, { ...e, status: 'void' });
        } catch (err) {
          report.errors.push(`grade props ${league} ${e.id}: ${(err as Error).message}`);
        }
      }
    }

    // --- Pick model --------------------------------------------------------------------------
    // Refit from every graded prop line of the league whenever new grades came in (or no fit
    // exists yet): the site prices props with it and shows its out-of-sample record.
    try {
      const listed = o.io.read<{ files: string[] }>('index.json')?.files ?? [];
      const propPaths = [...new Set([...listed, ...dirty])].filter((f) => f.startsWith(`props/${league}/`));
      // A re-simulation of the season by the current model, when scripts/props-backtest.ts has made one.
      const history = o.io.read<PropHistory>(historyPath(league));
      const had = o.io.read<FitFile>(fitPath(league));
      const usable = history?.model === MODEL_VERSION && history.entries.length ? history : undefined;
      const stale = !had || had.history?.updatedAt !== usable?.updatedAt;
      if (propPaths.length && (report.propsGraded > gradedBefore || stale)) {
        o.io.write(fitPath(league), buildFit(propPaths.flatMap((f) => Object.values(propFile(f))), league, o.now, { model: MODEL_VERSION, history: usable }));
        report.fit++;
        say(`fit      ${league}: refit the pick model from ${propPaths.length} prop log file${propPaths.length === 1 ? '' : 's'}`);
      }
    } catch (e) {
      report.errors.push(`${league} fit: ${(e as Error).message}`);
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

function sortKeys<T>(f: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(f).sort(([a], [b]) => a.localeCompare(b)));
}
