import { LitElement, html, css } from 'lit';
import './timeline-viz';
import './calendar-heatmap';
import './contributor-leaderboard';
import './growth-chart';
import './churn-treemap';
import './commit-log';
import './view-switcher';
import './project-switcher';
import { advance, clampFrameDelta, ticksPerSecond } from '../lib/playback';
import { formatHash, parseHash, type ViewMode } from '../lib/route';
import { SUPPORTED_SCHEMA_VERSION, type TimelineData } from '../types';

declare global {
  interface Window {
    // Set by `codevis export --format html`, which inlines the data so the
    // exported file works with no server behind it.
    __CODEVIS_TIMELINE__?: TimelineData;
  }
}

/**
 * Reject a payload this build cannot read. A file from a newer codevis may be
 * missing fields the renderer dereferences, and failing with a sentence beats
 * rendering a half-empty visualization that looks like a data problem.
 * Files written before versioning existed have no `schema_version` at all and
 * are accepted — that is what version 1 was.
 */
function assertUsable(data: TimelineData): TimelineData {
  if (!data?.metadata || !Array.isArray(data.timeline)) {
    throw new Error('malformed timeline data');
  }
  const version = data.metadata.schema_version ?? SUPPORTED_SCHEMA_VERSION;
  if (version > SUPPORTED_SCHEMA_VERSION) {
    throw new Error(
      `timeline.json is schema version ${version}, but this build understands ${SUPPORTED_SCHEMA_VERSION}. Rebuild the frontend.`
    );
  }
  return data;
}

export class AppRoot extends LitElement {
  static properties = {
    timelineData: { state: true },
    isPlaying: { state: true },
    currentTime: { state: true },
    maxTime: { state: true },
    speed: { state: true },
    viewMode: { state: true },
    currentProjectId: { state: true },
    multiProjectMode: { state: true },
  };

  declare timelineData: TimelineData | null;
  declare isPlaying: boolean;
  declare currentTime: number;
  declare maxTime: number;
  declare speed: number;
  declare viewMode: ViewMode;
  declare currentProjectId: string | null;
  /** Whether `/api/projects` answered — decides project-switcher vs the
   *  legacy bare `/api/timeline` fetch. Undetermined (null) while probing. */
  declare multiProjectMode: boolean | null;

  /** The project a timeline was actually loaded for, set only once
   *  `handleProjectReady` has run — unlike `currentProjectId`, which is
   *  pre-populated from the URL hash before anything has loaded. Comparing
   *  against `currentProjectId` there would misclassify a deep link's very
   *  first load as a refresh (both already "match") and jump the playhead
   *  to the end of history instead of resetting to the start. */
  private loadedProjectId: string | null = null;

