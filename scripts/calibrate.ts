// Prints the engine's league-level calibration against real NBA targets.
// Run after changing anything in src/sim or src/model:  npm run calibrate
import { leagueAverageGame } from '../tests/helpers';
import { buildSpec } from '../src/model/build';
import { LEAGUES } from '../src/model/leagues';
import { simulateGame } from '../src/sim/engine';
import { makeRng } from '../src/lib/rng';
import { BF, NBF } from '../src/sim/types';

const N = 4000;
const { spec } = buildSpec(leagueAverageGame(), { outs: new Set(), ins: new Set(), whistle: 1, homeCourt: true, minutesMode: 'projected' });
const tot = new Float64Array(NBF);
let poss = 0, m = 0, m2 = 0, ot = 0, foulOuts = 0;
const t0 = Date.now();
for (let s = 0; s < N; s++) {
  const r = simulateGame(spec, makeRng('calibrate', s));
  poss += (r.possessions[0] + r.possessions[1]) / 2;
  const d = r.score[0] - r.score[1];
  m += d;
  m2 += d * d;
  if (r.ot) ot++;
  foulOuts += r.fouledOut[0].length + r.fouledOut[1].length;
  for (let t = 0; t < 2; t++) for (let i = 0; i < r.box[t].length; i++) tot[i % NBF] += r.box[t][i];
}
const per = (f: number) => (tot[f] / (2 * N)).toFixed(1);
const mean = m / N;
const lg = LEAGUES.nba;
console.log(`${N} league-average NBA games in ${Date.now() - t0} ms`);
console.log(`possessions/team ${(poss / N).toFixed(1)} (target ${lg.pace})`);
console.log(`points/possession ${(tot[BF.pts] / 2 / poss).toFixed(3)} (target ${lg.ppp})`);
console.log(`home margin ${mean.toFixed(2)} (target ~${lg.homeAdvPts}), sd ${Math.sqrt(m2 / N - mean * mean).toFixed(2)} (target ~13.5)`);
console.log(`overtime ${((ot / N) * 100).toFixed(1)}% (real ~6%), foul-outs/game ${(foulOuts / N).toFixed(2)} (real ~0.15)`);
console.log(`per team: FGA ${per(BF.fga)} 3PA ${per(BF.tpa)} FTA ${per(BF.fta)} OREB ${per(BF.oreb)} DREB ${per(BF.dreb)} AST ${per(BF.ast)} STL ${per(BF.stl)} BLK ${per(BF.blk)} TOV ${per(BF.tov)} PF ${per(BF.pf)}`);
