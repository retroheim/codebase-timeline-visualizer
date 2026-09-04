// Pure pacing math for the playback loop, kept separate from app-root.ts so
// it's testable without faking requestAnimationFrame/performance.now.

/**
 * Commits per second at a given speed multiplier, matching the pacing of the
 * original setInterval implementation (a full playback always takes ~300
 * ticks at 1x, each tick firing every 500ms): `commitsPerTick` commits every
 * `500/speed` ms is `commitsPerTick * 1000/(500/speed)` = `commitsPerTick * 2
 * * speed` commits/sec.
 */
export function commitsPerTick(maxTime: number): number {
  return Math.max(1, Math.round(maxTime / 300));
}

export function ticksPerSecond(maxTime: number, speed: number): number {
  return commitsPerTick(maxTime) * 2 * speed;
}

export interface AdvanceResult {
  /** Leftover fractional commits, carried into the next frame. */
  carry: number;
  /** Whole commits to advance this frame (may be 0). */
  steps: number;
}

/**
 * How far to advance for one animation frame of elapsed time `dtSeconds` at
 * `rate` commits/sec, given fractional commits already banked from prior
 * frames (`carry`). Frame-rate independent: a dropped frame just banks a
 * bigger `dtSeconds`, not a bigger visual jump per call.
 */
export function advance(carry: number, dtSeconds: number, rate: number): AdvanceResult {
  const total = carry + dtSeconds * rate;
  const steps = Math.floor(total);
  return { carry: total - steps, steps };
}

/**
 * Elapsed time between animation frames, clamped so a tab backgrounded for a
 * while (rAF pauses; resuming can hand back a multi-second delta) doesn't
 * produce one huge catch-up jump in `advance()` — it just resumes smoothly
 * instead of leaping forward.
 */
export function clampFrameDelta(dtMs: number, maxMs = 250): number {
  return Math.max(0, Math.min(dtMs, maxMs)) / 1000;
}
