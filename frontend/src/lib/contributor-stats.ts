// Leaderboard rows, straight off the Rust-precomputed whole-history
// `contributors` map — no timeline scan needed. Note `data.contributors` is
// keyed by author *display name* (matches `CommitEvent.author`), not email;
// `Contributor.email` is a field inside the record, not the key.

import { contributorStatsAsOf, timelineUpTo } from './as-of';
import { isBotAuthor } from './bot-authors';
import type { TimelineData } from '../types';

export type SortKey = 'commits' | 'linesAdded' | 'linesRemoved' | 'netLines' | 'filesChanged';

export interface LeaderboardRow {
  author: string;
  email: string;
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
  filesChanged: number;
  firstCommit: number;
  lastCommit: number;
  /** Present only on the synthetic "Automated" row `groupBotRows` produces —
   *  the real bot/model names actually found in *this* repo's data, sorted,
   *  so the grouped row can still say exactly who it's standing in for. */
  mergedAuthors?: string[];
}

/** Folds every bot-authored row (see `isBotAuthor`) into one synthetic
 *  "Automated" row, so a repo with a dozen AI-model contributors doesn't
 *  drown out its human ones. Returns `rows` unchanged when no row is a bot.
 *  The merged row's `mergedAuthors` lists exactly which real names got
 *  folded in, so "Automated" never hides *which* bots were actually
 *  involved in this specific repo. */
export function groupBotRows(rows: LeaderboardRow[]): LeaderboardRow[] {
  const bots = rows.filter((r) => isBotAuthor(r.author));
  if (bots.length === 0) return rows;

  const humans = rows.filter((r) => !isBotAuthor(r.author));
  const merged: LeaderboardRow = {
    author: 'Automated',
    email: '',
    commits: bots.reduce((sum, r) => sum + r.commits, 0),
    linesAdded: bots.reduce((sum, r) => sum + r.linesAdded, 0),
    linesRemoved: bots.reduce((sum, r) => sum + r.linesRemoved, 0),
    netLines: bots.reduce((sum, r) => sum + r.netLines, 0),
    filesChanged: bots.reduce((sum, r) => sum + r.filesChanged, 0),
    firstCommit: Math.min(...bots.map((r) => r.firstCommit)),
    lastCommit: Math.max(...bots.map((r) => r.lastCommit)),
    mergedAuthors: bots.map((r) => r.author).sort(),
  };
  return [...humans, merged];
}

export function buildLeaderboard(data: TimelineData): LeaderboardRow[] {
  return Object.entries(data.contributors).map(([author, c]) => ({
    author,
    email: c.email,
    commits: c.commits,
    linesAdded: c.lines_added,
    linesRemoved: c.lines_removed,
    netLines: c.lines_added - c.lines_removed,
    filesChanged: c.files_changed,
    firstCommit: c.first_commit,
    lastCommit: c.last_commit,
  }));
}

/** Leaderboard rows as of `currentTime` — recomputed from a sliced timeline
 *  rather than the whole-history `contributors` map. Email isn't carried on
 *  `CommitEvent`, so it's still looked up from `data.contributors` (a fixed
 *  identity fact, not something that needs to be time-scoped). */
export function buildLeaderboardAsOf(data: TimelineData, currentTime: number): LeaderboardRow[] {
  const scoped = contributorStatsAsOf(timelineUpTo(data.timeline, currentTime));
  return Object.entries(scoped).map(([author, c]) => ({
    author,
    email: data.contributors[author]?.email ?? '',
    commits: c.commits,
    linesAdded: c.linesAdded,
    linesRemoved: c.linesRemoved,
    netLines: c.linesAdded - c.linesRemoved,
    filesChanged: c.filesChanged,
    firstCommit: c.firstCommit,
    lastCommit: c.lastCommit,
  }));
}

export function sortLeaderboard(rows: LeaderboardRow[], sortBy: SortKey): LeaderboardRow[] {
  return [...rows].sort((a, b) => b[sortBy] - a[sortBy]);
}
