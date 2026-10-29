// Each player's line in every simulation, so player props can be scored jointly with the game.
import { BF, NBF, type GameResult, type SimSpec } from './types';

export interface PlayerOutcomes {
  /** Home players, then away, in spec order. Stat arrays are indexed [sim * ids.length + player]. */
  ids: string[];
  pts: Uint8Array;
  reb: Uint8Array;
  ast: Uint8Array;
  tpm: Uint8Array;
  /** Mean simulated minutes per player. */
  min: Float32Array;
}

export class PlayerRecorder {
  private readonly po: PlayerOutcomes;
  private readonly secs: Float64Array;
  private readonly home: number;
  private sims = 0;

  constructor(spec: SimSpec, n: number) {
    const ids = [...spec.home.players, ...spec.away.players].map((p) => p.id);
    const size = n * ids.length;
    this.home = spec.home.players.length;
    this.po = { ids, pts: new Uint8Array(size), reb: new Uint8Array(size), ast: new Uint8Array(size), tpm: new Uint8Array(size), min: new Float32Array(ids.length) };
    this.secs = new Float64Array(ids.length);
  }

  add(s: number, r: GameResult) {
    const P = this.po.ids.length;
    for (let t = 0; t < 2; t++) {
      const box = r.box[t];
      const count = box.length / NBF;
      for (let i = 0; i < count; i++) {
        const o = i * NBF;
        const k = t === 0 ? i : this.home + i;
        const j = s * P + k;
        this.po.pts[j] = Math.min(255, box[o + BF.pts]);
        this.po.reb[j] = Math.min(255, box[o + BF.oreb] + box[o + BF.dreb]);
        this.po.ast[j] = Math.min(255, box[o + BF.ast]);
        this.po.tpm[j] = Math.min(255, box[o + BF.tpm]);
        this.secs[k] += box[o + BF.sec];
      }
    }
    this.sims++;
  }

  finish(): PlayerOutcomes {
    for (let k = 0; k < this.secs.length; k++) this.po.min[k] = this.sims ? this.secs[k] / 60 / this.sims : 0;
    return this.po;
  }
}
