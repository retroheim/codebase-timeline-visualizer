import { afterEach, describe, expect, it, vi } from 'vitest';
import '../churn-treemap';
import type { ChurnTreemap } from '../churn-treemap';
import { emptyTimelineData, mount, sampleTimelineData, unmount } from './fixtures';
import * as asOfLib from '../../lib/as-of';
import type { CommitEvent, FileChange, FileStat, TimelineData } from '../../types';

/** One commit that adds a single file, for building a fixture with a lot
 *  of small low-churn files under one directory alongside one dominant
 *  file — enough imbalance that the small directory's own treemap rect
 *  shrinks below MIN_VISIBLE_AREA even on a small canvas. */
function addFileCommit(path: string, linesAdded: number, timestamp: number): CommitEvent {
  const change: FileChange = {
    filename: path.split('/').pop() ?? path,
    old_path: null,
    new_path: path,
    change_type: 'ADD',
    lines_added: linesAdded,
    lines_removed: 0,
  };
  return {
    timestamp,
    datetime: new Date(timestamp * 1000).toISOString(),
    commit_hash: `h${timestamp}`,
    author: 'a',
    message: `add ${path}`,
    files_changed: [change],
    lines_added: linesAdded,
    lines_removed: 0,
    cumulative_lines: linesAdded,
    cumulative_files: 1,
  };
}

/** A dominant file plus a cluster of tiny files under one directory — the
 *  tiny directory's churn share is small enough that its combined treemap
 *  rect falls under MIN_VISIBLE_AREA (340px²) even at a modest canvas
 *  size, forcing `pickVisibleNodes` to aggregate it into one directory
 *  rect instead of five file leaves. */
function lopsidedTreemapData(): TimelineData {
  const big = addFileCommit('big.ts', 3000, 1000);
  const tinyPaths = ['tiny/a.ts', 'tiny/b.ts', 'tiny/c.ts', 'tiny/d.ts', 'tiny/e.ts'];
  const tinyCommits = tinyPaths.map((path, i) => addFileCommit(path, 1, 1001 + i));
  const timeline = [big, ...tinyCommits];

  const files: Record<string, FileStat> = {
    'big.ts': { changes: 1, lines_added: 3000, lines_removed: 0, authors: ['a'], first_change: 1000, last_change: 1000 },
  };
  tinyPaths.forEach((path, i) => {
    files[path] = { changes: 1, lines_added: 1, lines_removed: 0, authors: ['a'], first_change: 1001 + i, last_change: 1001 + i };
  });

  return {
    metadata: {
      schema_version: 1,
      repo_name: 'lopsided',
      github_repo: null,
      total_commits: timeline.length,
      total_contributors: 1,
      total_files: Object.keys(files).length,
      date_range: { start: timeline[0].datetime, end: timeline[timeline.length - 1].datetime },
    },
    timeline,
    contributors: {
      a: { email: 'a@example.com', commits: timeline.length, lines_added: 3005, lines_removed: 0, files_changed: 6, first_commit: 1000, last_commit: 1005 },
    },
    files,
  };
}

