import { LitElement, html, css } from 'lit';
import { VIEW_MODES, type ViewMode } from '../lib/route';

export class ViewSwitcher extends LitElement {
  static properties = {
    mode: { type: String },
    disabled: { type: Boolean },
  };

  declare mode: ViewMode;
  declare disabled: boolean;

  // Instrument-panel channel selector, not a SaaS tab bar: uppercase mono
  // labels (same register as the "N COMMITS" wordmark caption) separated by
  // hairlines, with a glowing underline on the active channel instead of a
  // filled pill — quieter than a solid background, so it doesn't compete
  // with whichever view is actually on screen.
  static styles = css`
    :host {
      display: flex;
      align-items: stretch;
      background: rgba(13, 20, 36, 0.68);
      backdrop-filter: blur(18px) saturate(140%);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      overflow: hidden;
    }
    button {
      position: relative;
      font-family: var(--font-mono, monospace);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      padding: 9px 13px 8px;
      border: none;
      border-right: 1px solid rgba(255, 255, 255, 0.06);
      background: transparent;
      color: var(--mist, #55617a);
      cursor: pointer;
      transition: color 0.15s ease;
    }
    button:last-child {
      border-right: none;
    }
    button::after {
      content: '';
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 0;
      height: 1.5px;
      background: var(--thread, #2fe6b8);
      box-shadow: var(--glow-thread, none);
      transform: scaleX(0);
      transition: transform 0.2s ease;
    }
    button:hover:not(:disabled) {
      color: var(--paper, #e7edf5);
    }
    button.active {
      color: var(--paper, #e7edf5);
    }
    button.active::after {
      transform: scaleX(1);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.35;
    }
    @media (prefers-reduced-motion: reduce) {
      button::after {
        transition: none;
      }
    }
  `;

  private select(mode: ViewMode): void {
    if (this.disabled || mode === this.mode) return;
    this.dispatchEvent(new CustomEvent<{ mode: ViewMode }>('view-change', { detail: { mode }, bubbles: true, composed: true }));
  }

  render() {
    return html`
      ${VIEW_MODES.map(
        (v) => html`
          <button class=${v.mode === this.mode ? 'active' : ''} ?disabled=${this.disabled} @click=${() => this.select(v.mode)}>
            ${v.label}
          </button>
        `
      )}
    `;
  }
}

customElements.define('view-switcher', ViewSwitcher);

declare global {
  interface HTMLElementTagNameMap {
    'view-switcher': ViewSwitcher;
  }
}
