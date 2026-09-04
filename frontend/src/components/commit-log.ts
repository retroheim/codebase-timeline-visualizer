import { LitElement, html, css } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { filterCommits, sortCommits, type CommitSortKey, type SortDirection } from '../lib/commit-table';
import { contributorColorScale } from '../lib/contributor-color';
import { isBotAuthor } from '../lib/bot-authors';
import { timelineUpTo } from '../lib/as-of';
import './scope-toggle';
import './bot-group-toggle';
import type { TimeScope } from './scope-toggle';
import type { CommitEvent, TimelineData } from '../types';

const AUTOMATED = 'Automated';

export class CommitLog extends LitElement {
  static properties = {
    data: { attribute: false },
    currentTime: { type: Number },
    query: { state: true },
    author: { state: true },
    sortBy: { state: true },
    sortDir: { state: true },
    scope: { state: true },
    groupBots: { state: true },
  };

  declare data: TimelineData | null;
  declare currentTime: number;
  declare query: string;
  declare author: string;
  declare sortBy: CommitSortKey;
  declare sortDir: SortDirection;
  declare scope: TimeScope;
  /** Whether bot/AI-model authors (see lib/bot-authors.ts) are folded into
   *  one "Automated" entry in the author filter and in each row's author
   *  cell. Defaults to grouped, matching the leaderboard's default. */
  declare groupBots: boolean;

  constructor() {
    super();
    this.query = '';
    this.author = '';
    this.sortBy = 'date';
    this.sortDir = 'desc';
    this.scope = 'all-time';
    this.groupBots = true;
  }

  // A log reads correctly as dense, monospaced, terminal-like — the
  // redesign here is sharpening that register (real hash fragments, a
  // sort-direction arrow, a glowing left rail for "where playback is right
  // now"), not fighting the table format the way the leaderboard needed to.
  static styles = css`
    :host {
      display: block;
      width: 100%;
      height: 100%;
      overflow: hidden;
      padding: 88px 28px 20px;
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
      font-family: var(--font-mono, monospace);
    }
    .controls {
      flex: none;
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 14px;
      font-size: 11.5px;
    }
    input,
    select {
      font-family: inherit;
      font-size: inherit;
      background: var(--panel, #0d1424);
      color: var(--paper, #e7edf5);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      padding: 7px 10px;
    }
    input {
      flex: 1;
      max-width: 320px;
    }
    input:focus-visible,
    select:focus-visible {
      outline: none;
      border-color: var(--thread, #2fe6b8);
      box-shadow: 0 0 0 1px var(--thread, #2fe6b8);
    }
    .count {
      margin-left: auto;
      color: var(--mist, #55617a);
      letter-spacing: 0.04em;
    }
    .table-wrap {
      flex: 1;
      overflow: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    th,
    td {
      text-align: left;
      padding: 7px 12px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      white-space: nowrap;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--void, #060810);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.09em;
      color: var(--mist, #55617a);
      cursor: pointer;
      user-select: none;
    }
    th:hover {
      color: var(--paper, #e7edf5);
    }
    th.active {
      color: var(--thread, #2fe6b8);
    }
    th .arrow {
      display: inline-block;
      margin-left: 3px;
      opacity: 0.85;
    }
    tr {
      cursor: pointer;
      border-left: 2px solid transparent;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.03);
    }
    tr.current {
      border-left-color: var(--flare, #ff8a5c);
    }
    tr.current td {
      background: rgba(255, 138, 92, 0.08);
    }
    td.hash {
      color: var(--mist, #55617a);
      letter-spacing: 0.02em;
    }
    td.message {
      white-space: normal;
      max-width: 460px;
      font-family: var(--font-body, sans-serif);
      color: var(--paper, #e7edf5);
    }
    td.lines {
      font-variant-numeric: tabular-nums;
    }
    .add {
      color: var(--thread, #2fe6b8);
    }
    .rm {
      color: var(--flare, #ff8a5c);
    }
    .author-swatch {
      display: inline-block;
      width: 7px;
      height: 7px;
      border-radius: 50%;
      margin-right: 7px;
    }
    .empty {
      color: var(--mist, #55617a);
      padding: 40px;
      font-family: var(--font-body, sans-serif);
    }
  `;

  private handleQuery = (event: Event): void => {
    this.query = (event.target as HTMLInputElement).value;
  };

  private handleAuthor = (event: Event): void => {
    this.author = (event.target as HTMLSelectElement).value;
  };

  private handleScopeChange = (event: CustomEvent<{ scope: TimeScope }>): void => {
    this.scope = event.detail.scope;
  };

