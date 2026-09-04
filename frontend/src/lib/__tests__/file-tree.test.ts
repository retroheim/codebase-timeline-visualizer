import { describe, expect, it } from 'vitest';
import { buildFileTree, resolveFilePath, TreeNode } from '../file-tree';
import type { CommitEvent, FileChange } from '../../types';

function file(path: string, changeType = 'ADD'): FileChange {
  return {
    filename: path.split('/').pop() ?? path,
    old_path: changeType === 'DELETE' ? path : null,
    new_path: changeType === 'DELETE' ? null : path,
    change_type: changeType,
    lines_added: 1,
    lines_removed: 0,
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
    lines_added: files.length,
    lines_removed: 0,
    cumulative_lines: 0,
    cumulative_files: 0,
  };
}

function findByPath(node: TreeNode, path: string): TreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children) {
    const found = findByPath(child, path);
    if (found) return found;
  }
  return undefined;
}

describe('buildFileTree', () => {
  it('nests files under their directories', () => {
    const timeline = [commit('a', [file('src/lib/foo.ts'), file('README.md')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'README.md')?.isFile).toBe(true);
    expect(findByPath(root, 'src')?.isFile).toBe(false);
    expect(findByPath(root, 'src/lib/foo.ts')?.isFile).toBe(true);
  });

  it('skips a /dev/null path entirely rather than adding a bogus node', () => {
    const devNull: FileChange = {
      filename: 'null',
      old_path: null,
      new_path: '/dev/null',
      change_type: 'ADD',
      lines_added: 0,
      lines_removed: 0,
    };
    const timeline = [commit('a', [devNull, file('real.ts')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, '/dev/null')).toBeUndefined();
    expect(root.children).toHaveLength(1);
    expect(root.children[0].path).toBe('real.ts');
  });

  it('falls back to old_path for deleted files instead of a bare filename', () => {
    const timeline = [commit('a', [file('src/lib/foo.ts')]), commit('a', [file('src/lib/foo.ts', 'DELETE')])];
    const { root } = buildFileTree(timeline);

    // The deleted file should still live under src/lib, not a root-level
    // "foo.ts" — new_path is null for deletions, so this only works if the
    // fallback to old_path is in place.
    expect(findByPath(root, 'foo.ts')).toBeUndefined();
    expect(findByPath(root, 'src/lib/foo.ts')?.isFile).toBe(true);
  });

  it('counts touches: once per file per commit, aggregated up through ancestors', () => {
    const timeline = [commit('a', [file('src/foo.ts')]), commit('a', [file('src/foo.ts')]), commit('a', [file('src/bar.ts')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.touches).toBe(2);
    expect(findByPath(root, 'src/bar.ts')?.touches).toBe(1);
    expect(findByPath(root, 'src')?.touches).toBe(3);
    expect(root.touches).toBe(3);
  });

  it('introducedAt is the earliest commit index that touched a node', () => {
    const timeline = [commit('a', [file('src/foo.ts')]), commit('a', [file('src/bar.ts')]), commit('a', [file('src/foo.ts')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.introducedAt).toBe(0);
    expect(findByPath(root, 'src/bar.ts')?.introducedAt).toBe(1);
    expect(findByPath(root, 'src')?.introducedAt).toBe(0);
  });

  it('leaves small directories alone (at or under the cluster threshold)', () => {
    const files = Array.from({ length: 8 }, (_, i) => file(`src/file${i}.ts`));
    const { root } = buildFileTree([commit('a', files)]);
    const src = findByPath(root, 'src');

    expect(src?.children.every((c) => !c.isCluster)).toBe(true);
    expect(src?.children).toHaveLength(8);
  });

  it('collapses a directory past the cluster threshold into one aggregate node', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/file${i}.ts`));
    const { root, fileClusterMap } = buildFileTree([commit('a', files)]);
    const src = findByPath(root, 'src');

    expect(src?.children).toHaveLength(1);
    const cluster = src?.children[0];
    expect(cluster?.isCluster).toBe(true);
    expect(cluster?.clusterSize).toBe(20);
    expect(cluster?.touches).toBe(20);
    expect(fileClusterMap.get('src/file0.ts')).toBe(cluster?.path);
    expect(fileClusterMap.size).toBe(20);
  });

  it('splits an over-threshold directory into multiple clusters when the files are not actually similar', () => {
    // Two co-changed .rs impl/test pairs (unrelated to each other — sharing
    // just an extension isn't enough to fuse them, see file-similarity.ts)
    // plus a pile of .md docs, each touched alone in its own commit and
    // with nothing else in common with each other either.
    const timeline = [
      commit('a', [file('src/auth.rs'), file('src/auth_test.rs')]),
      commit('a', [file('src/db.rs'), file('src/db_test.rs')]),
      ...Array.from({ length: 9 }, (_, i) => commit('a', [file(`src/doc${i}.md`)])),
    ];
    const { root } = buildFileTree(timeline);
    const src = findByPath(root, 'src')!;

    expect(src.children.length).toBeGreaterThan(1);
    expect(src.children.every((c) => c.isCluster)).toBe(true);

    const rsClusters = src.children.filter((c) => c.clusterSize === 2);
    expect(rsClusters).toHaveLength(2); // auth pair and db pair, kept separate

    // The 9 unrelated markdown files fall out as ungrouped leftovers, which
    // still exceed CLUSTER_THRESHOLD, so they land in one catch-all cluster
    // named from their shared extension rather than rendering individually.
    const mdCluster = src.children.find((c) => c.clusterSize === 9);
    expect(mdCluster?.name).toBe('9 .md files');

    const totalClustered = src.children.reduce((sum, c) => sum + (c.clusterSize ?? 0), 0);
    expect(totalClustered).toBe(13); // 4 rust files + 9 markdown files
  });

  it('names a cluster by its shared extension when every member has one', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/file${i}.rs`));
    const { root } = buildFileTree([commit('a', files)]);
    const cluster = findByPath(root, 'src')?.children[0];

    expect(cluster?.name).toBe('20 .rs files');
  });

  it('does not cascade: a cluster from one directory must not inflate a sibling or parent cluster', () => {
    // Two separate directories each individually over threshold — this
    // reproduces the bug where a cluster (already isFile:true) got counted
    // toward its *parent's* file threshold too, and one file-heavy branch
    // anywhere in the tree cascaded into absorbing every other cluster up
    // to the root.
    const heavyDirA = Array.from({ length: 20 }, (_, i) => file(`pkgA/file${i}.ts`));
    const heavyDirB = Array.from({ length: 20 }, (_, i) => file(`pkgB/file${i}.ts`));
    const looseRootFiles = Array.from({ length: 3 }, (_, i) => file(`root${i}.ts`));

    const { root } = buildFileTree([commit('a', [...heavyDirA, ...heavyDirB, ...looseRootFiles])]);

    // Root itself has only 3 loose files (below threshold) plus two
    // subdirectories — it must NOT collapse into one giant cluster that
    // absorbs pkgA's and pkgB's clusters.
    expect(root.children.some((c) => c.isCluster)).toBe(false);

    const pkgA = findByPath(root, 'pkgA');
    const pkgB = findByPath(root, 'pkgB');
    expect(pkgA?.children).toHaveLength(1);
    expect(pkgA?.children[0]?.isCluster).toBe(true);
    expect(pkgA?.children[0]?.clusterSize).toBe(20);
    expect(pkgB?.children[0]?.clusterSize).toBe(20);
  });
  it('promotes a segment to a directory once a path goes through it', () => {
    // `config` arrives as a file, then later as a directory. If it stays a
    // leaf, its whole subtree hangs off a node the renderer draws as a file
    // and hides below the zoom threshold.
    const timeline = [commit('a', [file('config')]), commit('a', [file('config/db.yml')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'config')?.isFile).toBe(false);
    expect(findByPath(root, 'config/db.yml')?.isFile).toBe(true);
  });

  it('builds a cluster reverse index matching fileClusterMap', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`src/file${i}.ts`));
    const { fileClusterMap, clusterMembers } = buildFileTree([commit('a', files)]);

    expect(clusterMembers.size).toBe(1);
    const [clusterPath, members] = [...clusterMembers.entries()][0];
    expect(members.sort()).toEqual([...fileClusterMap.keys()].sort());
    members.forEach((m) => expect(fileClusterMap.get(m)).toBe(clusterPath));
  });

  it('has no clusters, and so no members, below the threshold', () => {
    const files = Array.from({ length: 3 }, (_, i) => file(`src/file${i}.ts`));
    expect(buildFileTree([commit('a', files)]).clusterMembers.size).toBe(0);
  });
});

describe('clusterOwnerPath and expandedPaths', () => {
  it('records the owning directory on a cluster, not the synthetic cluster path', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`pkg/file${i}.ts`));
    const { root } = buildFileTree([commit('a', files)]);
    const cluster = findByPath(root, 'pkg')?.children[0];

    expect(cluster?.isCluster).toBe(true);
    expect(cluster?.clusterOwnerPath).toBe('pkg');
    expect(cluster?.path).not.toBe('pkg');
  });

  it('leaves a directory unclustered when it is in expandedPaths, regardless of count', () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`pkg/file${i}.ts`));
    const { root } = buildFileTree([commit('a', files)], new Set(['pkg']));
    const pkg = findByPath(root, 'pkg');

    expect(pkg?.children.every((c) => !c.isCluster)).toBe(true);
    expect(pkg?.children).toHaveLength(20);
  });

  it('only expands the directory actually named, not sibling directories over the same threshold', () => {
    const files = [
      ...Array.from({ length: 20 }, (_, i) => file(`pkgA/file${i}.ts`)),
      ...Array.from({ length: 20 }, (_, i) => file(`pkgB/file${i}.ts`)),
    ];
    const { root } = buildFileTree(files.length ? [commit('a', files)] : [], new Set(['pkgA']));
    expect(findByPath(root, 'pkgA')?.children.every((c) => !c.isCluster)).toBe(true);
    expect(findByPath(root, 'pkgB')?.children[0]?.isCluster).toBe(true);
  });
});

