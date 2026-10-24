import { useMemo, useState } from 'preact/hooks';
import { DEFAULT_JUICE, HIT_FLOOR, MAX_PRICE, suggestParlays, type GameMarket, type Parlay } from '../model/parlays';
import type { GameData } from '../model/types';
import { fmtAmerican } from '../lib/stats';
import { pct, perHundred, tipTime } from './format';

export interface ScanState {
  status: 'idle' | 'running' | 'done';
  done: number;
  total: number;
  current?: string;
  failed: number;
}

const SIZE_TITLE: Record<1 | 2 | 3, string> = { 1: 'Singles', 2: '2-leg parlays', 3: '3-leg parlays' };

function ParlayCard(props: { p: Parlay; showGame: boolean; markets: Record<string, GameMarket>; onOpen: (id: string) => void }) {
  const { p } = props;
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
          <dt>Hit chance</dt>
          <dd>{pct(p.pHit, 0)}</dd>
        </div>
        <div>
          <dt>Price implies</dt>
          <dd>{pct(p.pImplied, 0)}</dd>
        </div>
        <div>
          <dt>Model alone</dt>
          <dd>{pct(p.pModel, 0)}</dd>
        </div>
        <div>
          <dt>Expected return</dt>
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
}) {
  const { game: g, markets } = props;
  const ids = Object.keys(markets);
  const [scope, setScope] = useState<'game' | 'slate'>(ids.length > 1 ? 'slate' : 'game');
  const pool = useMemo(() => (scope === 'game' ? (markets[g.id] ? [markets[g.id]] : []) : Object.values(markets)), [scope, markets, g.id]);
  const s = useMemo(() => suggestParlays(pool), [pool]);
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

      <section class="card">
        <header class="card-head">
          <h2>Suggested parlays</h2>
          <div class="seg small" role="radiogroup" aria-label="Which games">
            <button type="button" role="radio" aria-checked={scope === 'game'} class={scope === 'game' ? 'on' : ''} onClick={() => setScope('game')}>
              This game
            </button>
            <button type="button" role="radio" aria-checked={scope === 'slate'} class={scope === 'slate' ? 'on' : ''} onClick={() => setScope('slate')}>
              Across the slate ({ids.length} {ids.length === 1 ? 'game' : 'games'})
            </button>
          </div>
        </header>
        <p class="muted small">
          One to three legs from moneylines, spreads and totals. A pick needs positive expected value after blending the simulation 50/50 with the market's no-vig odds. It
          also needs a hit chance of at least {pct(HIT_FLOOR[1], 0)}, {pct(HIT_FLOOR[2], 0)} or {pct(HIT_FLOOR[3], 0)} and a price no longer than {fmtAmerican(MAX_PRICE[1])},{' '}
          {fmtAmerican(MAX_PRICE[2])} or {fmtAmerican(MAX_PRICE[3])} for one, two or three legs. Same-game legs are scored together from the simulations; legs from different games
          are treated as independent.
        </p>
        {scope === 'slate' && (
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
        {scope === 'game' && !markets[g.id] && (
          <p class="note">
            {g.phase !== 'pre'
              ? 'This game has already started, so its pre-game lines are no longer available. Switch to the slate or pick an upcoming game.'
              : g.odds
                ? 'Waiting for this game’s simulation to finish.'
                : 'No betting line is posted for this game yet.'}
          </p>
        )}
        {changed.length > 0 && (
          <p class="note">
            {changed.map((m) => `${m.label}: ${m.note}`).join(' · ')}. Lines may already reflect news your scenario adds or removes.
          </p>
        )}
      </section>

      {pool.length > 0 &&
        ([1, 2, 3] as const).map((size) => (
          <section class="card" key={size}>
            <header class="card-head">
              <h2>{SIZE_TITLE[size]}</h2>
            </header>
            {s.bySize[size].length ? (
              <div class="parlay-grid">
                {s.bySize[size].map((p) => (
                  <ParlayCard key={p.legs.map((l) => l.key).join('|')} p={p} showGame={scope === 'slate'} markets={markets} onOpen={props.onOpen} />
                ))}
              </div>
            ) : (
              <p class="muted">
                Nothing clears the bar here. {scope === 'game' && ids.length < 2 ? 'Try the whole slate for more combinations.' : 'Passing is a fine choice.'}
              </p>
            )}
          </section>
        ))}

      {scope === 'slate' && pool.length > 0 && (
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
