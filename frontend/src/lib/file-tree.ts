import { commonExtension, groupBySimilarity } from './file-similarity';
import type { CommitEvent, FileChange } from '../types';

/**
 * The path a changed file should be filed under. `new_path` is null for
 * deletions, so fall back to `old_path` before the bare filename — otherwise a
 * deleted file collapses to a dir-less name at the tree root. Every consumer
 * must agree on this or nodes and lookups drift apart.
 */
export function resolveFilePath(file: FileChange): string {
  return file.new_path || file.old_path || file.filename;
}

export interface TreeNode {
  name: string;
  path: string;
  isFile: boolean;
  isCluster?: boolean;
  clusterSize?: number;
  // The real directory a cluster aggregates, for the "expand this cluster"
  // interaction — the cluster's own `path` is the synthetic `.../·cluster·`
  // marker, not a real tree location.
  clusterOwnerPath?: string;
  introducedAt: number;
  touches: number;
  children: TreeNode[];
  // The commit index at which this node most recently ceased to exist —
  // undefined if it exists as of the final commit in the timeline. Set from
  // a leaf's own DELETE deltas; a directory or cluster only carries a
  // removedAt when EVERY child under it has one (i.e. nothing live remains
  // underneath), computed bottom-up in collapseClusters(). A file that was
  // deleted and later re-added has this cleared back to undefined — only the
  // final state matters for whether the animation should keep showing it.
  removedAt?: number;
  // Populated once by computeTreeLayout() after the radial layout and radius
  // scales are final. Every draw-loop consumer reads these instead of calling
  // trig/scale functions per node per frame — the position and size in
  // tree-space don't change between layout rebuilds, only the canvas'
  // zoom/pan transform does, and that's applied globally via ctx.scale/
  // ctx.translate rather than per-point.
  layoutX?: number;
  layoutY?: number;
  layoutRadius?: number;
  // Flattened [x0, y0, x1, y1, ...] arc points from this node's parent to
  // this node, precomputed once. Keyed by the child (target) since every
  // non-root node has exactly one parent link.
  arcPoints?: Float64Array;
  // Hue comes from the node's own angular position in the radial layout —
  // every subtree occupies a disjoint angular wedge at every depth, so two
  // sibling directories at the same depth under different parents get
  // genuinely different colors, not just different depth-based shades of the
  // same top-level branch color. Lightness/saturation still step per depth
  // level for the "further down the trunk" cue. Undefined only for the root
  // itself, which isn't part of any branch. Precomputed by
  // computeTreeLayout() alongside the other layout* fields.
  colorRgb?: [number, number, number];
  // How many levels below its top-level branch root this node sits (0 for
  // the branch root itself). Exposed separately from branchBucket so the
  // renderer can taper link width/alpha with depth without having to decode
  // it back out of the bucket key.
  branchDepth?: number;
  // Opaque grouping key (uniquely encodes branchIndex + branchDepth) used to
  // batch same-colored nodes into one canvas draw call instead of one per
  // node — canvas fillStyle/strokeStyle can't vary within a single batched
  // path. Every node that shares a bucket has the identical colorRgb.
  branchBucket?: number;
}

interface MutableTreeNode extends Omit<TreeNode, 'children'> {
  children: Map<string, MutableTreeNode>;
}

// Above this many files directly in one directory, group the overflow into
// a single cluster node instead of drawing each one. Conventions that cap
// file length (e.g. a 500-line limit) push codebases toward many small
// files per module rather than fewer large ones — without this, that shows
// up as visual clutter that has nothing to do with the codebase's actual
// shape, just its line-count policy.
const CLUSTER_THRESHOLD = 8;

