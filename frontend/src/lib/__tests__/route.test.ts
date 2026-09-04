import { describe, expect, it } from 'vitest';
import { formatHash, parseHash } from '../route';

describe('parseHash', () => {
  it('parses a project id and view', () => {
    expect(parseHash('#/my-repo/growth')).toEqual({ projectId: 'my-repo', view: 'growth' });
  });

  it('defaults to the tree view when no view segment is present', () => {
    expect(parseHash('#/my-repo')).toEqual({ projectId: 'my-repo', view: 'tree' });
  });

  it('falls back to the tree view for an unknown view name', () => {
    expect(parseHash('#/my-repo/nonsense')).toEqual({ projectId: 'my-repo', view: 'tree' });
  });

  it('returns no project for an empty hash', () => {
    expect(parseHash('')).toEqual({ projectId: null, view: 'tree' });
    expect(parseHash('#/')).toEqual({ projectId: null, view: 'tree' });
    expect(parseHash('#')).toEqual({ projectId: null, view: 'tree' });
  });
});

describe('formatHash', () => {
  it('round-trips through parseHash', () => {
    const state = { projectId: 'my-repo', view: 'leaderboard' as const };
    expect(parseHash(formatHash(state))).toEqual(state);
  });

  it('formats no project as the bare root hash', () => {
    expect(formatHash({ projectId: null, view: 'tree' })).toBe('#/');
  });
});
