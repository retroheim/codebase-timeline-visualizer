// One color per contributor, shared across every view that shows a
// contributor (the radial tree's avatars, the leaderboard's bars, the
// commit table's author badges) so the same person reads as the same color
// everywhere. Domain is the sorted author list rather than insertion or
// display order, so the mapping doesn't shift depending on which view
// happened to build the scale first.

import * as d3 from 'd3';
import type { TimelineData } from '../types';

export function contributorColorScale(data: TimelineData): (author: string) => string {
  const authors = Object.keys(data.contributors).sort();
  const scale = d3.scaleOrdinal<string, string>(d3.schemeTableau10).domain(authors);
  return (author: string) => scale(author);
}