  private handleBotGroupChange = (event: CustomEvent<{ grouped: boolean }>): void => {
    this.groupBots = event.detail.grouped;
    // The previously-selected individual bot (or the "Automated" sentinel)
    // has no matching option in the other mode's dropdown — reset rather
    // than silently filtering to a value that no longer appears anywhere.
    if (this.author === AUTOMATED || (this.groupBots && isBotAuthor(this.author))) {
      this.author = '';
    }
  };

  private handleSort(key: CommitSortKey): void {
    if (this.sortBy === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortBy = key;
      this.sortDir = 'desc';
    }
  }

  private seekTo(index: number): void {
    this.dispatchEvent(new CustomEvent('seek', { detail: { index }, bubbles: true, composed: true }));
  }

  render() {
    if (!this.data || this.data.timeline.length === 0) {
      return html`<div class="empty">No commits to show.</div>`;
    }

    const indexByCommit = new Map<CommitEvent, number>(this.data.timeline.map((c, i) => [c, i]));
    const scopedTimeline = this.scope === 'as-of' ? timelineUpTo(this.data.timeline, this.currentTime) : this.data.timeline;

    const allAuthors = Object.keys(this.data.contributors).sort();
    const hasBots = allAuthors.some(isBotAuthor);
    const authors =
      this.groupBots && hasBots
        ? [...allAuthors.filter((a) => !isBotAuthor(a)), AUTOMATED]
        : allAuthors;

    const base =
      this.groupBots && this.author === AUTOMATED ? scopedTimeline.filter((c) => isBotAuthor(c.author)) : scopedTimeline;
    const filtered = filterCommits(base, {
      author: this.author && this.author !== AUTOMATED ? this.author : undefined,
      query: this.query,
    });
    const sorted = sortCommits(filtered, this.sortBy, this.sortDir);
    const colorFor = contributorColorScale(this.data);

    return html`
      <div class="controls">
        <input type="search" placeholder="Search message or file…" .value=${this.query} @input=${this.handleQuery} />
        <select .value=${this.author} @change=${this.handleAuthor}>
          <option value="">All authors</option>
          ${authors.map((a) => html`<option value=${a}>${a}</option>`)}
        </select>
        <bot-group-toggle .grouped=${this.groupBots} @bot-group-change=${this.handleBotGroupChange}></bot-group-toggle>
        <scope-toggle .scope=${this.scope} @scope-change=${this.handleScopeChange}></scope-toggle>
        <span class="count">${sorted.length} / ${scopedTimeline.length}</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th data-sort-key="date" class=${this.sortBy === 'date' ? 'active' : ''} @click=${() => this.handleSort('date')}>
                Date${this.sortIndicator('date')}
              </th>
              <th>Hash</th>
              <th>Author</th>
              <th>Message</th>
              <th
                data-sort-key="filesChanged"
                class=${this.sortBy === 'filesChanged' ? 'active' : ''}
                @click=${() => this.handleSort('filesChanged')}
              >
                Files${this.sortIndicator('filesChanged')}
              </th>
              <th
                data-sort-key="linesChanged"
                class=${this.sortBy === 'linesChanged' ? 'active' : ''}
                @click=${() => this.handleSort('linesChanged')}
              >
                Lines${this.sortIndicator('linesChanged')}
              </th>
            </tr>
          </thead>
          <tbody>
            ${repeat(
              sorted,
              (c) => c.commit_hash,
              (c) => {
                const index = indexByCommit.get(c) ?? -1;
                const isBot = this.groupBots && isBotAuthor(c.author);
                const authorColor = isBot ? 'var(--bloom, #c792ff)' : colorFor(c.author);
                const authorLabel = isBot ? AUTOMATED : c.author;
                return html`
                  <tr class=${index === this.currentTime ? 'current' : ''} @click=${() => this.seekTo(index)}>
                    <td>${new Date(c.timestamp * 1000).toLocaleDateString()}</td>
                    <td class="hash">${c.commit_hash.slice(0, 7)}</td>
                    <td>
                      <span class="author-swatch" style="background:${authorColor}; box-shadow: 0 0 5px ${authorColor}"></span
                      ><span title=${isBot ? c.author : ''}>${authorLabel}</span>
                    </td>
                    <td class="message">${c.message.split('\n')[0]}</td>
                    <td>${c.files_changed?.length ?? 0}</td>
                    <td class="lines"><span class="add">+${c.lines_added}</span> <span class="rm">−${c.lines_removed}</span></td>
                  </tr>
                `;
              }
            )}
          </tbody>
        </table>
      </div>
    `;
  }

  private sortIndicator(key: CommitSortKey) {
    if (this.sortBy !== key) return null;
    return html`<span class="arrow">${this.sortDir === 'desc' ? '↓' : '↑'}</span>`;
  }
}

customElements.define('commit-log', CommitLog);

declare global {
  interface HTMLElementTagNameMap {
    'commit-log': CommitLog;
  }
}
