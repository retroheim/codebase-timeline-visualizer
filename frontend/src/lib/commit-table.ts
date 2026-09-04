// Filtering/sorting for the raw commit-log view. Pure so it's testable
// without mounting the table component.

import { resolveFilePath } from './file-tree';
import type { CommitEvent } from '../types';

export interface CommitFilter {
  author?: string;
  query?: string;
  dateFrom?: number;
  dateTo?: number;
}

export type CommitSortKey = 'date' | 'linesChanged' | 'filesChanged';
export type SortDirection = 'asc' | 'desc';

export function filterCommits(timeline: CommitEvent[], filter: CommitFilter): CommitEvent[] {
  const query = filter.query?.trim().toLowerCase();
  return timeline.filter((commit) => {
    if (filter.author && commit.author !== filter.author) return false;
    if (filter.dateFrom !== undefined && commit.timestamp < filter.dateFrom) return false;
    if (filter.dateTo !== undefined && commit.timestamp > filter.dateTo) return false;
    if (query) {
      const inMessage = commit.message.toLowerCase().includes(query);
      const inFiles = (commit.files_changed || []).some((f) => resolveFilePath(f).toLowerCase().includes(query));
      if (!inMessage && !inFiles) return false;
    }
    return true;
  });
}

function linesChanged(commit: CommitEvent): number {
  return commit.lines_added + commit.lines_removed;
}

export function sortCommits(commits: CommitEvent[], sortBy: CommitSortKey, dir: SortDirection = 'desc'): CommitEvent[] {
  const factor = dir === 'asc' ? 1 : -1;
  return [...commits].sort((a, b) => {
    switch (sortBy) {
      case 'linesChanged':
        return factor * (linesChanged(a) - linesChanged(b));
      case 'filesChanged':
        return factor * ((a.files_changed?.length ?? 0) - (b.files_changed?.length ?? 0));
      case 'date':
      default:
        return factor * (a.timestamp - b.timestamp);
    }
  });
}