// Turn every file path ever touched into a nested tree: {name, path, isFile, introducedAt, children}
function buildRawTree(timeline: CommitEvent[]): MutableTreeNode {
  const root: MutableTreeNode = {
    name: 'root',
    path: '',
    isFile: false,
    introducedAt: 0,
    touches: 0,
    children: new Map(),
  };

  timeline.forEach((commit, index) => {
    (commit.files_changed || []).forEach((file) => {
      const path = resolveFilePath(file);
      if (!path || path === '/dev/null') return;

      const parts = path.split('/').filter(Boolean);
      let node = root;
      let builtPath = '';
      root.touches += 1;

      parts.forEach((part, i) => {
        builtPath = builtPath ? `${builtPath}/${part}` : part;
        const isFile = i === parts.length - 1;

        if (!node.children.has(part)) {
          node.children.set(part, {
            name: part,
            path: builtPath,
            isFile,
            introducedAt: index,
            touches: 0,
            children: new Map(),
          });
        }

        const child = node.children.get(part)!;
        child.introducedAt = Math.min(child.introducedAt, index);
        child.touches += 1;
        // A segment first seen as a file (`config`) and later used as a
        // directory (`config/db.yml`) must stop being a leaf, or its whole
        // subtree is built underneath a node the renderer draws as a file and
        // hides below the zoom threshold. Once a directory, always a directory.
        if (!isFile) {
          child.isFile = false;
          // A segment promoted from leaf to directory can't still carry a
          // file-level removedAt from before the promotion — a directory's
          // removedAt is derived bottom-up from its children in
          // collapseClusters(), not tracked here.
          child.removedAt = undefined;
        } else {
          // Only the leaf segment carries the delta's own change_type — a
          // DELETE of `src/foo.ts` doesn't mean `src` was deleted. Track the
          // most recent delete on the file itself; any later touch (a
          // re-add) clears it, so only the FINAL state governs whether the
          // animation keeps showing it.
          child.removedAt = file.change_type === 'DELETE' ? index : undefined;
        }
        node = child;
      });
    });
  });

  return root;
}

// Which commit indices touched each path, keyed by the same resolved path
// buildRawTree uses — the raw material for co-change similarity clustering
// below. Built in one pass over the timeline, same as buildRawTree, rather
// than derived from the tree afterward.
function buildCommitSetByPath(timeline: CommitEvent[]): Map<string, Set<number>> {
  const commitSetByPath = new Map<string, Set<number>>();
  timeline.forEach((commit, index) => {
    (commit.files_changed || []).forEach((file) => {
      const path = resolveFilePath(file);
      if (!path || path === '/dev/null') return;
      const set = commitSetByPath.get(path);
      if (set) set.add(index);
      else commitSetByPath.set(path, new Set([index]));
    });
  });
  return commitSetByPath;
}

// Collapse a directory's file children into one or more aggregate nodes
// once there are more than CLUSTER_THRESHOLD of them. Records where each
// collapsed file went in `fileClusterMap`, so callers that need to target an
// individual file (e.g. "which node did this commit touch") can redirect to
// its cluster when the file itself isn't rendered as its own node.
/**
 * A directory (or cluster) is alive as long as anything live remains under
 * it — its removedAt is only defined once EVERY one of its direct children
 * has one. A single child with no removedAt (still exists as of the final
 * commit) keeps the parent alive forever, which is the correct default: an
 * empty directory isn't itself a thing git tracks or a thing the animation
 * needs to hide.
 */
function cascadeRemovedAt(children: TreeNode[]): number | undefined {
  if (children.length === 0 || children.some((c) => c.removedAt === undefined)) return undefined;
  return Math.max(...children.map((c) => c.removedAt!));
}

// Builds one aggregate TreeNode out of a group of similar files. `index`
// disambiguates the synthetic path when a directory produces more than one
// cluster (one per similarity group) instead of the single catch-all it used
// to.
function makeCluster(owner: TreeNode, members: TreeNode[], index: number, fileClusterMap: Map<string, string>): TreeNode {
  const clusterPath = `${owner.path}/·cluster·${index}`;
  const introducedAt = Math.min(...members.map((c) => c.introducedAt));
  const touches = members.reduce((sum, c) => sum + c.touches, 0);
  members.forEach((c) => fileClusterMap.set(c.path, clusterPath));

  const ext = commonExtension(members);
  const name = ext ? `${members.length} ${ext} files` : `${members.length} files`;

  return {
    name,
    path: clusterPath,
    isFile: true,
    isCluster: true,
    clusterSize: members.length,
    clusterOwnerPath: owner.path,
    introducedAt,
    touches,
    // A cluster only disappears once every file it swallowed has been
    // removed — one surviving member is enough to keep the group visible.
    removedAt: cascadeRemovedAt(members),
    children: [],
  };
}

