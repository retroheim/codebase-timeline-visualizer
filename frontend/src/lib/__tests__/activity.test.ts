import { describe, expect, it } from 'vitest';
import { activityAsOf, fileFactsAsOf } from '../activity';
import type { CommitEvent, FileChange } from '../../types';

function file(path: string, linesAdded = 1, linesRemoved = 0, changeType = 'ADD'): FileChange {
  return {
    filename: path.split('/').pop() ?? path,
    old_path: changeType === 'DELETE' ? path : null,
    new_path: changeType === 'DELETE' ? null : path,
    change_type: changeType,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  };
}

function commit(author: string, files: FileChange[]): CommitEvent {
  return {
    timestamp: 0,
    datetime: '',
    commit_hash: 'abc',
    author,
    message: '',
    files_changed: files,
    lines_added: files.reduce((s, f) => s + f.lines_added, 0),
    lines_removed: files.reduce((s, f) => s + f.lines_removed, 0),
    cumulative_lines: 0,
    cumulative_files: 0,
  };
}

const exact = (path: string) => (p: string) => p === path;

describe('activityAsOf', () => {
  it('only counts commits at or before currentTime, not the whole history', () => {
    const timeline = [
      commit('a', [file('foo.ts', 10)]),
      commit('a', [file('foo.ts', 5)]),
      commit('a', [file('foo.ts', 100)]), // must not be counted at currentTime=1
    ];

    const activity = activityAsOf(timeline, exact('foo.ts'), 1);
    expect(activity.edits).toBe(2);
    expect(activity.linesAdded).toBe(15);
  });

  it('matches the whole-history total once currentTime reaches the end', () => {
    const timeline = [
      commit('a', [file('foo.ts', 10)]),
      commit('a', [file('foo.ts', 5)]),
      commit('a', [file('foo.ts', 100)]),
    ];

    const activity = activityAsOf(timeline, exact('foo.ts'), timeline.length - 1);
    expect(activity.edits).toBe(3);
    expect(activity.linesAdded).toBe(115);
  });

  it('is zero before the file has been touched at all', () => {
    const timeline = [commit('a', [file('other.ts')]), commit('a', [file('foo.ts')])];
    const activity = activityAsOf(timeline, exact('foo.ts'), 0);
    expect(activity.edits).toBe(0);
    expect(activity.authors.size).toBe(0);
  });

  it('ignores files that do not match the predicate', () => {
    const timeline = [commit('a', [file('foo.ts'), file('bar.ts')])];
    const activity = activityAsOf(timeline, exact('foo.ts'), 0);
    expect(activity.edits).toBe(1);
  });

  it('sums lines added and removed independently', () => {
    const timeline = [commit('a', [file('foo.ts', 10, 3)]), commit('a', [file('foo.ts', 0, 7)])];
    const activity = activityAsOf(timeline, exact('foo.ts'), 1);
    expect(activity.linesAdded).toBe(10);
    expect(activity.linesRemoved).toBe(10);
  });

  it('dedupes authors: repeated edits by the same person count once', () => {
    const timeline = [commit('alice', [file('foo.ts')]), commit('alice', [file('foo.ts')])];
    const activity = activityAsOf(timeline, exact('foo.ts'), 1);
    expect(activity.authors.size).toBe(1);
    expect([...activity.authors]).toEqual(['alice']);
  });

  it('counts distinct authors across multiple edits', () => {
    const timeline = [commit('alice', [file('foo.ts')]), commit('bob', [file('foo.ts')])];
    const activity = activityAsOf(timeline, exact('foo.ts'), 1);
    expect(activity.authors.size).toBe(2);
  });

  it('supports a prefix predicate, for directory-scoped activity', () => {
    const timeline = [
      commit('a', [file('src/foo.ts')]),
      commit('a', [file('src/nested/bar.ts')]),
      commit('a', [file('other/baz.ts')]),
    ];
    const activity = activityAsOf(timeline, (p) => p === 'src' || p.startsWith('src/'), 2);
    expect(activity.edits).toBe(2);
  });

  it('supports a set-membership predicate, for cluster-scoped activity', () => {
    const members = new Set(['a.ts', 'c.ts']);
    const timeline = [commit('x', [file('a.ts')]), commit('x', [file('b.ts')]), commit('x', [file('c.ts')])];
    const activity = activityAsOf(timeline, (p) => members.has(p), 2);
    expect(activity.edits).toBe(2);
  });

  it('clamps currentTime past the end of the timeline instead of throwing', () => {
    const timeline = [commit('a', [file('foo.ts')])];
    expect(() => activityAsOf(timeline, exact('foo.ts'), 999)).not.toThrow();
    expect(activityAsOf(timeline, exact('foo.ts'), 999).edits).toBe(1);
  });

  it('handles a negative currentTime (before the timeline starts) as zero activity', () => {
    const timeline = [commit('a', [file('foo.ts')])];
    const activity = activityAsOf(timeline, exact('foo.ts'), -1);
    expect(activity.edits).toBe(0);
  });

  it('handles an empty timeline', () => {
    expect(activityAsOf([], exact('foo.ts'), 5)).toEqual({
      edits: 0,
      linesAdded: 0,
      linesRemoved: 0,
      authors: new Set(),
    });
  });
});

