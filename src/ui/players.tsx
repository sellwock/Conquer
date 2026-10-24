import { useMemo, useState } from 'preact/hooks';
import { Hist } from '../lib/stats';
import type { BuiltSpec } from '../model/build';
import type { GameData } from '../model/types';
import type { PlayerSummary, SimSummary } from '../sim/run';
import { RangeDot } from './charts';
import { fair, pct } from './format';
import { IMPACT_SIMS, type Palette } from './app';

export interface ImpactRow {
  id: string;
  name: string;
  side: 0 | 1;
  winSwing: number;
  pointSwing: number;
}

type StatKey = 'pts' | 'reb' | 'ast' | 'tpm' | 'pra';
const STAT_LABEL: Record<StatKey, string> = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', tpm: '3-pointers made', pra: 'Pts + Reb + Ast' };

function ProjTable(props: { rows: PlayerSummary[]; color: string; label: string; actual: Map<string, { pts: number; reb: number; ast: number; tpm: number; min: number; played: boolean }> }) {
  const maxPts = Math.max(30, ...props.rows.map((r) => Hist.from(r.hists.pts).quantile(0.9)));
  const showActual = props.actual.size > 0;
  return (
    <div class="table-wrap">
      <table class="data proj">
        <caption style={{ '--team': props.color } as Record<string, string>}>{props.label}</caption>
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col" class="num">MIN</th>
            <th scope="col" class="num">PTS</th>
            <th scope="col" class="range-col">
              10th–90th pct{showActual && <span class="legend-actual"> ◆ actual</span>}
            </th>
            <th scope="col" class="num">REB</th>
            <th scope="col" class="num">AST</th>
            <th scope="col" class="num">3PM</th>
            <th scope="col" class="num">PRA</th>
            <th scope="col" class="num" title="Share of sims where the player fouls out">Foul out</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map((r) => {
            const h = Hist.from(r.hists.pts);
            const a = props.actual.get(r.id);
            return (
              <tr key={r.id}>
                <th scope="row">{r.short}</th>
                <td class="num">{r.min.toFixed(1)}</td>
                <td class="num strong">{r.pts.toFixed(1)}</td>
                <td class="range-col">
                  <RangeDot lo={h.quantile(0.1)} mid={r.pts} hi={h.quantile(0.9)} max={maxPts} color={props.color} actual={a?.played ? a.pts : undefined} />
                </td>
                <td class="num">{r.reb.toFixed(1)}</td>
                <td class="num">{r.ast.toFixed(1)}</td>
                <td class="num">{r.tpm.toFixed(1)}</td>
                <td class="num">{(r.pts + r.reb + r.ast).toFixed(1)}</td>
                <td class="num">{r.foulOutPct >= 0.005 ? pct(r.foulOutPct, 0) : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Players(props: {
  game: GameData;
  summary: SimSummary;
  built: BuiltSpec;
  palette: Palette;
  impact: { status: 'idle' | 'running' | 'done'; rows: ImpactRow[] };
  onImpact: () => void;
}) {
  const { game: g, summary: s, palette } = props;
  const active = s.players.filter((p) => p.min >= 1).sort((a, b) => b.min - a.min);
  const actual = useMemo(() => {
    const m = new Map<string, { pts: number; reb: number; ast: number; tpm: number; min: number; played: boolean }>();
    if (g.phase === 'pre') return m;
    for (const p of [...g.home.players, ...g.away.players]) if (p.actual) m.set(p.id, { pts: p.actual.pts, reb: p.actual.oreb + p.actual.dreb, ast: p.actual.ast, tpm: p.actual.tpm, min: p.actual.min, played: p.actual.played });
    return m;
  }, [g]);

  const [pid, setPid] = useState(active[0]?.id ?? '');
  const [stat, setStat] = useState<StatKey>('pts');
  const player = active.find((p) => p.id === pid) ?? active[0];
  const mean = player ? (stat === 'pra' ? player.pts + player.reb + player.ast : player[stat]) : 0;
  const [line, setLine] = useState<number | null>(null);
  const effLine = line ?? Math.max(0.5, Math.round(mean) - 0.5);
  const hist = player ? Hist.from(player.hists[stat]) : null;
  const over = hist ? hist.probOver(effLine) : 0;
  const push = hist && Number.isInteger(effLine) ? hist.probEq(effLine) : 0;

  return (
    <div class="players">
      <section class="card">
        <ProjTable rows={active.filter((p) => p.team === 1)} color={palette.away} label={g.away.name} actual={actual} />
        <ProjTable rows={active.filter((p) => p.team === 0)} color={palette.home} label={g.home.name} actual={actual} />
      </section>

      {player && hist && (
        <section class="card">
          <header class="card-head">
            <h2>Line checker</h2>
            <p class="muted small">Pick a player, a stat and a line to see how often the simulations clear it.</p>
          </header>
          <div class="prop-form">
            <label>
              <span class="ctl-label">Player</span>
              <select
                id="prop-player"
                value={player.id}
                onChange={(e) => {
                  setPid((e.currentTarget as HTMLSelectElement).value);
                  setLine(null);
                }}
              >
                {active.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.short} ({p.team === 0 ? g.home.abbr : g.away.abbr})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span class="ctl-label">Stat</span>
              <select
                id="prop-stat"
                value={stat}
                onChange={(e) => {
                  setStat((e.currentTarget as HTMLSelectElement).value as StatKey);
                  setLine(null);
                }}
              >
                {(Object.keys(STAT_LABEL) as StatKey[]).map((k) => (
                  <option key={k} value={k}>
                    {STAT_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span class="ctl-label">Line</span>
              <input id="prop-line" type="number" step={0.5} min={0} value={effLine} onInput={(e) => setLine(Number((e.currentTarget as HTMLInputElement).value))} />
            </label>
          </div>
          <div class="prop-out">
            <div>
              <span class="kicker">Over {effLine}</span>
              <strong>{pct(over / Math.max(1e-9, 1 - push))}</strong>
              <span class="muted">fair {fair(over / Math.max(1e-9, 1 - push))}</span>
            </div>
            <div>
              <span class="kicker">Under {effLine}</span>
              <strong>{pct((1 - over - push) / Math.max(1e-9, 1 - push))}</strong>
              <span class="muted">fair {fair((1 - over - push) / Math.max(1e-9, 1 - push))}</span>
            </div>
            <div>
              <span class="kicker">Projection</span>
              <strong>{mean.toFixed(1)}</strong>
              <span class="muted">
                median {hist.quantile(0.5)}, 80% range {hist.quantile(0.1)}–{hist.quantile(0.9)}
              </span>
            </div>
          </div>
        </section>
      )}

      <section class="card">
        <header class="card-head">
          <h2>Who matters most tonight</h2>
          <p class="muted small">
            Re-runs the game with each rotation player ruled out ({IMPACT_SIMS.toLocaleString()} sims each) and measures how much his team's win chance drops. Swings under about two points are within
            simulation noise.
          </p>
        </header>
        {props.impact.status === 'idle' && (
          <button type="button" class="btn" onClick={props.onImpact}>
            Rank player impact
          </button>
        )}
        {props.impact.status === 'running' && (
          <p class="loading-inline">
            <span class="spinner" aria-hidden="true" />
            Running about {(17 * IMPACT_SIMS).toLocaleString()} extra simulations…
          </p>
        )}
        {props.impact.status === 'done' && (
          <div class="impact-bars">
            {props.impact.rows.map((r) => {
              const max = Math.max(...props.impact.rows.map((x) => Math.abs(x.winSwing)), 0.01);
              return (
                <div class={`ib-row${r.winSwing < 0.02 ? ' faint' : ''}`} key={r.id}>
                  <span class="ib-name">
                    {r.name} <small>{r.side === 0 ? g.home.abbr : g.away.abbr}</small>
                  </span>
                  <span class="ib-track">
                    <span style={{ width: `${(Math.max(0, r.winSwing) / max) * 100}%`, background: r.side === 0 ? palette.home : palette.away }} />
                  </span>
                  <span class="ib-val">
                    {r.winSwing < 0.02 ? 'No clear drop' : `−${(r.winSwing * 100).toFixed(1)} win pts · −${Math.max(0, r.pointSwing).toFixed(1)} margin`}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