function collapseClusters(
  node: TreeNode,
  fileClusterMap: Map<string, string>,
  expandedPaths: ReadonlySet<string>,
  commitSetByPath: ReadonlyMap<string, Set<number>>
): TreeNode {
  const children = node.children.map((c) => collapseClusters(c, fileClusterMap, expandedPaths, commitSetByPath));
  // A cluster from a child directory is already an aggregate, not a plain
  // file — treat it like a directory here so it can't get swept into *this*
  // level's cluster too. Without this, one file-heavy branch anywhere in the
  // tree cascades into absorbing every other cluster up to the root.
  const dirChildren = children.filter((c) => !c.isFile || c.isCluster);
  const fileChildren = children.filter((c) => c.isFile && !c.isCluster);

  // Explicitly expanded (double-clicked) directories skip clustering
  // entirely regardless of file count, showing every file as its own node.
  if (fileChildren.length <= CLUSTER_THRESHOLD || expandedPaths.has(node.path)) {
    const allChildren = [...dirChildren, ...fileChildren];
    // A leaf file has no children to cascade from — its own removedAt
    // (resolved in buildRawTree) passes through untouched.
    const removedAt = node.isFile ? node.removedAt : cascadeRemovedAt(allChildren);
    return { ...node, removedAt, children: allChildren };
  }

  // Past the threshold, group by similarity instead of dumping every file
  // into one undifferentiated blob — co-change coupling, shared extension,
  // and shared name stem combine into groups that actually mean something
  // (an impl/test pair, every `.rs` file in a module) rather than an
  // arbitrary "everything past #8" cutoff.
  const groups = groupBySimilarity(fileChildren, commitSetByPath);
  const multiFileGroups = groups.filter((g) => g.length > 1);
  const leftovers = groups.filter((g) => g.length === 1).flat();

  const clusters = multiFileGroups.map((members, i) => makeCluster(node, members, i, fileClusterMap));
  // Files that didn't match anything nearby stay as individual nodes if
  // there are few enough of them — otherwise they'd defeat the whole point
  // of clustering, so bundle them into one catch-all group same as the old
  // "everything past the threshold" behavior, keeping the directory's
  // rendered child count bounded regardless of how well individual files
  // happened to group.
  const ungrouped =
    leftovers.length > CLUSTER_THRESHOLD ? [makeCluster(node, leftovers, clusters.length, fileClusterMap)] : leftovers;

  const allChildren = [...dirChildren, ...clusters, ...ungrouped];
  return { ...node, removedAt: cascadeRemovedAt(allChildren), children: allChildren };
}

export interface BuiltTree {
  root: TreeNode;
  // Original file path -> cluster path, for files that got grouped away.
  fileClusterMap: Map<string, string>;
  // The reverse: cluster path -> the file paths it swallowed. Built here once
  // because the inspector needs it per render, and deriving it by scanning all
  // of fileClusterMap each time is O(all files) on every reactive update.
  clusterMembers: Map<string, string[]>;
}

export function buildFileTree(timeline: CommitEvent[], expandedPaths?: ReadonlySet<string>): BuiltTree {
  const rawRoot = buildRawTree(timeline);

  const toArray = (node: MutableTreeNode): TreeNode => ({
    name: node.name,
    path: node.path,
    isFile: node.isFile,
    introducedAt: node.introducedAt,
    touches: node.touches,
    removedAt: node.removedAt,
    children: Array.from(node.children.values())
      .map(toArray)
      .sort((a, b) => a.name.localeCompare(b.name)),
  });

  const fileClusterMap = new Map<string, string>();
  const commitSetByPath = buildCommitSetByPath(timeline);
  const root = collapseClusters(toArray(rawRoot), fileClusterMap, expandedPaths ?? new Set(), commitSetByPath);
  // The repo root isn't a thing git ever "deletes", even in the degenerate
  // case where every top-level path happens to be gone as of the final
  // commit — the cascade above would otherwise mark it removed too, and the
  // hub node must never disappear.
  root.removedAt = undefined;

  const clusterMembers = new Map<string, string[]>();
  for (const [filePath, clusterPath] of fileClusterMap) {
    const members = clusterMembers.get(clusterPath);
    if (members) members.push(filePath);
    else clusterMembers.set(clusterPath, [filePath]);
  }

  return { root, fileClusterMap, clusterMembers };
}
