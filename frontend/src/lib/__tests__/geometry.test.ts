import { describe, expect, it } from 'vitest';
import {
  arcInterpolator,
  cartesian,
  declutterRing,
  hslToRgb,
  lerp,
  polarToCartesian,
  radialArcPoints,
  radialArcPointsFlat,
  reservoirSample,
  revealCount,
  sizingFor,
} from '../geometry';

describe('lerp', () => {
  it('hits both endpoints exactly', () => {
    expect(lerp(10, 20, 0)).toBe(10);
    expect(lerp(10, 20, 1)).toBe(20);
    expect(lerp(10, 20, 0.5)).toBe(15);
  });
});

describe('polarToCartesian', () => {
  it('puts angle 0 at 12 o\'clock', () => {
    const [x, y] = polarToCartesian(0, 100);
    expect(x).toBeCloseTo(0);
    expect(y).toBeCloseTo(-100);
  });

  it('puts a quarter turn at 3 o\'clock', () => {
    const [x, y] = polarToCartesian(Math.PI / 2, 100);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
  });

  it('collapses to the origin at radius 0', () => {
    expect(polarToCartesian(1.234, 0).map(Math.abs)).toEqual([0, 0]);
  });
});

describe('cartesian', () => {
  it('projects a node using its angle and radius', () => {
    expect(cartesian({ x: Math.PI, y: 50 })[1]).toBeCloseTo(50);
  });
});

describe('radialArcPoints', () => {
  it('starts at the source and ends at the target', () => {
    const source = { x: 0, y: 10 };
    const target = { x: Math.PI / 2, y: 100 };
    const pts = radialArcPoints(source, target);

    expect(pts[0][0]).toBeCloseTo(cartesian(source)[0]);
    expect(pts[0][1]).toBeCloseTo(cartesian(source)[1]);
    expect(pts[pts.length - 1][0]).toBeCloseTo(cartesian(target)[0]);
    expect(pts[pts.length - 1][1]).toBeCloseTo(cartesian(target)[1]);
  });

  it('bows away from the straight chord, which is the whole point', () => {
    // Same radius, quarter turn apart: a straight segment would pass inside the
    // ring, the polar interpolation must stay on it.
    const pts = radialArcPoints({ x: 0, y: 100 }, { x: Math.PI / 2, y: 100 });
    const mid = pts[Math.floor(pts.length / 2)];
    expect(Math.hypot(mid[0], mid[1])).toBeCloseTo(100);
  });
});

describe('radialArcPointsFlat', () => {
  it('matches radialArcPoints, just flattened', () => {
    const source = { x: 0, y: 10 };
    const target = { x: Math.PI / 2, y: 100 };
    const nested = radialArcPoints(source, target);
    const flat = radialArcPointsFlat(source, target);

    expect(flat.length).toBe(nested.length * 2);
    nested.forEach(([x, y], i) => {
      expect(flat[i * 2]).toBeCloseTo(x);
      expect(flat[i * 2 + 1]).toBeCloseTo(y);
    });
  });
});

describe('reservoirSample', () => {
  it('returns every element, unmodified original, when k >= length', () => {
    const arr = [1, 2, 3];
    const sample = reservoirSample(arr, 5);
    expect([...sample].sort()).toEqual([1, 2, 3]);
    expect(sample).not.toBe(arr);
  });

  it('returns exactly k elements, all drawn from the input', () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    const sample = reservoirSample(arr, 8);
    expect(sample).toHaveLength(8);
    expect(new Set(sample).size).toBe(8);
    sample.forEach((v) => expect(arr).toContain(v));
  });

  it('does not mutate the input array', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const copy = [...arr];
    reservoirSample(arr, 5);
    expect(arr).toEqual(copy);
  });

  it('samples every element with roughly equal probability', () => {
    // Classic reservoir-sampling correctness check: over many trials each
    // element should appear in the sample about k/n of the time. A biased
    // implementation (e.g. always keeping the first k) would fail this hard.
    const n = 20;
    const k = 5;
    const arr = Array.from({ length: n }, (_, i) => i);
    const counts = new Array(n).fill(0);
    const trials = 4000;

    for (let t = 0; t < trials; t += 1) {
      for (const v of reservoirSample(arr, k)) counts[v] += 1;
    }

    const expected = trials * (k / n);
    for (const count of counts) {
      expect(count).toBeGreaterThan(expected * 0.7);
      expect(count).toBeLessThan(expected * 1.3);
    }
  });

  it('handles k=0', () => {
    expect(reservoirSample([1, 2, 3], 0)).toEqual([]);
  });
});

describe('hslToRgb', () => {
  it('matches known reference colors', () => {
    expect(hslToRgb(0, 100, 50)).toEqual([255, 0, 0]); // red
    expect(hslToRgb(120, 100, 50)).toEqual([0, 255, 0]); // green
    expect(hslToRgb(240, 100, 50)).toEqual([0, 0, 255]); // blue
    expect(hslToRgb(0, 0, 100)).toEqual([255, 255, 255]); // white
    expect(hslToRgb(0, 0, 0)).toEqual([0, 0, 0]); // black
    expect(hslToRgb(0, 0, 50)).toEqual([128, 128, 128]); // mid gray, any hue
  });

  it('wraps hue outside [0, 360) the same as within it', () => {
    expect(hslToRgb(360, 100, 50)).toEqual(hslToRgb(0, 100, 50));
    expect(hslToRgb(-120, 100, 50)).toEqual(hslToRgb(240, 100, 50));
    expect(hslToRgb(480, 100, 50)).toEqual(hslToRgb(120, 100, 50));
  });

  it('produces distinct colors for evenly-spaced hues, the branch-coloring use case', () => {
    const hues = [0, 90, 180, 270];
    const colors = hues.map((h) => hslToRgb(h, 62, 60));
    const keys = colors.map((c) => c.join(','));
    expect(new Set(keys).size).toBe(4);
  });
});

