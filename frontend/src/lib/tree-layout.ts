// Everything needed to draw the radial tree, computed from the timeline and
// the viewport size alone. No DOM, no canvas, no d3 selections — this used to
// live inside the component's rebuildLayout(), tangled with SVG construction,
// which is why none of it could be tested.

import * as d3 from 'd3';
import { buildFileTree, TreeNode } from './file-tree';
import { cartesian, declutterRing, hslToRgb, radialArcPointsFlat, sizingFor, Sizing } from './geometry';
import type { CommitEvent } from '../types';

// Hue by depth-and-top-branch-index alone gave every sibling subtree at the
// same depth the identical color — two unrelated directories nested three
// levels down under different top-level branches were indistinguishable,
// reading as concentric "rings" rather than as separate branches. Base hue
// now comes off the node's own angular position: d3.tree() already
// partitions the full circle recursively, giving every subtree a disjoint
// angular wedge sized by its own extent, at every depth, not just the top
// level, so two sibling subtrees anywhere in the tree land on different hues
// for free. That alone isn't enough on its own though: a straight chain with
// no branching (a single child at every level) keeps the exact same angular
// position all the way down, since there are no siblings to spread apart —
// so a fixed per-depth hue step is layered on top, guaranteeing the next
// child down is always visibly different from its parent even along an
// unbranching path. Lightness and saturation step a fixed amount per level
// toward a floor/ceiling and hold there once reached, carrying the separate
// "further down the trunk" shading cue.
const BRANCH_SATURATION_BASE = 35;
const BRANCH_SATURATION_STEP = 3;
const BRANCH_SATURATION_MAX = 100;
const BRANCH_LIGHT_MAX = 86;
const BRANCH_LIGHT_STEP = 5;
const BRANCH_LIGHT_MIN = 26;
const BRANCH_HUE_STEP = 11;
// Saturation/lightness on their own only ever tracked depth, so every node
// at the same depth looked like the same "shade of the branch" — soft and
// samey. A second, depth-independent axis pushes some nodes toward neon
// (near-max saturation, punchier mid lightness) and others toward pastel
// (low saturation, bright light) regardless of how deep they sit, so both
// styles show up at every level instead of the whole tree reading as one
// uniform palette. Deterministic per node (derived from hueUnits, already
// unique per node — see below), not randomized, so a rebuild reproduces the
// same look.
const NEON_SATURATION_BOOST = 45;
const NEON_LIGHT_DROP = 28;
// Modulus for turning hueUnits into a 0..1 vibrancy value — arbitrary but
// prime and unrelated to HUE_RESOLUTION/BRANCH_HUE_STEP/SIBLING_HUE_SPREAD,
// so it doesn't just echo one of those and collapse back into a hue-only
// pattern.
const VIBRANCY_MODULUS = 71;
// Quantization granularity for the angle-derived hue: steps per degree.
// Fine enough that many siblings crammed into a narrow wedge still resolve
// to different colors instead of collapsing onto the same whole degree.
const HUE_RESOLUTION = 100;
// Direct siblings under one parent that share very little of the circle
// (e.g. a directory with 25 subdirectories, each getting a sliver of arc)
// can have angular positions so close together that, after HSL->RGB
// rounds to an integer 0-255 triplet, two adjacent siblings land on the
// identical pixel color even at fine hue quantization — the arc gap is
// real but too small to survive the final rounding step. A fixed spread
// keyed on each node's plain index among its siblings sidesteps that: it
// guarantees a minimum separation of SIBLING_HUE_SPREAD / siblingCount
// between any two siblings' hues, independent of how tightly the layout
// happened to pack their actual angular positions.
const SIBLING_HUE_SPREAD = 60;

export type PointNode = d3.HierarchyPointNode<TreeNode>;
export type PointLink = d3.HierarchyPointLink<TreeNode>;

export interface TreeLayout {
  root: PointNode;
  nodeByPath: Map<string, PointNode>;
  /** Sorted by first appearance; playback walks these with a cursor. */
  nodesByIntroduction: PointNode[];
  linksByIntroduction: PointLink[];
  /** `nodesByIntroduction[i].data.introducedAt`, hoisted for binary search. */
  nodeIntroductions: number[];
  linkIntroductions: number[];
  /**
   * Nodes that ever get a `removedAt`, sorted by it ascending — the removal
   * mirror of `nodesByIntroduction`/`nodeIntroductions`. Nodes that never get
   * removed aren't in here at all; walking this with a cursor the same way
   * playback walks the introduction arrays is what lets the "dissolve" pass
   * touch only the handful of nodes currently fading, not scan everything.
   */
  nodesByRemoval: PointNode[];
  removalTimes: number[];
  fileClusterMap: Map<string, string>;
  clusterMembers: Map<string, string[]>;
  /** How many top-level branches root() has. */
  branchCount: number;
  sizing: Sizing;
  fileRadiusScale: (touches: number) => number;
  dirRadiusScale: (touches: number) => number;
  /** How many commits the "just arrived" glow takes to fade. */
  glowWindow: number;
}

