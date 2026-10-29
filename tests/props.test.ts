import { describe, expect, it } from 'vitest';
import { americanOf, parsePropBets, pickPropBook } from '../src/data/espn/props';
import { propMarkets, MIN_MINUTES, type SoFar } from '../src/model/props';
import { evaluate, legsForGame, suggestParlays, SIM_ONLY, type GameMarket } from '../src/model/parlays';
import { packMarket, unpackMarket } from '../src/model/slate';
import { runOutcomes } from '../src/sim/quick';
import { buildSpec } from '../src/model/build';
import { runSims } from '../src/sim/run';
import { leagueAverageGame } from './helpers';

const ref = (id: string) => ({ $ref: `http://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2027/athletes/${id}?lang=en&region=us` });
const item = (athlete: string, typeId: string, name: string, line: number, american: string) => ({
  athlete: ref(athlete),
  type: { id: typeId, name },
  odds: { american: { value: american }, total: { value: String(line) } },
  current: { target: { value: line, displayValue: String(line) } },
});

describe('prop feed', () => {
  it('pairs over (listed first) with under, keeping only props the simulation can price', () => {
    const lines = parsePropBets([
      item('5104157', '4', 'Total 3-Point Field Goals', 1.5, '-188'),
      item('5104157', '4', 'Total 3-Point Field Goals', 1.5, '+142'),
      item('5104157', '90', 'Total Points, Rebounds, and Assists', 39.5, '-116'),
      item('5104157', '90', 'Total Points, Rebounds, and Assists', 39.5, 'EVEN'),
      // A milestone ladder, a team prop and a lone item are left out.
      item('5104157', '218', 'Points Milestones', 25, '-150'),
      { type: { id: '98', name: 'Team Total Points' }, team: { $ref: 'x/teams/24' }, odds: { american: { value: '-110' } }, current: { target: { value: 110.5 } } },
      item('6442', '1', 'Total Points', 20.5, '-113'),
      // Mismatched lines can't be a pair.
      item('4066457', '3', 'Total Rebounds', 3.5, '-144'),
      item('4066457', '3', 'Total Rebounds', 4.5, '+110'),
    ]);
    expect(lines).toEqual([
      { athleteId: '5104157', stat: 'tpm', line: 1.5, over: -188, under: 142 },
      { athleteId: '5104157', stat: 'pra', line: 39.5, over: -116, under: 100 },
    ]);
    expect(americanOf('+131')).toBe(131);
    expect(americanOf('-')).toBeUndefined();
  });
});

describe('prop books', () => {
  const pre = { provider: { id: '100', name: 'DraftKings' }, propBets: { $ref: 'x/100/propBets' } };
  const live = { provider: { id: '200', name: 'DraftKings - Live Odds' }, propBets: { $ref: 'x/200/propBets' } };
  it('reads the pre-game book before tip-off and the in-game feed once the game is live', () => {
    expect(pickPropBook([pre, live], false)).toBe(pre);
    expect(pickPropBook([pre, live], true)).toBe(live);
    expect(pickPropBook([pre], true)).toBeUndefined();
    expect(pickPropBook([{ provider: { name: 'Other' } }, pre], false)).toBe(pre);
  });
});

