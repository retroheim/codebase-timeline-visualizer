import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../app-root';
import type { AppRoot } from '../app-root';
import type { TimelineData } from '../../types';
import { mount, unmount } from './fixtures';

// `timeline-viz` (the default 'tree' view) uses ResizeObserver + canvas 2D,
// neither fully supported by happy-dom. These tests set the initial hash to
// a lighter view (already covered by its own component tests) so app-root's
// orchestration logic — fetch fallback, seek handling, project-ready
// semantics, hash routing — can be exercised without depending on
// timeline-viz's rendering, which is pre-existing, separately-scoped code.

function threeCommitTimeline(repoName = 'sample'): TimelineData {
  const commit = (i: number) => ({
    timestamp: 1700000000 + i,
    datetime: new Date((1700000000 + i) * 1000).toISOString(),
    commit_hash: `h${i}`,
    author: 'a',
    message: `commit ${i}`,
    files_changed: [],
    lines_added: 1,
    lines_removed: 0,
    cumulative_lines: i + 1,
    cumulative_files: 1,
  });
  return {
    metadata: {
      schema_version: 1,
      repo_name: repoName,
      github_repo: null,
      total_commits: 3,
      total_contributors: 1,
      total_files: 1,
      date_range: { start: null, end: null },
    },
    timeline: [commit(0), commit(1), commit(2)],
    contributors: {},
    files: {},
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 404): Response {
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe('app-root', () => {
  let el: AppRoot | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    history.replaceState(null, '', '#/x/commits');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
    delete window.__CODEVIS_TIMELINE__;
    vi.unstubAllGlobals();
    history.replaceState(null, '', '#/');
  });

  it('falls back to legacy /api/timeline when /api/projects 404s', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse(null, false, 404));
      if (url === '/api/timeline') return Promise.resolve(jsonResponse(threeCommitTimeline('legacy-repo')));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.timelineData).not.toBeNull());

    expect(el.multiProjectMode).toBe(false);
    expect(el.shadowRoot?.querySelector('project-switcher')).toBeNull();
    expect(el.shadowRoot?.textContent).toContain('legacy-repo');
  });

  it('boots multi-project mode and renders project-switcher when /api/projects responds', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));

    expect(el.shadowRoot?.querySelector('project-switcher')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.wordmark')).toBeNull();
  });

  it('uses inlined __CODEVIS_TIMELINE__ and never calls fetch', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline('inlined-repo');
    el = await mount<AppRoot>('app-root');

    expect(el.timelineData?.metadata.repo_name).toBe('inlined-repo');
    expect(el.multiProjectMode).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('seek clamps to maxTime and stops playback', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
    el = await mount<AppRoot>('app-root');
    el.isPlaying = true;

    const vizLayer = el.shadowRoot?.querySelector('.viz-layer');
    vizLayer!.dispatchEvent(new CustomEvent('seek', { detail: { index: 999 }, bubbles: true, composed: true }));

    expect(el.currentTime).toBe(el.maxTime);
    expect(el.isPlaying).toBe(false);
  });

  it('seek clamps a negative index to 0', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
    el = await mount<AppRoot>('app-root');

    const vizLayer = el.shadowRoot?.querySelector('.viz-layer');
    vizLayer!.dispatchEvent(new CustomEvent('seek', { detail: { index: -5 }, bubbles: true, composed: true }));

    expect(el.currentTime).toBe(0);
  });

  it('loading a new project resets to the start of its history', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));

    const switcher = el.shadowRoot?.querySelector('project-switcher');
    switcher!.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'proj-a', data: threeCommitTimeline() },
        bubbles: true,
        composed: true,
      })
    );

    expect(el.currentProjectId).toBe('proj-a');
    expect(el.currentTime).toBe(0);
    expect(el.maxTime).toBe(2);
  });

  it('refreshing the currently loaded project jumps to the new end of history', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));
    const switcher = el.shadowRoot?.querySelector('project-switcher')!;

    switcher.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'proj-a', data: threeCommitTimeline() },
        bubbles: true,
        composed: true,
      })
    );
    // Scrub away from the start so a refresh's "jump to end" is observable
    // as something other than what a fresh load would already produce.
    el.currentTime = 1;

    switcher.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'proj-a', data: threeCommitTimeline() },
        bubbles: true,
        composed: true,
      })
    );

    expect(el.currentTime).toBe(el.maxTime);
  });

  it('a deep link to a project resets to the start on its first load, not the end', async () => {
    // The hash already names this exact project *before* anything has
    // loaded — `currentProjectId` is pre-populated from it in
    // connectedCallback. The very first `project-ready` for that same id
    // must still be treated as a fresh load, not a refresh.
    history.replaceState(null, '', '#/proj-a/commits');
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));
    expect(el.currentProjectId).toBe('proj-a');

    const switcher = el.shadowRoot?.querySelector('project-switcher')!;
    switcher.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'proj-a', data: threeCommitTimeline() },
        bubbles: true,
        composed: true,
      })
    );

    expect(el.currentTime).toBe(0);
    expect(el.maxTime).toBe(2);
  });

  it('updates the URL hash when the view changes, once a project is loaded', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));

    const switcher = el.shadowRoot?.querySelector('project-switcher')!;
    switcher.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'proj-a', data: threeCommitTimeline() },
        bubbles: true,
        composed: true,
      })
    );

    const viewSwitcher = el.shadowRoot?.querySelector('view-switcher')!;
    viewSwitcher.dispatchEvent(
      new CustomEvent('view-change', { detail: { mode: 'growth' }, bubbles: true, composed: true })
    );

    expect(window.location.hash).toBe('#/proj-a/growth');
  });

  it('warns and does not crash on unusable inlined data', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.__CODEVIS_TIMELINE__ = { metadata: undefined, timeline: null } as unknown as TimelineData;
    el = await mount<AppRoot>('app-root');

    expect(el.timelineData).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns and does not crash when /api/timeline is unreachable in legacy mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse(null, false, 404));
      if (url === '/api/timeline') return Promise.reject(new Error('network down'));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(el.timelineData).toBeNull();
    warn.mockRestore();
  });

  it('does not crash when the /api/projects probe itself rejects', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.reject(new Error('offline'));
      if (url === '/api/timeline') return Promise.resolve(jsonResponse(threeCommitTimeline('fallback-repo')));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.timelineData).not.toBeNull());
    expect(el.multiProjectMode).toBe(false);
  });

  it('warns on a project-error event without crashing', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));

    const switcher = el.shadowRoot?.querySelector('project-switcher')!;
    switcher.dispatchEvent(
      new CustomEvent('project-error', { detail: { message: 'boom' }, bubbles: true, composed: true })
    );

    expect(warn).toHaveBeenCalledWith('Project error:', 'boom');
    warn.mockRestore();
  });

  it('warns and does not crash when /api/timeline resolves with a non-ok status', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse(null, false, 404));
      if (url === '/api/timeline') return Promise.resolve(jsonResponse({ error: 'not found' }, false, 404));
      throw new Error(`unexpected fetch ${url}`);
    });

    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(el.timelineData).toBeNull();
    warn.mockRestore();
  });

  it('warns and does not crash on an unusable project-ready payload', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/projects') return Promise.resolve(jsonResponse([]));
      throw new Error(`unexpected fetch ${url}`);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    el = await mount<AppRoot>('app-root');
    await vi.waitFor(() => expect(el!.multiProjectMode).toBe(true));

    const switcher = el.shadowRoot?.querySelector('project-switcher')!;
    switcher.dispatchEvent(
      new CustomEvent('project-ready', {
        detail: { projectId: 'bad-proj', data: { metadata: undefined, timeline: null } },
        bubbles: true,
        composed: true,
      })
    );

    expect(warn).toHaveBeenCalled();
    // Unchanged from what the initial hash set — the bad payload is
    // rejected before `currentProjectId` is ever touched.
    expect(el.currentProjectId).toBe('x');
    warn.mockRestore();
  });

  it('clamps an out-of-range currentTime on a plain (non-refresh, non-legacy) apply', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
    el = await mount<AppRoot>('app-root', { currentTime: 999 } as Partial<AppRoot>);
    expect(el.currentTime).toBe(el.maxTime);
  });

  it('renders the calendar and treemap views without throwing', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
    history.replaceState(null, '', '#/x/calendar');
    el = await mount<AppRoot>('app-root');
    expect(el.shadowRoot?.querySelector('calendar-heatmap')).not.toBeNull();

    el.viewMode = 'treemap';
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('churn-treemap')).not.toBeNull();
  });

  it('picks up a browser back/forward hash change', async () => {
    window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
    el = await mount<AppRoot>('app-root');
    expect(el.viewMode).toBe('commits');

    history.replaceState(null, '', '#/x/leaderboard');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await el.updateComplete;

    expect(el.viewMode).toBe('leaderboard');
  });

  describe('playback dock', () => {
    let rafQueue: Array<(now: number) => void>;

    beforeEach(() => {
      rafQueue = [];
      vi.stubGlobal('requestAnimationFrame', (cb: (now: number) => void) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      vi.stubGlobal('cancelAnimationFrame', () => {});
    });

    function flushRaf(now: number): void {
      const queue = rafQueue;
      rafQueue = [];
      queue.forEach((cb) => cb(now));
    }

    it('formats "—" for a timeline with no commits', async () => {
      const empty = threeCommitTimeline();
      empty.timeline = [];
      window.__CODEVIS_TIMELINE__ = empty;
      el = await mount<AppRoot>('app-root');

      expect(el.shadowRoot?.querySelector('.time-display')?.textContent).toContain('—');
    });

    it('play button starts playback, and clicking again pauses it', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;

      playButton.click();
      expect(el.isPlaying).toBe(true);

      playButton.click();
      expect(el.isPlaying).toBe(false);
    });

    it('starting playback from the end restarts at 0', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      el.currentTime = el.maxTime;
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;

      playButton.click();
      expect(el.currentTime).toBe(0);
      expect(el.isPlaying).toBe(true);
    });

    it('advancing a frame steps currentTime forward without reaching the end', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;
      playButton.click();
      expect(rafQueue).toHaveLength(1);

      const base = performance.now();
      // At 1x speed on a 3-commit timeline (maxTime=2), one max-clamped
      // (250ms) frame banks 0.5 commits of carry — not yet a whole step.
      flushRaf(base + 100000);
      expect(el.currentTime).toBe(0);
      expect(rafQueue).toHaveLength(1); // still playing, scheduled another frame

      // A second clamped frame pushes total carry to 1.0 — one whole step.
      flushRaf(base + 200000);
      expect(el.currentTime).toBe(1);
      expect(el.isPlaying).toBe(true);
    });

    it('reaching the end of the timeline during playback stops it', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      el.speed = 4; // rate high enough to cross a 3-commit timeline in one clamped frame
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;
      playButton.click();

      flushRaf(performance.now() + 100000);

      expect(el.currentTime).toBe(el.maxTime);
      expect(el.isPlaying).toBe(false);
    });

    it('scrubbing the slider updates currentTime and stops playback', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;
      playButton.click();
      expect(el.isPlaying).toBe(true);

      const slider = el.shadowRoot?.querySelector('.timeline-slider') as HTMLInputElement;
      slider.value = '1';
      slider.dispatchEvent(new Event('input', { bubbles: true }));

      expect(el.currentTime).toBe(1);
      expect(el.isPlaying).toBe(false);
    });

    it('changing speed while playing restarts the interval without throwing', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      const playButton = el.shadowRoot?.querySelector('.play-button') as HTMLButtonElement;
      playButton.click();

      const speedSelect = el.shadowRoot?.querySelector('.speed-select') as HTMLSelectElement;
      speedSelect.value = '2';
      speedSelect.dispatchEvent(new Event('change', { bubbles: true }));

      expect(el.speed).toBe(2);
      expect(el.isPlaying).toBe(true);
    });

    it('changing speed while paused does not start playback', async () => {
      window.__CODEVIS_TIMELINE__ = threeCommitTimeline();
      el = await mount<AppRoot>('app-root');
      const speedSelect = el.shadowRoot?.querySelector('.speed-select') as HTMLSelectElement;
      speedSelect.value = '0.5';
      speedSelect.dispatchEvent(new Event('change', { bubbles: true }));

      expect(el.speed).toBe(0.5);
      expect(el.isPlaying).toBe(false);
    });
  });
});