const MAX_GLOW_WINDOW = 24;

export function computeTreeLayout(
  timeline: CommitEvent[],
  width: number,
  height: number,
  expandedPaths?: ReadonlySet<string>
): TreeLayout | null {
  if (timeline.length === 0) return null;

  const { root: treeData, fileClusterMap, clusterMembers } = buildFileTree(timeline, expandedPaths);
  const hierarchy = d3.hierarchy<TreeNode>(treeData, (d) => d.children);
  const leafCount = hierarchy.leaves().length;
  const sizing = sizingFor(leafCount);

  // More content needs more room: scale radius with tree size instead of a
  // fixed radius that forces everything to overlap once a repo gets big.
  // Capped growth (sqrt, not linear) since screen space is finite no
  // matter how big the repo is — beyond a point we lean on the per-depth
  // equal-area rescale below plus zoom, not on an ever-bigger canvas.
  const baseRadius = Math.min(width, height) / 2 - 60;
  const radius = baseRadius + Math.sqrt(leafCount) * 6;
  const layout = d3
    .tree<TreeNode>()
    .size([2 * Math.PI, Math.max(radius, 100)])
    .separation((a, b) => {
      const siblingSpread = a.parent === b.parent ? a.parent!.children!.length : 1;
      const base = a.parent === b.parent ? 1 : 2;
      const clusterBoost = a.data.isCluster || b.data.isCluster ? 1.8 : 1;
      const fileBoost = (a.data.isFile || b.data.isFile ? 1.6 : 1) * clusterBoost;
      return (base * fileBoost * Math.max(1, Math.sqrt(siblingSpread) / 2)) / Math.max(1, a.depth);
    });

  const root = layout(hierarchy);

  // d3.tree() spaces depth linearly: every level gets an equal radial
  // band regardless of how many nodes live there. A repo where thousands
  // of files sit 3-4 levels deep then crams them onto one tight inner
  // ring, all overlapping, no matter how big `radius` is. Re-space rings
  // by cumulative node count instead, so dense levels get pushed out to
  // where the circumference (and therefore room) is actually bigger.
  //
  // Pure count-based spacing has its own failure mode though: a shallow
  // level with few nodes (e.g. a handful of top-level directories) gets
  // squeezed to a tiny fraction of the radius just because deep levels
  // dominate the total leaf count — even though it's the first branching
  // point and every one of those branches' links has to *start* there.
  // Near the pole, angular separation alone can't create real physical
  // separation (arc length -> 0 as radius -> 0), so that's exactly where
  // the visual becomes a dense knot no matter how well later rings are
  // spaced. Floor each depth at a minimum share of the radius (independent
  // of node count) so early branches get real room to fan out from.
  const allNodes = root.descendants();
  const maxDepth = d3.max(allNodes, (d) => d.depth) ?? 1;
  const countsAtDepth = new Array(maxDepth + 1).fill(0);
  allNodes.forEach((d) => (countsAtDepth[d.depth] += 1));
  const cumulative = new Array(maxDepth + 1).fill(0);
  countsAtDepth.reduce((acc, count, depth) => (cumulative[depth] = acc + count), 0);
  const total = allNodes.length;
  const radiusAtDepth = cumulative.map((c, depth) => {
    const countBased = Math.sqrt(c / total);
    const depthFloor = 0.5 * Math.sqrt(depth / maxDepth);
    return radius * Math.max(countBased, depthFloor);
  });
  allNodes.forEach((d) => {
    d.y = d.depth === 0 ? 0 : radiusAtDepth[d.depth];
  });

  // Weight nodes by activity: how often they were actually touched, so
  // hot spots stand out and rarely-touched files/dirs shrink out of the
  // way instead of adding uniform clutter.
  const fileTouchesMax = d3.max(allNodes, (d) => (d.data.isFile ? d.data.touches : 0)) ?? 1;
  const dirTouchesMax = d3.max(allNodes, (d) => (d.data.isFile ? 0 : d.data.touches)) ?? 1;
  const fileScale = d3
    .scaleSqrt()
    .domain([1, Math.max(1, fileTouchesMax)])
    .range([sizing.file * 0.5, sizing.file * 2.8])
    .clamp(true);
  const dirScale = d3
    .scaleSqrt()
    .domain([1, Math.max(1, dirTouchesMax)])
    .range([sizing.dir * 0.65, sizing.dir * 2.2])
    .clamp(true);

  // Separation() only shapes angle *relative to siblings* — it doesn't
  // guarantee an actual minimum pixel gap between any two nodes sharing a
  // ring, including across different branches. Enforce that directly:
  // walk each ring in angular order and push nodes apart until every pair
  // clears a real minimum distance, given how big they'll actually render.
  const minGapPx = (sizing.dir + sizing.file) * 2.2;
  const nodesByDepth: PointNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  allNodes.forEach((d) => nodesByDepth[d.depth].push(d));
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    declutterRing(nodesByDepth[depth], radiusAtDepth[depth], minGapPx);
  }

  const nodeByPath = new Map<string, PointNode>();
  allNodes.forEach((n) => nodeByPath.set(n.data.path, n));

  const nodesByIntroduction = [...allNodes].sort(
    (a, b) => a.data.introducedAt - b.data.introducedAt
  );
  const linksByIntroduction = root
    .links()
    .sort((a, b) => a.target.data.introducedAt - b.target.data.introducedAt);

  const nodesByRemoval = allNodes
    .filter((n) => n.data.removedAt !== undefined)
    .sort((a, b) => a.data.removedAt! - b.data.removedAt!);

  // Exposed as metadata only now — hue no longer derives from this directly,
  // it comes off each node's own angular position (see below).
  const branchCount = Math.max(1, (root.children ?? []).length);

  // Cache cartesian position, draw radius, arc points, and branch color
  // directly on each node's `.data` — once, here, at layout time. Position,
  // radius, and color in tree-space are fixed until the next rebuild; only
  // the canvas' zoom/pan transform changes per frame, and that's applied
  // once globally via ctx.scale/ctx.translate, not per point. Without this,
  // the draw loop recomputed sin/cos and allocated a fresh [x, y] tuple for
  // every node and a fresh 6-point array for every link on every single
  // animation frame — the dominant cost during playback and zoom on any repo
  // with more than a few hundred visible nodes.
  //
  // `allNodes` (root.descendants()) is topologically ordered — every node's
  // parent appears earlier in the array — so branch/depth-in-branch can be
  // read off the already-processed parent in one forward pass instead of
  // walking up to the root for every single node.
  const depthInBranchByNode = new Map<PointNode, number>();
  allNodes.forEach((n) => {
    const [x, y] = cartesian(n);
    n.data.layoutX = x;
    n.data.layoutY = y;
    n.data.layoutRadius = n.data.isFile ? fileScale(n.data.touches) : dirScale(n.data.touches);
    if (n.parent) {
      n.data.arcPoints = radialArcPointsFlat(n.parent, n);
    } else {
      return; // root: no branch, no color — drawn as its own fixed hub marker.
    }

    const depthInBranch =
      n.depth === 1 ? 0 : (depthInBranchByNode.get(n.parent!) ?? 0) + 1;
    depthInBranchByNode.set(n, depthInBranch);

    // Quantized to a fine grid (0.01°, 36000 steps around the circle) rather
    // than a whole degree — whole-degree rounding collapsed direct siblings
    // crowded into a narrow angular wedge (a directory with many
    // subdirectories, all competing for a small slice of arc) onto the exact
    // same integer degree, making them indistinguishable from each other
    // even though the layout had already placed them at different angles.
    // The batching pass below relies on every node sharing a bucket having
    // the identical color, so this stays a rounded integer either way —
    // it's just a finer one.
    const siblings = n.parent!.children ?? [n];
    const siblingIndex = siblings.indexOf(n);
    const siblingHue = (siblingIndex / siblings.length) * SIBLING_HUE_SPREAD;
    const hueUnits = Math.round(
      ((n.x / (2 * Math.PI)) * 360 + depthInBranch * BRANCH_HUE_STEP + siblingHue) * HUE_RESOLUTION
    );
    const vibrancy = (hueUnits % VIBRANCY_MODULUS) / VIBRANCY_MODULUS;
    const lightness = Math.max(
      BRANCH_LIGHT_MIN,
      BRANCH_LIGHT_MAX - depthInBranch * BRANCH_LIGHT_STEP - vibrancy * NEON_LIGHT_DROP
    );
    const saturation = Math.min(
      BRANCH_SATURATION_MAX,
      BRANCH_SATURATION_BASE + depthInBranch * BRANCH_SATURATION_STEP + vibrancy * NEON_SATURATION_BOOST
    );
    n.data.colorRgb = hslToRgb(hueUnits / HUE_RESOLUTION, saturation, lightness);
    n.data.branchDepth = depthInBranch;
    // Opaque grouping key: every node sharing (hueUnits, depthInBranch) has
    // the identical color, so this doubles as the batching bucket. 1e6
    // comfortably exceeds any realistic hueUnits*depth combination, so hue
    // buckets never collide with each other's depth range.
    n.data.branchBucket = hueUnits * 1_000_000 + depthInBranch;
  });

  return {
    root,
    nodeByPath,
    nodesByIntroduction,
    linksByIntroduction,
    nodeIntroductions: nodesByIntroduction.map((n) => n.data.introducedAt),
    linkIntroductions: linksByIntroduction.map((l) => l.target.data.introducedAt),
    nodesByRemoval,
    removalTimes: nodesByRemoval.map((n) => n.data.removedAt!),
    fileClusterMap,
    clusterMembers,
    branchCount,
    sizing,
    fileRadiusScale: (touches: number) => fileScale(touches),
    dirRadiusScale: (touches: number) => dirScale(touches),
    // Scaled down for small repos so the "just arrived" glow actually fades
    // instead of staying lit for the whole playback when total commits is
    // smaller than the window itself.
    glowWindow: Math.max(3, Math.min(MAX_GLOW_WINDOW, Math.round(timeline.length * 0.15))),
  };
}
