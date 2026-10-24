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
      version: '1.1.0',
      fingerprint: FINGERPRINT,
    });
  });
});

const FINGERPRINT = ['nba:0.5775:113.50:111.26', 'ncaam:0.5600:72.67:70.97'];
