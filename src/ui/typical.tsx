import { useState } from 'preact/hooks';
import { LEAGUES } from '../model/leagues';
import type { BuiltSpec } from '../model/build';
import type { GameData } from '../model/types';
import { fmtClock, periodName } from '../sim/engine';
import type { SimSummary } from '../sim/run';
import { BF, NBF, type SimTeam } from '../sim/types';
import type { Palette } from './app';

function BoxTable(props: { team: SimTeam; box: number[]; label: string; color: string }) {
  const rows = props.team.players
    .map((p, i) => ({ p, b: (f: number) => props.box[i * NBF + f] }))
    .filter((r) => r.b(BF.sec) > 0)
    .sort((a, b) => b.b(BF.sec) - a.b(BF.sec));
  const tot = (f: number) => rows.reduce((s, r) => s + r.b(f), 0);
  const line = (b: (f: number) => number) => [
    (b(BF.sec) / 60).toFixed(0),
    b(BF.pts),
    `${b(BF.fgm)}-${b(BF.fga)}`,
    `${b(BF.tpm)}-${b(BF.tpa)}`,
    `${b(BF.ftm)}-${b(BF.fta)}`,
    b(BF.oreb) + b(BF.dreb),
    b(BF.ast),
    b(BF.stl),
    b(BF.blk),
    b(BF.tov),
    b(BF.pf),
  ];
  const heads = ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'STL', 'BLK', 'TO', 'PF'];
  return (
    <div class="table-wrap">
      <table class="data box">
        <caption style={{ '--team': props.color } as Record<string, string>}>{props.label}</caption>
        <thead>
          <tr>
            <th scope="col">Player</th>
            {heads.map((h) => (
              <th key={h} scope="col" class="num">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, b }) => (
            <tr key={p.id}>
              <th scope="row">
                {p.short}
                {p.starter && <span class="starter">S</span>}
              </th>
              {line(b).map((v, i) => (
                <td key={i} class={`num${i === 1 ? ' strong' : ''}`}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
          <tr class="total">
            <th scope="row">Team</th>
            {line(tot).map((v, i) => (
              <td key={i} class="num">
                {i === 0 ? '' : v}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export function TypicalGame(props: { game: GameData; summary: SimSummary; built: BuiltSpec; palette: Palette }) {
  const { game: g, summary: s, built, palette } = props;
  const r = s.typical.result;
  const lg = LEAGUES[g.league];
  const [filter, setFilter] = useState<'all' | 'scoring' | 'runs'>('scoring');
  const log = r.log ?? [];
  const shown = log.filter((e) => (filter === 'all' ? true : filter === 'scoring' ? e.pts > 0 || e.team === -1 : e.run != null || e.team === -1));
  const colorOf = (t: number) => (t === 0 ? palette.home : t === 1 ? palette.away : 'var(--muted)');
  const periods = r.periodScores.length;
  const winner = r.score[0] > r.score[1] ? g.home : g.away;

  return (
    <div class="typical">
      <section class="card">
        <header class="card-head">
          <h2>
            {winner.shortName} {Math.max(...r.score)}, {winner === g.home ? g.away.shortName : g.home.shortName} {Math.min(...r.score)}
            {r.ot ? ` (${r.ot > 1 ? `${r.ot}OT` : 'OT'})` : ''}
          </h2>
          <p class="muted small">
            Simulation #{(s.typical.index + 1).toLocaleString()} of {s.n.toLocaleString()}, picked because its margin, total and the main players' scoring sit closest to the middle of all
            the sims. Replay it any time with the same seed.
          </p>
        </header>
        <div class="table-wrap">
          <table class="data linescore">
            <thead>
              <tr>
                <th scope="col">Team</th>
                {r.periodScores.map((_, i) => (
                  <th key={i} scope="col" class="num">
                    {i < lg.periods ? (lg.periods === 4 ? i + 1 : `H${i + 1}`) : i - lg.periods === 0 ? 'OT' : `${i - lg.periods + 1}OT`}
                  </th>
                ))}
                <th scope="col" class="num">
                  T
                </th>
              </tr>
            </thead>
            <tbody>
              {[1, 0].map((t) => (
                <tr key={t}>
                  <th scope="row">
                    <i class="swatch" style={{ background: t ? palette.away : palette.home }} />
                    {t ? g.away.abbr : g.home.abbr}
                  </th>
                  {r.periodScores.map((ps, i) => (
                    <td key={i} class="num">
                      {ps[t]}
                    </td>
                  ))}
                  <td class="num strong">{r.score[t]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ul class="facts">
          <li>
            Longest run: {g.away.abbr} {r.maxRun[1]}-0, {g.home.abbr} {r.maxRun[0]}-0
          </li>
          <li>Lead changes: {r.leadChanges}</li>
          <li>
            Biggest lead: {g.away.abbr} {r.largestLead[1]}, {g.home.abbr} {r.largestLead[0]}
          </li>
          {periods > lg.periods && <li>Went to overtime</li>}
        </ul>
      </section>

      <section class="card">
        <BoxTable team={built.spec.away} box={r.box[1]} label={g.away.name} color={palette.away} />
        <BoxTable team={built.spec.home} box={r.box[0]} label={g.home.name} color={palette.home} />
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Play-by-play</h2>
          <div class="seg small" role="radiogroup" aria-label="Which plays">
            {(
              [
                ['scoring', 'Scoring'],
                ['runs', 'Runs'],
                ['all', 'Every play'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} class={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        <ol class="pbp">
          {shown.map((e, i) => (
            <li key={i} class={`${e.team === -1 ? 'pbp-period' : ''}${e.run ? ' pbp-run' : ''}`}>
              {e.team === -1 ? (
                <span class="pbp-sep">{e.text}</span>
              ) : (
                <>
                  <span class="pbp-clock">
                    {periodName(e.period, lg.periods).replace(' quarter', '').replace(' half', 'H')} {fmtClock(e.clockSec)}
                  </span>
                  <i class="pbp-team" style={{ background: colorOf(e.team) }} />
                  <span class="pbp-text">
                    {e.text}
                    {e.run && <span class="run-badge">{e.run}-0 run</span>}
                  </span>
                  <span class="pbp-score">
                    {e.away}–{e.home}
                  </span>
                </>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
