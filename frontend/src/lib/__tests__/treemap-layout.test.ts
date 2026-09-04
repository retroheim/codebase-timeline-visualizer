import { describe, expect, it } from 'vitest';
import { computeTreemapLayout, pickVisibleNodes } from '../treemap-layout';
import type { CommitEvent, FileChange, FileStat } from '../../types';

function file(path: string): FileChange {
  return {
    filename: path.split('/').pop() ?? path,
    old_path: null,
    new_path: path,
    change_type: 'ADD',
    lines_added: 1,
    lines_removed: 0,
  };
}

function commit(files: FileChange[]): CommitEvent {
  return {
    timestamp: 0,
    datetime: '',
    commit_hash: 'abc',
    author: 'a',
    message: '',
    files_changed: files,
    lines_added: files.length,
    lines_removed: 0,
    cumulative_lines: 0,
    cumulative_files: 0,
  };
}

function stat(linesAdded: number, linesRemoved = 0): FileStat {
  return { changes: 1, lines_added: linesAdded, lines_removed: linesRemoved, authors: ['a'], first_change: 0, last_change: 0 };
}

describe('computeTreemapLayout', () => {
  it('returns null for an empty timeline or non-positive dimensions', () => {
    expect(computeTreemapLayout([], {}, 100, 100)).toBeNull();
    const timeline = [commit([file('a.ts')])];
    expect(computeTreemapLayout(timeline, {}, 0, 100)).toBeNull();
  });

  it('lays out leaves with positive area proportional to their churn', () => {
    const timeline = [commit([file('big.ts'), file('small.ts')])];
    const files = { 'big.ts': stat(90), 'small.ts': stat(10) };
    const result = computeTreemapLayout(timeline, files, 200, 200, 'churn');
    expect(result).not.toBeNull();

    const big = result!.nodeByPath.get('big.ts')!;
    const small = result!.nodeByPath.get('small.ts')!;
    const area = (n: typeof big) => (n.x1 - n.x0) * (n.y1 - n.y0);
    expect(area(big)).toBeGreaterThan(area(small));
  });

  it('sizes leaves by the selected metric, not always churn', () => {
    const timeline = [commit([file('added.ts'), file('removed.ts')])];
    const files = { 'added.ts': stat(100, 0), 'removed.ts': stat(0, 100) };
    const byAdded = computeTreemapLayout(timeline, files, 200, 200, 'linesAdded')!;
    const addedNode = byAdded.nodeByPath.get('added.ts')!;
    const removedNode = byAdded.nodeByPath.get('removed.ts')!;
    const area = (n: typeof addedNode) => (n.x1 - n.x0) * (n.y1 - n.y0);
    expect(area(addedNode)).toBeGreaterThan(area(removedNode));
  });

  it('every laid-out rect stays within the given bounds', () => {
    const timeline = [commit([file('src/a.ts'), file('src/b.ts'), file('docs/c.md')])];
    const files = { 'src/a.ts': stat(5), 'src/b.ts': stat(3), 'docs/c.md': stat(1) };
    const result = computeTreemapLayout(timeline, files, 300, 150)!;
    result.root.each((n) => {
      expect(n.x0).toBeGreaterThanOrEqual(0);
      expect(n.x1).toBeLessThanOrEqual(300);
      expect(n.y0).toBeGreaterThanOrEqual(0);
      expect(n.y1).toBeLessThanOrEqual(150);
    });
  });

  it('treats a file missing from the files map as zero value rather than throwing', () => {
    const timeline = [commit([file('known.ts'), file('unknown.ts')])];
    // `unknown.ts` deliberately has no entry in `files` — a tree/stats
    // mismatch that should degrade to 0, not crash the layout.
    const files = { 'known.ts': stat(10) };
    const result = computeTreemapLayout(timeline, files, 200, 200)!;
    expect(result).not.toBeNull();
    const unknown = result.nodeByPath.get('unknown.ts')!;
    expect(unknown.value).toBe(0);
  });

  it('sizes by edit count for the "edits" metric', () => {
    const timeline = [commit([file('a.ts'), file('b.ts')])];
    const files = {
      'a.ts': { changes: 9, lines_added: 1, lines_removed: 0, authors: ['a'], first_change: 0, last_change: 0 },
      'b.ts': { changes: 1, lines_added: 100, lines_removed: 0, authors: ['a'], first_change: 0, last_change: 0 },
    };
    const result = computeTreemapLayout(timeline, files, 200, 200, 'edits')!;
    const a = result.nodeByPath.get('a.ts')!;
    const b = result.nodeByPath.get('b.ts')!;
    // By edit count a.ts (9 edits) outweighs b.ts (1 edit), the reverse of
    // what 'churn' (lines) would say — confirms the metric switch actually
    // changes which field drives sizing.
    const area = (n: typeof a) => (n.x1 - n.x0) * (n.y1 - n.y0);
    expect(area(a)).toBeGreaterThan(area(b));
  });

  it('sums a cluster node value from its member files, not the cluster path itself', () => {
    // Past CLUSTER_THRESHOLD (8) in one directory, buildFileTree collapses
    // the files into a synthetic cluster node — its value must come from
    // summing its real members via clusterMembers, since `files[clusterPath]`
    // (the synthetic "·cluster·0" path) was never a real file with stats.
    const files_changed = Array.from({ length: 10 }, (_, i) => file(`src/f${i}.ts`));
    const timeline = [commit(files_changed)];
    const files = Object.fromEntries(files_changed.map((f) => [f.new_path as string, stat(10)]));
    const result = computeTreemapLayout(timeline, files, 200, 200, 'churn')!;

    const clusterEntry = Array.from(result.nodeByPath.entries()).find(([path]) => path.includes('·cluster·'));
    expect(clusterEntry, 'fixture should have produced a cluster node').toBeDefined();
    const [, clusterRect] = clusterEntry!;
    // 10 files * 10 lines each = 100, not 0 (which is what it'd be if the
    // cluster's synthetic path were looked up directly in `files`).
    expect(clusterRect.value).toBe(100);
  });
});

