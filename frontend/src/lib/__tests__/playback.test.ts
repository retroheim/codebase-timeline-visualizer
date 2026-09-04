import { describe, expect, it } from 'vitest';
import { advance, clampFrameDelta, commitsPerTick, ticksPerSecond } from '../playback';

describe('commitsPerTick', () => {
  it('is never less than 1 even for a tiny timeline', () => {
    expect(commitsPerTick(1)).toBe(1);
    expect(commitsPerTick(0)).toBe(1);
  });

  it('scales with timeline length', () => {
    expect(commitsPerTick(3000)).toBe(10);
  });
});

describe('ticksPerSecond', () => {
  it('matches the original setInterval pacing: commitsPerTick every 500ms/speed', () => {
    const maxTime = 3000;
    const speed = 1;
    // Original: commitsPerTick(3000)=10 commits every 500ms -> 20 commits/sec.
    expect(ticksPerSecond(maxTime, speed)).toBeCloseTo(20);
  });

  it('scales linearly with speed', () => {
    const maxTime = 3000;
    expect(ticksPerSecond(maxTime, 2)).toBeCloseTo(ticksPerSecond(maxTime, 1) * 2);
    expect(ticksPerSecond(maxTime, 0.5)).toBeCloseTo(ticksPerSecond(maxTime, 1) * 0.5);
  });
});

describe('advance', () => {
  it('banks fractional progress across calls instead of dropping it', () => {
    // 0.4 commits/frame: no whole step for two frames, then one.
    let carry = 0;
    let steps = 0;
    ({ carry, steps } = advance(carry, 1, 0.4));
    expect(steps).toBe(0);
    ({ carry, steps } = advance(carry, 1, 0.4));
    expect(steps).toBe(0);
    ({ carry, steps } = advance(carry, 1, 0.4));
    expect(steps).toBe(1);
    expect(carry).toBeCloseTo(0.2);
  });

  it('is frame-rate independent: total steps over an interval match regardless of how it is chopped into frames', () => {
    const rate = 37; // commits/sec, arbitrary
    const totalSeconds = 5;

    let carryFine = 0;
    let stepsFine = 0;
    for (let i = 0; i < totalSeconds / (1 / 240); i += 1) {
      const r = advance(carryFine, 1 / 240, rate);
      carryFine = r.carry;
      stepsFine += r.steps;
    }

    let carryCoarse = 0;
    let stepsCoarse = 0;
    for (let i = 0; i < totalSeconds / (1 / 24); i += 1) {
      const r = advance(carryCoarse, 1 / 24, rate);
      carryCoarse = r.carry;
      stepsCoarse += r.steps;
    }

    expect(Math.abs(stepsFine - stepsCoarse)).toBeLessThanOrEqual(1);
  });

  it('handles zero elapsed time without advancing', () => {
    const { steps, carry } = advance(0.9, 0, 100);
    expect(steps).toBe(0);
    expect(carry).toBeCloseTo(0.9);
  });
});

describe('clampFrameDelta', () => {
  it('passes small deltas through unchanged (converted to seconds)', () => {
    expect(clampFrameDelta(16)).toBeCloseTo(0.016);
  });

  it('caps a large delta (tab was backgrounded) instead of letting it produce a huge jump', () => {
    expect(clampFrameDelta(30000)).toBeCloseTo(0.25);
  });

  it('never returns negative for a clock going backwards', () => {
    expect(clampFrameDelta(-50)).toBe(0);
  });
});
