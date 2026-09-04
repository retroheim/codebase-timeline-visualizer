// Contributor/file aggregates computed from a (possibly time-sliced)
// timeline, rather than read from `TimelineData.contributors`/`.files` —
// those are always whole-history, precomputed once by the Rust exporter.
// Views that want to show "as of the scrubber's current position" instead
// of "across all of history" pass `timeline.slice(0, currentTime + 1)` in
// here rather than the full array. Mirrors `contributor_stats`/`file_stats`
// in src/analyzer.rs field-for-field so the numbers agree with the
// whole-history ones when the slice happens to be the full timeline.

import { resolveFilePath } from './file-tree';
import type { CommitEvent, FileStat } from '../types';

export interface ContributorCounts {
  commits: number;
  linesAdded: number;
  linesRemoved: number;
  filesChanged: number;
  firstCommit: number;
  lastCommit: number;
}

export function contributorStatsAsOf(timeline: CommitEvent[]): Record<string, ContributorCounts> {
  const result: Record<string, ContributorCounts> = {};

  for (const commit of timeline) {
    // A `Co-authored-by:` trailer credits a second name (often a bot) with
    // the same commit — mirrors `contributor_stats` in src/analyzer.rs.
    const names = [commit.author, ...(commit.co_authors ?? []).map((c) => c.name)];
    for (const name of names) {
      const entry =
        result[name] ??
        (result[name] = {
          commits: 0,
          linesAdded: 0,
          linesRemoved: 0,
          filesChanged: 0,
          firstCommit: commit.timestamp,
          lastCommit: commit.timestamp,
        });
      entry.commits += 1;
      entry.linesAdded += commit.lines_added;
      entry.linesRemoved += commit.lines_removed;
      entry.filesChanged += commit.files_changed?.length ?? 0;
      entry.firstCommit = Math.min(entry.firstCommit, commit.timestamp);
      entry.lastCommit = Math.max(entry.lastCommit, commit.timestamp);
    }
  }

  return result;
}

export function fileStatsAsOf(timeline: CommitEvent[]): Record<string, FileStat> {
  const files: Record<string, FileStat> = {};
  const authorsSeen: Record<string, Set<string>> = {};

  for (const commit of timeline) {
    for (const change of commit.files_changed || []) {
      const key = resolveFilePath(change);
      if (!key || key === '/dev/null') continue;

      const entry =
        files[key] ??
        (files[key] = {
          changes: 0,
          lines_added: 0,
          lines_removed: 0,
          authors: [],
          first_change: commit.timestamp,
          last_change: commit.timestamp,
        });
      entry.changes += 1;
      entry.lines_added += change.lines_added;
      entry.lines_removed += change.lines_removed;
      entry.first_change = Math.min(entry.first_change, commit.timestamp);
      entry.last_change = Math.max(entry.last_change, commit.timestamp);

      const seen = authorsSeen[key] ?? (authorsSeen[key] = new Set());
      seen.add(commit.author);
      for (const co of commit.co_authors ?? []) seen.add(co.name);
    }
  }

  for (const [path, authors] of Object.entries(authorsSeen)) {
    files[path].authors = Array.from(authors).sort();
  }

  return files;
}

/** Commits from index 0 through `currentTime` inclusive — the "as of now"
 *  slice every scoped view derives from. */
export function timelineUpTo(timeline: CommitEvent[], currentTime: number): CommitEvent[] {
  return timeline.slice(0, Math.max(0, currentTime + 1));
}
