// Cross-language parity check: `contributorStatsAsOf`/`fileStatsAsOf` here
// and `contributor_stats`/`file_stats` in src/analyzer.rs are two
// independently maintained implementations of the same aggregation logic
// (including Co-authored-by crediting), previously kept in sync only by a
// comment claiming they mirror each other. This test and its Rust
// counterpart (analyzer::tests::contributor_and_file_stats_match_the_shared_
// cross_language_fixture) both read test-fixtures/contributor-parity.json
// and assert the *same* expected output baked into that file, so a future
// divergence between the two implementations fails whichever side actually
// drifted, not just "some test somewhere."
import { describe, expect, it } from 'vitest';
import { contributorStatsAsOf, fileStatsAsOf } from '../as-of';
import fixture from '../../../../test-fixtures/contributor-parity.json';
import type { CommitEvent } from '../../types';

const timeline = fixture.timeline as CommitEvent[];

describe('as-of parity with src/analyzer.rs', () => {
  it('contributorStatsAsOf matches the fixture expected_contributors', () => {
    const stats = contributorStatsAsOf(timeline);
    for (const [name, expected] of Object.entries(fixture.expected_contributors)) {
      const actual = stats[name];
      expect(actual, `fixture expected contributor ${name} to be credited`).toBeDefined();
      expect(actual.commits, `${name} commits`).toBe(expected.commits);
      expect(actual.linesAdded, `${name} lines_added`).toBe(expected.lines_added);
      expect(actual.linesRemoved, `${name} lines_removed`).toBe(expected.lines_removed);
      expect(actual.filesChanged, `${name} files_changed`).toBe(expected.files_changed);
    }
  });

  it('fileStatsAsOf matches the fixture expected_file_authors', () => {
    const files = fileStatsAsOf(timeline);
    for (const [path, expectedAuthors] of Object.entries(fixture.expected_file_authors)) {
      const actual = files[path];
      expect(actual, `fixture expected file ${path} to be tracked`).toBeDefined();
      expect([...actual.authors].sort()).toEqual([...expectedAuthors].sort());
    }
  });
});
