import { useMemo } from 'preact/hooks';
import { Hist } from '../lib/stats';
import { LEAGUES, regulationSec } from '../model/leagues';
import type { GameData } from '../model/types';
import { periodName } from '../sim/engine';
import { stateWinProb, type SimSummary } from '../sim/run';
import { ProbLine, type Series } from './charts';
import { pct, signed1 } from './format';
import type { Palette } from './app';

function RunTable(props: { game: GameData; s: SimSummary; palette: Palette }) {
  const { game: g, s, palette } = props;
  const runs = [Hist.from(s.maxRun[0]), Hist.from(s.maxRun[1])];
  const leads = [Hist.from(s.largestLead[0]), Hist.from(s.largestLead[1])];
  const half = Hist.from(s.firstHalfMargin);
  const rows: [string, (t: 0 | 1) => string][] = [
    ['Longest run, average', (t) => `${runs[t].mean().toFixed(1)}-0`],
    ['Has an 8-0 run', (t) => pct(runs[t].probAtLeast(8), 0)],
    ['Has a 12-0 run', (t) => pct(runs[t].probAtLeast(12), 0)],
    ['Has a 16-0 run', (t) => pct(runs[t].probAtLeast(16), 0)],
    ['Leads by 10+ at some point', (t) => pct(leads[t].probAtLeast(10), 0)],
    ['Leads by 20+ at some point', (t) => pct(leads[t].probAtLeast(20), 0)],
  ];
  return (
    <section class="card">
      <header class="card-head">
        <h2>Runs and swings</h2>
        <p class="muted small">How often each team strings together unanswered points or builds a cushion, across every simulated game.</p>
      </header>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col" class="num">
                <i class="swatch" style={{ background: palette.away }} />
                {g.away.abbr}
              </th>
              <th scope="col" class="num">
                <i class="swatch" style={{ background: palette.home }} />
                {g.home.abbr}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td class="num">{f(1)}</td>
                <td class="num">{f(0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul class="facts">
        <li>Lead changes per game: {s.leadChanges.toFixed(1)}</li>
        {half.n > 0 && (
          <li>
            First half: {g.home.abbr} {signed1(half.mean())}, {g.home.abbr} leads at the break in {pct(half.probOver(0), 0)} (tied {pct(half.probEq(0), 0)})
          </li>
        )}
        <li>Overtime: {pct(s.otPct)}</li>
      </ul>
    </section>
  );
}

export function Flow(props: { game: GameData; summary: SimSummary; palette: Palette; from: string; onFrom: (from: string) => void }) {
  const { game: g, summary: s, palette } = props;
  const lg = LEAGUES[g.league];
  const reg = regulationSec(lg);
  const elapsedOf = (period: number, clockSec: number) =>
    period <= lg.periods ? (period - 1) * lg.periodSec + (lg.periodSec - clockSec) : reg + (period - lg.periods - 1) * lg.otSec + (lg.otSec - clockSec);

  const chart = useMemo(() => {
    if (!g.plays.length) return null;
    const m = Hist.from(s.margin);
    const mean = m.mean(), sd = m.sd();
    const last = g.plays[g.plays.length - 1];
    const xMax = Math.max(reg, elapsedOf(last.period, last.clockSec));
    const model: Series = { name: 'This model', color: 'var(--ink)', points: [] };
    const espn: Series = { name: 'ESPN', color: 'var(--muted)', dashed: true, points: [] };
    const bySeq = new Map(g.espnWinProb.map((w) => [w.seq, w.homeWinPct]));
    model.points.push({ x: 0, y: stateWinProb(0, 1, mean, sd) });
    for (const p of g.plays) {
      const x = elapsedOf(p.period, p.clockSec);
      const remaining = p.period <= lg.periods ? reg - x : p.clockSec;
      model.points.push({ x, y: stateWinProb(p.homeScore - p.awayScore, remaining / reg, mean, sd) });
      const e = bySeq.get(p.seq);
      if (e != null) espn.points.push({ x, y: e });
    }
    const periods: number[] = [];
    for (let i = 1; i < lg.periods; i++) periods.push(i * lg.periodSec);
    const ots = Math.max(0, last.period - lg.periods);
    for (let i = 0; i < ots; i++) periods.push(reg + i * lg.otSec);
    return { series: espn.points.length > 2 ? [model, espn] : [model], xMax, periods };
  }, [g, s]);

  const fromTip = props.from === 'tip';
  const selectedPlay = !fromTip && props.from !== 'now' ? g.plays.find((p) => String(p.seq) === props.from) : undefined;

  const pick = (x: number) => {
    let best = g.plays[0];
    for (const p of g.plays) if (elapsedOf(p.period, p.clockSec) <= x) best = p;
    if (best) props.onFrom(String(best.seq));
  };

  return (
    <div class="flow">
      {g.plays.length > 0 && chart && (
        <section class="card">
          <header class="card-head">
            <h2>Win probability, as it happened</h2>
            <p class="muted small">
              {fromTip
                ? `The solid line applies this simulation's pre-game outlook to the real score and clock. Tap any moment to simulate the rest of the game from there.`
                : 'Tap another moment to move the starting point, or go back to tip-off.'}
            </p>
          </header>
          {fromTip ? (
            <ProbLine
              series={chart.series}
              xMax={chart.xMax}
              periods={chart.periods}
              periodLabel={(i) => (i < lg.periods - 1 ? (lg.periods === 4 ? `Q${i + 2}` : 'H2') : `OT${i - lg.periods + 2 > 1 ? i - lg.periods + 2 : ''}`)}
              topLabel={`${g.home.abbr} wins`}
              bottomLabel={`${g.away.abbr} wins`}
              onPick={pick}
              describe={(x) => {
                let best = g.plays[0];
                for (const p of g.plays) if (elapsedOf(p.period, p.clockSec) <= x) best = p;
                return (
                  <div class="tt-head">
                    {periodName(best.period, lg.periods)} {best.clock} · {g.away.abbr} {best.awayScore}–{best.homeScore} {g.home.abbr}
                  </div>
                );
              }}
            />
          ) : (
            <div class="moment">
              {selectedPlay && (
                <p>
                  Simulating from <b>{periodName(selectedPlay.period, lg.periods)}, {selectedPlay.clock}</b> with {g.away.abbr} {selectedPlay.awayScore}, {g.home.abbr}{' '}
                  {selectedPlay.homeScore}. Last play: “{selectedPlay.text}”
                </p>
              )}
              {props.from === 'now' && <p>Simulating the rest of the game from the current score, clock, fouls and minutes.</p>}
              <p>
                From here, {g.home.abbr} wins <b>{pct(s.homeWin)}</b> of {s.n.toLocaleString()} sims; projected final {g.away.abbr} {s.awayScore.toFixed(0)}, {g.home.abbr} {s.homeScore.toFixed(0)}.
              </p>
              <button type="button" class="btn" onClick={() => props.onFrom('tip')}>
                Back to tip-off
              </button>
            </div>
          )}
          {fromTip && (
            <p class="legend">
              <span>
                <i class="solid" />
                This model
              </span>
              {chart.series.length > 1 && (
                <span>
                  <i class="dashed" />
                  ESPN
                </span>
              )}
            </p>
          )}
        </section>
      )}
      <RunTable game={g} s={s} palette={palette} />
    </div>
  );
}
