// Activity-heatmap data prep: bucket commits into UTC calendar days, then
// lay those out into GitHub-style week columns (gap-filled so every column
// is a full 7-day Sun-Sat strip, even where no commits happened).

import type { CommitEvent } from '../types';

export interface DayBucket {
  dateKey: string;
  date: Date;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  commitIndices: number[];
}

function dateKeyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyBucket(date: Date): DayBucket {
  return { dateKey: dateKeyOf(date), date, commits: 0, linesAdded: 0, linesRemoved: 0, commitIndices: [] };
}

export function bucketByDay(timeline: CommitEvent[]): DayBucket[] {
  const byKey = new Map<string, DayBucket>();

  timeline.forEach((commit, index) => {
    const ts = new Date(commit.timestamp * 1000);
    const dayStart = new Date(Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate()));
    const key = dateKeyOf(dayStart);

    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = emptyBucket(dayStart);
      byKey.set(key, bucket);
    }
    bucket.commits += 1;
    bucket.linesAdded += commit.lines_added;
    bucket.linesRemoved += commit.lines_removed;
    bucket.commitIndices.push(index);
  });

  return Array.from(byKey.values()).sort((a, b) => a.date.getTime() - b.date.getTime());
}

/** Gap-fills `buckets` into full Sun-Sat week columns spanning the first
 *  bucket's week through the last bucket's week. */
export function calendarWeeks(buckets: DayBucket[]): DayBucket[][] {
  if (buckets.length === 0) return [];

  const byKey = new Map(buckets.map((b) => [b.dateKey, b]));
  const start = new Date(buckets[0].date);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  const end = new Date(buckets[buckets.length - 1].date);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));

  const weeks: DayBucket[][] = [];
  let week: DayBucket[] = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = dateKeyOf(d);
    week.push(byKey.get(key) ?? emptyBucket(new Date(d)));
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}

/** Discrete 0..thresholds.length bucket for `value`, mirroring
 *  timeline-viz's REMOVAL_STAGES precedent of a few discrete visual steps
 *  rather than one continuous scale per cell (simpler to reason about and to
 *  keep visually distinct at small cell sizes). */
export function intensityLevel(value: number, thresholds: number[]): number {
  let level = 0;
  for (const t of thresholds) {
    if (value > t) level += 1;
  }
  return level;
}

/** Longest run of consecutive calendar days with at least one commit.
 *  `buckets` must already be sorted ascending by date (as `bucketByDay`
 *  returns them) — this walks day-to-day gaps, not indices. */
export function longestStreak(buckets: DayBucket[]): number {
  let longest = 0;
  let current = 0;
  let prevDate: Date | null = null;

  for (const bucket of buckets) {
    if (bucket.commits === 0) {
      current = 0;
      prevDate = null;
      continue;
    }
    const isConsecutiveDay = prevDate !== null && bucket.date.getTime() - prevDate.getTime() === 86_400_000;
    current = isConsecutiveDay ? current + 1 : 1;
    longest = Math.max(longest, current);
    prevDate = bucket.date;
  }

  return longest;
}
