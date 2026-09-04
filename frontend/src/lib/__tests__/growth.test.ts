import { describe, expect, it } from 'vitest';
import { growthSeries, nearestIndexForTimestamp } from '../growth';
import { makeCommit } from './commit-fixture';
import type { CommitEvent } from '../../types';

function commit(timestamp: number, cumulativeLines: number, cumulativeFiles: number): CommitEvent {
  return makeCommit({ timestamp, cumulative_lines: cumulativeLines, cumulative_files: cumulativeFiles });
}

describe('growthSeries', () => {
  it('maps precomputed cumulative fields straight through with an index', () => {
    const timeline = [commit(100, 10, 1), commit(200, 25, 2)];
    expect(growthSeries(timeline)).toEqual([
      { index: 0, timestamp: 100, cumulativeLines: 10, cumulativeFiles: 1 },
      { index: 1, timestamp: 200, cumulativeLines: 25, cumulativeFiles: 2 },
    ]);
  });

  it('returns an empty array for an empty timeline', () => {
    expect(growthSeries([])).toEqual([]);
  });
});

describe('nearestIndexForTimestamp', () => {
  const series = growthSeries([commit(100, 1, 1), commit(200, 2, 1), commit(300, 3, 1)]);

  it('returns the exact index for an exact timestamp match', () => {
    expect(nearestIndexForTimestamp(series, 200)).toBe(1);
  });

  it('rounds to the nearer neighbor between two points', () => {
    expect(nearestIndexForTimestamp(series, 240)).toBe(1);
    expect(nearestIndexForTimestamp(series, 260)).toBe(2);
  });

  it('clamps to the first point before the series starts', () => {
    expect(nearestIndexForTimestamp(series, 0)).toBe(0);
  });

  it('clamps to the last point after the series ends', () => {
    expect(nearestIndexForTimestamp(series, 1000)).toBe(2);
  });

  it('returns 0 for an empty series', () => {
    expect(nearestIndexForTimestamp([], 100)).toBe(0);
  });
});
