import { LitElement, html, css } from 'lit';

export type TimeScope = 'all-time' | 'as-of';

/**
 * Shared by every whole-history-by-default view (calendar, leaderboard,
 * treemap, commit log) that can also show numbers "as of" the playback
 * scrubber's current position instead. A single small component rather than
 * four near-identical inline toggles, since the behavior (and the choice of
 * which is the honest default) needs to stay in sync across all of them.
 */
export class ScopeToggle extends LitElement {
  static properties = {
    scope: { type: String },
  };

  declare scope: TimeScope;

  constructor() {
    super();
    this.scope = 'all-time';
  }

  static styles = css`
    :host {
      display: inline-flex;
      border-radius: 7px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    button {
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 6px 10px;
      border: none;
      background: transparent;
      color: var(--mist, #55617a);
      cursor: pointer;
    }
    button + button {
      border-left: 1px solid rgba(255, 255, 255, 0.1);
    }
    button:hover {
      color: var(--paper, #e7edf5);
    }
    button.active {
      background: rgba(47, 230, 184, 0.14);
      color: var(--thread, #2fe6b8);
    }
  `;

  private select(scope: TimeScope): void {
    if (scope === this.scope) return;
    this.dispatchEvent(new CustomEvent<{ scope: TimeScope }>('scope-change', { detail: { scope }, bubbles: true, composed: true }));
  }

  render() {
    return html`
      <button class=${this.scope === 'all-time' ? 'active' : ''} @click=${() => this.select('all-time')}>All time</button>
      <button class=${this.scope === 'as-of' ? 'active' : ''} @click=${() => this.select('as-of')}>As of now</button>
    `;
  }
}

customElements.define('scope-toggle', ScopeToggle);

declare global {
  interface HTMLElementTagNameMap {
    'scope-toggle': ScopeToggle;
  }
}
