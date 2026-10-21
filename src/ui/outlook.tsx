import { useMemo } from 'preact/hooks';
import { Hist, impliedFromAmerican, fmtAmerican } from '../lib/stats';
import { LEAGUES } from '../model/leagues';
import type { GameData, GameSnapshot, TeamProfile } from '../model/types';
import { Histogram, type Marker } from './charts';
import { fair, pct, signed1, spreadText } from './format';
import type { Palette, SimState } from './app';

function outList(t: TeamProfile, unavailable: Set<string>) {
  return t.players.filter((p) => unavailable.has(p.id));
}

export function Outlook(props: { game: GameData; sim: Required<SimState>; palette: Palette; start?: GameSnapshot }) {
  const { game: g, sim, palette } = props;
  const s = sim.scenario;
  const lg = LEAGUES[g.league];
  const margin = useMemo(() => Hist.from(s.margin), [s]);
  const total = useMemo(() => Hist.from(s.total), [s]);
  const m = margin.mean();
  const t = s.homeScore + s.awayScore;
  const fav = m >= 0 ? g.home : g.away;
  const fromTip = !props.start;
  const final = g.phase === 'post' && g.homeScore != null && g.awayScore != null && fromTip;
  const actualMargin = final ? g.homeScore! - g.awayScore! : undefined;
  const actualTotal = final ? g.homeScore! + g.awayScore! : undefined;

  const marginMarkers: Marker[] = [];
  if (g.odds?.spread != null) marginMarkers.push({ value: -g.odds.spread, label: `Line ${g.odds.details ?? signed1(g.odds.spread)}` });
  if (actualMargin != null) marginMarkers.push({ value: actualMargin, label: `Final ${actualMargin > 0 ? g.home.abbr : g.away.abbr} +${Math.abs(actualMargin)}`, tone: 'accent' });
  const totalMarkers: Marker[] = [];
  if (g.odds?.total != null) totalMarkers.push({ value: g.odds.total, label: `O/U ${g.odds.total}` });
  if (actualTotal != null) totalMarkers.push({ value: actualTotal, label: `Final ${actualTotal}`, tone: 'accent' });

  const base = sim.baseline;
  const plans = sim.built.plans;
  const outsHome = outList(g.home, plans.home.unavailable);
  const outsAway = outList(g.away, plans.away.unavailable);

  return (
    <div class="outlook">
      {base && (outsHome.length > 0 || outsAway.length > 0) && (
        <section class="card impact-card">
          <h2>What the absences cost</h2>
          <div class="impact-grid">
            <div>
              <span class="kicker">Everyone available</span>
              <strong>
                {g.home.abbr} {pct(base.homeWin)}
              </strong>
              <span class="muted">{spreadText(Hist.from(base.margin).mean() >= 0 ? g.home.abbr : g.away.abbr, Math.abs(Hist.from(base.margin).mean()))}</span>
            </div>
            <div class="arrow" aria-hidden="true">
              →
            </div>
            <div>
              <span class="kicker">This scenario</span>
              <strong>
                {g.home.abbr} {pct(s.homeWin)}
              </strong>
              <span class="muted">{spreadText(fav.abbr, Math.abs(m))}</span>
            </div>
            <div class={`swing ${s.homeWin - base.homeWin >= 0 ? 'up' : 'down'}`}>
              <span class="kicker">{g.home.abbr} win chance</span>
              <strong>{signed1((s.homeWin - base.homeWin) * 100)} pts</strong>
              <span class="muted">Margin {signed1(m - Hist.from(base.margin).mean())}</span>
            </div>
          </div>
          <p class="outs">
            {[...outsAway.map((p) => [g.away.abbr, p] as const), ...outsHome.map((p) => [g.home.abbr, p] as const)].map(([abbr, p], i) => (
              <span key={p.id} class="out-tag">
                {i > 0 ? '' : 'Out: '}
                <b>{p.short}</b> {abbr}
                {p.injury?.out ? ` (${p.injury.status.toLowerCase()})` : ''}
              </span>
            ))}
          </p>
        </section>
      )}

      <section class="card stats-row" aria-label="Headline numbers">
        <div class="stat">
          <span class="kicker">Win chance</span>
          <strong>
            {(s.homeWin >= 0.5 ? g.home : g.away).abbr} {pct(Math.max(s.homeWin, 1 - s.homeWin))}
          </strong>
          <span class="muted">
            {(s.homeWin >= 0.5 ? g.away : g.home).abbr} {pct(Math.min(s.homeWin, 1 - s.homeWin))} · ±{pct(1.96 * Math.sqrt((s.homeWin * (1 - s.homeWin)) / s.n))} sampling error
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Model line</span>
          <strong>{spreadText(fav.abbr, Math.abs(m))}</strong>
          <span class="muted">Median margin {signed1(margin.quantile(0.5))} for {g.home.abbr}</span>
        </div>
        <div class="stat">
          <span class="kicker">Total</span>
          <strong>{t.toFixed(1)}</strong>
          <span class="muted">80% of sims between {total.quantile(0.1)} and {total.quantile(0.9)}</span>
        </div>
        <div class="stat">
          <span class="kicker">Overtime</span>
          <strong>{pct(s.otPct)}</strong>
          <span class="muted">{s.possessions.toFixed(1)} possessions per team</span>
        </div>
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Final margin</h2>
          <p class="legend">
            <span><i style={{ background: palette.away }} />{g.away.abbr} wins</span>
            <span><i style={{ background: palette.home }} />{g.home.abbr} wins</span>
          </p>
        </header>
        <Histogram
          hist={s.margin}
          colorFor={(v) => (v > 0 ? palette.home : palette.away)}
          markers={marginMarkers}
          fmt={(v) => (v === 0 ? '0' : `${v > 0 ? g.home.abbr : g.away.abbr} ${Math.abs(v)}`)}
          tip={(v, p) => `${v === 0 ? 'Tie' : `${v > 0 ? g.home.abbr : g.away.abbr} by ${Math.abs(v)}`}: ${pct(p)} of sims`}
          ariaLabel={`Distribution of final margins. ${g.home.abbr} wins ${pct(s.homeWin)} of simulations.`}
        />
      </section>

      <section class="card">
        <header class="card-head">
          <h2>Combined points</h2>
        </header>
        <Histogram
          hist={s.total}
          colorFor={() => 'var(--series-total)'}
          markers={totalMarkers}
          fmt={(v) => String(v)}
          tip={(v, p) => `${v} points: ${pct(p)} of sims`}
          ariaLabel={`Distribution of total points, mean ${t.toFixed(1)}.`}
        />
      </section>

      <MarketTable game={g} margin={margin} total={total} homeWin={s.homeWin} />

      {final && actualMargin != null && <LuckMeter game={g} margin={margin} actual={actualMargin} />}

      <section class="card">
        <header class="card-head">
          <h2>By {lg.periods === 4 ? 'quarter' : 'half'}</h2>
          <p class="muted small">Average points per period across all sims{props.start ? ' (remaining periods only)' : ''}.</p>
        </header>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th scope="col">Team</th>
                {s.periodMeans.map((_, i) => (
                  <th key={i} scope="col" class="num">
                    {lg.periods === 4 ? `Q${i + 1}` : `H${i + 1}`}
                  </th>
                ))}
                <th scope="col" class="num">
                  Final
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">{g.away.abbr}</th>
                {s.periodMeans.map(([, a], i) => (
                  <td key={i} class="num">{a.toFixed(1)}</td>
                ))}
                <td class="num strong">{s.awayScore.toFixed(1)}</td>
              </tr>
              <tr>
                <th scope="row">{g.home.abbr}</th>
                {s.periodMeans.map(([h], i) => (
                  <td key={i} class="num">{h.toFixed(1)}</td>
                ))}
                <td class="num strong">{s.homeScore.toFixed(1)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function noVig(a: number, b: number): [number, number] {
  const pa = impliedFromAmerican(a), pb = impliedFromAmerican(b);
  return [pa / (pa + pb), pb / (pa + pb)];
}

function MarketTable(props: { game: GameData; margin: Hist; total: Hist; homeWin: number }) {
  const { game: g, margin, total, homeWin } = props;
  const o = g.odds;
  const rows: { label: string; model: string; market: string; edge?: number; fairOdds?: string }[] = [];
  const mlH = o?.homeML, mlA = o?.awayML;
  const [mh, ma] = mlH != null && mlA != null ? noVig(mlH, mlA) : [undefined, undefined];
  rows.push({ label: `${g.home.abbr} moneyline`, model: pct(homeWin), market: mh != null ? `${pct(mh)} (${fmtAmerican(mlH!)})` : '–', edge: mh != null ? homeWin - mh : undefined, fairOdds: fair(homeWin) });
  rows.push({ label: `${g.away.abbr} moneyline`, model: pct(1 - homeWin), market: ma != null ? `${pct(ma)} (${fmtAmerican(mlA!)})` : '–', edge: ma != null ? 1 - homeWin - ma : undefined, fairOdds: fair(1 - homeWin) });
  if (o?.spread != null) {
    // Home covers when margin + spread > 0.
    const need = -o.spread;
    const cover = margin.probOver(need) + (Number.isInteger(need) ? 0 : 0);
    const push = Number.isInteger(need) ? margin.probEq(need) : 0;
    const homeCover = cover / Math.max(1e-9, 1 - push);
    rows.push({ label: `${g.home.abbr} ${o.spread > 0 ? '+' : ''}${o.spread}`, model: pct(homeCover), market: '50.0%', edge: homeCover - 0.5, fairOdds: fair(homeCover) });
    rows.push({ label: `${g.away.abbr} ${-o.spread > 0 ? '+' : ''}${-o.spread}`, model: pct(1 - homeCover), market: '50.0%', edge: 0.5 - homeCover, fairOdds: fair(1 - homeCover) });
  }
  if (o?.total != null) {
    const push = Number.isInteger(o.total) ? total.probEq(o.total) : 0;
    const over = total.probOver(o.total) / Math.max(1e-9, 1 - push);
    rows.push({ label: `Over ${o.total}`, model: pct(over), market: '50.0%', edge: over - 0.5, fairOdds: fair(over) });
    rows.push({ label: `Under ${o.total}`, model: pct(1 - over), market: '50.0%', edge: 0.5 - over, fairOdds: fair(1 - over) });
  }
  return (
    <section class="card">
      <header class="card-head">
        <h2>Model vs market</h2>
        <p class="muted small">{o ? `Line from ${o.provider}. Spread and total markets are treated as 50/50 after the vig; moneylines have the vig removed.` : 'No betting line is posted for this game.'}</p>
      </header>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr>
              <th scope="col">Outcome</th>
              <th scope="col" class="num">Model</th>
              <th scope="col" class="num">Fair odds</th>
              <th scope="col" class="num">Market</th>
              <th scope="col" class="num">Difference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                <td class="num">{r.model}</td>
                <td class="num">{r.fairOdds}</td>
                <td class="num">{r.market}</td>
                <td class={`num ${r.edge == null ? '' : r.edge > 0.03 ? 'pos' : r.edge < -0.03 ? 'neg' : ''}`}>{r.edge == null ? '–' : `${signed1(r.edge * 100)} pts`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function LuckMeter(props: { game: GameData; margin: Hist; actual: number }) {
  const { game: g, margin, actual } = props;
  const winner = actual > 0 ? g.home : g.away;
  const pWinner = actual > 0 ? margin.probOver(0) : 1 - margin.probOver(0);
  const atLeast = actual > 0 ? margin.probAtLeast(actual) : 1 - margin.probOver(actual);
  const below = 1 - margin.probAtLeast(actual);
  const percentile = below + margin.probEq(actual) / 2;
  const verdict = pWinner < 0.3 ? 'an upset by the model’s numbers' : pWinner > 0.7 ? 'the expected winner' : 'a coin-flip game that broke one way';
  return (
    <section class="card luck">
      <header class="card-head">
        <h2>How likely was the actual result?</h2>
      </header>
      <div class="luck-track" role="img" aria-label={`Actual margin sits at the ${Math.round(percentile * 100)}th percentile of simulated margins`}>
        <span class="luck-fill" style={{ width: `${percentile * 100}%` }} />
        <span class="luck-mark" style={{ left: `${percentile * 100}%` }} />
      </div>
      <div class="luck-scale">
        <span>{g.away.abbr} blowout</span>
        <span>Even</span>
        <span>{g.home.abbr} blowout</span>
      </div>
      <p>
        {winner.shortName} won by {Math.abs(actual)}, {verdict} ({pct(pWinner)} of sims had {winner.abbr} winning). A {winner.abbr} win by {Math.abs(actual)} or more came up in {pct(atLeast)} of
        simulations.
      </p>
    </section>
  );
}
