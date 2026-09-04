import { describe, expect, it } from 'vitest';
import { contributorStatsAsOf, fileStatsAsOf, timelineUpTo } from '../as-of';
import { makeCommit, makeFileChange } from './commit-fixture';
import type { CommitAuthor, CommitEvent, FileChange } from '../../types';

function file(path: string, linesAdded = 1, linesRemoved = 0): FileChange {
  return makeFileChange({ new_path: path, lines_added: linesAdded, lines_removed: linesRemoved });
}

function commit(author: string, timestamp: number, files: FileChange[], coAuthors: CommitAuthor[] = []): CommitEvent {
  return makeCommit({ author, timestamp, files, coAuthors });
}

describe('contributorStatsAsOf', () => {
  it('aggregates commits/lines/files per author', () => {
    const timeline = [
      commit('Alice', 100, [file('a.ts', 10)]),
      commit('Alice', 200, [file('a.ts', 5, 2), file('b.ts', 3)]),
      commit('Bob', 150, [file('c.ts', 1)]),
    ];
    const stats = contributorStatsAsOf(timeline);

    expect(stats.Alice).toEqual({
      commits: 2,
      linesAdded: 18,
      linesRemoved: 2,
      filesChanged: 3,
      firstCommit: 100,
      lastCommit: 200,
    });
    expect(stats.Bob.commits).toBe(1);
  });

  it('returns an empty object for an empty timeline', () => {
    expect(contributorStatsAsOf([])).toEqual({});
  });

  it('credits a Co-authored-by trailer alongside the primary author', () => {
    const timeline = [
      commit('Alice', 100, [file('a.ts', 10)], [{ name: 'Codesmith', email: 'bot@example.com' }]),
    ];
    const stats = contributorStatsAsOf(timeline);
    expect(stats.Alice.commits).toBe(1);
    expect(stats.Codesmith).toEqual({
      commits: 1,
      linesAdded: 10,
      linesRemoved: 0,
      filesChanged: 1,
      firstCommit: 100,
      lastCommit: 100,
    });
  });

  it('excludes contributors whose commits fall outside the given slice', () => {
    const timeline = [commit('Alice', 100, [file('a.ts')]), commit('Bob', 200, [file('b.ts')])];
    const stats = contributorStatsAsOf(timelineUpTo(timeline, 0));
    expect(stats.Alice).toBeDefined();
    expect(stats.Bob).toBeUndefined();
  });
});

describe('fileStatsAsOf', () => {
  it('aggregates changes/lines per file and collects unique sorted authors', () => {
    const timeline = [
      commit('Bob', 100, [file('a.ts', 10)]),
      commit('Alice', 200, [file('a.ts', 5, 1)]),
    ];
    const stats = fileStatsAsOf(timeline);

    expect(stats['a.ts']).toEqual({
      changes: 2,
      lines_added: 15,
      lines_removed: 1,
      authors: ['Alice', 'Bob'],
      first_change: 100,
      last_change: 200,
    });
  });

  it('skips a /dev/null path', () => {
    const devNull = file('/dev/null');
    const timeline = [commit('a', 0, [devNull, file('real.ts')])];
    const stats = fileStatsAsOf(timeline);
    expect(stats['/dev/null']).toBeUndefined();
    expect(stats['real.ts']).toBeDefined();
  });

  it('returns an empty object for an empty timeline', () => {
    expect(fileStatsAsOf([])).toEqual({});
  });

  it('includes a Co-authored-by trailer name in the file\'s author list', () => {
    const timeline = [
      commit('Alice', 100, [file('a.ts')], [{ name: 'Codesmith', email: 'bot@example.com' }]),
    ];
    const stats = fileStatsAsOf(timeline);
    expect(stats['a.ts'].authors).toEqual(['Alice', 'Codesmith']);
  });
});

describe('timelineUpTo', () => {
  const timeline = [commit('a', 0, []), commit('b', 1, []), commit('c', 2, [])];

  it('includes commits from 0 through currentTime inclusive', () => {
    expect(timelineUpTo(timeline, 1)).toHaveLength(2);
    expect(timelineUpTo(timeline, 1).map((c) => c.author)).toEqual(['a', 'b']);
  });

  it('includes the whole timeline when currentTime is the last index', () => {
    expect(timelineUpTo(timeline, 2)).toHaveLength(3);
  });

  it('clamps a negative currentTime to an empty slice', () => {
    expect(timelineUpTo(timeline, -1)).toEqual([]);
  });
});
