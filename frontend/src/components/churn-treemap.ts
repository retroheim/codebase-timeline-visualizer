import { LitElement, html, css, svg } from 'lit';
import { computeTreemapLayout, pickVisibleNodes, type ChurnMetric } from '../lib/treemap-layout';
import { colorForBranch } from '../lib/branch-color';
import { fileStatsAsOf, timelineUpTo } from '../lib/as-of';
import './scope-toggle';
import type { TimeScope } from './scope-toggle';
import type { TreeNode } from '../lib/file-tree';
import type { TimelineData } from '../types';
import * as d3 from 'd3';

// Below this rendered area (px²), a rect stops being a legible unit of its
// own — a repo with thousands of files laid into a normal-sized viewport
// would otherwise produce rects smaller than a pixel. `pickVisibleNodes`
// climbs back up to the nearest ancestor directory that's still legible.
const MIN_VISIBLE_AREA = 340;

const METRICS: { key: ChurnMetric; label: string }[] = [
  { key: 'churn', label: 'Total churn' },
  { key: 'edits', label: 'Edit count' },
  { key: 'linesAdded', label: 'Lines added' },
  { key: 'linesRemoved', label: 'Lines removed' },
];

export class ChurnTreemap extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
    metric: { state: true },
    scope: { state: true },
    width: { state: true },
    height: { state: true },
  };

  declare data: TimelineData | null;
  declare currentTime: number;
  declare metric: ChurnMetric;
  declare scope: TimeScope;
  declare width: number;
  declare height: number;

  private resizeObserver?: ResizeObserver;

  // `currentTime` advances fractionally every animation frame during
  // playback (see app-root's rAF loop), but `timelineUpTo` only cares about
  // its floored value — rebuilding the full file-stats map and re-running
  // the d3 treemap layout on every sub-integer tick would be pure waste.
  // Cache on everything the layout actually depends on and only redo the
  // work when one of those inputs has genuinely changed.
  private lastLayoutInputs: {
    scope: TimeScope;
    flooredTime: number;
    metric: ChurnMetric;
    width: number;
    height: number;
    data: TimelineData | null;
  } | null = null;
  private cachedLayout: ReturnType<typeof computeTreemapLayout> = null;

  constructor() {
    super();
    this.metric = 'churn';
    this.scope = 'all-time';
    this.width = 960;
    this.height = 520;
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      width: 100%;
      height: 100%;
      padding: 72px 28px 24px;
      box-sizing: border-box;
      gap: 12px;
    }
    .controls {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }
    .controls .spacer {
      flex: 1;
    }
    select {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      letter-spacing: 0.02em;
      text-transform: none;
      background: var(--panel, #0d1424);
      color: var(--paper, #e7edf5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 5px 8px;
      cursor: pointer;
    }
    select:focus-visible {
      outline: 2px solid var(--flare, #ff8a5c);
      outline-offset: 1px;
    }
    .canvas {
      flex: 1;
      min-height: 0;
    }
    svg {
      display: block;
      width: 100%;
      height: 100%;
    }
    g.cell {
      cursor: default;
    }
    rect.leaf {
      stroke: rgba(6, 8, 16, 0.7);
      stroke-width: 1.5;
      transition: filter 0.12s ease, stroke 0.12s ease;
    }
    g.cell:hover rect.leaf {
      filter: brightness(1.35);
      stroke: rgba(231, 237, 245, 0.55);
    }
    rect.dir-marker {
      fill: none;
      stroke: rgba(6, 8, 16, 0.85);
      stroke-width: 1;
      stroke-dasharray: 3 2;
      pointer-events: none;
    }
    /* White + a dark shadow reads on both the light and dark ends of the
       brightened branch palette, instead of a fixed dark label color that
       would vanish against a deep-lightness cell. */
    text.label {
      fill: #fdfefe;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      font-family: var(--font-mono, monospace);
      font-weight: 600;
      font-size: 10px;
      pointer-events: none;
    }
    text.count {
      fill: rgba(253, 254, 254, 0.8);
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.85);
      font-family: var(--font-mono, monospace);
      font-size: 9px;
      pointer-events: none;
    }
    .empty {
      color: var(--mist, #55617a);
      padding: 40px;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this.resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        this.width = rect.width;
        this.height = rect.height;
      }
    });
  }

  firstUpdated(): void {
    const canvas = this.shadowRoot?.querySelector('.canvas');
    if (canvas) this.resizeObserver?.observe(canvas);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.resizeObserver?.disconnect();
  }

  private topLevelBranch(path: string): string {
    return path.split('/')[0] || path;
  }

  private handleMetricChange = (event: Event): void => {
    this.metric = (event.target as HTMLSelectElement).value as ChurnMetric;
  };

  private handleScopeChange = (event: CustomEvent<{ scope: TimeScope }>): void => {
    this.scope = event.detail.scope;
  };

  private computeLayout(): ReturnType<typeof computeTreemapLayout> {
    const inputs = {
      scope: this.scope,
      flooredTime: Math.floor(this.currentTime),
      metric: this.metric,
      width: this.width,
      height: this.height,
      data: this.data,
    };
    const last = this.lastLayoutInputs;
    if (
      last &&
      last.scope === inputs.scope &&
      last.flooredTime === inputs.flooredTime &&
      last.metric === inputs.metric &&
      last.width === inputs.width &&
      last.height === inputs.height &&
      last.data === inputs.data
    ) {
      return this.cachedLayout;
    }

    const timeline = this.scope === 'as-of' ? timelineUpTo(this.data!.timeline, this.currentTime) : this.data!.timeline;
    const files = this.scope === 'as-of' ? fileStatsAsOf(timeline) : this.data!.files;
    const layout = computeTreemapLayout(timeline, files, this.width, this.height, this.metric);
    this.lastLayoutInputs = inputs;
    this.cachedLayout = layout;
    return layout;
  }

  render() {
    if (!this.data || this.data.timeline.length === 0) {
      return html`<div class="empty">No commits to show.</div>`;
    }

    const layout = this.computeLayout();
    if (!layout) {
      return html`<div class="empty">Nothing to show.</div>`;
    }

    const cells = pickVisibleNodes(layout.root, MIN_VISIBLE_AREA);

    return html`
      <div class="controls">
        <label>
          Size by
          <select .value=${this.metric} @change=${this.handleMetricChange}>
            ${METRICS.map((m) => html`<option value=${m.key}>${m.label}</option>`)}
          </select>
        </label>
        <span class="spacer"></span>
        <scope-toggle .scope=${this.scope} @scope-change=${this.handleScopeChange}></scope-toggle>
      </div>
      <div class="canvas">
        <svg viewBox="0 0 ${this.width} ${this.height}" role="img" aria-label="File churn treemap">
          ${cells.map((cell) => this.renderCell(cell))}
        </svg>
      </div>
    `;
  }

  private renderCell(node: d3.HierarchyRectangularNode<TreeNode>) {
    const width = node.x1 - node.x0;
    const height = node.y1 - node.y0;
    const branch = this.topLevelBranch(node.data.path || node.data.name);
    const [r, g, b] = colorForBranch(branch, node.depth);
    const value = Math.round(node.value ?? 0);
    const isAggregatedDir = Boolean(node.children && node.children.length > 0);
    const fileCount = isAggregatedDir ? node.leaves().length : node.data.isCluster ? node.data.clusterSize ?? 1 : 1;
    const label = node.data.name || '(root)';

    // `svg` (not `html`) — this whole cell is a standalone template
    // instantiated from a `${}` binding in render(), not static markup in
    // the outer template. Without it, lit parses "<g>...</g>" with no
    // enclosing `<svg>` in that same parse, so the browser never enters
    // foreign-content/SVG mode: every element here would come out as an
    // inert HTMLUnknownElement — attributes and even CSS `fill` resolve
    // fine, but nothing has paintable geometry and nothing appears on
    // screen. See the identical note in calendar-heatmap.ts.
    return svg`
      <g class="cell" transform="translate(${node.x0}, ${node.y0})">
        <rect class="leaf" width=${width} height=${height} rx="2" style="fill: rgb(${r}, ${g}, ${b})">
          <title>${label} — ${fileCount} file${fileCount === 1 ? '' : 's'} — ${value.toLocaleString()}</title>
        </rect>
        ${isAggregatedDir && width > 18 && height > 18
          ? svg`<rect class="dir-marker" x="3" y="3" width=${Math.max(0, width - 6)} height=${Math.max(0, height - 6)} rx="1"></rect>`
          : null}
        ${width > 42 && height > 18 ? svg`<text class="label" x="6" y="15">${truncate(label, width)}</text>` : null}
        ${isAggregatedDir && width > 42 && height > 32
          ? svg`<text class="count" x="6" y="28">${fileCount} files</text>`
          : null}
      </g>
    `;
  }
}

function truncate(name: string, width: number): string {
  const maxChars = Math.floor(width / 6.2);
  return name.length > maxChars ? `${name.slice(0, Math.max(1, maxChars - 1))}…` : name;
}

customElements.define('churn-treemap', ChurnTreemap);

declare global {
  interface HTMLElementTagNameMap {
    'churn-treemap': ChurnTreemap;
  }
}
