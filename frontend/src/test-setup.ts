// Test-only polyfills for browser APIs happy-dom doesn't (fully) implement.
// None of these need real behavior — components under test only need them to
// not throw; the pixel/geometry math they'd drive is either asserted loosely
// here or covered precisely by pure lib/ unit tests instead.

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// Canvas 2D: a Proxy that accepts any method call (no-op) and any property
// write (recorded, never read back for drawing) — cheaper than enumerating
// timeline-viz.ts's exact draw-call surface by hand and re-syncing it every
// time that surface changes.
function canvasContextStub(): CanvasRenderingContext2D {
  const store: Record<string, unknown> = {};
  return new Proxy(store, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  contextId: string,
  ...rest: unknown[]
): ReturnType<typeof originalGetContext> {
  if (contextId === '2d') return canvasContextStub();
  return originalGetContext.apply(this, [contextId, ...rest] as Parameters<typeof originalGetContext>);
} as typeof HTMLCanvasElement.prototype.getContext;

// d3.pointer() needs `svg.createSVGPoint().matrixTransform(ctm.inverse())`.
// happy-dom's `createSVGPoint` returns a point missing `matrixTransform`;
// override with an identity transform (ignores the matrix entirely) since
// tests only assert the resulting index falls in a plausible range, not an
// exact pixel-perfect mapping — real coordinate math is unit-tested in
// lib/growth.ts's tests.
interface StubPoint {
  x: number;
  y: number;
  matrixTransform(): StubPoint;
}
SVGSVGElement.prototype.createSVGPoint = function (): DOMPoint {
  const point: StubPoint = {
    x: 0,
    y: 0,
    matrixTransform() {
      return { x: point.x, y: point.y, matrixTransform: point.matrixTransform };
    },
  };
  return point as unknown as DOMPoint;
};
if (!SVGGraphicsElement.prototype.getScreenCTM) {
  SVGGraphicsElement.prototype.getScreenCTM = function (): DOMMatrix {
    return { inverse: () => ({}) } as unknown as DOMMatrix;
  };
}

// happy-dom has no layout engine, so every element's `getBoundingClientRect`
// is 0x0 by default — components that size themselves off it (timeline-viz)
// would otherwise lay out everything at zero radius. A fixed nonzero default
// gives them a plausible viewport; a test that cares about a specific size
// can still override per-element with `vi.spyOn`.
const rectDefaults: DOMRect = {
  width: 800,
  height: 600,
  top: 0,
  left: 0,
  right: 800,
  bottom: 600,
  x: 0,
  y: 0,
  toJSON() {
    return this;
  },
};
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return { ...rectDefaults };
};
