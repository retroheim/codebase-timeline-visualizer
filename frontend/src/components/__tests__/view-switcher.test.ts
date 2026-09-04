import { afterEach, describe, expect, it } from 'vitest';
import '../view-switcher';
import type { ViewSwitcher } from '../view-switcher';
import { VIEW_MODES } from '../../lib/route';
import { mount, unmount } from './fixtures';

describe('view-switcher', () => {
  let el: ViewSwitcher | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('renders one button per view mode', async () => {
    el = await mount<ViewSwitcher>('view-switcher', { mode: 'tree', disabled: false });
    const buttons = el.shadowRoot?.querySelectorAll('button');
    expect(buttons).toHaveLength(VIEW_MODES.length);
  });

  it('marks the current mode active', async () => {
    el = await mount<ViewSwitcher>('view-switcher', { mode: 'growth', disabled: false });
    const active = el.shadowRoot?.querySelector('button.active');
    expect(active?.textContent?.trim()).toBe('Growth');
  });

  it('dispatches view-change when a different mode is clicked', async () => {
    el = await mount<ViewSwitcher>('view-switcher', { mode: 'tree', disabled: false });
    const events: string[] = [];
    el.addEventListener('view-change', (e) => events.push((e as CustomEvent<{ mode: string }>).detail.mode));

    const buttons = Array.from(el.shadowRoot!.querySelectorAll('button'));
    const calendarButton = buttons.find((b) => b.textContent?.trim() === 'Calendar');
    calendarButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual(['calendar']);
  });

  it('does not dispatch when disabled', async () => {
    el = await mount<ViewSwitcher>('view-switcher', { mode: 'tree', disabled: true });
    const events: unknown[] = [];
    el.addEventListener('view-change', () => events.push(1));

    const buttons = el.shadowRoot?.querySelectorAll('button');
    buttons?.forEach((b) => expect(b.hasAttribute('disabled')).toBe(true));
    buttons![1].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(0);
  });

  it('does not re-dispatch for clicking the already-active mode', async () => {
    el = await mount<ViewSwitcher>('view-switcher', { mode: 'tree', disabled: false });
    const events: unknown[] = [];
    el.addEventListener('view-change', () => events.push(1));

    const active = el.shadowRoot?.querySelector('button.active');
    active!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(0);
  });
});
