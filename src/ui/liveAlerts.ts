// Alerts when the pick model's live bet first appears: a browser notification naming the bet, its
// price, how far the book can move and it's still a bet, and how old the line is. Only lines the
// book changed in the last five minutes alert (ESPN's copy of older ones has usually moved at the
// book), each pick once per game, and only while the live record is ahead on days it hadn't seen.
import { useEffect } from 'preact/hooks';
import { fitSingles, weightsFor, type GameMarket, type Leg } from '../model/parlays';
import type { LeagueId } from '../model/types';
import { fmtAmerican } from '../lib/stats';
import { fitAhead, stillText, type FitState } from './bestBets';
import { STALE_LINE_MIN, ageText, lineAgeMin, pct } from './format';
import { firstSeen, showNotification } from './notify';

export const ALERTS_KEY = 'conquer.liveAlerts';
const SEEN_KEY = 'conquer.liveAlertsSeen';

export interface LiveAlert {
  /** Game, player, stat and side: a line or price move on the same bet doesn't alert again. */
  key: string;
  title: string;
  body: string;
}

export const alertKey = (l: Leg) => `${l.gameId}|${l.prop!.athleteId}|${l.prop!.stat}|${l.side}`;

/** The live picks worth an alert right now, best return first. */
export function alertable(league: LeagueId, fit: FitState, markets: GameMarket[], now = Date.now()): LiveAlert[] {
  const fits = fit.fits;
  if (!fits?.live || !fitAhead(fit, 'live')) return [];
  const live = markets.filter((m) => m.live && m.props?.length);
  return fitSingles(live, weightsFor(league, 'blend', fits)).flatMap((p) => {
    const l = p.legs[0];
    const age = lineAgeMin(l.prop?.updated, now);
    // A line the feed doesn't date can't be shown to be fresh.
    if (!l.prop || !l.fitted || age == null || age >= STALE_LINE_MIN) return [];
    const still = stillText(l, fits);
    return [
      {
        key: alertKey(l),
        title: `${l.label} ${fmtAmerican(l.price)}`,
        body: [`${l.game}, has ${l.prop.now ?? 0}`, `fit ${pct(l.pBlend, 0)}`, still, `line set ${age < 1 ? 'just now' : `${ageText(age)} ago`}`]
          .filter(Boolean)
          .join(' · '),
      },
    ];
  });
}

/** One notification for a single new pick; several at once share one. */
export function alertMessage(fresh: LiveAlert[]): LiveAlert | undefined {
  if (fresh.length <= 1) return fresh[0];
  return { key: 'conquer-live-picks', title: `${fresh.length} new live picks`, body: fresh.map((a) => a.title).join('\n') };
}

/**
 * Watches the priced live games and announces each new pick once. Picks that appear while alerts
 * are off are marked seen too, so turning alerts on only announces what's new from then.
 */
export function useLiveAlerts(league: LeagueId, fit: FitState, markets: Record<string, GameMarket>, on: boolean) {
  useEffect(() => {
    const now = alertable(league, fit, Object.values(markets));
    if (!now.length) return;
    const fresh = new Set(firstSeen(SEEN_KEY, now.map((a) => a.key)));
    const msg = alertMessage(now.filter((a) => fresh.has(a.key)));
    if (msg && on) showNotification(msg.title, msg.body, msg.key);
  }, [league, fit, markets, on]);
}
