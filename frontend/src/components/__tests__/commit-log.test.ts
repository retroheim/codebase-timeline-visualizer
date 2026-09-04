import { afterEach, describe, expect, it } from 'vitest';
import '../commit-log';
import type { CommitLog } from '../commit-log';
import { emptyTimelineData, mount, sampleTimelineData, unmount } from './fixtures';
import { makeCommit } from '../../lib/__tests__/commit-fixture';
import type { TimelineData } from '../../types';

function addContributor(data: TimelineData, author: string): void {
  data.contributors[author] = { email: '', commits: 1, lines_added: 1, lines_removed: 0, files_changed: 1, first_commit: 0, last_commit: 0 };
}

describe('commit-log', () => {
  let el: CommitLog | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('shows an empty state for a timeline with no commits', async () => {
    el = await mount<CommitLog>('commit-log', { data: emptyTimelineData(), currentTime: 0 });
    expect(el.shadowRoot?.textContent).toContain('No commits to show');
    expect(el.shadowRoot?.querySelector('table')).toBeNull();
  });

  it('renders one row per commit, newest first by default', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    expect(rows![0].textContent).toContain('fix widget bug');
    expect(rows![2].textContent).toContain('init project');
  });

  it('filters rows by the search query against message and filename', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const input = el.shadowRoot?.querySelector('input[type="search"]') as HTMLInputElement;
    input.value = 'readme';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows![0].textContent).toContain('add widget');
  });

  it('filters rows by author', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'Bob';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows![0].textContent).toContain('Bob');
  });

  it('dispatches a seek event with the commit index when a row is clicked', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const seekEvents: number[] = [];
    el.addEventListener('seek', (e) => seekEvents.push((e as CustomEvent<{ index: number }>).detail.index));

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    // Newest-first: row 0 is the third (index 2) commit.
    rows![0].dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(seekEvents).toEqual([2]);
  });

  it('sorts by a different column when its header is clicked, defaulting to descending', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const filesHeader = el.shadowRoot!.querySelector('th[data-sort-key="filesChanged"]');
    filesHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.sortBy).toBe('filesChanged');
    expect(el.sortDir).toBe('desc');
  });

  it('sorts by lines changed when the Lines header is clicked', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const linesHeader = el.shadowRoot!.querySelector('th[data-sort-key="linesChanged"]');
    linesHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.sortBy).toBe('linesChanged');
  });

  it('clicking the same header again flips sort direction', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    const dateHeader = el.shadowRoot!.querySelector('th[data-sort-key="date"]');
    // Default sortBy is already 'date' — one click flips desc -> asc.
    dateHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.sortBy).toBe('date');
    expect(el.sortDir).toBe('asc');
    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows![0].textContent).toContain('init project');
  });

  it('scopes the list to commits up to currentTime once switched to "as of now"', async () => {
    el = await mount<CommitLog>('commit-log', { data: sampleTimelineData(), currentTime: 0 });
    expect(el.shadowRoot?.querySelectorAll('tbody tr')).toHaveLength(3);

    const toggle = el.shadowRoot!.querySelector('scope-toggle')!;
    toggle.dispatchEvent(new CustomEvent('scope-change', { detail: { scope: 'as-of' }, bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(1);
    expect(rows![0].textContent).toContain('init project');
  });

  it('defaults to labeling a bot-authored commit "Automated" and offers it as a filter option', async () => {
    const data = sampleTimelineData();
    data.timeline = [...data.timeline, makeCommit({ author: 'Claude Opus 5', timestamp: 99999, message: 'automated cleanup' })];
    addContributor(data, 'Claude Opus 5');
    el = await mount<CommitLog>('commit-log', { data });

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    const botRow = Array.from(rows!).find((r) => r.textContent?.includes('automated cleanup'));
    expect(botRow?.querySelector('td:nth-child(3)')?.textContent).toContain('Automated');
    expect(botRow?.textContent).not.toContain('Claude Opus 5');

    const options = Array.from(el.shadowRoot!.querySelectorAll('select option')).map((o) => o.textContent);
    expect(options).toContain('Automated');
    expect(options).not.toContain('Claude Opus 5');
  });

  it('filtering by Automated shows every bot commit regardless of which bot authored it', async () => {
    const data = sampleTimelineData();
    data.timeline = [
      ...data.timeline,
      makeCommit({ author: 'Claude Opus 5', timestamp: 99999, message: 'claude commit' }),
      makeCommit({ author: 'blacksmith-sh[bot]', timestamp: 99998, message: 'blacksmith commit' }),
    ];
    addContributor(data, 'Claude Opus 5');
    addContributor(data, 'blacksmith-sh[bot]');
    el = await mount<CommitLog>('commit-log', { data });

    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'Automated';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('tbody')?.textContent).toContain('claude commit');
    expect(el.shadowRoot?.querySelector('tbody')?.textContent).toContain('blacksmith commit');
  });

  it('switching to Individual restores each bot\'s real name and resets an Automated filter', async () => {
    const data = sampleTimelineData();
    data.timeline = [...data.timeline, makeCommit({ author: 'Claude Opus 5', timestamp: 99999, message: 'automated cleanup' })];
    addContributor(data, 'Claude Opus 5');
    el = await mount<CommitLog>('commit-log', { data });

    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    select.value = 'Automated';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;
    expect(el.author).toBe('Automated');

    const toggle = el.shadowRoot!.querySelector('bot-group-toggle')!;
    toggle.dispatchEvent(new CustomEvent('bot-group-change', { detail: { grouped: false }, bubbles: true }));
    await el.updateComplete;

    // The Automated filter no longer means anything once ungrouped — it
    // must reset rather than silently matching nothing.
    expect(el.author).toBe('');
    const rows = el.shadowRoot?.querySelectorAll('tbody tr');
    const botRow = Array.from(rows!).find((r) => r.textContent?.includes('automated cleanup'));
    expect(botRow?.querySelector('td:nth-child(3)')?.textContent).toContain('Claude Opus 5');

    const options = Array.from(el.shadowRoot!.querySelectorAll('select option')).map((o) => o.textContent);
    expect(options).toContain('Claude Opus 5');
    expect(options).not.toContain('Automated');
  });
});
