import { describe, expect, it } from 'vitest';
import { filterCommits, sortCommits } from '../commit-table';
import { makeCommit, makeFileChange } from './commit-fixture';
import type { CommitEvent, FileChange } from '../../types';

function file(path: string): FileChange {
  return makeFileChange({ new_path: path, filename: path });
}

function commit(overrides: Partial<CommitEvent>): CommitEvent {
  return makeCommit({ author: 'Alice', message: 'fix bug', ...overrides });
}

describe('filterCommits', () => {
  const timeline = [
    commit({ author: 'Alice', message: 'fix login bug', timestamp: 100 }),
    commit({ author: 'Bob', message: 'add feature', timestamp: 200, files_changed: [file('src/widget.ts')] }),
    commit({ author: 'Alice', message: 'refactor', timestamp: 300 }),
  ];

  it('filters by exact author', () => {
    expect(filterCommits(timeline, { author: 'Bob' })).toHaveLength(1);
  });

  it('filters by a case-insensitive message substring', () => {
    expect(filterCommits(timeline, { query: 'LOGIN' })).toHaveLength(1);
  });

  it('filters by a filename substring', () => {
    expect(filterCommits(timeline, { query: 'widget' })).toHaveLength(1);
  });

  it('filters by a date range', () => {
    expect(filterCommits(timeline, { dateFrom: 150, dateTo: 250 })).toHaveLength(1);
  });

  it('returns everything for an empty filter', () => {
    expect(filterCommits(timeline, {})).toHaveLength(3);
  });
});

describe('sortCommits', () => {
  const timeline = [
    commit({ timestamp: 300, lines_added: 5, lines_removed: 0, files_changed: [file('a')] }),
    commit({ timestamp: 100, lines_added: 50, lines_removed: 10, files_changed: [file('a'), file('b')] }),
    commit({ timestamp: 200, lines_added: 1, lines_removed: 1 }),
  ];

  it('sorts by date descending by default', () => {
    expect(sortCommits(timeline, 'date').map((c) => c.timestamp)).toEqual([300, 200, 100]);
  });

  it('sorts by date ascending when asked', () => {
    expect(sortCommits(timeline, 'date', 'asc').map((c) => c.timestamp)).toEqual([100, 200, 300]);
  });

  it('sorts by total lines changed', () => {
    expect(sortCommits(timeline, 'linesChanged').map((c) => c.timestamp)).toEqual([100, 300, 200]);
  });

  it('sorts by files changed count', () => {
    expect(sortCommits(timeline, 'filesChanged').map((c) => c.timestamp)).toEqual([100, 300, 200]);
  });

  it('does not mutate the input array', () => {
    const copy = [...timeline];
    sortCommits(timeline, 'date');
    expect(timeline).toEqual(copy);
  });
});