describe('declutterRing', () => {
  it('pushes nodes apart until every pair clears the minimum gap', () => {
    const radius = 100;
    const minGapPx = 10;
    const nodes = [{ x: 0, y: radius }, { x: 0.01, y: radius }, { x: 0.02, y: radius }];

    declutterRing(nodes, radius, minGapPx);

    const sorted = [...nodes].sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i].x - sorted[i - 1].x).toBeGreaterThanOrEqual(minGapPx / radius - 1e-9);
    }
  });

  it('leaves the radius alone so link arcs stay valid', () => {
    const nodes = [{ x: 0, y: 100 }, { x: 0.001, y: 100 }];
    declutterRing(nodes, 100, 20);
    expect(nodes.every((n) => n.y === 100)).toBe(true);
  });

  it('compresses back inside one turn rather than spiralling', () => {
    const radius = 10;
    // 40 nodes needing a 20px gap at radius 10 would span far past 2π.
    const nodes = Array.from({ length: 40 }, () => ({ x: 0, y: radius }));
    declutterRing(nodes, radius, 20);

    const xs = nodes.map((n) => n.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThanOrEqual(2 * Math.PI);
  });

  it('is a no-op below two nodes or at the pole', () => {
    const single = [{ x: 1, y: 5 }];
    declutterRing(single, 5, 10);
    expect(single[0].x).toBe(1);

    const atPole = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    declutterRing(atPole, 0, 10);
    expect(atPole.map((n) => n.x)).toEqual([0, 0]);
  });
});

describe('arcInterpolator', () => {
  it('starts at `from` and ends at `to` regardless of the bow', () => {
    const from: [number, number] = [0, 0];
    const to: [number, number] = [100, 40];
    for (const bow of [-0.5, 0, 0.5]) {
      const interpolate = arcInterpolator(from, to, bow);
      expect(interpolate(0)[0]).toBeCloseTo(from[0]);
      expect(interpolate(0)[1]).toBeCloseTo(from[1]);
      expect(interpolate(1)[0]).toBeCloseTo(to[0]);
      expect(interpolate(1)[1]).toBeCloseTo(to[1]);
    }
  });

  it('leaves the straight line when bowed', () => {
    const straight = arcInterpolator([0, 0], [100, 0], 0)(0.5);
    const bowed = arcInterpolator([0, 0], [100, 0], 0.5)(0.5);
    expect(bowed[1]).not.toBeCloseTo(straight[1]);
  });

  it('survives a zero-length move without dividing by zero', () => {
    const interpolate = arcInterpolator([5, 5], [5, 5], 0.5);
    expect(Number.isFinite(interpolate(0.5)[0])).toBe(true);
  });
});

describe('sizingFor', () => {
  it('shrinks nodes and raises the zoom threshold as the tree grows', () => {
    const small = sizingFor(10);
    const huge = sizingFor(10000);
    expect(huge.file).toBeLessThan(small.file);
    expect(huge.fileZoomThreshold).toBeGreaterThan(small.fileZoomThreshold);
  });

  it('shows files at any zoom for a small repo', () => {
    expect(sizingFor(10).fileZoomThreshold).toBe(0);
  });

  it('steps through every size tier, each smaller than the last', () => {
    const tiers = [sizingFor(100), sizingFor(500), sizingFor(2000), sizingFor(7000)];
    for (let i = 1; i < tiers.length; i += 1) {
      expect(tiers[i].file).toBeLessThanOrEqual(tiers[i - 1].file);
      expect(tiers[i].fileZoomThreshold).toBeGreaterThanOrEqual(tiers[i - 1].fileZoomThreshold);
    }
  });
});

describe('revealCount', () => {
  const introductions = [0, 0, 1, 3, 3, 3, 7];

  it('counts everything introduced at or before the given time', () => {
    expect(revealCount(introductions, -1)).toBe(0);
    expect(revealCount(introductions, 0)).toBe(2);
    expect(revealCount(introductions, 2)).toBe(3);
    expect(revealCount(introductions, 3)).toBe(6);
    expect(revealCount(introductions, 100)).toBe(introductions.length);
  });

  it('is empty for an empty timeline', () => {
    expect(revealCount([], 5)).toBe(0);
  });

  /**
   * Scrubbing backwards jumps via this binary search while playing forwards
   * advances a cursor. If the two ever disagree, a rewind lands on a different
   * set of nodes than playing to the same instant would.
   */
  it('agrees with a forward linear scan at every instant', () => {
    for (let time = -1; time <= 8; time += 1) {
      const linear = introductions.filter((t) => t <= time).length;
      expect(revealCount(introductions, time)).toBe(linear);
    }
  });
});
