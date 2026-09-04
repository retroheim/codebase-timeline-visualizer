import { afterEach, describe, expect, it, vi } from 'vitest';
import '../contributor-leaderboard';
import type { ContributorLeaderboard } from '../contributor-leaderboard';
import { emptyTimelineData, mount, sampleTimelineData, unmount } from './fixtures';
import * as contributorStatsLib from '../../lib/contributor-stats';
import type { TimelineData } from '../../types';

/** sampleTimelineData's Alice/Bob plus two bot contributors, for exercising
 *  the Automated/Individual grouping toggle. */
function timelineWithBots(): TimelineData {
  const data = sampleTimelineData();
  data.contributors['Claude Opus 5'] = {
    email: '',
    commits: 3,
    lines_added: 50,
    lines_removed: 5,
    files_changed: 2,
    first_commit: 0,
    last_commit: 1,
  };
  data.contributors['blacksmith-sh[bot]'] = {
    email: '',
    commits: 1,
    lines_added: 2,
    lines_removed: 0,
    files_changed: 1,
    first_commit: 0,
    last_commit: 0,
  };
  return data;
}

describe('contributor-leaderboard', () => {
  let el: ContributorLeaderboard | undefined;

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
  });

  it('shows an empty state when there are no contributors', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: emptyTimelineData() });
    expect(el.shadowRoot?.textContent).toContain('No contributors to show');
    expect(el.shadowRoot?.querySelector('.row')).toBeNull();
  });

  it('renders one row per contributor, sorted by commits descending by default, ranked from 01', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: sampleTimelineData() });
    const rows = el.shadowRoot?.querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    // Alice has 2 commits, Bob has 1 — Alice should sort first and rank 01.
    expect(rows![0].textContent).toContain('Alice');
    expect(rows![0].querySelector('.rank')?.textContent).toBe('01');
    expect(rows![1].textContent).toContain('Bob');
    expect(rows![1].querySelector('.rank')?.textContent).toBe('02');
  });

  it('re-sorts when a different column header is clicked', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: sampleTimelineData() });
    // Bob has more lines added (25) than Alice (13).
    const linesAddedHeader = Array.from(el.shadowRoot!.querySelectorAll('.headers button')).find((b) =>
      b.textContent?.includes('+ Lines')
    );
    expect(linesAddedHeader).toBeDefined();
    linesAddedHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('.row');
    expect(rows![0].textContent).toContain('Bob');
  });

  it('sizes the leading bar by the active sort metric', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: sampleTimelineData() });
    const bars = el.shadowRoot?.querySelectorAll('.bar');
    expect(bars).toHaveLength(2);
    // Alice (2 commits) leads Bob (1 commit) under the default 'commits' sort.
    const aliceWidth = parseFloat((bars![0] as HTMLElement).style.width);
    const bobWidth = parseFloat((bars![1] as HTMLElement).style.width);
    expect(aliceWidth).toBeGreaterThan(bobWidth);
  });

  it('scopes to commits up to currentTime once switched to "as of now"', async () => {
    // sampleTimelineData: commit 0 is Alice's, commit 1 is Bob's.
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: sampleTimelineData(), currentTime: 0 });
    expect(el.shadowRoot?.querySelectorAll('.row')).toHaveLength(2);

    const toggle = el.shadowRoot!.querySelector('scope-toggle')!;
    toggle.dispatchEvent(new CustomEvent('scope-change', { detail: { scope: 'as-of' }, bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('.row');
    expect(rows).toHaveLength(1);
    expect(rows![0].textContent).toContain('Alice');
  });

  it('does not recompute contributor stats for sub-integer currentTime ticks within the same commit', async () => {
    const spy = vi.spyOn(contributorStatsLib, 'buildLeaderboardAsOf');
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', {
      data: sampleTimelineData(),
      currentTime: 0,
      scope: 'as-of',
    } as Partial<ContributorLeaderboard>);
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

    // Sorting must stay free-standing (never invalidate the aggregation
    // cache) — clicking a column header must not trigger a recompute.
    const callsAfterTick = spy.mock.calls.length;
    const linesAddedHeader = Array.from(el.shadowRoot!.querySelectorAll('.headers button')).find((b) =>
      b.textContent?.includes('+ Lines')
    );
    linesAddedHeader!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;
    expect(spy.mock.calls.length).toBe(callsAfterTick);

    spy.mockRestore();
  });

  it('defaults to grouping bot contributors into one Automated row', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: timelineWithBots() });
    const rows = el.shadowRoot?.querySelectorAll('.row');
    // Alice, Bob, Automated — not Alice, Bob, Claude Opus 5, blacksmith-sh[bot].
    expect(rows).toHaveLength(3);

    const automated = Array.from(rows!).find((r) => r.querySelector('.author')?.textContent === 'Automated');
    expect(automated).toBeDefined();
    const botList = automated!.querySelector('.bot-list');
    expect(botList?.textContent).toContain('2 bots');
    expect(botList?.textContent).toContain('Claude Opus 5');
    expect(botList?.textContent).toContain('blacksmith-sh[bot]');
  });

  it('switching to Individual shows every bot as its own row', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: timelineWithBots() });
    const toggle = el.shadowRoot!.querySelector('bot-group-toggle')!;
    toggle.dispatchEvent(new CustomEvent('bot-group-change', { detail: { grouped: false }, bubbles: true }));
    await el.updateComplete;

    const rows = el.shadowRoot?.querySelectorAll('.row');
    expect(rows).toHaveLength(4);
    const authors = Array.from(rows!).map((r) => r.querySelector('.author')?.textContent);
    expect(authors).toEqual(expect.arrayContaining(['Alice', 'Bob', 'Claude Opus 5', 'blacksmith-sh[bot]']));
    expect(authors).not.toContain('Automated');
  });

  it('has no bots to group and renders individual rows unchanged when no contributor is a bot', async () => {
    el = await mount<ContributorLeaderboard>('contributor-leaderboard', { data: sampleTimelineData() });
    const rows = el.shadowRoot?.querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    expect(el.shadowRoot?.querySelector('.bot-list')).toBeNull();
  });
});
