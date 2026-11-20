// How much to stake on a single bet: a quarter of the Kelly fraction, capped. Full Kelly assumes
// the chance is known exactly; the pick model's isn't, so the stake is cut hard and capped.
export const KELLY_SHARE = 0.25;
/** No single bet above this share of the bankroll. */
export const MAX_STAKE_SHARE = 0.01;

/**
 * The stake for a bet at decimal price `decimal` that wins with chance `p`, from `bankroll`.
 * Halved unless the pick model's record is tested. Zero when the bet has no edge.
 */
export function kellyStake(p: number, decimal: number, bankroll: number, tested: boolean): number {
  if (!(bankroll > 0) || decimal <= 1) return 0;
  const kelly = (p * decimal - 1) / (decimal - 1);
  if (!(kelly > 0)) return 0;
  const share = Math.min(MAX_STAKE_SHARE, KELLY_SHARE * kelly) * (tested ? 1 : 0.5);
  return Math.round(bankroll * share * 100) / 100;
}
