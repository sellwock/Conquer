import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { LeagueId } from '../model/types';
import { LEAGUES } from '../model/leagues';
import { PROP_WORDS } from '../model/parlays';
import { MODEL_VERSION } from '../model/version';
import { fmtAmerican } from '../lib/stats';
import { gradeEntry, summarize, type Graded, type Record3, type Summary } from '../track/grade';
import { gradeProps, summarizeProps, TOP_PER_GAME, type GradedProp, type GradedSnap, type PropSummary, type PropWhen } from '../track/propGrade';
import { loadForwardLog, loadPropLog, type ForwardLog } from '../track/forward';
import { runBacktest, type BacktestProgress } from '../track/backtest';
import type { Entry, PropEntry, PropSnap } from '../track/types';
import { Reliability } from './charts';
import { propMixText } from './parlays';
import { lineText, one, pct, signed1 } from './format';

type Source = 'log' | 'backtest';
const BACKTEST_DAYS = [7, 14, 30];
const MIN_VERDICT_GAMES = 30;
const GAMES_SHOWN = 50;

function ago(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function rate(r: Record3): string {
  const n = r.win + r.loss;
  return n ? pct(r.win / n) : '–';
}

function units(u: number): string {
  return `${u >= 0 ? '+' : '−'}${Math.abs(u).toFixed(1)} units`;
}

/** A bootstrap interval from a handful of games is meaningless, so don't call it early. */
function verdictOf(v: { n: number; lo: number; hi: number }, who: string) {
  const few = v.n < MIN_VERDICT_GAMES;
  const better = !few && v.hi < 0, worse = !few && v.lo > 0;
  return {
    few,
    cls: better ? 'pos' : worse ? 'neg' : '',
    text: few ? 'Too few games to tell' : better ? `${who} beats the market` : worse ? `Market beats the ${who.toLowerCase()}` : 'No clear difference yet',
  };
}

function Verdict({ s }: { s: Summary }) {
  const v = s.vsMarket;
  if (!v) return <p class="muted">No moneylines in this sample, so there's no market to compare against.</p>;
  const { few, cls, text } = verdictOf(v, 'Model');
  return (
    <div class="verdict">
      <strong class={cls}>{text}</strong>
      <span class="muted">
        Brier score (lower is better) on {v.n} game{v.n === 1 ? '' : 's'} with a moneyline: model {v.model.toFixed(3)}, market {v.market.toFixed(3)}. Difference {signed(v.diff)}
        {few ? `. A verdict needs at least ${MIN_VERDICT_GAMES} games.` : `, 95% interval ${signed(v.lo)} to ${signed(v.hi)}.`}
      </span>
    </div>
  );
}

const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(3)}`;

function SummaryCards({ s, source }: { s: Summary; source: Source }) {
  return (
    <>
      <section class="card stats-row" aria-label="Record">
        <div class="stat">
          <span class="kicker">Winners</span>
          <strong>{s.straightUp.n ? pct(s.straightUp.correct / s.straightUp.n) : '–'}</strong>
          <span class="muted">
            {s.straightUp.correct}–{s.straightUp.n - s.straightUp.correct} picking the model's favorite
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Against the spread</span>
          <strong>{rate(s.ats)}</strong>
          <span class="muted">
            {s.ats.win}–{s.ats.loss}
            {s.ats.push ? `–${s.ats.push}` : ''} · {units(s.ats.units)}
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Over/under</span>
          <strong>{rate(s.ou)}</strong>
          <span class="muted">
            {s.ou.win}–{s.ou.loss}
            {s.ou.push ? `–${s.ou.push}` : ''} · {units(s.ou.units)}
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Average miss</span>
          <strong>{s.marginMAE.toFixed(1)} pts</strong>
          <span class="muted">on the margin · {s.totalMAE.toFixed(1)} on the total</span>
        </div>
        {source === 'log' && s.clv && (
          <div class="stat">
            <span class="kicker">Line movement</span>
            <strong>{signed1(s.clv.mean)} pts</strong>
            <span class="muted">toward the model's spread pick after the snapshot ({s.clv.n} games)</span>
          </div>
        )}
      </section>
      <section class="card">
        <header class="card-head">
          <h2>Against the market</h2>
        </header>
        <Verdict s={s} />
        <p class="muted small">
          A pick-by-pick record needs hundreds of games before it means much: at 500 games, a 52% against-the-spread rate is still within about two points of a coin flip. The Brier
          comparison uses every game's probability, so it settles sooner. Units are hypothetical, staking 1 unit on every pick at the listed price. Not advice.
        </p>
      </section>
      <section class="card">
        <header class="card-head">
          <h2>Calibration</h2>
          <p class="muted small">When the model says 70%, the home team should win about 70% of the time. Dots near the diagonal mean honest probabilities.</p>
        </header>
        <Reliability bins={s.calibration} color="var(--accent)" />
      </section>
    </>
  );
}

function GamesTable({ rows }: { rows: { e: Entry; g: Graded }[] }) {
  const cell = (r?: string) => (r === 'win' ? <span class="pos">Won</span> : r === 'loss' ? <span class="neg">Lost</span> : r === 'push' ? <span class="muted">Push</span> : <span class="muted">–</span>);
  return (
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Game</th>
            <th scope="col" class="num">Home win</th>
            <th scope="col" class="num">Model line</th>
            <th scope="col" class="num">Market</th>
            <th scope="col" class="num">Final</th>
            <th scope="col">Spread pick</th>
            <th scope="col">Total pick</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ e, g }) => {
            const m = e.pred!.meanMargin;
            return (
              <tr key={e.id}>
                <td>{new Date(e.tip).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                <th scope="row">
                  {e.away.abbr} @ {e.home.abbr}
                </th>
                <td class="num">{pct(g.pHome, 0)}</td>
                <td class="num">{lineText(e.home.abbr, e.away.abbr, m)}</td>
                <td class="num">{e.line?.spread != null ? lineText(e.home.abbr, e.away.abbr, -e.line.spread) : (e.line?.details ?? '–')}</td>
                <td class="num">
                  {e.result!.away}–{e.result!.home}
                </td>
                <td>
                  {g.ats ? (
                    <>
                      {g.ats.pick === 'home' ? e.home.abbr : e.away.abbr} {fmtAmerican(g.ats.pick === 'home' ? g.ats.line : -g.ats.line)} · {cell(g.ats.result)}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td>
                  {g.ou ? (
                    <>
                      {g.ou.pick === 'over' ? 'Over' : 'Under'} {g.ou.line} · {cell(g.ou.result)}
                    </>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const record3 = (r: Record3) => `${r.win}–${r.loss}${r.push ? `–${r.push}` : ''} · ${units(r.units)}`;

/** "Q2 5:00" or "H1 10:00": the moment a live line was saved. */
function momentText(league: LeagueId, at: NonNullable<PropSnap['at']>): string {
  const L = LEAGUES[league];
  const p = at.period > L.periods ? (at.period - L.periods > 1 ? `${at.period - L.periods}OT` : 'OT') : `${L.periods === 4 ? 'Q' : 'H'}${at.period}`;
  const m = Math.floor(at.clockSec / 60), sec = Math.floor(at.clockSec % 60);
  return `${p} ${m}:${String(sec).padStart(2, '0')}`;
}

function PropStats({ s, when }: { s: PropSummary; when: PropWhen }) {
  const v = s.vsMarket;
  const verdict = v && verdictOf(v, 'Sim');
  return (
    <>
      <section class="card stats-row" aria-label="Prop record">
        <div class="stat">
          <span class="kicker">Top picks</span>
          <strong>{rate(s.top)}</strong>
          <span class="muted">
            {record3(s.top)} · the app's best {TOP_PER_GAME} per game
          </span>
        </div>
        <div class="stat">
          <span class="kicker">Every line</span>
          <strong>{rate(s.every)}</strong>
          <span class="muted">
            {record3(s.every)} · the sim's side of {s.lines} lines in {s.games} game{s.games === 1 ? '' : 's'}
          </span>
        </div>
      </section>
      <section class="card">
        <header class="card-head">
          <h2>Props against the market</h2>
        </header>
        {v && verdict ? (
          <div class="verdict">
            <strong class={verdict.cls}>{verdict.text}</strong>
            <span class="muted">
              Brier score on the over (lower is better), averaged per game over {v.n} game{v.n === 1 ? '' : 's'}: sim {v.model.toFixed(3)}, market {v.market.toFixed(3)}. Difference{' '}
              {signed(v.diff)}
              {verdict.few ? `. A verdict needs at least ${MIN_VERDICT_GAMES} games.` : `, 95% interval ${signed(v.lo)} to ${signed(v.hi)}.`}
            </span>
          </div>
        ) : (
          <p class="muted">Every graded line pushed, so there's nothing to compare yet.</p>
        )}
        <p class="muted small">
          Props in one game move together (a fast pace lifts every over), so each game counts once in the comparison. Top picks are ranked the way the app ranks single bets
          now, with props at {propMixText()}: a positive return, at least a 40% hit chance and no price longer than +200. The Sim column, Every line and the comparison above
          use the simulation's own chances, so they show when it earns more say.{when === 'live' ? ' Live lines are the book\'s in-game prices at the moment shown.' : ''}{' '}
          Units are hypothetical, staking 1 unit on every pick at the listed price. Not advice.
        </p>
      </section>
    </>
  );
}

function PropTable({ rows, league, live }: { rows: GradedProp[]; league: LeagueId; live: boolean }) {
  const cell = (r: string) => (r === 'win' ? <span class="pos">Won</span> : r === 'loss' ? <span class="neg">Lost</span> : <span class="muted">Push</span>);
  return (
    <div class="table-wrap">
      <table class="data props-table">
        <thead>
          <tr>
            <th scope="col" title={live ? 'When the line was saved, the score then (away–home), and what the player had' : undefined}>
              Bet
            </th>
            <th scope="col" class="num">
              Price
            </th>
            <th scope="col" class="num" title="The sim's chance this side wins">
              Sim
            </th>
            <th scope="col" class="num" title="The book's no-vig chance">
              Mkt
            </th>
            <th scope="col" title="The player's final line">
              Result
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.gameId}:${r.athleteId}:${r.stat}:${r.side}`}>
              <th scope="row">
                {r.player} {r.side} {r.line} {PROP_WORDS[r.stat]}
                <br />
                <span class="muted small">
                  {new Date(r.tip).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · {r.label}
                  {live && (
                    <>
                      <br />
                      Saved {r.at ? `${momentText(league, r.at)}, ${r.at.away}–${r.at.home}` : 'mid-game'} · had {r.now ?? 0}
                    </>
                  )}
                </span>
              </th>
              <td class="num">{fmtAmerican(r.price)}</td>
              <td class="num">{pct(r.pSim, 0)}</td>
              <td class="num">{pct(r.pMarket, 0)}</td>
              <td title={`Sim average ${one(r.mean)}`}>
                {cell(r.result)}
                <br />
                <span class="muted small">{r.final}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Player props from the saved log: the lines and the sim's chances before tip-off, and once mid-game. */
function PropRecord(props: { league: LeagueId; model: string }) {
  const [when, setWhen] = useState<PropWhen>('pre');
  const [log, setLog] = useState<{ status: 'loading' | 'ok' | 'error'; entries: PropEntry[]; error?: string }>({ status: 'loading', entries: [] });
  const [all, setAll] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setLog({ status: 'loading', entries: [] });
    loadPropLog(props.league, ac.signal)
      .then((entries) => setLog({ status: 'ok', entries }))
      .catch((e) => {
        if (e?.name !== 'AbortError') setLog({ status: 'error', entries: [], error: e?.message ?? String(e) });
      });
    return () => ac.abort();
  }, [props.league]);

  const logged = useMemo(() => log.entries.filter((e) => e[when] && (props.model === 'all' || e[when]!.model === props.model)), [log.entries, when, props.model]);
  const snaps = useMemo(() => logged.map((e) => gradeProps(e, when)).filter((g): g is GradedSnap => !!g), [logged, when]);
  const summary = useMemo(() => summarizeProps(snaps), [snaps]);
  const top = useMemo(() => snaps.flatMap((s) => s.top), [snaps]);
  const waiting = logged.filter((e) => e.status === 'open').length;

  return (
    <>
      <section class="card">
        <header class="card-head">
          <h2>Player props</h2>
          <div class="seg small" role="radiogroup" aria-label="Which prop lines">
            <button type="button" role="radio" aria-checked={when === 'pre'} class={when === 'pre' ? 'on' : ''} onClick={() => setWhen('pre')}>
              Before tip-off
            </button>
            <button type="button" role="radio" aria-checked={when === 'live'} class={when === 'live' ? 'on' : ''} onClick={() => setWhen('live')}>
              Live
            </button>
          </div>
        </header>
        <p class="muted">
          {when === 'pre'
            ? "The posted prop lines and the sim's chance on each, saved with the game's last snapshot before tip-off and graded from the final box score."
            : `The book's in-game prop lines, saved once per game mid-game (${LEAGUES[props.league].periods === 4 ? '2nd or 3rd quarter' : 'between 10:00 left in the first half and 10:00 left in the second'}) with the sim's chances from that score, then never changed. Graded from the final box score.`}
          {waiting ? ` ${waiting} game${waiting === 1 ? '' : 's'} waiting on a result.` : ''}
        </p>
        {log.status === 'loading' && (
          <p class="muted">
            <span class="spinner" aria-hidden="true" /> Loading the prop log…
          </p>
        )}
        {log.status === 'error' && <p class="note">Couldn't load the prop log: {log.error}</p>}
        {log.status === 'ok' && !snaps.length && (
          <p class="muted">
            No graded {when === 'pre' ? 'pre-game' : 'live'} props yet.{' '}
            {when === 'pre'
              ? 'They appear once a game with posted props ends; books usually post them on game day, and the job saves them in its last few hours before tip-off.'
              : "They appear once a game the job caught mid-game ends. A game with no job run in that window has no live entry."}{' '}
            A player who sits has their props voided, as books do.
          </p>
        )}
      </section>
      {snaps.length > 0 && (
        <>
          <PropStats s={summary} when={when} />
          <section class="card">
            <header class="card-head">
              <h2>Top prop picks</h2>
              <p class="muted small">{top.length} graded, newest first.</p>
            </header>
            {top.length ? (
              <PropTable rows={all ? top : top.slice(0, GAMES_SHOWN)} league={props.league} live={when === 'live'} />
            ) : (
              <p class="muted">None of the graded lines cleared the bar for a pick.</p>
            )}
            {top.length > GAMES_SHOWN && (
              <button type="button" class="ghost-btn" onClick={() => setAll(!all)}>
                {all ? `Show the latest ${GAMES_SHOWN}` : `Show all ${top.length} picks`}
              </button>
            )}
          </section>
        </>
      )}
    </>
  );
}

