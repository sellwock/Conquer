import { describe, expect, it } from 'vitest';
import { effectiveFrom, parseHash, toHash } from '../src/ui/state';

describe('where the simulation starts', () => {
  it('defaults to auto, which stays out of the link', () => {
    const s = parseHash('#game=401810123');
    expect(s.from).toBe('auto');
    expect(toHash(s)).toBe('#game=401810123');
  });

  it('keeps an explicit start in the link', () => {
    for (const from of ['tip', 'now', '412']) {
      const s = parseHash(`#game=1&from=${from}`);
      expect(s.from).toBe(from);
      expect(parseHash(toHash(s)).from).toBe(from);
    }
  });

  it('simulates a game in progress from now unless told otherwise', () => {
    expect(effectiveFrom('auto', 'in')).toBe('now');
    expect(effectiveFrom('auto', 'pre')).toBe('tip');
    expect(effectiveFrom('auto', 'post')).toBe('tip');
    expect(effectiveFrom('auto', undefined)).toBe('tip');
    expect(effectiveFrom('tip', 'in')).toBe('tip');
    expect(effectiveFrom('412', 'in')).toBe('412');
  });
});