describe('pickVisibleNodes', () => {
  it('returns individual file leaves when every rect is already above minArea', () => {
    const timeline = [commit([file('a.ts'), file('b.ts')])];
    const files = { 'a.ts': stat(50), 'b.ts': stat(50) };
    const result = computeTreemapLayout(timeline, files, 200, 200)!;
    const visible = pickVisibleNodes(result.root, 1);
    const paths = visible.map((n) => n.data.path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts']);
  });

  it('collapses a directory into one node once its rect is too small to descend into', () => {
    // Many tiny files under one directory, laid out into a small canvas —
    // each individual leaf ends up far smaller than any reasonable minArea.
    const filesChanged = Array.from({ length: 50 }, (_, i) => file(`src/f${i}.ts`));
    const timeline = [commit(filesChanged)];
    const fileStats = Object.fromEntries(filesChanged.map((f) => [f.new_path as string, stat(1)]));
    const result = computeTreemapLayout(timeline, fileStats, 40, 40)!;

    const visible = pickVisibleNodes(result.root, 50);
    // Collapsed to a handful of directory/cluster-level nodes instead of
    // descending all the way to 50 individual file rects.
    expect(visible.length).toBeLessThan(10);
    expect(visible.some((n) => n.data.path.startsWith('src/f'))).toBe(false);
  });

  it('every returned node has positive area', () => {
    const timeline = [commit([file('a.ts'), file('src/b.ts'), file('src/c.ts')])];
    const files = { 'a.ts': stat(1), 'src/b.ts': stat(1), 'src/c.ts': stat(1) };
    const result = computeTreemapLayout(timeline, files, 100, 100)!;
    const visible = pickVisibleNodes(result.root, 5);
    for (const n of visible) {
      expect((n.x1 - n.x0) * (n.y1 - n.y0)).toBeGreaterThan(0);
    }
  });
});