describe('player props in parlays', () => {
  const g = leagueAverageGame();
  const built = buildSpec(g, { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
  const s = runSims(built.spec, 2000, 'props');
  const po = s.outcomes.players!;

  it("keeps each player's line in every simulation", () => {
    expect(po.ids.length).toBe(s.players.length);
    expect(po.pts.length).toBe(2000 * po.ids.length);
    for (const [j, id] of po.ids.entries()) {
      const p = s.players.find((x) => x.id === id)!;
      let pts = 0, reb = 0;
      for (let k = 0; k < 2000; k++) {
        pts += po.pts[k * po.ids.length + j];
        reb += po.reb[k * po.ids.length + j];
      }
      expect(pts / 2000).toBeCloseTo(p.pts, 6);
      expect(reb / 2000).toBeCloseTo(p.reb, 6);
    }
  });

  const star = [...s.players].sort((a, b) => b.pts - a.pts)[0];
  const bench = [...s.players].sort((a, b) => a.min - b.min)[0];
  const lines = [
    // A line far below the star's average: the simulation loves the over.
    { athleteId: star.id, stat: 'pts' as const, line: Math.round(star.pts) - 8.5, over: -110, under: -110 },
    { athleteId: star.id, stat: 'pra' as const, line: Math.round(star.pts + star.reb + star.ast) + 0.5, over: -110, under: -110 },
    { athleteId: bench.id, stat: 'pts' as const, line: 0.5, over: -110, under: -110 },
    { athleteId: 'nobody', stat: 'pts' as const, line: 10.5, over: -110, under: -110 },
  ];
  const names = new Map(s.players.map((p) => [p.id, p.short]));
  const props = propMarkets(lines, po, names);
  const market: GameMarket = {
    gameId: 'g1',
    league: 'nba',
    label: 'AWY @ HOM',
    home: 'HOM',
    away: 'AWY',
    odds: { provider: 'Book', spread: -0.5, total: Math.round(s.homeScore + s.awayScore) + 0.5, homeML: -110, awayML: -110, homeSpreadOdds: -110, awaySpreadOdds: -110, overOdds: -110, underOdds: -110 },
    margin: s.outcomes.margin,
    total: s.outcomes.total,
    props,
  };

  it('prices only rotation players, summing combo stats per simulation', () => {
    expect(bench.min).toBeLessThan(MIN_MINUTES);
    expect(props.map((p) => p.stat)).toEqual(['pts', 'pra']);
    expect(props[0].mean).toBeCloseTo(star.pts, 6);
    expect(props[1].mean).toBeCloseTo(star.pts + star.reb + star.ast, 6);
  });

  it('turns each prop into an over and an under leg, left to the market by the blend', () => {
    const legs = legsForGame(market).filter((l) => l.prop);
    expect(legs).toHaveLength(4);
    expect(new Set(legs.map((l) => l.key)).size).toBe(4);
    const over = legs.find((l) => l.prop!.stat === 'pts' && l.side === 'over')!;
    expect(over.label).toBe(`${star.short} over ${props[0].line} points`);
    expect(over.pModel).toBeGreaterThan(0.85);
    expect(over.pFair).toBeCloseTo(0.5);
    expect(over.pBlend).toBeCloseTo(0.5); // no backtest for props: the market alone
    expect(over.ev).toBeLessThan(0);
    const sim = legsForGame(market, SIM_ONLY).find((l) => l.key === over.key)!;
    expect(sim.pBlend).toBe(sim.pModel);
    expect(sim.ev).toBeGreaterThan(0.5);
  });

  it('scores a prop together with the game total, and never pairs two props on one player', () => {
    const legs = legsForGame(market, SIM_ONLY);
    const ptsOver = legs.find((l) => l.prop?.stat === 'pts' && l.side === 'over')!;
    const praOver = legs.find((l) => l.prop?.stat === 'pra' && l.side === 'over')!;
    const gameOver = legs.find((l) => l.kind === 'total' && l.side === 'over')!;
    // The star scoring more and the game going over move together.
    expect(evaluate([praOver, gameOver]).correlation!).toBeGreaterThan(0);
    const sug = suggestParlays([market], 3, SIM_ONLY);
    expect(sug.bySize[1].some((p) => p.legs[0].key === ptsOver.key)).toBe(true);
    for (const size of [2, 3] as const)
      for (const p of sug.bySize[size]) {
        const ids = p.legs.filter((l) => l.prop).map((l) => l.prop!.athleteId);
        expect(new Set(ids).size).toBe(ids.length);
      }
  });

  it('scores integer lines as pushes, and the under as the over\'s complement', () => {
    const [even] = propMarkets([{ athleteId: star.id, stat: 'pts', line: Math.round(star.pts), over: -110, under: -110 }], po, names);
    const j = po.ids.indexOf(star.id);
    let pushes = 0;
    for (let k = 0; k < 2000; k++) {
      const v = po.pts[k * po.ids.length + j];
      expect(even.hits[k]).toBe(v > even.line ? 1 : v < even.line ? 0 : 2);
      if (even.hits[k] === 2) pushes++;
    }
    expect(pushes).toBeGreaterThan(0);
    const legs = legsForGame({ ...market, props: [even] }, SIM_ONLY).filter((l) => l.prop);
    const [over, under] = [legs.find((l) => l.side === 'over')!, legs.find((l) => l.side === 'under')!];
    for (let k = 0; k < 2000; k++) expect(under.outcome[k]).toBe(over.outcome[k] === 2 ? 2 : 1 - over.outcome[k]);
    expect(over.pPush).toBeCloseTo(pushes / 2000);
  });

  it('caches props compactly and restores them exactly', () => {
    const back = unpackMarket(JSON.parse(JSON.stringify(packMarket({ ...market, propsAt: 5, propsProvider: 'Book' }, 1))));
    expect(back.props).toHaveLength(props.length);
    back.props!.forEach((p, i) => {
      const { hits, ...rest } = props[i];
      expect(p).toMatchObject(rest);
      expect(Array.from(p.hits)).toEqual(Array.from(hits));
    });
    expect(back).toMatchObject({ propsAt: 5, propsProvider: 'Book' });
    // 2 bits per simulation: about 1.3 KB of base64 per line at 2,000 sims.
    const size = JSON.stringify(packMarket(market, 1)).length - JSON.stringify(packMarket({ ...market, props: undefined }, 1)).length;
    expect(size / props.length).toBeLessThan(1500);
  });

  it('prices live props from what each player has so far plus the simulated rest', () => {
    const j = po.ids.indexOf(star.id);
    const soFar = new Map<string, SoFar>([
      [star.id, { pts: 10, reb: 2, ast: 1, tpm: 1, played: true }],
      [bench.id, { pts: 0, reb: 0, ast: 0, tpm: 0, played: false }],
    ]);
    const live = propMarkets(
      [
        { athleteId: star.id, stat: 'pts', line: 30.5, over: -110, under: -110 },
        // Already cleared: the over can't lose.
        { athleteId: star.id, stat: 'ast', line: 0.5, over: -500, under: 350 },
        { athleteId: bench.id, stat: 'pts', line: 0.5, over: -110, under: -110 },
      ],
      po,
      names,
      soFar,
    );
    const [pts, ast] = live;
    expect(pts.now).toBe(10);
    let sum = 0;
    for (let k = 0; k < 2000; k++) {
      const v = 10 + po.pts[k * po.ids.length + j];
      sum += v;
      expect(pts.hits[k]).toBe(v > 30.5 ? 1 : 0);
    }
    expect(pts.mean).toBeCloseTo(sum / 2000, 6);
    expect(ast.hits.every((h) => h === 1)).toBe(true);
    // A player who hasn't played yet is still priced live if the simulation gives them any minutes,
    // because a live prop is settled on whatever they end with.
    expect(live.some((p) => p.athleteId === bench.id)).toBe(po.min[po.ids.indexOf(bench.id)] >= 1);
  });

  it('the slate pass records the same player lines as the full simulation', () => {
    const q = runOutcomes(built.spec, 2000, 'props', { players: true });
    expect(q.players!.ids).toEqual(po.ids);
    expect(Array.from(q.players!.pts)).toEqual(Array.from(po.pts));
    expect(Array.from(q.players!.ast)).toEqual(Array.from(po.ast));
    expect(Array.from(q.players!.min)).toEqual(Array.from(po.min));
    expect(runOutcomes(built.spec, 50, 'props').players).toBeUndefined();
  });
});
