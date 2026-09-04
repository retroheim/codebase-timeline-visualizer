import { describe, expect, it } from 'vitest';
import { computeTreeLayout } from '../tree-layout';
import { cartesian, radialArcPointsFlat } from '../geometry';
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

function commit(files: FileChange[], author = 'Test User'): CommitEvent {
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

const WIDTH = 900;
const HEIGHT = 700;

describe('computeTreeLayout', () => {
  it('returns null for an empty timeline rather than an empty tree', () => {
    expect(computeTreeLayout([], WIDTH, HEIGHT)).toBeNull();
  });

  it('indexes every node by its path', () => {
    const layout = computeTreeLayout(
      [commit([file('src/a.ts')]), commit([file('src/nested/b.ts')])],
      WIDTH,
      HEIGHT
    )!;

    expect(layout.nodeByPath.has('src')).toBe(true);
    expect(layout.nodeByPath.has('src/a.ts')).toBe(true);
    expect(layout.nodeByPath.has('src/nested')).toBe(true);
    expect(layout.nodeByPath.has('src/nested/b.ts')).toBe(true);
  });

  it('orders nodes and links by first appearance', () => {
    const layout = computeTreeLayout(
      [commit([file('a.ts')]), commit([file('b.ts')]), commit([file('c.ts')])],
      WIDTH,
      HEIGHT
    )!;

    const sorted = [...layout.nodeIntroductions].sort((x, y) => x - y);
    expect(layout.nodeIntroductions).toEqual(sorted);

    const sortedLinks = [...layout.linkIntroductions].sort((x, y) => x - y);
    expect(layout.linkIntroductions).toEqual(sortedLinks);
  });

  /** The hoisted arrays are what playback indexes into; a mismatch would
   *  reveal a different node than the one whose time was compared. */
  it('keeps the hoisted introduction arrays aligned with their nodes', () => {
    const layout = computeTreeLayout(
      [commit([file('a.ts')]), commit([file('dir/b.ts')])],
      WIDTH,
      HEIGHT
    )!;

    expect(layout.nodeIntroductions).toEqual(
      layout.nodesByIntroduction.map((n) => n.data.introducedAt)
    );
    expect(layout.linkIntroductions).toEqual(
      layout.linksByIntroduction.map((l) => l.target.data.introducedAt)
    );
  });

  it('produces one link per node except the root', () => {
    const layout = computeTreeLayout([commit([file('src/a.ts'), file('src/b.ts')])], WIDTH, HEIGHT)!;
    expect(layout.linksByIntroduction.length).toBe(layout.nodesByIntroduction.length - 1);
  });

  it('puts the root at the centre and everything else outside it', () => {
    const layout = computeTreeLayout([commit([file('src/a.ts')])], WIDTH, HEIGHT)!;
    expect(layout.root.y).toBe(0);
    expect(layout.root.descendants().filter((d) => d.depth > 0).every((d) => d.y > 0)).toBe(true);
  });

  it('separates nodes sharing a ring by a real distance', () => {
    const files = Array.from({ length: 6 }, (_, i) => file(`dir${i}/file.ts`));
    const layout = computeTreeLayout([commit(files)], WIDTH, HEIGHT)!;

    const ring = layout.root.descendants().filter((d) => d.depth === 1);
    const angles = ring.map((d) => d.x).sort((a, b) => a - b);
    for (let i = 1; i < angles.length; i += 1) {
      expect(angles[i] - angles[i - 1]).toBeGreaterThan(0);
    }
  });

  it('scales node radius with how often a file was touched', () => {
    const layout = computeTreeLayout(
      [
        commit([file('hot.ts'), file('cold.ts')]),
        commit([file('hot.ts')]),
        commit([file('hot.ts')]),
      ],
      WIDTH,
      HEIGHT
    )!;

    const hot = layout.nodeByPath.get('hot.ts')!;
    const cold = layout.nodeByPath.get('cold.ts')!;
    expect(layout.fileRadiusScale(hot.data.touches)).toBeGreaterThan(
      layout.fileRadiusScale(cold.data.touches)
    );
  });

  it('exposes the cluster reverse index for grouped files', () => {
    // CLUSTER_THRESHOLD is 8, so 12 files in one directory collapse.
    const files = Array.from({ length: 12 }, (_, i) => file(`pkg/file${i}.ts`));
    const layout = computeTreeLayout([commit(files)], WIDTH, HEIGHT)!;

    expect(layout.clusterMembers.size).toBe(1);
    const [clusterPath, members] = [...layout.clusterMembers.entries()][0];
    expect(members).toHaveLength(12);
    expect(layout.nodeByPath.has(clusterPath)).toBe(true);
    // Every clustered file must be redirectable to its cluster, or a spark
    // aimed at it has nowhere to land.
    members.forEach((m) => expect(layout.fileClusterMap.get(m)).toBe(clusterPath));
  });

  it('keeps the glow window inside its bounds for any repo size', () => {
    const tiny = computeTreeLayout([commit([file('a.ts')])], WIDTH, HEIGHT)!;
    expect(tiny.glowWindow).toBeGreaterThanOrEqual(3);

    const big = computeTreeLayout(
      Array.from({ length: 1000 }, (_, i) => commit([file(`f${i}.ts`)])),
      WIDTH,
      HEIGHT
    )!;
    expect(big.glowWindow).toBeLessThanOrEqual(24);
  });

  /**
   * The draw loop reads `data.layoutX/layoutY/layoutRadius/arcPoints`
   * directly instead of recomputing cartesian()/radialArcPoints() every
   * frame. This pins the cache to agree with an on-demand recomputation from
   * the same node positions, so a future edit can't let the two drift apart
   * silently (the failure mode would be nodes drawn in the wrong place).
   */
  it('caches cartesian position, radius, and arc points matching on-demand geometry', () => {
    const layout = computeTreeLayout(
      [commit([file('src/a.ts')]), commit([file('src/nested/b.ts')])],
      WIDTH,
      HEIGHT
    )!;

    for (const n of layout.root.descendants()) {
      const [ex, ey] = cartesian(n);
      expect(n.data.layoutX).toBeCloseTo(ex);
      expect(n.data.layoutY).toBeCloseTo(ey);

      const expectedRadius = n.data.isFile
        ? layout.fileRadiusScale(n.data.touches)
        : layout.dirRadiusScale(n.data.touches);
      expect(n.data.layoutRadius).toBeCloseTo(expectedRadius);

      if (n.parent) {
        const expectedArc = radialArcPointsFlat(n.parent, n);
        expect(n.data.arcPoints).toBeDefined();
        expect(Array.from(n.data.arcPoints!)).toEqual(Array.from(expectedArc));
      } else {
        expect(n.data.arcPoints).toBeUndefined();
      }
    }
  });

  it('carries removedAt through to the laid-out node, unaffected by layout', () => {
    const layout = computeTreeLayout(
      [commit([file('src/foo.ts')]), commit([file('src/foo.ts', 'DELETE')])],
      WIDTH,
      HEIGHT
    )!;

    expect(layout.nodeByPath.get('src/foo.ts')?.data.removedAt).toBe(1);
    expect(layout.nodeByPath.get('src')?.data.removedAt).toBe(1);
    expect(layout.root.data.removedAt).toBeUndefined();
  });

  /**
   * The dissolve pass walks this cursor-style, mirroring
   * nodesByIntroduction/nodeIntroductions — only nodes that ever get removed
   * belong in it, sorted by when, so playback can find "what's fading right
   * now" without scanning every node in the tree.
   */
  it('indexes only removed nodes, sorted by removal time, aligned with removalTimes', () => {
    const layout = computeTreeLayout(
      [
        commit([file('a.ts'), file('b.ts'), file('c.ts')]),
        commit([file('b.ts', 'DELETE')]),
        commit([file('a.ts', 'DELETE')]),
      ],
      WIDTH,
      HEIGHT
    )!;

    const paths = layout.nodesByRemoval.map((n) => n.data.path);
    expect(paths).toEqual(['b.ts', 'a.ts']);
    expect(layout.removalTimes).toEqual([1, 2]);
    expect(layout.nodesByRemoval.every((n) => n.data.path !== 'c.ts')).toBe(true);
  });

  describe('branch coloring', () => {
    it('gives each top-level branch a distinct color', () => {
      const layout = computeTreeLayout(
        [commit([file('alpha/a.ts'), file('beta/b.ts'), file('gamma/c.ts')])],
        WIDTH,
        HEIGHT
      )!;

      const colors = ['alpha', 'beta', 'gamma'].map((name) => layout.nodeByPath.get(name)!.data.colorRgb!.join(','));
      expect(new Set(colors).size).toBe(3);
      expect(layout.branchCount).toBe(3);
    });

    it('gives deeper nodes within the same branch a different shade than shallower ones', () => {
      const layout = computeTreeLayout([commit([file('src/a/b/c/deep.ts'), file('src/shallow.ts')])], WIDTH, HEIGHT)!;

      const shallow = layout.nodeByPath.get('src/shallow.ts')!;
      const deep = layout.nodeByPath.get('src/a/b/c/deep.ts')!;
      // Same branch (both under `src`) -> same hue family, different depth
      // shade -> not the identical color.
      expect(deep.data.colorRgb).not.toEqual(shallow.data.colorRgb);
      expect(deep.data.branchBucket).not.toBe(shallow.data.branchBucket);
    });

    /**
     * The actual ask this exists to pin: every single depth level gets its
     * own genuinely distinct color, not one of a handful of shade bands a
     * deep chain eventually collapses into. Hue never stops rotating, so
     * this must hold arbitrarily far down — tested well past what the old
     * 5-tier scheme could have told apart.
     */
    it('gives every distinct depth level down a long chain its own distinct color', () => {
      const depth = 20;
      const path = Array.from({ length: depth }, (_, i) => `d${i}`).join('/') + '/leaf.ts';
      const layout = computeTreeLayout([commit([file(path)])], WIDTH, HEIGHT)!;

      const colors: string[] = [];
      let built = '';
      for (let i = 0; i < depth; i += 1) {
        built = built ? `${built}/d${i}` : `d${i}`;
        colors.push(layout.nodeByPath.get(built)!.data.colorRgb!.join(','));
      }

      expect(new Set(colors).size).toBe(depth);
    });

    it('reports branchDepth incrementing by exactly one per level, starting at 0 for the branch root', () => {
      const layout = computeTreeLayout([commit([file('src/a/b/leaf.ts')])], WIDTH, HEIGHT)!;
      expect(layout.nodeByPath.get('src')!.data.branchDepth).toBe(0);
      expect(layout.nodeByPath.get('src/a')!.data.branchDepth).toBe(1);
      expect(layout.nodeByPath.get('src/a/b')!.data.branchDepth).toBe(2);
      expect(layout.nodeByPath.get('src/a/b/leaf.ts')!.data.branchDepth).toBe(3);
    });

    /**
     * The actual ask this exists to pin: two sibling subtrees at the SAME
     * depth under the SAME top-level branch must not share a color just
     * because they share a branchIndex and a depth — hue comes from each
     * node's own angular slice now, not from (branchIndex, depth) alone, so
     * `src/a` and `src/b` (and everything under them) fan out into their own
     * distinct color families even though both are "in `src`".
     */
    it('gives sibling subtrees under the same top-level branch distinct colors, not just distinct depths', () => {
      const layout = computeTreeLayout([commit([file('src/a/one.ts'), file('src/b/two.ts')])], WIDTH, HEIGHT)!;
      const a = layout.nodeByPath.get('src/a')!;
      const b = layout.nodeByPath.get('src/b')!;
      const one = layout.nodeByPath.get('src/a/one.ts')!;
      const two = layout.nodeByPath.get('src/b/two.ts')!;

      expect(a.data.branchDepth).toBe(b.data.branchDepth); // same depth in branch
      expect(a.data.colorRgb).not.toEqual(b.data.colorRgb); // still different colors
      expect(one.data.colorRgb).not.toEqual(two.data.colorRgb);
      expect(one.data.branchBucket).not.toBe(two.data.branchBucket);
    });

    it('gives every node sharing a bucket the exact same color', () => {
      const layout = computeTreeLayout(
        [commit([file('src/a/one.ts'), file('src/a/two.ts'), file('src/b/three.ts')])],
        WIDTH,
        HEIGHT
      )!;
      const byBucket = new Map<number, string[]>();
      layout.root.descendants().forEach((n) => {
        if (n.data.branchBucket === undefined) return;
        const list = byBucket.get(n.data.branchBucket) ?? [];
        list.push(n.data.colorRgb!.join(','));
        byBucket.set(n.data.branchBucket, list);
      });
      for (const colors of byBucket.values()) {
        expect(new Set(colors).size).toBe(1);
      }
    });

    it('leaves the root with no branch color of its own', () => {
      const layout = computeTreeLayout([commit([file('src/a.ts')])], WIDTH, HEIGHT)!;
      expect(layout.root.data.colorRgb).toBeUndefined();
      expect(layout.root.data.branchBucket).toBeUndefined();
      expect(layout.root.data.branchDepth).toBeUndefined();
    });

    it('adapts to a single top-level branch without dividing by zero', () => {
      const layout = computeTreeLayout([commit([file('only/a.ts')])], WIDTH, HEIGHT)!;
      const node = layout.nodeByPath.get('only')!;
      expect(node.data.colorRgb!.every((c) => Number.isFinite(c))).toBe(true);
    });
  });

  describe('expandedPaths', () => {
    it('threads through to skip clustering for the named directory', () => {
      const files = Array.from({ length: 20 }, (_, i) => file(`pkg/file${i}.ts`));
      const collapsed = computeTreeLayout([commit(files)], WIDTH, HEIGHT)!;
      const expanded = computeTreeLayout([commit(files)], WIDTH, HEIGHT, new Set(['pkg']))!;

      expect(collapsed.nodeByPath.get('pkg/file0.ts')).toBeUndefined();
      expect(expanded.nodeByPath.get('pkg/file0.ts')).toBeDefined();
      expect(expanded.nodeByPath.get('pkg/file0.ts')?.data.layoutX).toBeDefined();
    });
  });

  it('survives a viewport too small for its own padding', () => {
    // baseRadius goes negative at these dimensions; the layout must still
    // produce usable coordinates rather than NaN.
    const layout = computeTreeLayout([commit([file('src/a.ts')])], 40, 30)!;
    expect(layout.root.descendants().every((d) => Number.isFinite(d.x) && Number.isFinite(d.y))).toBe(
      true
    );
  });
});