describe('removedAt', () => {
  it('marks a leaf removed at the commit that deletes it', () => {
    const timeline = [commit('a', [file('src/foo.ts')]), commit('a', [file('src/foo.ts', 'DELETE')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.removedAt).toBe(1);
  });

  it('leaves a never-deleted file with no removedAt', () => {
    const timeline = [commit('a', [file('src/foo.ts')]), commit('a', [file('src/foo.ts')])];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.removedAt).toBeUndefined();
  });

  it('clears removal when the file is re-added — only the final state counts', () => {
    const timeline = [
      commit('a', [file('src/foo.ts')]),
      commit('a', [file('src/foo.ts', 'DELETE')]),
      commit('a', [file('src/foo.ts')]),
    ];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.removedAt).toBeUndefined();
  });

  it('re-deletes correctly after a re-add', () => {
    const timeline = [
      commit('a', [file('src/foo.ts')]),
      commit('a', [file('src/foo.ts', 'DELETE')]),
      commit('a', [file('src/foo.ts')]),
      commit('a', [file('src/foo.ts', 'DELETE')]),
    ];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.removedAt).toBe(3);
  });

  it('leaves a directory alive while any child survives', () => {
    const timeline = [
      commit('a', [file('src/foo.ts'), file('src/bar.ts')]),
      commit('a', [file('src/foo.ts', 'DELETE')]),
    ];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/foo.ts')?.removedAt).toBe(1);
    expect(findByPath(root, 'src/bar.ts')?.removedAt).toBeUndefined();
    expect(findByPath(root, 'src')?.removedAt).toBeUndefined();
  });

  it('marks a directory removed once every child under it is gone, at the latest removal', () => {
    const timeline = [
      commit('a', [file('src/foo.ts'), file('src/bar.ts')]),
      commit('a', [file('src/foo.ts', 'DELETE')]),
      commit('a', [file('src/bar.ts', 'DELETE')]),
    ];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src')?.removedAt).toBe(2);
  });

  it('cascades through nested directories', () => {
    const timeline = [
      commit('a', [file('src/lib/foo.ts')]),
      commit('a', [file('src/lib/foo.ts', 'DELETE')]),
    ];
    const { root } = buildFileTree(timeline);

    expect(findByPath(root, 'src/lib')?.removedAt).toBe(1);
    expect(findByPath(root, 'src')?.removedAt).toBe(1);
  });

  it('never marks the root removed even if every top-level path is gone', () => {
    const timeline = [commit('a', [file('a.ts')]), commit('a', [file('a.ts', 'DELETE')])];
    const { root } = buildFileTree(timeline);

    expect(root.removedAt).toBeUndefined();
  });

  it('clears a stale file-level removedAt when the path is promoted to a directory', () => {
    // `config` is deleted as a file, then later reused as a directory path.
    // The directory must not inherit the old file's removedAt.
    const timeline = [
      commit('a', [file('config')]),
      commit('a', [file('config', 'DELETE')]),
      commit('a', [file('config/db.yml')]),
    ];
    const { root } = buildFileTree(timeline);

    const config = findByPath(root, 'config');
    expect(config?.isFile).toBe(false);
    expect(config?.removedAt).toBeUndefined();
  });

  it('marks a cluster removed only once every member file is gone', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`pkg/file${i}.ts`));
    const deleteAllButOne = files.slice(0, 11).map((f) => file(f.new_path!, 'DELETE'));

    const { root } = buildFileTree([commit('a', files), commit('a', deleteAllButOne)]);
    const cluster = findByPath(root, 'pkg')?.children[0];
    expect(cluster?.isCluster).toBe(true);
    expect(cluster?.removedAt).toBeUndefined();

    const deleteLastOne = [file('pkg/file11.ts', 'DELETE')];
    const { root: root2 } = buildFileTree([commit('a', files), commit('a', deleteAllButOne), commit('a', deleteLastOne)]);
    const cluster2 = findByPath(root2, 'pkg')?.children[0];
    expect(cluster2?.removedAt).toBe(2);
  });
});

describe('resolveFilePath', () => {
  it('prefers new_path', () => {
    expect(resolveFilePath(file('src/a.ts'))).toBe('src/a.ts');
  });

  it('falls back to old_path for a deletion', () => {
    expect(resolveFilePath(file('src/a.ts', 'DELETE'))).toBe('src/a.ts');
  });

  it('falls back to the bare filename when both paths are null', () => {
    expect(
      resolveFilePath({
        filename: 'orphan.ts',
        old_path: null,
        new_path: null,
        change_type: 'MODIFY',
        lines_added: 0,
        lines_removed: 0,
      })
    ).toBe('orphan.ts');
  });
});
