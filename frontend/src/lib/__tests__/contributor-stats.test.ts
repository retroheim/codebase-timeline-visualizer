import { describe, expect, it } from 'vitest';
import { buildLeaderboard, buildLeaderboardAsOf, groupBotRows, sortLeaderboard, type LeaderboardRow } from '../contributor-stats';
import { makeCommit } from './commit-fixture';
import type { CommitEvent, TimelineData } from '../../types';

function data(): TimelineData {
  return {
    metadata: {
      repo_name: 'x',
      github_repo: null,
      total_commits: 2,
      total_contributors: 2,
      total_files: 1,
      date_range: { start: null, end: null },
    },
    timeline: [],
    contributors: {
      Alice: {
        email: 'alice@example.com',
        commits: 5,
        lines_added: 100,
        lines_removed: 10,
        files_changed: 3,
        first_commit: 1,
        last_commit: 5,
      },
      Bob: {
        email: 'bob@example.com',
        commits: 12,
        lines_added: 20,
        lines_removed: 5,
        files_changed: 8,
        first_commit: 0,
        last_commit: 6,
      },
    },
    files: {},
  };
}

describe('buildLeaderboard', () => {
  it('maps each contributor entry keyed by author name into a row', () => {
    const rows = buildLeaderboard(data());
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.author === 'Alice');
    expect(alice).toMatchObject({ email: 'alice@example.com', commits: 5, netLines: 90 });
  });
});

describe('sortLeaderboard', () => {
  it('sorts descending by the given key without mutating the input', () => {
    const rows = buildLeaderboard(data());
    const sorted = sortLeaderboard(rows, 'commits');
    expect(sorted.map((r) => r.author)).toEqual(['Bob', 'Alice']);
    expect(rows).not.toBe(sorted);
  });

  it('sorts by netLines', () => {
    const rows = buildLeaderboard(data());
    const sorted = sortLeaderboard(rows, 'netLines');
    expect(sorted[0].author).toBe('Alice');
  });
});

describe('buildLeaderboardAsOf', () => {
  function commit(author: string, timestamp: number): CommitEvent {
    return makeCommit({ author, timestamp, lines_added: 1 });
  }

  it('only counts commits up to currentTime, unlike the whole-history buildLeaderboard', () => {
    const d = data();
    d.timeline = [commit('Alice', 0), commit('Bob', 1), commit('Alice', 2)];

    const asOfFirst = buildLeaderboardAsOf(d, 0);
    expect(asOfFirst).toHaveLength(1);
    expect(asOfFirst[0]).toMatchObject({ author: 'Alice', commits: 1, email: 'alice@example.com' });

    const asOfAll = buildLeaderboardAsOf(d, 2);
    expect(asOfAll.find((r) => r.author === 'Alice')?.commits).toBe(2);
    expect(asOfAll.find((r) => r.author === 'Bob')?.commits).toBe(1);
  });

  it('falls back to an empty email when the author has no contributors entry', () => {
    const d = data();
    d.timeline = [commit('Ghost', 0)];
    const rows = buildLeaderboardAsOf(d, 0);
    expect(rows[0]).toMatchObject({ author: 'Ghost', email: '' });
  });
});

describe('groupBotRows', () => {
  function row(author: string, overrides: Partial<LeaderboardRow> = {}): LeaderboardRow {
    return {
      author,
      email: '',
      commits: 1,
      linesAdded: 10,
      linesRemoved: 2,
      netLines: 8,
      filesChanged: 3,
      firstCommit: 100,
      lastCommit: 200,
      ...overrides,
    };
  }

  it('returns the rows unchanged when none are bots', () => {
    const rows = [row('Alice'), row('Bob')];
    expect(groupBotRows(rows)).toEqual(rows);
  });

  it('folds every bot row into one Automated row, summing totals and merging the time range', () => {
    const rows = [
      row('Alice', { commits: 5, linesAdded: 100, linesRemoved: 10, netLines: 90, filesChanged: 3, firstCommit: 1, lastCommit: 5 }),
      row('Claude Opus 5', { commits: 2, linesAdded: 20, linesRemoved: 1, netLines: 19, filesChanged: 4, firstCommit: 3, lastCommit: 8 }),
      row('blacksmith-sh[bot]', { commits: 1, linesAdded: 5, linesRemoved: 0, netLines: 5, filesChanged: 1, firstCommit: 6, lastCommit: 6 }),
    ];

    const grouped = groupBotRows(rows);
    expect(grouped).toHaveLength(2);
    expect(grouped.find((r) => r.author === 'Alice')).toBeDefined();

    const automated = grouped.find((r) => r.author === 'Automated');
    expect(automated).toMatchObject({
      commits: 3,
      linesAdded: 25,
      linesRemoved: 1,
      netLines: 24,
      filesChanged: 5,
      firstCommit: 3,
      lastCommit: 8,
    });
    // Lists exactly the bot names actually present in this data, not a
    // hardcoded/static list — the whole point of the field.
    expect(automated!.mergedAuthors).toEqual(['Claude Opus 5', 'blacksmith-sh[bot]'].sort());
  });

  it('does not merge when there is only one contributor and it is a bot', () => {
    const rows = [row('Codesmith', { commits: 4 })];
    const grouped = groupBotRows(rows);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].author).toBe('Automated');
    expect(grouped[0].mergedAuthors).toEqual(['Codesmith']);
  });
});
