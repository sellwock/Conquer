// The NFL half of the props replay (scripts/props-backtest.ts): every finished NFL game this
// season, its DraftKings lines as ESPN kept them (closing and opening, no prices), priced by the
// NFL prop model from each player's game log before kickoff, and graded from the box score.
import { getJson, mapLimit, requestCount, sitePath, type KeyValueStore } from '../src/data/espn/client';
import { loadNflGamelog, parseNflBox, type NflGameLog } from '../src/data/espn/nfl';
import { parseOdds, seasonYear } from '../src/data/espn/parse';
import { loadProps, type PropLine } from '../src/data/espn/props';
import { impliedPoints, nflPropMarkets, NFL_SIMS } from '../src/model/nfl/props';
import { NFL_MODEL_VERSION } from '../src/model/version';
import { propRows } from '../src/track/job';
import { NFL_BOX } from '../src/track/propGrade';
import type { PropEntry, PropRow } from '../src/track/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

interface Opts {
  max: number;
  book: RegExp;
  store: KeyValueStore;
  archived: Map<string, { provider: string; lines: PropLine[] }>;
}

export async function nflReplay(o: Opts): Promise<{ entries: PropEntry[]; skipped: Record<string, number>; fromArchive: number }> {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => void (skipped[why] = (skipped[why] ?? 0) + 1);

  // --- Finished games, week by week --------------------------------------------------------------
  const now: J = await getJson('site', sitePath('nfl', '/scoreboard'));
  const season = Number(now?.season?.year);
  const week = Number(now?.week?.number) || 1;
  const games: { id: string; date: string }[] = [];
  for (let w = 1; w <= week; w++) {
    const sb: J = await getJson('site', sitePath('nfl', `/scoreboard?dates=${season}&seasontype=2&week=${w}`)).catch(() => undefined);
    for (const e of sb?.events ?? []) if (e?.status?.type?.completed) games.push({ id: String(e.id), date: String(e.date) });
  }
  games.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const refs = games.slice(-o.max);
  console.log(`nfl: ${games.length} finished games in season ${season} through week ${week}; using ${refs.length}.`);

  // Each player's game log is fetched once for the whole replay; it holds every game, filtered by date when priced.
  const logs = new Map<string, Promise<NflGameLog[]>>();
  const logOf = (id: string) => {
    if (!logs.has(id)) logs.set(id, loadNflGamelog(id, season).catch(() => []));
    return logs.get(id)!;
  };

  const entries: PropEntry[] = [];
  let done = 0, fromArchive = 0;
  const t0 = Date.now();
  await mapLimit(refs, 3, async (r) => {
    try {
      const key = `props-history:nfl:${r.id}`;
      let board = JSON.parse(o.store.get(key) ?? 'null') as { provider?: string; lines: PropLine[] } | null;
      if (!board) {
        const b = await loadProps('nfl', r.id).catch(() => ({ provider: undefined, lines: [] as PropLine[] }));
        board = { provider: b.provider, lines: b.lines };
        if (b.lines.length) o.store.set(key, JSON.stringify(board));
      }
      if (!board.lines.length && o.archived.has(r.id)) {
        board = o.archived.get(r.id)!;
        fromArchive++;
      }
      if (!board.lines.length) return skip('no prop lines kept');
      if (!o.book.test(board.provider ?? '')) return skip(`another book (${board.provider})`);
      const summary: J = await getJson('site', sitePath('nfl', `/summary?event=${r.id}`));
      const comp = summary?.header?.competitions?.[0];
      const teams: J[] = comp?.competitors ?? [];
      const home = teams.find((t) => t.homeAway === 'home'), away = teams.find((t) => t.homeAway === 'away');
      if (!home || !away || !comp?.status?.type?.completed) return skip('no final score');
      const box = parseNflBox(summary);
      const ids = [...new Set(board.lines.map((l) => l.athleteId))];
      const history = new Map(await Promise.all(ids.map(async (id) => [id, await logOf(id)] as const)));
      const names = new Map(ids.map((id) => [id, box.get(id)?.name ?? id]));
      const teamOf = new Map([...box.values()].map((p) => [p.athleteId, p.teamId]));
      const implied = impliedPoints(parseOdds(summary, String(home.id)), String(home.id), String(away.id));
      const ctx = { gameId: r.id, kickoff: new Date(r.date).toISOString(), teamOf, implied };
      const close = nflPropMarkets(board.lines, history, names, ctx);
      const open = nflPropMarkets(board.lines.filter((l) => l.open).map((l) => ({ ...l, ...l.open! })), history, names, ctx);
      if (!close.length) return skip('no player with history');
      const snap = (rows: PropRow[]) => ({ model: NFL_MODEL_VERSION, takenAt: r.date, provider: board!.provider, n: NFL_SIMS, rows });
      entries.push({
        id: r.id,
        league: 'nfl',
        season: seasonYear(r.date, 'nfl'),
        tip: new Date(r.date).toISOString(),
        home: { id: String(home.id), abbr: String(home.team?.abbreviation ?? '') },
        away: { id: String(away.id), abbr: String(away.team?.abbreviation ?? '') },
        status: 'final',
        players: Object.fromEntries(close.map((m) => [m.athleteId, m.player])),
        pre: snap(propRows(close)),
        ...(open.length ? { open: snap(propRows(open)) } : {}),
        close: { takenAt: r.date, lines: board.lines.map((l) => [l.athleteId, l.stat, l.line, l.over, l.under]) },
        // A player with a line and no box entry didn't play: his props are void, as at the book.
        box: Object.fromEntries(ids.map((id) => [id, box.has(id) ? NFL_BOX.map((k) => box.get(id)!.line[k]) : null])),
      });
    } catch (e) {
      skip(`error: ${(e as Error).message.slice(0, 60)}`);
    } finally {
      if (++done % 25 === 0 || done === refs.length) console.log(`${done}/${refs.length} · ${entries.length} priced · ${requestCount()} requests · ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  });
  entries.sort((a, b) => a.tip.localeCompare(b.tip) || a.id.localeCompare(b.id));
  return { entries, skipped, fromArchive };
}
