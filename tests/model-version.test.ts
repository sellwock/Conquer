import { describe, expect, it } from 'vitest';
import { buildSpec } from '../src/model/build';
import { MODEL_VERSION } from '../src/model/version';
import { runQuick } from '../src/sim/quick';
import { leagueAverageGame } from './helpers';

// A fingerprint of the simulator's output on fixed inputs. When a change moves it, update the
// fingerprint AND bump MODEL_VERSION, so logged predictions and cached backtests stay separable.
const base = { outs: new Set<string>(), ins: new Set<string>(), whistle: 1, homeCourt: true, minutesMode: 'projected' as const };

function fingerprint() {
  return (['nba', 'ncaam'] as const).map((league) => {
    const q = runQuick(buildSpec(leagueAverageGame(league), base).spec, 400, 'fingerprint');
    return [league, q.homeWin.toFixed(4), q.home.toFixed(2), q.away.toFixed(2)].join(':');
  });
}

describe('model version', () => {
  it('changes only together with the simulation output', () => {
    expect({ version: MODEL_VERSION, fingerprint: fingerprint() }).toEqual({
      version: '1.2.0',
      fingerprint: FINGERPRINT,
    });
  });
});

const FINGERPRINT = ['nba:0.6275:115.72:111.63', 'ncaam:0.5525:72.69:70.70'];