describe('churn-treemap', () => {
  let el: ChurnTreemap | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('shows an empty state for a timeline with no commits', async () => {
    el = await mount<ChurnTreemap>('churn-treemap', { data: emptyTimelineData() });
    expect(el.shadowRoot?.textContent).toContain('No commits to show');
    expect(el.shadowRoot?.querySelector('svg')).toBeNull();
  });

  it('renders one leaf rect per file, sized by total churn by default', async () => {
    el = await mount<ChurnTreemap>('churn-treemap', { data: sampleTimelineData() });
    const rects = Array.from(el.shadowRoot?.querySelectorAll('rect.leaf') ?? []);
    // 3 files in the fixture, none clustered (well under the threshold).
    expect(rects).toHaveLength(3);

    const area = (r: Element) => Number(r.getAttribute('width')) * Number(r.getAttribute('height'));
    const byName = (name: string) => {
      const rect = rects.find((r) => r.querySelector('title')?.textContent?.includes(name));
      expect(rect, `no leaf rect found for ${name}`).toBeDefined();
      return rect!;
    };

    // widget.ts has the most churn (23 added + 2 removed = 25), index.ts the
    // least (10) — the metric should actually drive relative sizing, not
    // just produce *some* positive area regardless of the numbers.
    const widget = area(byName('widget.ts'));
    const index = area(byName('index.ts'));
    const readme = area(byName('readme.md'));
    expect(widget).toBeGreaterThan(readme);
    expect(widget).toBeGreaterThan(index);
    expect(index).toBeGreaterThan(readme);
  });

  it('re-lays-out when the metric selector changes', async () => {
    el = await mount<ChurnTreemap>('churn-treemap', { data: sampleTimelineData() });
    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();

    const before = Array.from(el.shadowRoot!.querySelectorAll('rect.leaf')).map((r) => r.getAttribute('width'));

    select.value = 'linesRemoved';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await el.updateComplete;

    const after = Array.from(el.shadowRoot!.querySelectorAll('rect.leaf')).map((r) => r.getAttribute('width'));
    expect(after).not.toEqual(before);
  });

  it('scopes to files touched up to currentTime once switched to "as of now"', async () => {
    // sampleTimelineData: commit 0 only touches src/index.ts.
    el = await mount<ChurnTreemap>('churn-treemap', { data: sampleTimelineData(), currentTime: 0 });
    expect(el.shadowRoot?.querySelectorAll('rect.leaf')).toHaveLength(3);

    const toggle = el.shadowRoot!.querySelector('scope-toggle')!;
    toggle.dispatchEvent(new CustomEvent('scope-change', { detail: { scope: 'as-of' }, bubbles: true }));
    await el.updateComplete;

    const rects = el.shadowRoot?.querySelectorAll('rect.leaf');
    expect(rects).toHaveLength(1);
    expect(rects![0].querySelector('title')?.textContent).toContain('index.ts');
  });

  it('does not recompute file stats for sub-integer currentTime ticks within the same commit', async () => {
    const spy = vi.spyOn(asOfLib, 'fileStatsAsOf');
    el = await mount<ChurnTreemap>('churn-treemap', {
      data: sampleTimelineData(),
      currentTime: 0,
      scope: 'as-of',
    } as Partial<ChurnTreemap>);
    const callsAfterMount = spy.mock.calls.length;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Playback advances currentTime fractionally every frame — sub-integer
    // moves within the same floored commit index must be free.
    el.currentTime = 0.4;
    await el.updateComplete;
    el.currentTime = 0.8;
    await el.updateComplete;
    expect(spy.mock.calls.length).toBe(callsAfterMount);

    // Crossing into a new commit index must still recompute.
    el.currentTime = 1;
    await el.updateComplete;
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterMount);

    spy.mockRestore();
  });

  it('aggregates a low-churn directory into one dir rect instead of one leaf per file', async () => {
    el = await mount<ChurnTreemap>('churn-treemap', {
      data: lopsidedTreemapData(),
      width: 2000,
      height: 60,
    } as Partial<ChurnTreemap>);

    const rects = Array.from(el.shadowRoot?.querySelectorAll('rect.leaf') ?? []);
    // 6 real files (big.ts + 5 under tiny/), but tiny/'s combined rect is
    // small enough to aggregate — one rect for big.ts, one for tiny/.
    expect(rects).toHaveLength(2);

    const aggregated = rects.find((r) => r.querySelector('title')?.textContent?.includes('5 files'));
    expect(aggregated, `expected an aggregated dir rect, got: ${rects.map((r) => r.querySelector('title')?.textContent)}`).toBeDefined();

    const leaf = rects.find((r) => r.querySelector('title')?.textContent?.includes('big.ts'));
    expect(leaf).toBeDefined();
    expect(leaf!.querySelector('title')?.textContent).toContain('1 file');
  });
});
