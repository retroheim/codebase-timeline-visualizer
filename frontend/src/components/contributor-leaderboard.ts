import { LitElement, html, css } from 'lit';
import {
  buildLeaderboard,
  buildLeaderboardAsOf,
  groupBotRows,
  sortLeaderboard,
  type LeaderboardRow,
  type SortKey,
} from '../lib/contributor-stats';
import { contributorColorScale } from '../lib/contributor-color';
import './scope-toggle';
import './bot-group-toggle';
import type { TimeScope } from './scope-toggle';
import type { TimelineData } from '../types';

const COLUMNS: { key: SortKey; label: string; format: (n: number) => string }[] = [
  { key: 'commits', label: 'Commits', format: (n) => n.toLocaleString() },
  { key: 'linesAdded', label: '+ Lines', format: (n) => `+${n.toLocaleString()}` },
  { key: 'linesRemoved', label: '− Lines', format: (n) => `−${n.toLocaleString()}` },
  { key: 'netLines', label: 'Net', format: (n) => n.toLocaleString() },
  { key: 'filesChanged', label: 'Files', format: (n) => n.toLocaleString() },
];

export class ContributorLeaderboard extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
    sortBy: { state: true },
    scope: { state: true },
    groupBots: { state: true },
  };

  declare data: TimelineData | null;
  declare currentTime: number;
  declare sortBy: SortKey;
  declare scope: TimeScope;
  /** Whether bot/AI-model contributors (blacksmith-sh[bot], Claude variants,
   *  Codesmith, etc. — see lib/bot-authors.ts) are folded into one
   *  "Automated" row. Defaults to grouped: a repo with a dozen AI-model
   *  contributors otherwise drowns out its human ones on a ranked board. */
  declare groupBots: boolean;

  // `currentTime` advances fractionally every animation frame during
  // playback (see app-root's rAF loop), but the as-of aggregation only
  // cares about its floored value — rebuilding the full contributor-stats
  // map on every sub-integer tick would be pure waste. `sortBy` is excluded
  // deliberately: it only reorders the already-built rows, cheap enough not
  // to need caching, and including it would invalidate the cache on every
  // column-header click for no benefit.
  private lastRowsInputs: { scope: TimeScope; flooredTime: number; data: TimelineData | null } | null = null;
  private cachedRows: LeaderboardRow[] = [];

  constructor() {
    super();
    this.sortBy = 'commits';
    this.scope = 'all-time';
    this.groupBots = true;
  }

  // Ranked bars, not a spreadsheet — rank position genuinely encodes order
  // here (this *is* a ranking), so a numeral marker is earned rather than
  // decorative. Each row's own bar is the primary read; the other metrics
  // sit alongside as quiet secondary numbers, re-orderable by clicking a
  // header without turning the whole thing back into a dense table.
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: auto;
      padding: 88px 32px 32px;
      box-sizing: border-box;
      font-family: var(--font-body, sans-serif);
    }
    .scope-row {
      max-width: 920px;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
    }
    .board {
      max-width: 920px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .headers {
      display: flex;
      align-items: baseline;
      gap: 18px;
      padding: 0 4px 10px;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--mist, #55617a);
    }
    .headers .spacer {
      flex: 1;
    }
    .headers button {
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      background: none;
      border: none;
      color: inherit;
      cursor: pointer;
      padding: 4px 2px;
      min-width: 62px;
      text-align: right;
    }
    .headers button:hover {
      color: var(--paper, #e7edf5);
    }
    .headers button.active {
      color: var(--thread, #2fe6b8);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 18px;
      padding: 11px 4px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    }
    .rank {
      flex: none;
      width: 26px;
      font-family: var(--font-mono, monospace);
      font-size: 12px;
      color: var(--mist, #55617a);
      text-align: right;
    }
    .row:first-child .rank {
      color: var(--flare, #ff8a5c);
    }
    .identity {
      flex: none;
      width: 168px;
      display: flex;
      align-items: center;
      gap: 9px;
      min-width: 0;
    }
    .swatch {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex: none;
    }
    .author-col {
      display: flex;
      flex-direction: column;
      gap: 1px;
      min-width: 0;
    }
    .author {
      font-family: var(--font-display, sans-serif);
      font-size: 14px;
      font-weight: 500;
      color: var(--paper, #e7edf5);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bot-list {
      font-family: var(--font-mono, monospace);
      font-size: 9.5px;
      color: var(--mist, #55617a);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .bar-track {
      flex: 1;
      position: relative;
      height: 22px;
      min-width: 0;
    }
    .bar {
      position: absolute;
      inset: 0;
      border-radius: 4px;
      opacity: 0.85;
      transition: width 0.25s ease;
    }
    .metrics {
      flex: none;
      display: flex;
      gap: 18px;
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      color: var(--mist, #55617a);
    }
    .metrics span {
      min-width: 62px;
      text-align: right;
    }
    .metrics span.active {
      color: var(--paper, #e7edf5);
    }
    .empty {
      color: var(--mist, #55617a);
      padding: 40px;
    }
  `;

  private handleSort(key: SortKey): void {
    this.sortBy = key;
  }

  private handleScopeChange = (event: CustomEvent<{ scope: TimeScope }>): void => {
    this.scope = event.detail.scope;
  };

  private handleBotGroupChange = (event: CustomEvent<{ grouped: boolean }>): void => {
    this.groupBots = event.detail.grouped;
  };

  private computeUnsortedRows(): LeaderboardRow[] {
    const inputs = { scope: this.scope, flooredTime: Math.floor(this.currentTime), data: this.data };
    const last = this.lastRowsInputs;
    if (last && last.scope === inputs.scope && last.flooredTime === inputs.flooredTime && last.data === inputs.data) {
      return this.cachedRows;
    }
    const rows = this.scope === 'as-of' ? buildLeaderboardAsOf(this.data!, this.currentTime) : buildLeaderboard(this.data!);
    this.lastRowsInputs = inputs;
    this.cachedRows = rows;
    return rows;
  }

  render() {
    if (!this.data || Object.keys(this.data.contributors).length === 0) {
      return html`<div class="empty">No contributors to show.</div>`;
    }

    const unsorted = this.computeUnsortedRows();
    const grouped = this.groupBots ? groupBotRows(unsorted) : unsorted;
    const rows = sortLeaderboard(grouped, this.sortBy);
    const colorFor = contributorColorScale(this.data);
    const max = Math.max(...rows.map((r) => Math.abs(r[this.sortBy])), 1);

    return html`
      <div class="scope-row">
        <bot-group-toggle .grouped=${this.groupBots} @bot-group-change=${this.handleBotGroupChange}></bot-group-toggle>
        <scope-toggle .scope=${this.scope} @scope-change=${this.handleScopeChange}></scope-toggle>
      </div>
      <div class="board">
        <div class="headers">
          <span style="width: 26px"></span>
          <span style="width: 168px">Contributor</span>
          <span class="spacer"></span>
          ${COLUMNS.map(
            (col) => html`
              <button class=${col.key === this.sortBy ? 'active' : ''} @click=${() => this.handleSort(col.key)}>
                ${col.label}
              </button>
            `
          )}
        </div>
        ${rows.map((row, i) => this.renderRow(row, i, colorFor, max))}
      </div>
    `;
  }

  private renderRow(row: LeaderboardRow, index: number, colorFor: (author: string) => string, max: number) {
    // Fixed rather than scale-assigned: "Automated" isn't a real contributor
    // identity in data.contributors, so it has no earned place in the
    // per-author ordinal scale — and a fixed violet ties it visually to the
    // Automated/Individual toggle above.
    const color = row.mergedAuthors ? 'var(--bloom, #c792ff)' : colorFor(row.author);
    const value = row[this.sortBy];
    const barPct = Math.max(2, Math.min(100, (Math.abs(value) / max) * 100));

    const botList = row.mergedAuthors?.join(', ') ?? '';

    return html`
      <div class="row">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <span class="identity">
          <span class="swatch" style="background:${color}; box-shadow: 0 0 6px ${color}"></span>
          <span class="author-col">
            <span class="author">${row.author}</span>
            ${row.mergedAuthors
              ? html`<span class="bot-list" title=${botList}>${row.mergedAuthors.length} bots: ${botList}</span>`
              : null}
          </span>
        </span>
        <span class="bar-track">
          <span class="bar" style="width:${barPct}%; background:${color}"></span>
        </span>
        <span class="metrics">
          ${COLUMNS.map(
            (col) => html`<span class=${col.key === this.sortBy ? 'active' : ''}>${col.format(row[col.key])}</span>`
          )}
        </span>
      </div>
    `;
  }
}

customElements.define('contributor-leaderboard', ContributorLeaderboard);

declare global {
  interface HTMLElementTagNameMap {
    'contributor-leaderboard': ContributorLeaderboard;
  }
}
