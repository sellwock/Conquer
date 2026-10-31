import { useEffect, useMemo, useState } from 'preact/hooks';
import {
  DEFAULT_JUICE,
  HIT_FLOOR,
  MAX_PRICE,
  MODEL_WEIGHT,
  defaultPickMode,
  evaluate,
  legsForGame,
  modelHasSay,
  suggestParlays,
  weightsFor,
  type BlendWeights,
  type GameMarket,
  type LegKind,
  type Parlay,
  type PickMode,
} from '../model/parlays';
import { LEAGUES } from '../model/leagues';
import type { GameData, LeagueId } from '../model/types';
import { fmtAmerican } from '../lib/stats';
import { one, pct, perHundred, tipTime } from './format';
import type { PropState } from './app';
import type { LiveSlate } from './liveSlate';

export interface ScanState {
  status: 'idle' | 'running' | 'done';
  done: number;
  total: number;
  current?: string;
  failed: number;
}

const SIZE_TITLE: Record<1 | 2 | 3, string> = { 1: 'Singles', 2: '2-leg parlays', 3: '3-leg parlays' };

const KIND_WORDS: Record<LegKind, string> = { ml: 'moneylines', spread: 'spreads', total: 'totals', prop: 'player props' };

/** "moneylines use the market's no-vig odds alone; spreads and totals blend 25% simulation with 75% market" */
export function blendText(w: BlendWeights): string {
  const byWeight = new Map<number, string[]>();
  for (const k of ['ml', 'spread', 'total', 'prop'] as LegKind[]) byWeight.set(w[k], [...(byWeight.get(w[k]) ?? []), KIND_WORDS[k]]);
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  return [...byWeight]
    .map(([x, kinds]) => `${list(kinds)} ${x === 0 ? "use the market's no-vig odds alone" : `blend ${Math.round(x * 100)}% simulation with ${Math.round((1 - x) * 100)}% market`}`)
    .join('; ');
}

/** Shown in place of blended suggestions when the market alone ranks every bet in a league. */
export function NoEdgeNote(props: { league: LeagueId; onSim?: () => void }) {
  const label = LEAGUES[props.league].label;
  return (
    <>
      <p>
        No backtest-weighted suggestions for {label} games. In backtests the model hasn't beaten the betting market on any {label} bet, so blending it in can't find value the
        market missed.
      </p>
      {props.onSim && (
        <p>
          <button type="button" class="btn" onClick={props.onSim}>
            Show the simulation's picks
          </button>
        </p>
      )}
      <p class="muted small">
        Weighted suggestions come back when a model version beats the market in the backtest. <a href={`#view=record&league=${props.league}`}>See the track record</a>.
      </p>
    </>
  );
}

/** Why simulation-only picks deserve less trust than their numbers suggest. */
export function simOnlyText(league: LeagueId): string {
  const label = LEAGUES[league].label;
  return `Ranked by the simulation alone: its chances replace the market's entirely. In backtests the market's odds were more accurate than the simulation's on ${label} games, so read these expected returns as the simulation's opinion, and expect them to be overstated.`;
}

const barText = () =>
  `It also needs a hit chance of at least ${pct(HIT_FLOOR[1], 0)}, ${pct(HIT_FLOOR[2], 0)} or ${pct(HIT_FLOOR[3], 0)} and a price no longer than ${fmtAmerican(MAX_PRICE[1])}, ${fmtAmerican(MAX_PRICE[2])} or ${fmtAmerican(MAX_PRICE[3])} for one, two or three legs. Same-game legs are scored together from the simulations; legs from different games are treated as independent.`;

