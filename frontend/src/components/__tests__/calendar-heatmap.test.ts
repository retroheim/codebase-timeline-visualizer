import { afterEach, describe, expect, it } from 'vitest';
import '../calendar-heatmap';
import type { CalendarHeatmap } from '../calendar-heatmap';
import { emptyTimelineData, mount, sampleTimelineData, unmount } from './fixtures';

describe('calendar-heatmap', () => {
  let el: CalendarHeatmap | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('shows an empty state for a timeline with no commits', async () => {
    el = await mount<CalendarHeatmap>('calendar-heatmap', { data: emptyTimelineData() });
    expect(el.shadowRoot?.textContent).toContain('No commits to show');
    expect(el.shadowRoot?.querySelector('svg')).toBeNull();
  });

  it('renders one day cell per day in the gap-filled range', async () => {
    el = await mount<CalendarHeatmap>('calendar-heatmap', { data: sampleTimelineData() });
    const svg = el.shadowRoot?.querySelector('svg');
    expect(svg).not.toBeNull();
    const days = el.shadowRoot?.querySelectorAll('rect.day');
    // Full weeks are gap-filled, so there are at least as many cells as
    // distinct commit days (3) and a multiple of 7 in total.
    expect(days?.length).toBeGreaterThanOrEqual(3);
    expect(days!.length % 7).toBe(0);
  });

  it('dispatches a seek event with the last commit index for the clicked day', async () => {
    el = await mount<CalendarHeatmap>('calendar-heatmap', { data: sampleTimelineData() });
    const seekEvents: number[] = [];
    el.addEventListener('seek', (e) => seekEvents.push((e as CustomEvent<{ index: number }>).detail.index));

    const populatedDay = Array.from(el.shadowRoot!.querySelectorAll('rect.day')).find((rect) =>
      /: [1-9]\d* commits?$/.test(rect.querySelector('title')?.textContent ?? '')
    );
    expect(populatedDay).toBeDefined();
    (populatedDay as SVGRectElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(seekEvents).toHaveLength(1);
    expect(seekEvents[0]).toBeGreaterThanOrEqual(0);
  });

  it('does not dispatch seek for a gap day with no commits', async () => {
    el = await mount<CalendarHeatmap>('calendar-heatmap', { data: sampleTimelineData() });
    const seekEvents: unknown[] = [];
    el.addEventListener('seek', () => seekEvents.push(1));

    const emptyDay = Array.from(el.shadowRoot!.querySelectorAll('rect.day')).find((rect) =>
      rect.querySelector('title')?.textContent?.includes('0 commits')
    );
    expect(emptyDay).toBeDefined();
    (emptyDay as SVGRectElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(seekEvents).toHaveLength(0);
  });

  it('defaults to all-time and switches to "as of now" scoping via the toggle', async () => {
    // sampleTimelineData has 3 commits on 3 distinct days.
    el = await mount<CalendarHeatmap>('calendar-heatmap', { data: sampleTimelineData(), currentTime: 0 });
    const statValue = () => el!.shadowRoot!.querySelector('.stat-value')?.textContent;
    expect(statValue()).toBe('3');

    const toggle = el.shadowRoot!.querySelector('scope-toggle')!;
    toggle.dispatchEvent(new CustomEvent('scope-change', { detail: { scope: 'as-of' }, bubbles: true }));
    await el.updateComplete;

    // Only the first commit (index 0) has "happened" as of currentTime=0.
    expect(statValue()).toBe('1');
  });
});