  // rAF-driven accumulator loop rather than setInterval: ties playback
  // progress to the display refresh instead of a fixed-ms timer, avoiding
  // setInterval drift and the 1s+ throttle browsers apply to background-tab
  // timers. Advances by fractional commits per frame (`carry`) so pacing is
  // frame-rate independent and smooth (a step most frames) instead of the
  // old chunky "jump N commits every 500ms" behaviour.
  private rafId: number | undefined;
  private lastFrameTime = 0;
  private carry = 0;
  private playbackRate = 0;

  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100vh;
      position: relative;
      background: var(--void, #060810);
      color: var(--paper, #e7edf5);
      font-family: var(--font-body, sans-serif);
      overflow: hidden;
    }

    .top-bar {
      position: absolute;
      top: 22px;
      left: 26px;
      right: 26px;
      z-index: 4;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      pointer-events: none;
    }
    .top-bar > * {
      pointer-events: auto;
    }

    .wordmark {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-family: var(--font-display, sans-serif);
      font-weight: 600;
      font-size: 15px;
      letter-spacing: 0.01em;
      color: var(--paper, #e7edf5);
      user-select: none;
      flex: none;
    }
    .wordmark-mark {
      color: var(--thread, #2fe6b8);
      font-size: 17px;
      line-height: 1;
    }
    .wordmark-sub {
      font-family: var(--font-mono, monospace);
      font-size: 10.5px;
      font-weight: 400;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }

    .controls {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .viz-layer {
      position: absolute;
      inset: 0;
    }
    /* Each view switch swaps in a genuinely new custom element (different
       tag), so this animation restarts on every switch for free — one
       orchestrated entrance rather than a jump-cut between instruments. */
    .viz-layer > * {
      animation: view-enter 0.32s cubic-bezier(0.16, 1, 0.3, 1) both;
    }
    @keyframes view-enter {
      from {
        opacity: 0;
        transform: scale(0.982);
      }
      to {
        opacity: 1;
        transform: scale(1);
      }
    }

    .dock {
      position: absolute;
      left: 50%;
      bottom: 26px;
      transform: translateX(-50%);
      z-index: 3;
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 10px 18px;
      max-width: calc(100vw - 48px);
      border-radius: 999px;
      background: rgba(13, 20, 36, 0.68);
      backdrop-filter: blur(18px) saturate(140%);
      -webkit-backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      box-shadow:
        0 20px 50px rgba(0, 0, 0, 0.5),
        inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }

    .play-button {
      flex: none;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      padding: 0;
      border: none;
      border-radius: 50%;
      background: linear-gradient(155deg, #ff9d70, var(--flare, #ff8a5c));
      color: #1a0e08;
      cursor: pointer;
      box-shadow: 0 0 0 rgba(255, 138, 92, 0);
      transition: box-shadow 0.2s ease, transform 0.15s ease;
    }
    .play-button:hover {
      box-shadow: 0 0 18px rgba(255, 138, 92, 0.55);
      transform: translateY(-1px);
    }
    .play-button:active {
      transform: translateY(0);
    }
    .play-button svg {
      margin-left: 1px;
    }

    .timeline-slider {
      -webkit-appearance: none;
      appearance: none;
      width: min(46vw, 420px);
      height: 3px;
      border-radius: 2px;
      cursor: pointer;
      background: linear-gradient(
        to right,
        var(--thread, #2fe6b8) 0%,
        var(--thread, #2fe6b8) var(--progress, 0%),
        rgba(255, 255, 255, 0.14) var(--progress, 0%),
        rgba(255, 255, 255, 0.14) 100%
      );
    }
    .timeline-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 13px;
      height: 13px;
      border-radius: 50%;
      background: var(--paper, #e7edf5);
      border: 2px solid var(--flare, #ff8a5c);
      box-shadow: 0 0 8px rgba(255, 138, 92, 0.6);
      cursor: pointer;
    }
    .timeline-slider::-moz-range-thumb {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--paper, #e7edf5);
      border: 2px solid var(--flare, #ff8a5c);
      box-shadow: 0 0 8px rgba(255, 138, 92, 0.6);
      cursor: pointer;
    }
    .timeline-slider::-moz-range-track {
      height: 3px;
      border-radius: 2px;
      background: transparent;
    }

    .time-display {
      flex: none;
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      letter-spacing: 0.01em;
      color: var(--mist, #55617a);
      white-space: nowrap;
    }
    .time-display b {
      color: var(--paper, #e7edf5);
      font-weight: 500;
    }

    .speed-select {
      flex: none;
      font-family: var(--font-mono, monospace);
      font-size: 11.5px;
      padding: 5px 8px;
      border-radius: 6px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.04);
      color: var(--paper, #e7edf5);
      cursor: pointer;
    }
    .speed-select:focus-visible {
      outline: 2px solid var(--flare, #ff8a5c);
      outline-offset: 1px;
    }

    .placeholder {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      gap: 10px;
      color: var(--mist, #55617a);
      font-size: 15px;
      text-align: center;
      padding: 24px;
    }
    .placeholder code {
      font-family: var(--font-mono, monospace);
      background: var(--panel, #0d1424);
      border: 1px solid rgba(255, 255, 255, 0.08);
      padding: 3px 8px;
      border-radius: 5px;
      color: var(--thread, #2fe6b8);
    }

    @media (max-width: 640px) {
      .dock {
        gap: 10px;
        padding: 8px 12px;
      }
      .timeline-slider {
        width: 34vw;
      }
      .time-display {
        display: none;
      }
    }
  `;

  constructor() {
    super();
    this.timelineData = null;
    this.isPlaying = false;
    this.currentTime = 0;
    this.maxTime = 100;
    this.speed = 1;
    this.viewMode = 'tree';
    this.currentProjectId = null;
    this.multiProjectMode = null;
  }

  connectedCallback(): void {
    super.connectedCallback();

    const route = parseHash(window.location.hash);
    this.viewMode = route.view;
    this.currentProjectId = route.projectId;
    window.addEventListener('hashchange', this.handleHashChange);

    // A standalone export carries its data inline; there is no server to ask.
    const inlined = window.__CODEVIS_TIMELINE__;
    if (inlined) {
      this.multiProjectMode = false;
      try {
        this.applyTimeline(assertUsable(inlined));
      } catch (error) {
        console.warn('Inlined timeline data is unusable:', error);
      }
      return;
    }

    // Probe for the multi-project API before falling back to the legacy
    // single-file `/api/timeline` — a `serve --data` process never mounts
    // `/api/projects`, so this 404s there and we fall back cleanly.
    fetch('/api/projects')
      .then((response) => {
        if (response.ok) {
          this.multiProjectMode = true;
          return;
        }
        this.multiProjectMode = false;
        return this.fetchLegacyTimeline();
      })
      .catch(() => {
        this.multiProjectMode = false;
        return this.fetchLegacyTimeline();
      });
  }

  private fetchLegacyTimeline(): Promise<void> {
    return fetch('/api/timeline')
      .then((response) => {
        // The server answers a missing/unreadable data file with a JSON error
        // body, which parses perfectly well — so without an `ok` check that
        // body lands in `timelineData`, the placeholder branch is skipped, and
        // render() throws dereferencing `.metadata` on it. Blank page instead
        // of the "run codevis analyze" hint, on the most common first run.
        if (!response.ok) throw new Error(`timeline unavailable (HTTP ${response.status})`);
        return response.json();
      })
      .then((data: TimelineData) => this.applyTimeline(assertUsable(data), { resetToStart: true }))
      .catch((error) => {
        console.warn('No timeline data available:', error);
      });
  }

  private handleHashChange = (): void => {
    const route = parseHash(window.location.hash);
    if (route.view !== this.viewMode) this.viewMode = route.view;
  };

  private writeHash(): void {
    const next = formatHash({ projectId: this.currentProjectId, view: this.viewMode });
    if (window.location.hash !== next) {
      history.replaceState(null, '', next);
    }
  }

  private handleViewChange = (event: CustomEvent<{ mode: ViewMode }>): void => {
    this.viewMode = event.detail.mode;
    this.writeHash();
  };

  private handleProjectReady = (event: CustomEvent<{ projectId: string; data: TimelineData }>): void => {
    const { projectId, data } = event.detail;
    let usable: TimelineData;
    try {
      usable = assertUsable(data);
    } catch (error) {
      console.warn('Project timeline is unusable:', error);
      return;
    }
    // Re-selecting a project a timeline was already loaded for means this
    // came from a refresh — jump to the new end of history so the new
    // commits are immediately visible, rather than clamping to wherever the
    // scrubber happened to be left (which could hide everything new).
    const isRefreshOfCurrent = projectId === this.loadedProjectId;
    this.currentProjectId = projectId;
    this.loadedProjectId = projectId;
    this.applyTimeline(usable, isRefreshOfCurrent ? { jumpToEnd: true } : { resetToStart: true });
    this.writeHash();
  };

  private handleProjectError = (event: CustomEvent<{ message: string }>): void => {
    console.warn('Project error:', event.detail.message);
  };

  private handleSeek = (event: CustomEvent<{ index: number }>): void => {
    this.isPlaying = false;
    this.stopInterval();
    this.currentTime = Math.max(0, Math.min(event.detail.index, this.maxTime));
  };

  private applyTimeline(data: TimelineData, opts: { resetToStart?: boolean; jumpToEnd?: boolean } = {}): void {
    // Playback is indexed into the old dataset; leaving it running across a
    // swap would advance a cursor through a timeline that no longer exists.
    this.stopInterval();
    this.isPlaying = false;
    this.timelineData = data;
    this.maxTime = data.timeline.length > 0 ? data.timeline.length - 1 : 0;
    if (opts.jumpToEnd) {
      this.currentTime = this.maxTime;
    } else if (opts.resetToStart) {
      this.currentTime = 0;
    } else if (this.currentTime > this.maxTime) {
      this.currentTime = this.maxTime;
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopInterval();
    window.removeEventListener('hashchange', this.handleHashChange);
  }

  private startInterval(): void {
    this.stopInterval();
    this.playbackRate = ticksPerSecond(this.maxTime, this.speed);
    this.carry = 0;
    this.lastFrameTime = performance.now();
    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private tick = (now: number): void => {
    const dtSeconds = clampFrameDelta(now - this.lastFrameTime);
    this.lastFrameTime = now;

    const { carry, steps } = advance(this.carry, dtSeconds, this.playbackRate);
    this.carry = carry;

    if (steps > 0) {
      const next = this.currentTime + steps;
      if (next >= this.maxTime) {
        this.currentTime = this.maxTime;
        this.isPlaying = false;
        this.stopInterval();
        return;
      }
      this.currentTime = next;
    }

    this.rafId = window.requestAnimationFrame(this.tick);
  };

  private stopInterval(): void {
    if (this.rafId !== undefined) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = undefined;
    }
  }

  private handlePlayPause = (): void => {
    const willPlay = !this.isPlaying;
    if (willPlay && this.currentTime >= this.maxTime) {
      this.currentTime = 0;
    }
    this.isPlaying = willPlay;
    if (willPlay) {
      this.startInterval();
    } else {
      this.stopInterval();
    }
  };

  private handleTimeChange = (event: Event): void => {
    const newTime = parseInt((event.target as HTMLInputElement).value, 10);
    this.isPlaying = false;
    this.stopInterval();
    this.currentTime = newTime;
  };

  private handleSpeedChange = (event: Event): void => {
    this.speed = parseFloat((event.target as HTMLSelectElement).value);
    if (this.isPlaying) {
      this.startInterval();
    }
  };

  private formatTime(time: number): string {
    const commit = this.timelineData?.timeline?.[time];
    if (!commit) return '—';
    const date = new Date(commit.timestamp * 1000);
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  private renderActiveView() {
    const data = this.timelineData;
    switch (this.viewMode) {
      case 'calendar':
        return html`<calendar-heatmap .data=${data} .currentTime=${this.currentTime}></calendar-heatmap>`;
      case 'leaderboard':
        return html`<contributor-leaderboard .data=${data} .currentTime=${this.currentTime}></contributor-leaderboard>`;
      case 'growth':
        return html`<growth-chart .data=${data} .currentTime=${this.currentTime}></growth-chart>`;
      case 'treemap':
        return html`<churn-treemap .data=${data} .currentTime=${this.currentTime}></churn-treemap>`;
      case 'commits':
        return html`<commit-log .data=${data} .currentTime=${this.currentTime}></commit-log>`;
      case 'tree':
      default:
        return html`<timeline-viz .data=${data} .currentTime=${this.currentTime}></timeline-viz>`;
    }
  }

  render() {
    const progress = this.maxTime > 0 ? (this.currentTime / this.maxTime) * 100 : 0;

    return html`
      <div class="top-bar">
        ${this.multiProjectMode
          ? html`<project-switcher
              .initialProjectId=${this.currentProjectId}
              @project-ready=${this.handleProjectReady}
              @project-error=${this.handleProjectError}
            ></project-switcher>`
          : html`
              <div class="wordmark">
                <span class="wordmark-mark">◈</span>
                ${this.timelineData?.metadata.repo_name || 'Codebase Timeline'}
                ${this.timelineData
                  ? html`<span class="wordmark-sub">${this.timelineData.metadata.total_commits} commits</span>`
                  : null}
              </div>
            `}
        <div class="controls">
          <view-switcher
            .mode=${this.viewMode}
            ?disabled=${!this.timelineData}
            @view-change=${this.handleViewChange}
          ></view-switcher>
        </div>
      </div>

      <div class="viz-layer" @seek=${this.handleSeek}>
        ${this.timelineData
          ? this.renderActiveView()
          : html`
              <div class="placeholder">
                <p>Timeline visualization will appear here</p>
                <p>
                  ${this.multiProjectMode
                    ? 'Register a project above to get started'
                    : 'Load a timeline.json file to get started'}
                </p>
                ${this.multiProjectMode ? null : html`<p>Or run: <code>codevis analyze ./your-repo</code></p>`}
              </div>
            `}
      </div>

      ${this.timelineData
        ? html`
            <div class="dock">
              <button
                class="play-button"
                @click=${this.handlePlayPause}
                aria-label=${this.isPlaying ? 'Pause' : 'Play'}
                title=${this.isPlaying ? 'Pause' : 'Play'}
              >
                ${this.isPlaying
                  ? html`<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <rect x="5" y="4" width="5" height="16" rx="1"></rect>
                      <rect x="14" y="4" width="5" height="16" rx="1"></rect>
                    </svg>`
                  : html`<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <path d="M7 4.5v15l13-7.5-13-7.5z"></path>
                    </svg>`}
              </button>
              <input
                type="range"
                class="timeline-slider"
                style="--progress: ${progress}%"
                min="0"
                max=${this.maxTime}
                .value=${String(this.currentTime)}
                @input=${this.handleTimeChange}
              />
              <span class="time-display"><b>${this.formatTime(this.currentTime)}</b> / ${this.formatTime(this.maxTime)}</span>
              <select class="speed-select" .value=${String(this.speed)} @change=${this.handleSpeedChange}>
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
                <option value="4">4×</option>
              </select>
            </div>
          `
        : null}
    `;
  }
}

customElements.define('app-root', AppRoot);

declare global {
  interface HTMLElementTagNameMap {
    'app-root': AppRoot;
  }
}
