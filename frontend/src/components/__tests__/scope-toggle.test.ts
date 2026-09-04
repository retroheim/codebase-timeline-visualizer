import { afterEach, describe, expect, it } from 'vitest';
import '../scope-toggle';
import type { ScopeToggle } from '../scope-toggle';
import { mount, unmount } from './fixtures';

describe('scope-toggle', () => {
  let el: ScopeToggle | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('defaults to all-time and marks it active', async () => {
    el = await mount<ScopeToggle>('scope-toggle');
    expect(el.scope).toBe('all-time');
    const active = el.shadowRoot?.querySelector('button.active');
    expect(active?.textContent).toContain('All time');
  });

  it('dispatches scope-change when the other option is clicked', async () => {
    el = await mount<ScopeToggle>('scope-toggle');
    const events: string[] = [];
    el.addEventListener('scope-change', (e) => events.push((e as CustomEvent<{ scope: string }>).detail.scope));

    const buttons = el.shadowRoot!.querySelectorAll('button');
    const asOf = Array.from(buttons).find((b) => b.textContent?.includes('As of now'));
    asOf!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toEqual(['as-of']);
  });

  it('does not dispatch when clicking the already-active option', async () => {
    el = await mount<ScopeToggle>('scope-toggle', { scope: 'as-of' } as Partial<ScopeToggle>);
    const events: unknown[] = [];
    el.addEventListener('scope-change', () => events.push(1));

    const buttons = el.shadowRoot!.querySelectorAll('button');
    const asOf = Array.from(buttons).find((b) => b.textContent?.includes('As of now'));
    asOf!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(events).toHaveLength(0);
  });
});
