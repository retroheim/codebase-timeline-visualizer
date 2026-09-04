// Cumulative growth series for the growth chart. `cumulative_lines` and
// `cumulative_files` are already precomputed by the Rust exporter per
// commit, so this is a thin map rather than a re-derivation.

import * as d3 from 'd3';
import type { CommitEvent } from '../types';

export interface GrowthPoint {
  index: number;
  timestamp: number;
  cumulativeLines: number;
  cumulativeFiles: number;
}

export function growthSeries(timeline: CommitEvent[]): GrowthPoint[] {
  return timeline.map((commit, index) => ({
    index,
    timestamp: commit.timestamp,
    cumulativeLines: commit.cumulative_lines,
    cumulativeFiles: commit.cumulative_files,
  }));
}

const bisectTimestamp = d3.bisector((p: GrowthPoint) => p.timestamp).left;

/** Index of the series point closest to `timestamp`, for click/drag-to-seek
 *  on the chart. Series is assumed sorted ascending by timestamp, same order
 *  as the timeline it was built from. */
export function nearestIndexForTimestamp(series: GrowthPoint[], timestamp: number): number {
  if (series.length === 0) return 0;
  const i = bisectTimestamp(series, timestamp);
  if (i <= 0) return series[0].index;
  if (i >= series.length) return series[series.length - 1].index;
  const before = series[i - 1];
  const after = series[i];
  return timestamp - before.timestamp <= after.timestamp - timestamp ? before.index : after.index;
}
