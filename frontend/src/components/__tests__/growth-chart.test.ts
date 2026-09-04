import { afterEach, describe, expect, it } from 'vitest';
import '../growth-chart';
import type { GrowthChart } from '../growth-chart';
import { emptyTimelineData, mount, sampleTimelineData, unmount } from './fixtures';

describe('growth-chart', () => {
  let el: GrowthChart | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('shows an empty state for a timeline with no commits', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: emptyTimelineData(), currentTime: 0 });
    expect(el.shadowRoot?.textContent).toContain('No commits to show');
    expect(el.shadowRoot?.querySelector('svg')).toBeNull();
  });

  it('draws a non-empty area and line path for real data', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: sampleTimelineData(), currentTime: 0 });
    const area = el.shadowRoot?.querySelector('path.area');
    const line = el.shadowRoot?.querySelector('path.line');
    expect(area?.getAttribute('d')).toBeTruthy();
    expect(line?.getAttribute('d')).toBeTruthy();
  });

  it('positions the playhead at the current commit and moves it when currentTime changes', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: sampleTimelineData(), currentTime: 0 });
    const playhead = el.shadowRoot?.querySelector('line.playhead-line');
    const firstX = playhead?.getAttribute('x1');
    expect(firstX).toBeTruthy();

    el.currentTime = 2;
    await el.updateComplete;
    const secondX = el.shadowRoot?.querySelector('line.playhead-line')?.getAttribute('x1');
    expect(secondX).toBeTruthy();
    expect(secondX).not.toBe(firstX);
  });

  it('dispatches a seek event with the nearest commit index on pointerdown', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: sampleTimelineData(), currentTime: 0 });
    const seekEvents: number[] = [];
    el.addEventListener('seek', (e) => seekEvents.push((e as CustomEvent<{ index: number }>).detail.index));

    const overlay = el.shadowRoot?.querySelector('rect.overlay');
    expect(overlay).not.toBeNull();
    overlay!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 500, clientY: 200 }));

    expect(seekEvents).toHaveLength(1);
    expect(seekEvents[0]).toBeGreaterThanOrEqual(0);
    expect(seekEvents[0]).toBeLessThanOrEqual(2);
  });

  it('does not seek on a plain hover (pointermove with no button pressed)', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: sampleTimelineData(), currentTime: 0 });
    const seekEvents: number[] = [];
    el.addEventListener('seek', (e) => seekEvents.push((e as CustomEvent<{ index: number }>).detail.index));

    const overlay = el.shadowRoot?.querySelector('rect.overlay');
    overlay!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 0, clientX: 500, clientY: 200 }));

    expect(seekEvents).toHaveLength(0);
  });

  it('does seek on a pointermove while dragging (a button held)', async () => {
    el = await mount<GrowthChart>('growth-chart', { data: sampleTimelineData(), currentTime: 0 });
    const seekEvents: number[] = [];
    el.addEventListener('seek', (e) => seekEvents.push((e as CustomEvent<{ index: number }>).detail.index));

    const overlay = el.shadowRoot?.querySelector('rect.overlay');
    overlay!.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: 500, clientY: 200 }));

    expect(seekEvents).toHaveLength(1);
  });
});
