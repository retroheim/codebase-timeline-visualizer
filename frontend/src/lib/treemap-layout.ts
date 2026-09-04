// File-churn treemap layout. Reuses `buildFileTree()` from file-tree.ts so
// the treemap gets the same over-threshold directory clustering the radial
// tree already has — node count is bounded the same way in both views.

import * as d3 from 'd3';
import { buildFileTree, type TreeNode } from './file-tree';
import type { CommitEvent, FileStat } from '../types';

export type ChurnMetric = 'churn' | 'edits' | 'linesAdded' | 'linesRemoved';

export interface TreemapResult {
  root: d3.HierarchyRectangularNode<TreeNode>;
  nodeByPath: Map<string, d3.HierarchyRectangularNode<TreeNode>>;
}

function singleFileValue(stat: FileStat | undefined, metric: ChurnMetric): number {
  if (!stat) return 0;
  switch (metric) {
    case 'edits':
      return stat.changes;
    case 'linesAdded':
      return stat.lines_added;
    case 'linesRemoved':
      return stat.lines_removed;
    case 'churn':
    default:
      return stat.lines_added + stat.lines_removed;
  }
}

function metricValue(
  node: TreeNode,
  files: Record<string, FileStat>,
  clusterMembers: Map<string, string[]>,
  metric: ChurnMetric
): number {
  if (node.isCluster) {
    const members = clusterMembers.get(node.path) ?? [];
    return members.reduce((sum, path) => sum + singleFileValue(files[path], metric), 0);
  }
  return singleFileValue(files[node.path], metric);
}

export function computeTreemapLayout(
  timeline: CommitEvent[],
  files: Record<string, FileStat>,
  width: number,
  height: number,
  metric: ChurnMetric = 'churn',
  expandedPaths?: ReadonlySet<string>
): TreemapResult | null {
  if (width <= 0 || height <= 0 || timeline.length === 0) return null;

  const { root: treeRoot, clusterMembers } = buildFileTree(timeline, expandedPaths);

  const hierarchy = d3
    .hierarchy<TreeNode>(treeRoot, (n) => n.children)
    .sum((n) => (n.isFile ? metricValue(n, files, clusterMembers, metric) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const layout = d3.treemap<TreeNode>().paddingInner(1).paddingOuter(1).round(true).size([width, height])(
    hierarchy
  ) as d3.HierarchyRectangularNode<TreeNode>;

  const nodeByPath = new Map<string, d3.HierarchyRectangularNode<TreeNode>>();
  layout.each((n) => nodeByPath.set(n.data.path, n));

  return { root: layout, nodeByPath };
}

/**
 * Picks which node to actually draw a rect for, per branch of the tree —
 * either a real leaf (file/cluster), or the shallowest ancestor directory
 * whose rect is already at or below `minArea`. A repo with thousands of
 * files laid out into a few hundred thousand pixels produces file-level
 * rects smaller than a single pixel; descending that far is not "more
 * detail", it's an invisible treemap. Stopping at the first directory
 * that's already small enough keeps every rendered rect legible, at the
 * cost of precision only where precision could never have been seen anyway.
 */
export function pickVisibleNodes(
  root: d3.HierarchyRectangularNode<TreeNode>,
  minArea: number
): d3.HierarchyRectangularNode<TreeNode>[] {
  const result: d3.HierarchyRectangularNode<TreeNode>[] = [];
  const walk = (node: d3.HierarchyRectangularNode<TreeNode>): void => {
    const area = (node.x1 - node.x0) * (node.y1 - node.y0);
    if (!node.children || node.children.length === 0 || area <= minArea) {
      if (area > 0) result.push(node);
      return;
    }
    node.children.forEach(walk);
  };
  walk(root);
  return result;
}
