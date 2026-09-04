import { LitElement, html, css, PropertyValues } from 'lit';
import * as d3 from 'd3';
import { growthSeries, nearestIndexForTimestamp, type GrowthPoint } from '../lib/growth';
import type { TimelineData } from '../types';

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 420;
const MARGIN = { top: 28, right: 24, bottom: 32, left: 64 };

export class GrowthChart extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
  };

  declare data: TimelineData | null;
  declare currentTime: number;

  private series: GrowthPoint[] = [];

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      padding: 56px 24px 8px;
      box-sizing: border-box;
    }
    svg {
      width: 100%;
      height: 100%;
      overflow: visible;
    }
    .area {
      fill: url(#growth-fade);
    }
    .line {
      fill: none;
      stroke: var(--thread, #2fe6b8);
      stroke-width: 2.25;
      stroke-linejoin: round;
      filter: drop-shadow(0 0 6px rgba(47, 230, 184, 0.55));
    }
    .playhead-line {
      stroke: var(--flare, #ff8a5c);
      stroke-width: 1.5;
      stroke-dasharray: 3 3;
      pointer-events: none;
    }
    .playhead-dot {
      fill: var(--flare, #ff8a5c);
      filter: drop-shadow(0 0 5px rgba(255, 138, 92, 0.8));
      pointer-events: none;
    }
    .overlay {
      fill: transparent;
      cursor: crosshair;
    }
    .axis text {
      fill: var(--mist, #55617a);
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.04em;
    }
    .axis path,
    .axis line {
      stroke: rgba(255, 255, 255, 0.1);
    }
    .empty {
      color: var(--mist, #55617a);
      padding: 40px;
    }
  `;

  updated(changed: PropertyValues): void {
    if (changed.has('data')) {
      this.series = growthSeries(this.data?.timeline ?? []);
    }
    this.draw();
  }

  private xScale() {
    const extent = d3.extent(this.series, (p) => p.timestamp * 1000) as [number, number];
    return d3
      .scaleTime()
      .domain(extent[0] === undefined ? [0, 1] : extent)
      .range([MARGIN.left, VIEW_WIDTH - MARGIN.right]);
  }

  private yScale() {
    const max = d3.max(this.series, (p) => p.cumulativeLines) ?? 1;
    return d3
      .scaleLinear()
      .domain([0, max])
      .nice()
      .range([VIEW_HEIGHT - MARGIN.bottom, MARGIN.top]);
  }

  private draw(): void {
    const svg = this.renderRoot.querySelector('svg');
    if (!svg || this.series.length === 0) return;

    const x = this.xScale();
    const y = this.yScale();
    const selection = d3.select(svg);

    const area = d3
      .area<GrowthPoint>()
      .x((p) => x(p.timestamp * 1000))
      .y0(y(0))
      .y1((p) => y(p.cumulativeLines));
    const line = d3
      .line<GrowthPoint>()
      .x((p) => x(p.timestamp * 1000))
      .y((p) => y(p.cumulativeLines));

    selection.select<SVGPathElement>('path.area').datum(this.series).attr('d', area);
    selection.select<SVGPathElement>('path.line').datum(this.series).attr('d', line);

    // `scaleTime` (not `scaleLinear` on a raw unix timestamp) so d3 picks
    // calendar-aware tick positions — a linear scale's "nice round numbers"
    // ticks can land close enough together that two adjacent ticks format to
    // the same month label with nothing to tell them apart.
    selection
      .select<SVGGElement>('g.x-axis')
      .attr('transform', `translate(0, ${VIEW_HEIGHT - MARGIN.bottom})`)
      .call(d3.axisBottom(x).ticks(6).tickFormat(d3.timeFormat('%b %y') as (v: Date | d3.NumberValue) => string));

    selection
      .select<SVGGElement>('g.y-axis')
      .attr('transform', `translate(${MARGIN.left}, 0)`)
      .call(d3.axisLeft(y).ticks(5));

    const current = this.series[Math.min(this.currentTime, this.series.length - 1)];
    if (current) {
      const cx = x(current.timestamp * 1000);
      const cy = y(current.cumulativeLines);
      selection
        .select<SVGLineElement>('line.playhead-line')
        .attr('x1', cx)
        .attr('x2', cx)
        .attr('y1', MARGIN.top)
        .attr('y2', VIEW_HEIGHT - MARGIN.bottom);
      selection.select<SVGCircleElement>('circle.playhead-dot').attr('cx', cx).attr('cy', cy).attr('r', 4);
    }
  }

  private handlePointer = (event: PointerEvent): void => {
    if (event.buttons === 0 && event.type === 'pointermove') return;
    const svg = this.renderRoot.querySelector('svg');
    if (!svg || this.series.length === 0) return;
    const [px] = d3.pointer(event, svg);
    const x = this.xScale();
    const timestamp = x.invert(px).getTime() / 1000;
    const index = nearestIndexForTimestamp(this.series, timestamp);
    this.dispatchEvent(new CustomEvent('seek', { detail: { index }, bubbles: true, composed: true }));
  };

  render() {
    if (!this.data || this.data.timeline.length === 0) {
      return html`<div class="empty">No commits to show.</div>`;
    }

    return html`
      <svg viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-label="Cumulative lines of code over time">
        <defs>
          <linearGradient id="growth-fade" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--thread, #2fe6b8)" stop-opacity="0.35"></stop>
            <stop offset="100%" stop-color="var(--thread, #2fe6b8)" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <path class="area"></path>
        <path class="line"></path>
        <g class="axis x-axis"></g>
        <g class="axis y-axis"></g>
        <line class="playhead-line"></line>
        <circle class="playhead-dot"></circle>
        <rect
          class="overlay"
          x=${MARGIN.left}
          y=${MARGIN.top}
          width=${VIEW_WIDTH - MARGIN.left - MARGIN.right}
          height=${VIEW_HEIGHT - MARGIN.top - MARGIN.bottom}
          @pointerdown=${this.handlePointer}
          @pointermove=${this.handlePointer}
        ></rect>
      </svg>
    `;
  }
}

customElements.define('growth-chart', GrowthChart);

declare global {
  interface HTMLElementTagNameMap {
    'growth-chart': GrowthChart;
  }
}
