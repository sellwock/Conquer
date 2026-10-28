// The "Last 5" tab: each player's per-game averages over their last five games for the team, with
// the game-by-game lines one tap away and tonight's simulated line alongside.
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import { seasonYear } from '../data/espn/parse';
import { averageLines, type LineAverages } from '../model/recent';
import type { BoxLine, GameData, GameLogLine, LeagueId, TeamProfile } from '../model/types';
import type { PlayerSummary, SimSummary } from '../sim/run';
import { pct } from './format';
import type { Palette } from './app';

type SortKey = 'min' | 'pts' | 'reb' | 'ast' | 'pra' | 'tpm' | 'stl' | 'blk' | 'tov';
const COLS: [SortKey, string][] = [
  ['min', 'MIN'],
  ['pts', 'PTS'],
  ['reb', 'REB'],
  ['ast', 'AST'],
  ['pra', 'PRA'],
  ['tpm', '3PM'],
  ['stl', 'STL'],
  ['blk', 'BLK'],
  ['tov', 'TO'],
];

type Stats = Record<SortKey, number>;

const fromBox = (b: BoxLine): Stats => {
  const reb = b.oreb + b.dreb;
  return { min: b.min, pts: b.pts, reb, ast: b.ast, pra: b.pts + reb + b.ast, tpm: b.tpm, stl: b.stl, blk: b.blk, tov: b.tov };
};
const fromSim = (p: PlayerSummary): Stats => ({ min: p.min, pts: p.pts, reb: p.reb, ast: p.ast, pra: p.pts + p.reb + p.ast, tpm: p.tpm, stl: p.stl, blk: p.blk, tov: p.tov });
const dateText = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export function Recent(props: { game: GameData; summary?: SimSummary; palette: Palette }) {
  const { game: g } = props;
  const [sort, setSort] = useState<SortKey>('min');
  const [open, setOpen] = useState<string | null>(null);
  const sims = new Map((props.summary?.players ?? []).map((p) => [p.id, p]));
  const season = seasonYear(g.date, g.league);
  const any = [...g.home.players, ...g.away.players].some((p) => p.recent?.length);

  if (!any) {
    return (
      <section class="card">
        <p class="muted">{g.demo ? 'The sample game has no game logs. Pick a real game to see recent form.' : 'No recent game logs could be loaded for this matchup.'}</p>
      </section>
    );
  }

  const table = (team: TeamProfile, color: string) => (
    <TeamTable team={team} color={color} league={g.league} season={season} sims={sims} sort={sort} onSort={setSort} open={open} onOpen={setOpen} />
  );
  return (
    <div class="recent">
      <section class="card">
        <header class="card-head">
          <h2>Last 5 games</h2>
          <p class="muted small">Per-game averages. Tap a player for each game and tonight's simulated line.</p>
        </header>
        {table(g.away, props.palette.away)}
        {table(g.home, props.palette.home)}
        <p class="muted small">
          From each team's last 10 completed games, counting only games the player played, so someone who changed teams shows only games with this team. Early in the season
          the five can reach back into last season; those games are marked. FG% is total makes over total attempts.
        </p>
      </section>
    </div>
  );
}

function TeamTable(props: {
  team: TeamProfile;
  color: string;
  league: LeagueId;
  season: number;
  sims: Map<string, PlayerSummary>;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  open: string | null;
  onOpen: (id: string | null) => void;
}) {
  const { team, sort } = props;
  const rows = team.players
    .map((p) => ({ p, avg: averageLines(p.recent ?? []) }))
    .filter((r): r is { p: (typeof team.players)[number]; avg: LineAverages } => !!r.avg)
    .sort((a, b) => b.avg[sort] - a.avg[sort] || b.avg.min - a.avg.min);
  const none = team.players.filter((p) => !p.recent?.length);
  const width = COLS.length + 3;

  return (
    <>
      <div class="table-wrap">
        <table class="data recent-table">
          <caption style={{ '--team': props.color } as Record<string, string>}>{team.name}</caption>
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col" class="num" title="Games in the average">
                GP
              </th>
              {COLS.map(([k, label]) => (
                <th key={k} scope="col" class="num" aria-sort={sort === k ? 'descending' : 'none'}>
                  <button type="button" class={sort === k ? 'sort on' : 'sort'} onClick={() => props.onSort(k)}>
                    {label}
                  </button>
                </th>
              ))}
              <th scope="col" class="num">
                FG%
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, avg }) => {
              const isOpen = props.open === p.id;
              const sim = props.sims.get(p.id);
              return (
                <Fragment key={p.id}>
                  <tr class={isOpen ? 'open' : ''}>
                    <th scope="row">
                      <button type="button" class="link" aria-expanded={isOpen} onClick={() => props.onOpen(isOpen ? null : p.id)}>
                        {p.short}
                      </button>
                      {p.injury && <span class={p.injury.out ? 'pill out-injury' : 'pill'}>{p.injury.status}</span>}
                    </th>
                    <td class="num">{avg.games}</td>
                    {COLS.map(([k]) => (
                      <td key={k} class={k === sort ? 'num strong' : 'num'}>
                        {avg[k].toFixed(1)}
                      </td>
                    ))}
                    <td class="num">{avg.fgPct != null ? pct(avg.fgPct, 0) : '–'}</td>
                  </tr>
                  {isOpen && (
                    <>
                      {p.recent!.map((l) => (
                        <LineRow key={l.eventId} line={l} lastSeason={seasonYear(l.date, props.league) < props.season} />
                      ))}
                      <tr class="sub sim">
                        <th scope="row">Tonight (sim)</th>
                        <td class="num" />
                        {sim ? (
                          <>
                            {COLS.map(([k]) => (
                              <td key={k} class="num">
                                {fromSim(sim)[k].toFixed(1)}
                              </td>
                            ))}
                            <td class="num">–</td>
                          </>
                        ) : (
                          <td colSpan={width - 2} class="muted">
                            {props.sims.size ? 'Not in tonight’s rotation' : 'Simulating…'}
                          </td>
                        )}
                      </tr>
                    </>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {none.length > 0 && <p class="muted small">No games in the last 10: {none.map((p) => p.short).join(', ')}.</p>}
    </>
  );
}

function LineRow(props: { line: GameLogLine; lastSeason: boolean }) {
  const { line: l } = props;
  const s = fromBox(l.box);
  return (
    <tr class="sub">
      <th scope="row">
        {dateText(l.date)} {l.opp ? `${l.home === false ? '@' : 'vs'} ${l.opp}` : ''}
        {props.lastSeason && <span class="muted"> · last season</span>}
      </th>
      <td class="num muted">{l.starter ? 'GS' : ''}</td>
      {COLS.map(([k]) => (
        <td key={k} class="num">
          {k === 'min' ? Math.round(s.min) : s[k]}
        </td>
      ))}
      <td class="num">
        {l.box.fgm}-{l.box.fga}
      </td>
    </tr>
  );
}
