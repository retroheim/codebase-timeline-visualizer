// Treemap coloring: "same visual language" as the radial tree
// (tree-layout.ts's depth-based saturation/lightness stepping), not
// pixel-identical hues. The radial tree's hue comes from each node's own
// angular position in that specific layout — a property with no equivalent
// in a rectangular treemap — so this derives hue from a hash of the
// top-level directory name instead, kept as an independent, self-contained
// formula rather than refactoring tree-layout.ts's tuned, tested angle-based
// one to share it.

import { hslToRgb } from './geometry';

// Deliberately more saturated / less washed-out than a typical pastel data-
// viz palette — the rest of the app reads as glowing jewel-tones against
// near-black (the radial tree, the calendar's teal, the growth line's glow),
// and a treemap that instead defaults to soft pastels at shallow depth would
// read as a different, more generic instrument bolted onto the same page.
const SATURATION_BASE = 58;
const SATURATION_STEP = 3;
const SATURATION_MAX = 100;
const LIGHT_MAX = 68;
const LIGHT_STEP = 4;
const LIGHT_MIN = 22;

function hashHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash % 360;
}

/** Deterministic color for a top-level branch name, stepping
 *  saturation/lightness with depth the same way tree-layout.ts does, so a
 *  deeper node in either view reads as "further down the trunk". */
export function colorForBranch(branchName: string, depth: number): [number, number, number] {
  const hue = hashHue(branchName);
  const saturation = Math.min(SATURATION_MAX, SATURATION_BASE + depth * SATURATION_STEP);
  const lightness = Math.max(LIGHT_MIN, LIGHT_MAX - depth * LIGHT_STEP);
  return hslToRgb(hue, saturation, lightness);
}
