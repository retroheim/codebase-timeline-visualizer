import { describe, expect, it } from 'vitest';
import { bucketByDay, calendarWeeks, intensityLevel, longestStreak } from '../calendar';
import { makeCommit } from './commit-fixture';
import type { CommitEvent } from '../../types';

function commit(timestamp: number, linesAdded = 1, linesRemoved = 0): CommitEvent {
  return makeCommit({ timestamp, lines_added: linesAdded, lines_removed: linesRemoved });
}

describe('bucketByDay', () => {
  it('groups commits on the same UTC day into one bucket', () => {
    const dayStart = Date.UTC(2024, 0, 15) / 1000;
    const timeline = [commit(dayStart), commit(dayStart + 3600), commit(dayStart + 7200)];
    const buckets = bucketByDay(timeline);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].commits).toBe(3);
    expect(buckets[0].commitIndices).toEqual([0, 1, 2]);
  });

  it('sums lines added/removed per day and sorts chronologically', () => {
    const day1 = Date.UTC(2024, 0, 15) / 1000;
    const day2 = Date.UTC(2024, 0, 16) / 1000;
    const timeline = [commit(day2, 5, 1), commit(day1, 2, 0), commit(day1, 3, 4)];
    const buckets = bucketByDay(timeline);
    expect(buckets).toHaveLength(2);
    expect(buckets[0].date.getTime()).toBeLessThan(buckets[1].date.getTime());
    expect(buckets[0].linesAdded).toBe(5);
    expect(buckets[0].linesRemoved).toBe(4);
  });

  it('returns an empty array for an empty timeline', () => {
    expect(bucketByDay([])).toEqual([]);
  });
});

describe('calendarWeeks', () => {
  it('returns an empty array for no buckets', () => {
    expect(calendarWeeks([])).toEqual([]);
  });

  it('gap-fills so every week column has exactly 7 days', () => {
    const buckets = bucketByDay([commit(Date.UTC(2024, 0, 15) / 1000)]);
    const weeks = calendarWeeks(buckets);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
    }
  });

  it('preserves commit data on the matching day within the gap-filled grid', () => {
    const ts = Date.UTC(2024, 0, 15) / 1000;
    const buckets = bucketByDay([commit(ts)]);
    const weeks = calendarWeeks(buckets);
    const flat = weeks.flat();
    const match = flat.find((d) => d.dateKey === buckets[0].dateKey);
    expect(match?.commits).toBe(1);
  });

  it('gap days carry zeroed stats, not undefined', () => {
    const ts = Date.UTC(2024, 0, 15) / 1000;
    const buckets = bucketByDay([commit(ts)]);
    const weeks = calendarWeeks(buckets);
    const gapDay = weeks.flat().find((d) => d.dateKey !== buckets[0].dateKey);
    expect(gapDay?.commits).toBe(0);
    expect(gapDay?.commitIndices).toEqual([]);
  });
});

describe('intensityLevel', () => {
  it('returns 0 when value does not exceed any threshold', () => {
    expect(intensityLevel(0, [0, 5, 10])).toBe(0);
  });

  it('increments once per exceeded threshold', () => {
    expect(intensityLevel(7, [0, 5, 10])).toBe(2);
    expect(intensityLevel(20, [0, 5, 10])).toBe(3);
  });
});

describe('longestStreak', () => {
  const day = 86_400;

  it('is 0 for no commits', () => {
    expect(longestStreak([])).toBe(0);
  });

  it('is 1 for a single active day', () => {
    const buckets = bucketByDay([commit(Date.UTC(2024, 0, 15) / 1000)]);
    expect(longestStreak(buckets)).toBe(1);
  });

  it('counts a run of consecutive days', () => {
    const start = Date.UTC(2024, 0, 15) / 1000;
    const timeline = [commit(start), commit(start + day), commit(start + 2 * day)];
    expect(longestStreak(bucketByDay(timeline))).toBe(3);
  });

  it('resets across a gap and reports the longest of multiple runs', () => {
    const start = Date.UTC(2024, 0, 1) / 1000;
    const timeline = [
      commit(start), // day 0: run of 1
      commit(start + 5 * day), // days 5-8: run of 4, after a gap
      commit(start + 6 * day),
      commit(start + 7 * day),
      commit(start + 8 * day),
    ];
    expect(longestStreak(bucketByDay(timeline))).toBe(4);
  });

  it('treats a zero-commit bucket (from the gap-filled weeks grid) as breaking the streak', () => {
    const start = Date.UTC(2024, 0, 15) / 1000;
    const weeks = calendarWeeks(bucketByDay([commit(start), commit(start + day)]));
    // The gap-filled flat array includes zero-commit days interleaved —
    // longestStreak must still report 2, not count through the gaps.
    expect(longestStreak(weeks.flat())).toBe(2);
  });
});
