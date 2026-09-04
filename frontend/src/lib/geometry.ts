// Pure geometry for the radial layout. Everything here is a function of its
// arguments — no DOM, no d3 selections, no component state — so it can be unit
// tested without a browser. Anything that needs a canvas or an SVG node belongs
// in the component, not here.

/** Minimal shape of a laid-out node: `x` is an angle in radians, `y` a radius. */
export interface PolarPoint {
  x: number;
  y: number;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * d3's radial convention puts angle 0 at 12 o'clock, so the quarter turn is
 * baked in here rather than at each call site.
 */
export function polarToCartesian(angle: number, radius: number): [number, number] {
  const a = angle - Math.PI / 2;
  return [radius * Math.cos(a), radius * Math.sin(a)];
}

export function cartesian(node: PolarPoint): [number, number] {
  return polarToCartesian(node.x, node.y);
}

// A radial tree link isn't a straight cartesian segment between the two
// points — interpolating angle/radius linearly *before* projecting to x/y
// is what gives radial dendrograms their characteristic gentle arc. Sample
// a handful of points along that polar interpolation for a smooth curve;
// cheap since it's just more geometry within the same batched canvas path,
// not more draw calls.
export const ARC_STEPS = 5;

export function radialArcPoints(source: PolarPoint, target: PolarPoint): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= ARC_STEPS; i += 1) {
    const t = i / ARC_STEPS;
    pts.push(polarToCartesian(lerp(source.x, target.x, t), lerp(source.y, target.y, t)));
  }
  return pts;
}

/**
 * Same curve as `radialArcPoints`, flattened into one typed array
 * (`[x0, y0, x1, y1, ...]`) instead of an array of tuples. Meant to be called
 * once per link at layout time and cached — a typed array is what lets the
 * per-frame draw loop read coordinates with zero allocation.
 */
export function radialArcPointsFlat(source: PolarPoint, target: PolarPoint): Float64Array {
  const out = new Float64Array((ARC_STEPS + 1) * 2);
  for (let i = 0; i <= ARC_STEPS; i += 1) {
    const t = i / ARC_STEPS;
    const [x, y] = polarToCartesian(lerp(source.x, target.x, t), lerp(source.y, target.y, t));
    out[i * 2] = x;
    out[i * 2 + 1] = y;
  }
  return out;
}

// Push nodes sharing a ring apart, in angular order, until every adjacent
// pair clears a real minimum pixel gap at that ring's radius. Mutates node.x
// (angle) in place — leaves node.y alone so the polar-interpolated link arcs
// stay valid.
export function declutterRing<T extends PolarPoint>(
  nodes: T[],
  radius: number,
  minGapPx: number
): void {
  if (nodes.length < 2 || radius <= 0) return;
  const minGapRad = minGapPx / radius;
  const sorted = [...nodes].sort((a, b) => a.x - b.x);

  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.x - prev.x < minGapRad) cur.x = prev.x + minGapRad;
  }

  // If the ring got pushed past a full turn, compress it back to fit —
  // preserves relative order and reasonably even spacing rather than
  // letting it spiral past 2π.
  const span = sorted[sorted.length - 1].x - sorted[0].x;
  const available = 2 * Math.PI - minGapRad;
  if (span > available && span > 0) {
    const base = sorted[0].x;
    const scale = available / span;
    sorted.forEach((n) => (n.x = base + (n.x - base) * scale));
  }
}

/**
 * Quadratic bezier through an offset control point, so motion arcs instead of
 * tracing the same straight line every time. `bowFactor` in [-0.5, 0.5] is
 * normally random; it is a parameter so tests can pin the curve.
 */
export function arcInterpolator(
  from: [number, number],
  to: [number, number],
  bowFactor: number = Math.random() - 0.5
): (t: number) => [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dist = Math.hypot(dx, dy) || 1;
  const bow = bowFactor * Math.min(dist * 0.6, 80);
  const midX = (from[0] + to[0]) / 2 - (dy / dist) * bow;
  const midY = (from[1] + to[1]) / 2 + (dx / dist) * bow;

  return (t: number) => [
    lerp(lerp(from[0], midX, t), lerp(midX, to[0], t), t),
    lerp(lerp(from[1], midY, t), lerp(midY, to[1], t), t),
  ];
}

export interface Sizing {
  file: number;
  dir: number;
  stroke: number;
  linkAlpha: number;
  fileAlpha: number;
  dirAlpha: number;
  fileZoomThreshold: number;
}

// Node/point sizing backs off as the tree grows. `fileZoomThreshold` is the
// bigger lever though: cramming thousands of leaves onto one ring overlaps
// into a solid wash no matter how small or translucent they are, so past a
// size threshold files simply don't render until the user zooms in enough
// to give them room — semantic zoom instead of fighting geometry with alpha.
export function sizingFor(leafCount: number): Sizing {
  if (leafCount > 6000)
    return { file: 1.4, dir: 1.8, stroke: 0.6, linkAlpha: 0.22, fileAlpha: 0.6, dirAlpha: 0.75, fileZoomThreshold: 2.4 };
  if (leafCount > 1500)
    return { file: 1.8, dir: 2.4, stroke: 0.7, linkAlpha: 0.26, fileAlpha: 0.6, dirAlpha: 0.78, fileZoomThreshold: 1.5 };
  if (leafCount > 300)
    return { file: 2.2, dir: 3, stroke: 0.85, linkAlpha: 0.3, fileAlpha: 0.6, dirAlpha: 0.8, fileZoomThreshold: 1 };
  return { file: 2.5, dir: 3.5, stroke: 1, linkAlpha: 0.35, fileAlpha: 0.6, dirAlpha: 0.85, fileZoomThreshold: 0 };
}

/**
 * Pick `k` distinct elements from `arr` without replacement, in O(n) with no
 * intermediate array. `arr.sort(() => Math.random() - 0.5)` — the pattern this
 * replaces — is both O(n log n) and a well-known biased shuffle (Fisher-Yates
 * it is not: comparator-based sorts don't guarantee a uniform permutation).
 * Order of the untouched prefix of `arr` up to `k` seeds the reservoir; order
 * of the result is otherwise unspecified — callers that care about output
 * order (e.g. re-sorting sparks by timestamp) should sort the result.
 */
export function reservoirSample<T>(arr: readonly T[], k: number): T[] {
  if (arr.length <= k) return arr.slice();
  const result = arr.slice(0, k);
  for (let i = k; i < arr.length; i += 1) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < k) result[j] = arr[i];
  }
  return result;
}

/**
 * Standard HSL -> RGB conversion. `h` in degrees (any range, wrapped mod
 * 360), `s`/`l` as percentages [0, 100]. Used once per node at layout time to
 * precompute each node's branch color — never called per frame, so clarity
 * over the reference algorithm beats micro-optimizing it.
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = ((h % 360) + 360) % 360;
  const sat = s / 100;
  const light = l / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;

  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Index of the first element whose `introducedAt` exceeds `time`, i.e. how many
 * items are revealed at that time. The forward playback path advances a cursor
 * instead of calling this; scrubbing backwards jumps straight here. The two
 * must agree exactly or a rewind lands on a different set of nodes than
 * playing forward to the same instant would.
 */
export function revealCount(introducedAt: number[], time: number): number {
  let lo = 0;
  let hi = introducedAt.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (introducedAt[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
