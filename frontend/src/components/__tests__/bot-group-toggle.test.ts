import { afterEach, describe, expect, it } from 'vitest';
import '../bot-group-toggle';
import type { BotGroupToggle } from '../bot-group-toggle';
import { mount, unmount } from './fixtures';

describe('bot-group-toggle', () => {
  let el: BotGroupToggle | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('defaults to grouped and marks Automated active', async () => {
    el = await mount<BotGroupToggle>('bot-group-toggle');
    expect(el.grouped).toBe(true);
    const active = el.shadowRoot?.querySelector('button.active');
    expect(active?.textContent).toContain('Automated');
  });

  it('dispatches bot-group-change when Individual is clicked', async () => {
    el = await mount<BotGroupToggle>('bot-group-toggle');
    const events: boolean[] = [];
    el.addEventListener('bot-group-change', (e) => events.push((e as CustomEvent<{ grouped: boolean }>).detail.grouped));

    const buttons = el.shadowRoot!.querySelectorAll('button');
    const individual = Array.from(buttons).find((b) => b.textContent?.includes('Individual'));
    individual!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual([false]);
  });

  it('does not dispatch when clicking the already-active option', async () => {
    el = await mount<BotGroupToggle>('bot-group-toggle', { grouped: false } as Partial<BotGroupToggle>);
    const events: unknown[] = [];
    el.addEventListener('bot-group-change', () => events.push(1));

    const buttons = el.shadowRoot!.querySelectorAll('button');
    const individual = Array.from(buttons).find((b) => b.textContent?.includes('Individual'));
    individual!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(0);
  });
});
