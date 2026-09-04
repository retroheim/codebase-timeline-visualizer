// Time-scoped edit activity for the inspector panel. Pure and separate from
// the component so it's testable without a browser: given the timeline and a
// path predicate, sum up what happened on or before `currentTime` only —
// not the eternal whole-history totals Rust precomputes into `files`, which
// don't know or care where playback is currently scrubbed to.

import { resolveFilePath } from './file-tree';
import type { CommitEvent } from '../types';

export interface Activity {
  edits: number;
  linesAdded: number;
  linesRemoved: number;
  authors: Set<string>;
}

export function activityAsOf(
  timeline: CommitEvent[],
  matchesPath: (path: string) => boolean,
  currentTime: number
): Activity {
  let edits = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  const authors = new Set<string>();
  const end = Math.min(currentTime, timeline.length - 1);

  for (let i = 0; i <= end; i += 1) {
    const commit = timeline[i];
    for (const f of commit.files_changed || []) {
      if (!matchesPath(resolveFilePath(f))) continue;
      edits += 1;
      linesAdded += f.lines_added;
      linesRemoved += f.lines_removed;
      authors.add(commit.author);
    }
  }

  return { edits, linesAdded, linesRemoved, authors };
}

export interface FileFacts {
  introducedAt: number;
  removedAt?: number;
  /**
   * True through the commit that removes the file, matching the app-wide
   * convention (`isRemoved` in timeline-viz.ts: `currentTime > removedAt`,
   * not `>=`) — a file's "last stand" commit still counts as alive.
   */
  alive: boolean;
  activity: Activity;
}

/**
 * Per-file facts computed straight from the raw timeline, bounded to
 * `currentTime` — the introducedAt/removedAt/alive equivalent of
 * `TreeNode`'s own fields, but for an arbitrary path that may not exist as a
 * node in the (possibly cluster-collapsed) layout at all. Cluster member
 * files are exactly this case: `collapseClusters()` drops their individual
 * TreeNode once folded into an aggregate, so `layout.nodeByPath` has no
 * entry for them — this is how the inspector still describes one without
 * needing it to be a real laid-out node.
 */
export function fileFactsAsOf(timeline: CommitEvent[], path: string, currentTime: number): FileFacts | null {
  let introducedAt: number | undefined;
  let removedAt: number | undefined;
  const end = Math.min(currentTime, timeline.length - 1);

  for (let i = 0; i <= end; i += 1) {
    const commit = timeline[i];
    for (const f of commit.files_changed || []) {
      if (resolveFilePath(f) !== path) continue;
      if (introducedAt === undefined) introducedAt = i;
      removedAt = f.change_type === 'DELETE' ? i : undefined;
    }
  }

  if (introducedAt === undefined) return null;

  return {
    introducedAt,
    removedAt,
    alive: removedAt === undefined || removedAt === currentTime,
    activity: activityAsOf(timeline, (p) => p === path, currentTime),
  };
}