export function TrackRecord(props: { league: LeagueId }) {
  const [source, setSource] = useState<Source>('log');
  const [log, setLog] = useState<{ status: 'loading' | 'ok' | 'error'; data?: ForwardLog; error?: string }>({ status: 'loading' });
  const [days, setDays] = useState(7);
  const [bt, setBt] = useState<{ status: 'idle' | 'running' | 'done' | 'error'; progress?: BacktestProgress; entries: Entry[]; failed: number; error?: string }>({
    status: 'idle',
    entries: [],
    failed: 0,
  });
  const [model, setModel] = useState<string>('all');
  const [allGames, setAllGames] = useState(false);
  const btAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLog({ status: 'loading' });
    loadForwardLog(props.league, ac.signal)
      .then((data) => setLog({ status: 'ok', data }))
      .catch((e) => {
        if (e?.name !== 'AbortError') setLog({ status: 'error', error: e?.message ?? String(e) });
      });
    return () => ac.abort();
  }, [props.league]);

  useEffect(() => {
    btAbort.current?.abort();
    setBt({ status: 'idle', entries: [], failed: 0 });
  }, [props.league]);
  useEffect(() => () => btAbort.current?.abort(), []);

  const startBacktest = () => {
    btAbort.current?.abort();
    const ac = new AbortController();
    btAbort.current = ac;
    setBt({ status: 'running', entries: [], failed: 0, progress: { done: 0, total: 0 } });
    runBacktest({ league: props.league, days, signal: ac.signal, onProgress: (progress) => setBt((b) => ({ ...b, progress })) })
      .then(({ entries, failed }) => setBt({ status: 'done', entries, failed }))
      .catch((e) => {
        if (e?.name !== 'AbortError') setBt({ status: 'error', entries: [], failed: 0, error: e?.message ?? String(e) });
      });
  };

  const entries = source === 'log' ? log.data?.entries ?? [] : bt.entries;
  const models = useMemo(() => [...new Set(entries.map((e) => e.pred?.model).filter(Boolean) as string[])].sort().reverse(), [entries]);
  // A version picked for one source may not exist in the other.
  const pick = models.includes(model) ? model : 'all';
  const rows = useMemo(
    () =>
      entries
        .filter((e) => pick === 'all' || e.pred?.model === pick)
        .map((e) => ({ e, g: gradeEntry(e) }))
        .filter((r): r is { e: Entry; g: Graded } => !!r.g),
    [entries, pick],
  );
  const summary = useMemo(() => summarize(rows.map((r) => r.g)), [rows]);
  const open = source === 'log' ? (log.data?.entries ?? []).filter((e) => e.status === 'open').length : 0;
  const lastRun = log.data?.status?.lastRun;
  const stale = lastRun ? Date.now() - Date.parse(lastRun) > 36 * 3_600_000 : false;

  return (
    <div class="record">
      <section class="card">
        <header class="card-head">
          <h2>Track record</h2>
          <div class="seg small" role="radiogroup" aria-label="Which record">
            <button type="button" role="radio" aria-checked={source === 'log'} class={source === 'log' ? 'on' : ''} onClick={() => setSource('log')}>
              Saved before tip-off
            </button>
            <button type="button" role="radio" aria-checked={source === 'backtest'} class={source === 'backtest' ? 'on' : ''} onClick={() => setSource('backtest')}>
              Backtest
            </button>
          </div>
        </header>
        {source === 'log' ? (
          <p class="muted">
            Every prediction here was saved before its game tipped off (live props: at the moment shown) and never changed afterwards, so this record has no hindsight.
            {log.status === 'ok' && lastRun ? ` The log last updated ${ago(lastRun)}.` : ''}
            {open ? ` ${open} game${open === 1 ? '' : 's'} waiting on a result.` : ''}
          </p>
        ) : (
          <>
            <p class="muted">
              Re-runs the current model on finished games as they looked before tip-off. Season stats stop at tip, but who suited up comes from the box score, so this has a little
              hindsight the saved log doesn't.
            </p>
            <div class="scan">
              <div class="seg small" role="radiogroup" aria-label="How far back">
                {BACKTEST_DAYS.map((d) => (
                  <button key={d} type="button" role="radio" aria-checked={days === d} class={days === d ? 'on' : ''} onClick={() => setDays(d)} disabled={bt.status === 'running'}>
                    Last {d} days
                  </button>
                ))}
              </div>
              {bt.status === 'running' ? (
                <>
                  <span class="spinner" aria-hidden="true" />
                  <span>
                    {bt.progress?.total ? `Simulating ${bt.progress.done} of ${bt.progress.total} games` : 'Finding games'}
                    {bt.progress?.label ? ` · ${bt.progress.label}` : ''}
                  </span>
                  <button type="button" class="ghost-btn" onClick={() => btAbort.current?.abort()}>
                    Stop
                  </button>
                </>
              ) : (
                <button type="button" class="btn" onClick={startBacktest}>
                  {bt.status === 'done' ? 'Run again' : 'Run backtest'}
                </button>
              )}
            </div>
            <p class="muted small">
              The first run reads every game's history from ESPN and can take a few minutes; results are cached for model {MODEL_VERSION}. Player props are graded in the saved log
              only.
            </p>
            {bt.failed > 0 && <p class="note">{bt.failed} games couldn't be loaded and were skipped.</p>}
            {bt.status === 'error' && <p class="note">The backtest stopped: {bt.error}</p>}
          </>
        )}
        {source === 'log' && stale && <p class="note">The log hasn't updated in over a day. In the offseason that's expected; during the season, check the Forward log workflow in GitHub Actions.</p>}
        {source === 'log' && log.status === 'error' && <p class="note">Couldn't load the prediction log: {log.error}</p>}
        {models.length > 1 && (
          <label class="model-filter">
            <span class="ctl-label">Model</span>
            <select id="record-model" value={pick} onChange={(e) => setModel((e.currentTarget as HTMLSelectElement).value)}>
              <option value="all">All versions</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                  {m === MODEL_VERSION ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {source === 'log' && log.status === 'loading' && (
        <div class="loading-panel">
          <span class="spinner" aria-hidden="true" />
          Loading the prediction log…
        </div>
      )}
      {rows.length === 0 && !(source === 'log' && log.status === 'loading') && bt.status !== 'running' && (
        <div class="empty-panel">
          {source === 'log'
            ? 'No graded games yet. The scheduled job saves predictions up to a day before tip-off, refreshes them in the last few hours, and grades them once the games end.'
            : bt.status === 'done'
              ? 'No finished games with results in that range.'
              : 'Pick a range and run the backtest to grade the model on recent games.'}
        </div>
      )}
      {rows.length > 0 && (
        <>
          <SummaryCards s={summary} source={source} />
          <section class="card">
            <header class="card-head">
              <h2>Games</h2>
              <p class="muted small">{rows.length} graded, newest first.</p>
            </header>
            <GamesTable rows={allGames ? rows : rows.slice(0, GAMES_SHOWN)} />
            {rows.length > GAMES_SHOWN && (
              <button type="button" class="ghost-btn" onClick={() => setAllGames(!allGames)}>
                {allGames ? `Show the latest ${GAMES_SHOWN}` : `Show all ${rows.length} games`}
              </button>
            )}
          </section>
        </>
      )}
      {source === 'log' && <PropRecord league={props.league} model={pick} />}
    </div>
  );
}
