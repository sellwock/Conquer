// The pick model's bets and the record behind them: the card that leads the slate board, the
// parlays tab's prop picks and the live bets panels. A pick is listed by the same rule its record
// is scored on (one per player per game, a minimum expected return, a capped price), and picks
// from a fit that isn't ahead on days it hadn't seen stay hidden until asked for.
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { MAX_PRICE, fitSingles, weightsFor, type GameMarket, type Parlay } from '../model/parlays';
import { fitVerdict, type FitVerdict, type PropFits } from '../model/propFit';
import type { LeagueId } from '../model/types';
import { MODEL_VERSION } from '../model/version';
import { fmtAmerican } from '../lib/stats';
import { fitsFor, type FitFile } from '../track/fit';
import { loadFit } from '../track/forward';
import { STALE_LINE_MIN, ageText, lineAgeMin, one, pct, perHundred, signedPct } from './format';

export interface FitState {
  /** The fit as the scheduled job wrote it, for its record. */
  file?: FitFile;
  /** The coefficients this model version may price with. */
  fits?: PropFits;
}

/** The league's fitted pick model; empty until it loads, and when there isn't one. */
export function useFit(league: LeagueId): FitState {
  const [loaded, setLoaded] = useState<{ league: LeagueId; file?: FitFile }>();
  useEffect(() => {
    const ac = new AbortController();
    loadFit(league, ac.signal)
      .then((file) => setLoaded({ league, file }))
      // The fit is extra: without it the site ranks as it did before there was one.
      .catch(() => {});
    return () => ac.abort();
  }, [league]);
  const file = loaded?.league === league ? loaded.file : undefined;
  return useMemo(() => ({ file, fits: fitsFor(file, MODEL_VERSION) }), [file]);
}

/** Lines posted before tip-off and lines from the in-game book have their own fit and record. */
export type FitWhen = 'pre' | 'live';

export const verdictOf = (fit: FitState, when: FitWhen): FitVerdict => fitVerdict(fit.file?.[when]?.test?.picks);

/** Whether a fit's picks are shown without asking: only when they're ahead on days it hadn't seen. */
export const fitAhead = (fit: FitState, when: FitWhen) => verdictOf(fit, when) !== 'none';

/** The fit's out-of-sample record in a line, with what it does and doesn't show. */
export function FitRecordLine(props: { fit: FitState; when: FitWhen; league: LeagueId }) {
  const part = props.fit.file?.[props.when];
  if (!part) return null;
  const t = part.test?.picks;
  const verdict = fitVerdict(t);
  const link = <a href={`#view=record&league=${props.league}`}>Track record</a>;
  if (!t || t.win + t.loss === 0)
    return (
      <p class="fit-line">
        <span class="chip warn">No record yet</span> Fitted to {part.lines.toLocaleString('en-US')} graded lines, but none of its picks could be scored on a day it hadn't
        seen yet. {link}
      </p>
    );
  return (
    <p class="fit-line">
      <span class={verdict === 'tested' ? 'chip good' : verdict === 'promising' ? 'chip' : 'chip warn'}>
        {verdict === 'tested' ? 'Tested' : verdict === 'promising' ? 'Ahead so far' : 'Not ahead'}
      </span>{' '}
      <strong>
        {t.win}-{t.loss}
      </strong>{' '}
      on days it hadn't seen, <strong class={t.lo > 0 ? 'pos' : t.hi < 0 ? 'neg' : ''}>{signedPct(t.roi)}</strong> per bet (95% range {signedPct(t.lo)} to {signedPct(t.hi)}).{' '}
      {verdict === 'promising' && 'Not proven: that range still includes losing. '}
      {verdict === 'none' && "That isn't ahead, so its picks are hidden unless you ask. "}
      {link}
    </p>
  );
}

