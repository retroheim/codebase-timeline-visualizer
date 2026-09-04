import { LitElement, html, css, svg } from 'lit';
import { bucketByDay, calendarWeeks, intensityLevel, longestStreak, type DayBucket } from '../lib/calendar';
import { timelineUpTo } from '../lib/as-of';
import './scope-toggle';
import type { TimeScope } from './scope-toggle';
import type { TimelineData } from '../types';

const CELL = 13;
const CELL_GAP = 4;
const MONTH_LABEL_HEIGHT = 20;
const LEVELS = 4;

export class CalendarHeatmap extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
    scope: { state: true },
  };

  declare data: TimelineData | null;
  declare currentTime: number;
  declare scope: TimeScope;

  constructor() {
    super();
    this.scope = 'all-time';
  }

  static styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      overflow: auto;
      padding: 88px 32px 32px;
      box-sizing: border-box;
      gap: 36px;
    }
    .stats {
      display: flex;
      gap: 48px;
    }
    .stat {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
    }
    .stat-value {
      font-family: var(--font-display, sans-serif);
      font-size: 34px;
      font-weight: 600;
      line-height: 1;
      color: var(--paper, #e7edf5);
      font-variant-numeric: tabular-nums;
    }
    .stat-label {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }
    .grid-wrap {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    svg {
      display: block;
      overflow: visible;
    }
    rect.day {
      cursor: pointer;
      stroke: rgba(255, 255, 255, 0.05);
      stroke-width: 1;
      transition: stroke 0.12s ease, filter 0.12s ease;
    }
    rect.day:hover {
      stroke: var(--paper, #e7edf5);
      stroke-width: 1.5;
      filter: brightness(1.2);
    }
    rect.day.hot {
      filter: drop-shadow(0 0 4px rgba(47, 230, 184, 0.65));
    }
    text.month {
      fill: var(--mist, #55617a);
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }
    .empty {
      color: var(--mist, #55617a);
      padding: 40px;
    }
    .scope-row {
      display: flex;
      justify-content: center;
    }
    .legend {
      display: flex;
      align-items: center;
      gap: 7px;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }
    .legend rect {
      stroke: rgba(255, 255, 255, 0.06);
    }
  `;

  private handleDayClick(bucket: DayBucket): void {
    if (bucket.commitIndices.length === 0) return;
    const index = bucket.commitIndices[bucket.commitIndices.length - 1];
    this.dispatchEvent(new CustomEvent('seek', { detail: { index }, bubbles: true, composed: true }));
  }

  private levelColor(level: number): string {
    // A fixed ramp from the panel background up to the thread accent —
    // reuses an existing design token rather than inventing a new hue
    // family for a view whose cells have no equivalent in the tree's
    // per-node hue system.
    const stops = ['rgba(255,255,255,0.05)', 'rgba(47,230,184,0.28)', 'rgba(47,230,184,0.55)', 'rgba(47,230,184,0.8)', '#2fe6b8'];
    return stops[Math.min(level, stops.length - 1)];
  }

  private handleScopeChange = (event: CustomEvent<{ scope: TimeScope }>): void => {
    this.scope = event.detail.scope;
  };

  render() {
    const fullTimeline = this.data?.timeline ?? [];
    if (fullTimeline.length === 0) {
      return html`<div class="empty">No commits to show.</div>`;
    }
    const timeline = this.scope === 'as-of' ? timelineUpTo(fullTimeline, this.currentTime) : fullTimeline;

    const buckets = bucketByDay(timeline);
    const weeks = calendarWeeks(buckets);
    const max = Math.max(...buckets.map((b) => b.commits), 1);
    const thresholds = Array.from({ length: LEVELS - 1 }, (_, i) => (max * (i + 1)) / LEVELS);
    const streak = longestStreak(buckets);

    const width = weeks.length * (CELL + CELL_GAP);
    const height = 7 * (CELL + CELL_GAP) + MONTH_LABEL_HEIGHT;

    let lastMonth = -1;
    const monthLabels: { x: number; label: string }[] = [];
    weeks.forEach((week, weekIndex) => {
      const month = week[0].date.getUTCMonth();
      if (month !== lastMonth) {
        lastMonth = month;
        monthLabels.push({
          x: weekIndex * (CELL + CELL_GAP),
          label: week[0].date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }),
        });
      }
    });

    return html`
      <div class="scope-row">
        <scope-toggle .scope=${this.scope} @scope-change=${this.handleScopeChange}></scope-toggle>
      </div>
      <div class="stats">
        <div class="stat">
          <span class="stat-value">${buckets.length.toLocaleString()}</span>
          <span class="stat-label">Active days</span>
        </div>
        <div class="stat">
          <span class="stat-value">${max.toLocaleString()}</span>
          <span class="stat-label">Busiest day</span>
        </div>
        <div class="stat">
          <span class="stat-value">${streak.toLocaleString()}</span>
          <span class="stat-label">Longest streak</span>
        </div>
      </div>
      <div class="grid-wrap">
        <svg width=${width} height=${height} role="img" aria-label="Commit activity calendar">
          ${monthLabels.map((m) => svg`<text class="month" x=${m.x} y="10">${m.label}</text>`)}
          ${weeks.map((week, weekIndex) =>
            week.map((day, dayIndex) => {
              const level = intensityLevel(day.commits, thresholds);
              // `svg` (not `html`), and required here: each cell is its own
              // standalone template instantiated inside a `${}` binding, not
              // static markup in the outer template — without `svg`, lit
              // parses "<rect>...</rect>" with no enclosing `<svg>` in that
              // same parse, so the browser's HTML parser never enters
              // foreign-content/SVG mode and creates an inert
              // HTMLUnknownElement instead of a real SVGRectElement: it
              // accepts attributes and even resolves CSS `fill` correctly,
              // but has no paintable geometry and never appears on screen.
              return svg`
                <rect
                  class="day ${level >= LEVELS - 1 ? 'hot' : ''}"
                  x=${weekIndex * (CELL + CELL_GAP)}
                  y=${MONTH_LABEL_HEIGHT + dayIndex * (CELL + CELL_GAP)}
                  width=${CELL}
                  height=${CELL}
                  rx="3"
                  style="fill: ${this.levelColor(level)}"
                  @click=${() => this.handleDayClick(day)}
                >
                  <title>${day.dateKey}: ${day.commits} commit${day.commits === 1 ? '' : 's'}</title>
                </rect>
              `;
            })
          )}
        </svg>
        <div class="legend">
          Less
          ${Array.from({ length: LEVELS + 1 }, (_, level) => level).map(
            (level) =>
              html`<svg width=${CELL} height=${CELL}
                >${svg`<rect width=${CELL} height=${CELL} rx="3" style="fill: ${this.levelColor(level)}"></rect>`}</svg
              >`
          )}
          More
        </div>
      </div>
    `;
  }
}

customElements.define('calendar-heatmap', CalendarHeatmap);

declare global {
  interface HTMLElementTagNameMap {
    'calendar-heatmap': CalendarHeatmap;
  }
}
