// Prints the engine's league-level calibration against real targets, for the NBA and college.
// Run after changing anything in src/sim or src/model:  npm run calibrate
import { leagueAverageGame } from '../tests/helpers';
import { buildSpec } from '../src/model/build';
import { LEAGUES } from '../src/model/leagues';
import { simulateGame } from '../src/sim/engine';
import { makeRng } from '../src/lib/rng';
import { BF, NBF } from '../src/sim/types';

const N = Number(process.argv[2] ?? 8000);
/** Real margin spread between evenly matched teams, and overtime rates (both leagues 5.5-6.5%). */
const SD_TARGET = { nba: 13.5, ncaam: 11.5 };

for (const league of ['nba', 'ncaam'] as const) {
  const { spec } = buildSpec(leagueAverageGame(league), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
  const tot = new Float64Array(NBF);
  let poss = 0, m = 0, m2 = 0, ot = 0, foulOuts = 0, close = 0;
  const t0 = Date.now();
  for (let s = 0; s < N; s++) {
    const r = simulateGame(spec, makeRng('calibrate', s));
    poss += (r.possessions[0] + r.possessions[1]) / 2;
    const d = r.score[0] - r.score[1];
    m += d;
    m2 += d * d;
    if (r.ot) ot++;
    else if (Math.abs(d) <= 3) close++;
    foulOuts += r.fouledOut[0].length + r.fouledOut[1].length;
    for (let t = 0; t < 2; t++) for (let i = 0; i < r.box[t].length; i++) tot[i % NBF] += r.box[t][i];
  }
  const per = (f: number) => (tot[f] / (2 * N)).toFixed(1);
  const mean = m / N;
  const lg = LEAGUES[league];
  console.log(`\n${N} league-average ${league === 'nba' ? 'NBA' : 'college'} games in ${Date.now() - t0} ms`);
  console.log(`possessions/team ${(poss / N).toFixed(1)} (target ${lg.pace})`);
  console.log(`points/possession ${(tot[BF.pts] / 2 / poss).toFixed(3)} (target ${lg.ppp})`);
  console.log(`home margin ${mean.toFixed(2)} (target ~${lg.homeAdvPts}), sd ${Math.sqrt(m2 / N - mean * mean).toFixed(2)} (target ~${SD_TARGET[league]})`);
  console.log(`overtime ${((ot / N) * 100).toFixed(1)}% (target 5.5-6.5%), regulation finishes within 3: ${((close / N) * 100).toFixed(1)}%`);
  console.log(`foul-outs/game ${(foulOuts / N).toFixed(2)}${league === 'nba' ? ' (real ~0.15)' : ''}`);
  console.log(`per team: FGA ${per(BF.fga)} 3PA ${per(BF.tpa)} FTA ${per(BF.fta)} OREB ${per(BF.oreb)} DREB ${per(BF.dreb)} AST ${per(BF.ast)} STL ${per(BF.stl)} BLK ${per(BF.blk)} TOV ${per(BF.tov)} PF ${per(BF.pf)}`);
}
