import { describe, expect, it } from 'vitest';
import { commonExtension, groupBySimilarity } from '../file-similarity';
import type { TreeNode } from '../file-tree';

function node(path: string, introducedAt = 0): TreeNode {
  const name = path.split('/').pop()!;
  return { name, path, isFile: true, introducedAt, touches: 1, children: [] };
}

describe('groupBySimilarity', () => {
  it('groups files that are always touched in the same commits', () => {
    const a = node('src/foo.ts');
    const b = node('src/foo.test.ts');
    const commitSetByPath = new Map([
      ['src/foo.ts', new Set([0, 1, 2])],
      ['src/foo.test.ts', new Set([0, 1, 2])],
    ]);

    const groups = groupBySimilarity([a, b], commitSetByPath);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('leaves unrelated files ungrouped: different extension, stem, and commits', () => {
    const a = node('src/foo.ts');
    const b = node('src/readme.md');
    const commitSetByPath = new Map([
      ['src/foo.ts', new Set([0])],
      ['src/readme.md', new Set([5])],
    ]);

    const groups = groupBySimilarity([a, b], commitSetByPath);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.length === 1)).toBe(true);
  });

  it('does not group on shared extension alone: too weak a signal to stand by itself', () => {
    // Sharing just an extension is common and, being transitive through
    // union-find, dangerous to trust alone — it would fuse any two
    // unrelated same-extension pairs elsewhere in the same directory into
    // one group through a third file. Real per-directory "many files of one
    // type" clustering comes from the caller's catch-all fallback, not from
    // grouping here.
    const files = [node('src/one.rs'), node('src/two.rs'), node('src/three.rs')];
    const commitSetByPath = new Map([
      ['src/one.rs', new Set([0])],
      ['src/two.rs', new Set([1])],
      ['src/three.rs', new Set([2])],
    ]);

    const groups = groupBySimilarity(files, commitSetByPath);
    expect(groups).toHaveLength(3);
    expect(groups.every((g) => g.length === 1)).toBe(true);
  });

  it('does not let a shared extension transitively fuse two unrelated coupled pairs', () => {
    const auth = node('src/auth.rs');
    const authTest = node('src/auth_test.rs');
    const db = node('src/db.rs');
    const dbTest = node('src/db_test.rs');
    const commitSetByPath = new Map([
      ['src/auth.rs', new Set([0])],
      ['src/auth_test.rs', new Set([0])],
      ['src/db.rs', new Set([1])],
      ['src/db_test.rs', new Set([1])],
    ]);

    const groups = groupBySimilarity([auth, authTest, db, dbTest], commitSetByPath);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.length).sort()).toEqual([2, 2]);
  });

  it('does not group files that only share a directory with nothing else in common', () => {
    const files = [node('src/one.rs'), node('src/two.md'), node('src/three.py')];
    const commitSetByPath = new Map([
      ['src/one.rs', new Set([0])],
      ['src/two.md', new Set([1])],
      ['src/three.py', new Set([2])],
    ]);

    const groups = groupBySimilarity(files, commitSetByPath);
    expect(groups).toHaveLength(3);
  });

  it('forms multiple distinct groups within one directory', () => {
    // Two co-changed pairs, unrelated to each other in every signal.
    const a1 = node('src/auth.ts');
    const a2 = node('src/auth.test.ts');
    const b1 = node('src/db.py');
    const b2 = node('src/db.test.py');
    const commitSetByPath = new Map([
      ['src/auth.ts', new Set([0, 1])],
      ['src/auth.test.ts', new Set([0, 1])],
      ['src/db.py', new Set([9])],
      ['src/db.test.py', new Set([9])],
    ]);

    const groups = groupBySimilarity([a1, a2, b1, b2], commitSetByPath);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.length).sort()).toEqual([2, 2]);
  });

  it('handles a file with no commit history in commitSetByPath without throwing', () => {
    const files = [node('src/a.ts'), node('src/b.ts')];
    const groups = groupBySimilarity(files, new Map());
    expect(groups).toHaveLength(2); // shared extension alone isn't enough to group
  });
});

describe('commonExtension', () => {
  it('returns the shared extension when every member has it', () => {
    expect(commonExtension([node('a.rs'), node('b.rs')])).toBe('.rs');
  });

  it('returns null when extensions differ', () => {
    expect(commonExtension([node('a.rs'), node('b.md')])).toBeNull();
  });

  it('returns null for extensionless files', () => {
    expect(commonExtension([node('Makefile'), node('LICENSE')])).toBeNull();
  });
});