function ParlayCard(props: { p: Parlay; mode: PickMode; showGame: boolean; markets: Record<string, GameMarket>; onOpen: (id: string) => void }) {
  const { p } = props;
  const sim = props.mode === 'sim';
  const assumed = p.legs.some((l) => {
    const o = props.markets[l.gameId]?.odds;
    if (!o) return false;
    if (l.kind === 'spread') return (l.side === 'home' ? o.homeSpreadOdds : o.awaySpreadOdds) == null;
    if (l.kind === 'total') return (l.side === 'over' ? o.overOdds : o.underOdds) == null;
    return false;
  });
  return (
    <article class="parlay">
      <header class="p-head">
        <strong class="p-price">{fmtAmerican(p.price)}</strong>
        <span class="chip">{p.legs.length === 1 ? 'Single' : `${p.legs.length} legs`}</span>
        {p.sameGame && <span class="chip">{p.maxFromOneGame === p.legs.length ? 'Same game' : `${p.maxFromOneGame} from one game`}</span>}
        {sim && <span class="chip warn">Sim only</span>}
      </header>
      <ol class="p-legs">
        {p.legs.map((l) => (
          <li key={l.key}>
            <span class="p-leg">{l.label}</span>
            {p.legs.length > 1 && <span class="p-leg-price">{fmtAmerican(l.price)}</span>}
            {props.showGame && (
              <button type="button" class="link p-game" onClick={() => props.onOpen(l.gameId)}>
                {l.game}
              </button>
            )}
          </li>
        ))}
      </ol>
      <dl class="p-metrics">
        <div>
          <dt>{sim ? 'Sim hit chance' : 'Hit chance'}</dt>
          <dd>{pct(p.pHit, 0)}</dd>
        </div>
        <div>
          <dt>Price implies</dt>
          <dd>{pct(p.pImplied, 0)}</dd>
        </div>
        {sim ? (
          <div title="The market's no-vig chance of each leg, multiplied together. For legs from one game this ignores how they move together.">
            <dt>Market (no-vig)</dt>
            <dd>{pct(p.legs.reduce((k, l) => k * l.pFair, 1), 0)}</dd>
          </div>
        ) : (
          <div>
            <dt>Model alone</dt>
            <dd>{pct(p.pModel, 0)}</dd>
          </div>
        )}
        <div>
          <dt>{sim ? 'Sim expected return' : 'Expected return'}</dt>
          <dd class={p.ev > 0 ? 'pos' : 'neg'}>{perHundred(p.ev)}</dd>
        </div>
      </dl>
      {(p.correlation != null && Math.abs(p.correlation) >= 0.03) || assumed ? (
        <p class="p-note">
          {p.correlation != null && Math.abs(p.correlation) >= 0.03 && (
            <>These legs land together {Math.round(Math.abs(p.correlation) * 100)}% {p.correlation > 0 ? 'more' : 'less'} often than if they were unrelated. </>
          )}
          {assumed && <>Some prices weren't posted, so {fmtAmerican(DEFAULT_JUICE)} is assumed. </>}
        </p>
      ) : null}
    </article>
  );
}

export function Parlays(props: {
  game: GameData;
  markets: Record<string, GameMarket>;
  remaining: number;
  scan: ScanState;
  onScan: () => void;
  onCancelScan: () => void;
  onOpen: (id: string) => void;
  props?: PropState;
  /** A live game simulated from now: its in-game prop lines, priced from the current box score. */
  liveMarket?: GameMarket;
  simFromNow: boolean;
  onFromNow: () => void;
  liveSlate: LiveSlate;
  liveScope: 'game' | 'all';
  onLiveScope: (s: 'game' | 'all') => void;
}) {
  const { game: g, markets } = props;
  const hasSay = modelHasSay(g.league);
  const [mode, setMode] = useState<PickMode>(defaultPickMode(g.league));
  useEffect(() => setMode(defaultPickMode(g.league)), [g.league]);
  // Blended picks can't beat the vig where the model has no say, so there's nothing to list.
  const showPicks = mode === 'sim' || hasSay;
  const ids = Object.keys(markets);
  const [scope, setScope] = useState<'game' | 'slate'>(ids.length > 1 ? 'slate' : 'game');
  const pool = useMemo(() => (scope === 'game' ? (markets[g.id] ? [markets[g.id]] : []) : Object.values(markets)), [scope, markets, g.id]);
  const s = useMemo(() => suggestParlays(pool, 3, weightsFor(g.league, mode)), [pool, g.league, mode]);
  const changed = pool.filter((m) => m.note);

  return (
    <div class="parlays">
      <section class="card disclaimer" role="note">
        <p>
          <strong>Suggestions, not advice.</strong> These parlays come from a computer simulation and can be wrong. Nothing here is betting, financial or professional advice, and no
          parlay is a sure thing. Sportsbook prices, especially for same-game parlays, will differ from what's shown. Only bet where it's legal for you, only what you can afford to
          lose, and if gambling stops being fun, call or text 1-800-GAMBLER.
        </p>
      </section>

      {!g.demo && (g.phase === 'in' || props.liveSlate.candidates > 0) && (
        <LiveProps
          game={g}
          market={props.liveMarket}
          state={props.props}
          fromNow={props.simFromNow}
          onFromNow={props.onFromNow}
          mode={mode}
          onSim={() => setMode('sim')}
          slate={props.liveSlate}
          scope={props.liveScope}
          onScope={props.onLiveScope}
          onOpen={props.onOpen}
        />
      )}

      <section class="card">
        <header class="card-head">
          <h2>Suggested parlays</h2>
          {showPicks && (
            <div class="seg small" role="radiogroup" aria-label="Which games">
              <button type="button" role="radio" aria-checked={scope === 'game'} class={scope === 'game' ? 'on' : ''} onClick={() => setScope('game')}>
                This game
              </button>
              <button type="button" role="radio" aria-checked={scope === 'slate'} class={scope === 'slate' ? 'on' : ''} onClick={() => setScope('slate')}>
                Across the slate ({ids.length} {ids.length === 1 ? 'game' : 'games'})
              </button>
            </div>
          )}
        </header>
        <div class="pick-mode">
          <span class="muted small">Ranked by</span>
          <div class="seg small" role="radiogroup" aria-label="How picks are ranked">
            <button type="button" role="radio" aria-checked={mode === 'blend'} class={mode === 'blend' ? 'on' : ''} onClick={() => setMode('blend')}>
              Backtest blend
            </button>
            <button type="button" role="radio" aria-checked={mode === 'sim'} class={mode === 'sim' ? 'on' : ''} onClick={() => setMode('sim')}>
              Simulation only
            </button>
          </div>
        </div>
        {!showPicks ? (
          <NoEdgeNote league={g.league} onSim={() => setMode('sim')} />
        ) : mode === 'sim' ? (
          <>
            <p class="note caution">{simOnlyText(g.league)}</p>
            <p class="muted small">
              One to three legs from moneylines, spreads, totals and this game's player props. A pick needs positive expected value by the simulation's own chances. {barText()}
            </p>
          </>
        ) : (
          <p class="muted small">
            One to three legs from moneylines, spreads and totals. A pick needs positive expected value after weighting the simulation against the market by how it did in
            backtests: {blendText(MODEL_WEIGHT[g.league])}. {barText()}
          </p>
        )}
        {showPicks && scope === 'slate' && (
          <div class="scan">
            {props.scan.status === 'running' ? (
              <>
                <span class="spinner" aria-hidden="true" />
                <span>
                  Simulating {props.scan.current ?? 'the slate'} ({props.scan.done} of {props.scan.total} done)
                </span>
                <button type="button" class="ghost-btn" onClick={props.onCancelScan}>
                  Stop
                </button>
              </>
            ) : props.remaining > 0 ? (
              <>
                <span>
                  {props.remaining} more {props.remaining === 1 ? 'game hasn’t' : 'games haven’t'} tipped off on this date.
                </span>
                <button type="button" class="btn" onClick={props.onScan}>
                  Simulate {props.remaining === 1 ? 'it' : `all ${props.remaining}`}
                </button>
              </>
            ) : (
              <span class="muted">Every upcoming game on this date with a posted line is included.</span>
            )}
            {props.scan.failed > 0 && <span class="muted small">{props.scan.failed} couldn't be loaded and were skipped.</span>}
          </div>
        )}
        {showPicks && scope === 'game' && !markets[g.id] && (
          <p class="note">
            {g.phase !== 'pre'
              ? 'This game has already started, so its pre-game lines are no longer available. Switch to the slate or pick an upcoming game.'
              : g.odds
                ? 'Waiting for this game’s simulation to finish.'
                : 'No betting line is posted for this game yet.'}
          </p>
        )}
        {showPicks && changed.length > 0 && (
          <p class="note">
            {changed.map((m) => `${m.label}: ${m.note}`).join(' · ')}. Lines may already reflect news your scenario adds or removes.
          </p>
        )}
      </section>

      {(scope === 'slate' ? pool.some((m) => m.props?.length) || (g.phase === 'pre' && !g.demo) : g.phase === 'pre' && !g.demo) && (
        <PropPicks game={g} scope={scope} pool={pool} state={props.props} mode={mode} onSim={() => setMode('sim')} onOpen={props.onOpen} />
      )}

      {showPicks &&
        pool.length > 0 &&
        ([1, 2, 3] as const).map((size) => (
          <section class="card" key={size}>
            <header class="card-head">
              <h2>{SIZE_TITLE[size]}</h2>
            </header>
            {s.bySize[size].length ? (
              <div class="parlay-grid">
                {s.bySize[size].map((p) => (
                  <ParlayCard key={p.legs.map((l) => l.key).join('|')} p={p} mode={mode} showGame={scope === 'slate'} markets={markets} onOpen={props.onOpen} />
                ))}
              </div>
            ) : (
              <p class="muted">
                Nothing clears the bar here. {scope === 'game' && ids.length < 2 ? 'Try the whole slate for more combinations.' : 'Passing is a fine choice.'}
              </p>
            )}
          </section>
        ))}

      {showPicks && scope === 'slate' && pool.length > 0 && (
        <section class="card">
          <header class="card-head">
            <h2>Games included</h2>
          </header>
          <ul class="facts">
            {pool.map((m) => (
              <li key={m.gameId}>
                <button type="button" class="link" onClick={() => props.onOpen(m.gameId)}>
                  {m.label}
                </button>{' '}
                {m.tip ? tipTime(m.tip) : ''} · {m.odds.details ?? 'no spread'}
                {m.odds.total != null ? ` · O/U ${m.odds.total}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The best player props by the current ranking, one bet each: the open game's, or the whole slate's. */
function PropPicks(props: {
  game: GameData;
  scope: 'game' | 'slate';
  pool: GameMarket[];
  state?: PropState;
  mode: PickMode;
  onSim: () => void;
  onOpen: (id: string) => void;
}) {
  const { game: g, scope, state } = props;
  const slate = scope === 'slate';
  const priced = props.pool.filter((m) => m.props?.length);
  const singles = useMemo(
    () =>
      props.pool
        .filter((m) => m.props?.length)
        .flatMap((m) => legsForGame(m, weightsFor(m.league, props.mode)).filter((l) => l.prop))
        .map((l) => evaluate([l]))
        .filter((p) => p.ev > 0 && p.pHit >= HIT_FLOOR[1] && p.price <= MAX_PRICE[1])
        .sort((a, b) => b.ev - a.ev)
        .slice(0, slate ? 15 : 10),
    [props.pool, props.mode, slate],
  );
  const open = props.pool.find((m) => m.gameId === g.id);
  const posted = state?.gameId === g.id && state.status === 'ok' ? state.board!.lines.length : 0;
  const provider = priced.find((m) => m.propsProvider)?.propsProvider ?? state?.board?.provider;
  const oldest = Math.min(...priced.map((m) => m.propsAt ?? Infinity));
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sourceText = slate
    ? priced.length
      ? `${provider ?? 'Book'} lines via ESPN · props for ${priced.length} of ${props.pool.length} game${props.pool.length === 1 ? '' : 's'}${Number.isFinite(oldest) ? ` · oldest ${time(oldest)}` : ''}`
      : ''
    : posted
      ? `${provider ?? 'Book'} lines via ESPN, ${posted} posted${state?.board ? ` · ${time(state.board.fetchedAt)}` : ''}`
      : '';

  let body;
  if (!slate && (!state || state.status === 'loading')) body = <p class="muted">Loading player prop lines…</p>;
  else if (!slate && state!.status === 'error') body = <p class="muted">Couldn't load player prop lines from ESPN.</p>;
  else if (!slate && !posted) body = <p class="muted">No player props are posted for this game yet.</p>;
  else if (!slate && !open) body = <p class="muted">Waiting for this game's simulation to finish.</p>;
  else if (slate && !priced.length)
    body = <p class="muted">No props priced yet. Simulating the slate fetches each game's prop lines along with its simulations.</p>;
  else if (props.mode === 'blend')
    body = (
      <>
        <p>Player props have no backtest yet, so the backtest blend prices them at the market's own odds and none can beat the vig.</p>
        <p>
          <button type="button" class="btn" onClick={props.onSim}>
            Show the simulation's prop picks
          </button>
        </p>
      </>
    );
  else if (!singles.length) body = <p class="muted">No prop clears the bar. Passing is a fine choice.</p>;
  else body = <PropTable singles={singles} onOpen={slate ? props.onOpen : undefined} />;

  return (
    <section class="card">
      <header class="card-head">
        <h2>Player props</h2>
        {sourceText && <p class="muted small">{sourceText}</p>}
      </header>
      {props.mode === 'sim' && (slate ? priced.length > 0 : posted > 0 && !!open) && (
        <p class="note caution">
          Props are priced by the simulation alone and have never been backtested. Player minutes drive every prop, and the simulation's minutes are a projection, so treat these
          as leans. Players projected under 15 minutes are left out. Props also go into the parlays below when they clear the bar.
          {slate && ' Lines for games other than the open one are as of when that game was simulated.'}
        </p>
      )}
      {body}
    </section>
  );
}

/** The best props as singles; `onOpen` adds a link to each prop's game. Live props add what the player has now. */
function PropTable(props: { singles: Parlay[]; onOpen?: (id: string) => void; live?: boolean }) {
  return (
    <div class="table-wrap">
      <table class="data props-table">
        <thead>
          <tr>
            <th scope="col">Bet</th>
            {props.live && (
              <th scope="col" class="num" title="What the player has so far">
                Now
              </th>
            )}
            <th scope="col" class="num">
              Price
            </th>
            <th scope="col" class="num" title={props.live ? 'The player\'s average final line in the simulations, from now' : "The player's average in the simulations"}>
              Sim avg
            </th>
            <th scope="col" class="num">
              Sim hit
            </th>
            <th scope="col" class="num" title="The book's no-vig chance">
              Market
            </th>
            <th scope="col" class="num">
              Sim return
            </th>
          </tr>
        </thead>
        <tbody>
          {props.singles.map((p) => {
            const l = p.legs[0];
            return (
              <tr key={l.key}>
                <th scope="row">
                  {l.label}
                  {props.onOpen && (
                    <>
                      <br />
                      <button type="button" class="link p-game" onClick={() => props.onOpen!(l.gameId)}>
                        {l.game}
                      </button>
                    </>
                  )}
                </th>
                {props.live && <td class="num">{l.prop!.now ?? 0}</td>}
                <td class="num">{fmtAmerican(l.price)}</td>
                <td class="num">{one(l.prop!.mean)}</td>
                <td class="num">{pct(p.pHit, 0)}</td>
                <td class="num">{pct(l.pFair, 0)}</td>
                <td class="num pos">{perHundred(p.ev)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live bets for games in progress: the book's in-game game lines and player props, priced from a
 * simulation from the current score (props from each player's line so far plus the simulated rest):
 * the open game's (from its own simulation from now), or every live game's (from the live scan),
 * as singles and as 2- and 3-leg parlays.
 */
function LiveProps(props: {
  game: GameData;
  market?: GameMarket;
  state?: PropState;
  fromNow: boolean;
  onFromNow: () => void;
  mode: PickMode;
  onSim: () => void;
  slate: LiveSlate;
  scope: 'game' | 'all';
  onScope: (s: 'game' | 'all') => void;
  onOpen: (id: string) => void;
}) {
  const { game: g, market: m, state, slate } = props;
  const live = g.phase === 'in';
  const all = props.scope === 'all';
  const markets = useMemo(() => ({ ...slate.markets, ...(m ? { [m.gameId]: m } : {}) }), [slate.markets, m]);
  const pool = useMemo(() => (all ? Object.values(markets) : m ? [m] : []), [all, markets, m]);
  const weights = weightsFor(g.league, props.mode);
  const singles = useMemo(
    () =>
      pool
        .flatMap((x) => legsForGame(x, weights).filter((l) => l.prop))
        .map((l) => evaluate([l]))
        .filter((p) => p.ev > 0 && p.pHit >= HIT_FLOOR[1] && p.price <= MAX_PRICE[1])
        .sort((a, b) => b.ev - a.ev)
        .slice(0, all ? 15 : 10),
    [pool, weights],
  );
  const lineSingles = useMemo(
    () =>
      pool
        .flatMap((x) => legsForGame(x, weights).filter((l) => !l.prop))
        .map((l) => evaluate([l]))
        .filter((p) => p.ev > 0 && p.pHit >= HIT_FLOOR[1] && p.price <= MAX_PRICE[1])
        .sort((a, b) => b.ev - a.ev)
        .slice(0, all ? 6 : 3),
    [pool, weights],
  );
  const sug = useMemo(() => suggestParlays(pool, 3, weights), [pool, weights]);
  const posted = state?.status === 'ok' ? state.board!.lines.length : 0;
  const hasLines = state?.status === 'ok' && !!state.board!.odds;
  const others = slate.candidates;
  const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  let status: preact.ComponentChildren = null;
  let body;
  if (!all) {
    if (!props.fromNow)
      body = (
        <>
          <p>Live bets are priced from the current score, clock and box score, so the simulation has to start from now.</p>
          <p>
            <button type="button" class="btn" onClick={props.onFromNow}>
              Simulate from now
            </button>
          </p>
        </>
      );
    else if (!state || state.status === 'loading') body = <p class="muted">Loading live prop lines…</p>;
    else if (state.status === 'error') body = <p class="muted">Couldn't load live prop lines from ESPN.</p>;
    else if (!posted && !hasLines) body = <p class="muted">The book has no live lines or player props for this game right now.</p>;
    else if (!m) body = <p class="muted">Waiting for the simulation from now to finish.</p>;
    if (props.fromNow && (posted > 0 || hasLines))
      status = (
        <p class="muted small">
          {state!.board!.provider ?? 'Book'} via ESPN: {[hasLines ? 'game lines' : '', posted ? `${posted} props` : ''].filter(Boolean).join(' and ')} ·{' '}
          {time(state!.board!.fetchedAt)}, refreshed every 2 minutes
        </p>
      );
  } else {
    const priced = Object.keys(markets).length;
    status = (
      <div class="scan">
        {slate.status === 'running' ? (
          <>
            <span class="spinner" aria-hidden="true" />
            <span>
              Pricing live games ({slate.done} of {slate.total} done)
            </span>
          </>
        ) : (
          <span class="muted small">
            {priced} live game{priced === 1 ? '' : 's'} priced{slate.updatedAt ? ` · updated ${time(slate.updatedAt)}` : ''}
            {slate.paused ? ' · paused' : ' · refreshes every 2 minutes'}
          </span>
        )}
        {slate.paused ? (
          <button type="button" class="btn" onClick={slate.resume}>
            Resume
          </button>
        ) : (
          <button type="button" class="ghost-btn" onClick={slate.pause}>
            Pause
          </button>
        )}
        {!slate.paused && slate.status !== 'running' && (
          <button type="button" class="ghost-btn" onClick={slate.refresh}>
            Refresh now
          </button>
        )}
        {slate.failed > 0 && <span class="muted small">{slate.failed} couldn't be loaded.</span>}
      </div>
    );
    if (live && !props.fromNow)
      body = (
        <p class="muted small">
          This game joins once it's simulated from now.{' '}
          <button type="button" class="link" onClick={props.onFromNow}>
            Simulate from now
          </button>
        </p>
      );
    if (!priced) body = <p class="muted">{slate.status === 'running' || (!slate.updatedAt && !slate.paused) ? 'Pricing live games…' : 'No live props to price right now.'}</p>;
  }
  const ready = all ? Object.keys(markets).length > 0 : !!m && props.fromNow && (posted > 0 || hasLines);
  let picks;
  if (ready && props.mode === 'blend')
    picks = (
      <>
        <p>Player props have no backtest yet, so the backtest blend prices them at the market's own odds and none can beat the vig.</p>
        <p>
          <button type="button" class="btn" onClick={props.onSim}>
            Show the simulation's prop picks
          </button>
        </p>
      </>
    );
  else if (ready && !singles.length && !lineSingles.length) picks = <p class="muted">No live bet clears the bar right now. Passing is a fine choice.</p>;
  else if (ready)
    picks = (
      <>
        {lineSingles.length > 0 && (
          <>
            <h3 class="kicker">Game lines</h3>
            <div class="parlay-grid">
              {lineSingles.map((p) => (
                <ParlayCard key={p.legs[0].key} p={p} mode={props.mode} showGame={all} markets={markets} onOpen={props.onOpen} />
              ))}
            </div>
          </>
        )}
        {singles.length > 0 && (
          <>
            <h3 class="kicker">Player props</h3>
            <PropTable singles={singles} live onOpen={all ? props.onOpen : undefined} />
          </>
        )}
        {([2, 3] as const).map((size) =>
          sug.bySize[size].length ? (
            <div key={size}>
              <h3 class="kicker">{SIZE_TITLE[size]}</h3>
              <div class="parlay-grid">
                {sug.bySize[size].map((p) => (
                  <ParlayCard key={p.legs.map((l) => l.key).join('|')} p={p} mode={props.mode} showGame={all} markets={markets} onOpen={props.onOpen} />
                ))}
              </div>
            </div>
          ) : null,
        )}
      </>
    );

  return (
    <section class="card">
      <header class="card-head">
        <h2>Live bets</h2>
        {live && (
          <div class="seg small" role="radiogroup" aria-label="Which live games">
            <button type="button" role="radio" aria-checked={!all} class={!all ? 'on' : ''} onClick={() => props.onScope('game')}>
              This game
            </button>
            <button type="button" role="radio" aria-checked={all} class={all ? 'on' : ''} onClick={() => props.onScope('all')}>
              All live games ({slate.updatedAt ? Object.keys(markets).length : others + 1})
            </button>
          </div>
        )}
      </header>
      {!live && !all ? (
        <>
          <p>
            {others} game{others === 1 ? ' is' : 's are'} live right now. Pricing them for live parlays reads each game's in-game lines and props and simulates it from the current
            score, about 1 MB per game every 2 minutes.
          </p>
          <p>
            <button type="button" class="btn" onClick={() => props.onScope('all')}>
              Price live games
            </button>
          </p>
        </>
      ) : (
        <>
          {status}
          {ready && props.mode === 'sim' && (
            <p class="note caution">
              Live lines move fast and the book's prices here can trail the real ones by a minute or two. Each player's final line is what they have now plus the simulated rest
              of the game, from the simulation's minutes. Live spreads and totals are full-game lines, priced from the simulation's final scores starting at the current one.
              None of this has been backtested. Treat these as leans.{all && ' Legs from different games are treated as independent.'}
              {all && ' Pricing every live game costs about 1 MB per game per refresh; pause to stop.'}
            </p>
          )}
          {body}
          {picks}
        </>
      )}
    </section>
  );
}
