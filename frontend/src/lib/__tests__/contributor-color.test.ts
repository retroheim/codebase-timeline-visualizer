import { describe, expect, it } from 'vitest';
import { contributorColorScale } from '../contributor-color';
import type { Contributor, TimelineData } from '../../types';

function contributor(): Contributor {
  return { email: 'a@example.com', commits: 1, lines_added: 1, lines_removed: 0, files_changed: 1, first_commit: 0, last_commit: 0 };
}

function dataWith(contributors: Record<string, Contributor>): TimelineData {
  return { metadata: {} as TimelineData['metadata'], timeline: [], contributors, files: {} };
}

describe('contributorColorScale', () => {
  it('is deterministic for the same author across separate calls', () => {
    const data = dataWith({ Alice: contributor(), Bob: contributor() });
    const colorFor = contributorColorScale(data);
    expect(colorFor('Alice')).toBe(colorFor('Alice'));
  });

  it('returns a non-empty color string', () => {
    const data = dataWith({ Alice: contributor() });
    const colorFor = contributorColorScale(data);
    expect(colorFor('Alice')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('assigns distinct colors to distinct contributors', () => {
    const data = dataWith({ Alice: contributor(), Bob: contributor(), Carol: contributor() });
    const colorFor = contributorColorScale(data);
    const colors = new Set(['Alice', 'Bob', 'Carol'].map(colorFor));
    expect(colors.size).toBe(3);
  });

  it('assigns each contributor the same color regardless of insertion order in the source data', () => {
    // The domain is built from the *sorted* author list, not object
    // insertion order — this is the invariant that keeps a person's color
    // stable across views/reloads where the contributors map might have
    // been built in a different order (e.g. as-of vs whole-history stats).
    const inOneOrder = contributorColorScale(dataWith({ Zack: contributor(), Amy: contributor(), Mia: contributor() }));
    const inAnotherOrder = contributorColorScale(dataWith({ Mia: contributor(), Zack: contributor(), Amy: contributor() }));

    expect(inOneOrder('Zack')).toBe(inAnotherOrder('Zack'));
    expect(inOneOrder('Amy')).toBe(inAnotherOrder('Amy'));
    expect(inOneOrder('Mia')).toBe(inAnotherOrder('Mia'));
  });
});