/** Fitted single bets: the price, the fit's chance, the chance the price needs, and the return per $100. */
export function BetTable(props: { singles: Parlay[]; live?: boolean; onOpen?: (id: string) => void }) {
  return (
    <div class="table-wrap">
      <table class="data props-table bets-table">
        <thead>
          <tr>
            <th scope="col">Bet</th>
            <th scope="col" class="num">
              Price
            </th>
            <th scope="col" class="num" title="The pick model's chance this bet wins">
              Fit
            </th>
            <th scope="col" class="num" title="The chance this price needs to break even">
              Needs
            </th>
            <th scope="col" class="num" title="Expected return per $100 at the fit's chance">
              Return
            </th>
          </tr>
        </thead>
        <tbody>
          {props.singles.map((p) => {
            const l = p.legs[0];
            // A live line the book hasn't touched in a while has usually moved at the book itself.
            const age = props.live ? lineAgeMin(l.prop!.updated) : undefined;
            return (
              <tr key={l.key}>
                <th scope="row">
                  {l.label}
                  <br />
                  <span class="muted small">
                    {props.onOpen && (
                      <>
                        <button type="button" class="link p-game" onClick={() => props.onOpen!(l.gameId)}>
                          {l.game}
                        </button>{' '}
                        ·{' '}
                      </>
                    )}
                    {props.live && <>has {l.prop!.now ?? 0} · </>}
                    sim {one(l.prop!.mean)} · book {pct(l.pFair, 0)}
                    {age != null && (
                      <>
                        {' '}
                        ·{' '}
                        {age >= STALE_LINE_MIN ? (
                          <span class="chip warn" title="ESPN's copy of this line hasn't changed in a while. The book's own price has probably moved.">
                            Line {ageText(age)} old: check the book
                          </span>
                        ) : (
                          <>line set {ageText(age)}{age < 1 ? '' : ' ago'}</>
                        )}
                      </>
                    )}
                  </span>
                </th>
                <td class="num" data-label="Price">
                  {fmtAmerican(l.price)}
                </td>
                <td class="num" data-label="Fit">
                  {pct(l.pBlend, 0)}
                </td>
                <td class="num" data-label="Needs">
                  {pct(1 / l.decimal, 0)}
                </td>
                <td class="num pos">{perHundred(p.ev)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** "a 3% expected return by the pick model at a price no longer than +200" */
export const barText = (fits: PropFits) => `a ${pct(fits.minEdge, 0)} expected return by the pick model at a price no longer than ${fmtAmerican(MAX_PRICE[1])}`;

/** One kind of line's picks (pre-game or live) under its record. Renders nothing without coefficients for it. */
export function FitPicks(props: {
  fit: FitState;
  when: FitWhen;
  league: LeagueId;
  markets: GameMarket[];
  /** Rows shown before "Show all". */
  limit?: number;
  revealed: boolean;
  onReveal: () => void;
  onOpen?: (id: string) => void;
  /** Shown in place of picks while no game here has props priced. */
  waiting?: ComponentChildren;
}) {
  const { fit, when } = props;
  const [all, setAll] = useState(false);
  const fits = fit.fits;
  const singles = useMemo(() => (fits ? fitSingles(props.markets, weightsFor(props.league, 'blend', fits)) : []), [props.markets, props.league, fits]);
  if (!fits?.[when]) return null;
  const priced = props.markets.some((m) => m.props?.length);
  const hidden = !fitAhead(fit, when) && !props.revealed;
  const limit = props.limit ?? 12;
  const shown = all ? singles : singles.slice(0, limit);
  const flat = fit.file?.[when]?.flat;
  const overs = singles.filter((p) => p.legs[0].side === 'over').length;

  return (
    <>
      <FitRecordLine fit={fit} when={when} league={props.league} />
      {!priced ? (
        (props.waiting ?? null)
      ) : hidden ? (
        <p>
          {singles.length} pick{singles.length === 1 ? '' : 's'} hidden.{' '}
          <button type="button" class="btn" onClick={props.onReveal}>
            Show {singles.length === 1 ? 'it' : 'them'} anyway
          </button>
        </p>
      ) : !singles.length ? (
        <p class="muted">No prop clears the bar right now: {barText(fits)}. Passing is a fine choice.</p>
      ) : (
        <>
          <BetTable singles={shown} live={when === 'live'} onOpen={props.onOpen} />
          {singles.length > shown.length && (
            <p>
              <button type="button" class="link" onClick={() => setAll(true)}>
                Show all {singles.length}
              </button>
            </p>
          )}
          <p class="muted small">
            One bet per player: the line and side with the best return by the fit, if it clears {barText(fits)}. The record stakes every pick equally, so the order
            here is untested.
            {flat && flat.over.roi < 0 && (
              <>
                {' '}
                Blind overs on these lines went {flat.over.win}-{flat.over.loss}, {signedPct(flat.over.roi)} per bet (unders {signedPct(flat.under.roi)})
                {overs ? `; the ${overs === 1 ? 'over' : `${overs} overs`} listed cleared the bar anyway.` : ', and no over clears the bar here.'}
              </>
            )}
          </p>
        </>
      )}
    </>
  );
}

/**
 * The slate board's lead card: the pick model's single bets for games in progress and games still
 * to tip. Renders nothing until a fit has loaded.
 */
export function BestBets(props: {
  league: LeagueId;
  fit: FitState;
  pre: GameMarket[];
  live: GameMarket[];
  revealed: boolean;
  onReveal: () => void;
  onOpen: (id: string) => void;
}) {
  const { fit } = props;
  if (!fit.fits) return null;
  // The in-game feed is the same book under a longer name.
  const provider = [...props.pre, ...props.live].find((m) => m.propsProvider)?.propsProvider?.replace(/\s*-\s*Live Odds$/i, '');
  const showLive = !!fit.fits.live && props.live.length > 0;
  return (
    <section class="card best-bets">
      <header class="card-head">
        <h2>Best bets</h2>
        <p class="muted small">Singles first · {provider ?? 'Book'} lines via ESPN</p>
      </header>
      <p class="muted small">
        Single bets from the pick model: a small model fitted to graded prop lines from the book's own odds and how far the simulation disagrees with them. Its record
        below comes only from days it hadn't seen. Suggestions, not advice; check the price at your book before betting.
      </p>
      {showLive && (
        <>
          <h3 class="kicker">Live now</h3>
          <FitPicks fit={fit} when="live" league={props.league} markets={props.live} revealed={props.revealed} onReveal={props.onReveal} onOpen={props.onOpen} />
          <p class="muted small">Live lines move fast, and the in-game prices ESPN relays can lag the book's by several minutes.</p>
        </>
      )}
      {fit.fits.pre ? (
        <>
          <h3 class="kicker">Before tip-off</h3>
          <FitPicks
            fit={fit}
            when="pre"
            league={props.league}
            markets={props.pre}
            revealed={props.revealed}
            onReveal={props.onReveal}
            onOpen={props.onOpen}
            waiting={<p class="muted">Picks appear as upcoming games with posted props are simulated.</p>}
          />
        </>
      ) : (
        <p class="note">
          The pre-game pick model was fitted to an earlier model version's simulations and is being refitted for {MODEL_VERSION}. Until then, pre-game props show the
          simulation's leans in the table below.
        </p>
      )}
    </section>
  );
}
