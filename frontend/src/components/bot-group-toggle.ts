import { LitElement, html, css } from 'lit';

/**
 * Shared by every view that shows individual contributors (leaderboard,
 * commit log, the radial tree's avatar ring) and can instead fold bot/
 * AI-model contributors into one "Automated" entry — see
 * lib/bot-authors.ts. A single small component rather than a near-identical
 * inline toggle per view, since the choice (and its default) needs to stay
 * in sync across all of them, same reasoning as `<scope-toggle>`.
 */
export class BotGroupToggle extends LitElement {
  static properties = {
    grouped: { type: Boolean },
  };

  declare grouped: boolean;

  constructor() {
    super();
    this.grouped = true;
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
      background: rgba(199, 146, 255, 0.14);
      color: var(--bloom, #c792ff);
    }
  `;

  private select(grouped: boolean): void {
    if (grouped === this.grouped) return;
    this.dispatchEvent(
      new CustomEvent<{ grouped: boolean }>('bot-group-change', { detail: { grouped }, bubbles: true, composed: true })
    );
  }

  render() {
    return html`
      <button
        class=${this.grouped ? 'active' : ''}
        title="Group bot/AI-model contributors into one 'Automated' entry"
        @click=${() => this.select(true)}
      >
        Automated
      </button>
      <button class=${!this.grouped ? 'active' : ''} title="Show every contributor individually" @click=${() => this.select(false)}>
        Individual
      </button>
    `;
  }
}

customElements.define('bot-group-toggle', BotGroupToggle);

declare global {
  interface HTMLElementTagNameMap {
    'bot-group-toggle': BotGroupToggle;
  }
}