describe('fileFactsAsOf', () => {
  it('returns null for a path never touched as of currentTime', () => {
    const timeline = [commit('a', [file('other.ts')])];
    expect(fileFactsAsOf(timeline, 'foo.ts', 0)).toBeNull();
  });

  it('reports introducedAt as the first commit that touched the path', () => {
    const timeline = [commit('a', [file('other.ts')]), commit('a', [file('foo.ts')])];
    expect(fileFactsAsOf(timeline, 'foo.ts', 1)?.introducedAt).toBe(1);
  });

  it('is alive with no removedAt when never deleted', () => {
    const timeline = [commit('a', [file('foo.ts')])];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 0)!;
    expect(facts.alive).toBe(true);
    expect(facts.removedAt).toBeUndefined();
  });

  it('stays alive exactly on the commit that deletes it', () => {
    const timeline = [commit('a', [file('foo.ts')]), commit('a', [file('foo.ts', 0, 0, 'DELETE')])];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 1)!;
    expect(facts.alive).toBe(true);
    expect(facts.removedAt).toBe(1);
  });

  it('is not alive strictly after the delete commit', () => {
    const timeline = [
      commit('a', [file('foo.ts')]),
      commit('a', [file('foo.ts', 0, 0, 'DELETE')]),
      commit('a', [file('other.ts')]),
    ];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 2)!;
    expect(facts.alive).toBe(false);
    expect(facts.removedAt).toBe(1);
  });

  it('clears removal when re-added, matching only the final state through currentTime', () => {
    const timeline = [
      commit('a', [file('foo.ts')]),
      commit('a', [file('foo.ts', 0, 0, 'DELETE')]),
      commit('a', [file('foo.ts')]),
    ];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 2)!;
    expect(facts.alive).toBe(true);
    expect(facts.removedAt).toBeUndefined();
  });

  it('embeds activity scoped the same way as activityAsOf', () => {
    const timeline = [commit('alice', [file('foo.ts', 10, 2)]), commit('bob', [file('foo.ts', 5, 1)])];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 1)!;
    expect(facts.activity.edits).toBe(2);
    expect(facts.activity.linesAdded).toBe(15);
    expect(facts.activity.authors.size).toBe(2);
  });

  it('does not see activity past currentTime, same cutoff as introducedAt/removedAt', () => {
    const timeline = [commit('a', [file('foo.ts')]), commit('a', [file('foo.ts', 0, 0, 'DELETE')])];
    const facts = fileFactsAsOf(timeline, 'foo.ts', 0)!;
    expect(facts.removedAt).toBeUndefined();
    expect(facts.alive).toBe(true);
    expect(facts.activity.edits).toBe(1);
  });
});
