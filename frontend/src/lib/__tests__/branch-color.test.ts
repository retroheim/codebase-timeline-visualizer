import { describe, expect, it } from 'vitest';
import { colorForBranch } from '../branch-color';

function luminance([r, g, b]: [number, number, number]): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

describe('colorForBranch', () => {
  it('is deterministic for the same name and depth', () => {
    expect(colorForBranch('src', 2)).toEqual(colorForBranch('src', 2));
  });

  it('gets darker with increasing depth, before the lightness floor', () => {
    const shallow = luminance(colorForBranch('src', 0));
    const deep = luminance(colorForBranch('src', 5));
    expect(deep).toBeLessThan(shallow);
  });

  it('produces a valid RGB triple', () => {
    const [r, g, b] = colorForBranch('frontend', 1);
    for (const channel of [r, g, b]) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(255);
    }
  });

  it('different branch names generally produce different hues', () => {
    expect(colorForBranch('src', 0)).not.toEqual(colorForBranch('frontend', 0));
  });
});
