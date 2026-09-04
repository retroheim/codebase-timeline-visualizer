import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../timeline-viz';
import type { TimelineViz } from '../timeline-viz';
import type { PointNode, TreeLayout } from '../../lib/tree-layout';
import type { CommitEvent, FileChange, TimelineData } from '../../types';
import { makeCommit } from '../../lib/__tests__/commit-fixture';
import { mount, sampleTimelineData, unmount } from './fixtures';

// Private-field peeks, cast through `unknown` — used only to find a node's
// real computed layout position (so a click lands on it deliberately,
// instead of guessing screen coordinates and hoping) and to check internal
// state a public getter doesn't expose. Never used to bypass behavior.
function layoutOf(el: TimelineViz): TreeLayout | null {
  return (el as unknown as { layout: TreeLayout | null }).layout;
}

function widthHeightOf(el: TimelineViz): [number, number] {
  const raw = el as unknown as { width: number; height: number };
  return [raw.width, raw.height];
}

function contributorsOf(el: TimelineViz): Record<string, unknown> {
  return (el as unknown as { contributors: Record<string, unknown> }).contributors;
}

/** sampleTimelineData's Alice/Bob plus two bot contributors, one of whom also
 *  authors a commit touching an already-existing file — for exercising the
 *  Automated/Individual toggle across avatars, sparks, and the inspector. */
function timelineWithBots(): TimelineData {
  const data = sampleTimelineData();
  const lastCommit = data.timeline[data.timeline.length - 1];
  data.contributors['Claude Opus 5'] = {
    email: '',
    commits: 1,
    lines_added: 1,
    lines_removed: 0,
    files_changed: 1,
    first_commit: lastCommit.timestamp,
    last_commit: lastCommit.timestamp,
  };
  data.contributors['blacksmith-sh[bot]'] = {
    email: '',
    commits: 1,
    lines_added: 1,
    lines_removed: 0,
    files_changed: 1,
    first_commit: lastCommit.timestamp,
    last_commit: lastCommit.timestamp,
  };
  const botCommit = makeCommit({
    timestamp: lastCommit.timestamp + 100,
    author: 'Claude Opus 5',
    message: 'automated tidy-up',
    files: [
      { filename: 'index.ts', old_path: null, new_path: 'src/index.ts', change_type: 'MODIFY', lines_added: 1, lines_removed: 0 },
    ],
    cumulative_lines: lastCommit.cumulative_lines + 1,
    cumulative_files: lastCommit.cumulative_files,
  });
  data.timeline = [...data.timeline, botCommit];
  return data;
}

/** Screen (client) coordinates that hit-test to `node`, inverting
 *  `screenToLocal`'s math at the default (no pan/zoom) transform used in
 *  every test here — `rect.left/top` are 0 per the getBoundingClientRect
 *  stub in test-setup.ts. */
function clientCoordsFor(el: TimelineViz, node: PointNode): { clientX: number; clientY: number } {
  const [width, height] = widthHeightOf(el);
  return {
    clientX: node.data.layoutX! + width / 2,
    clientY: node.data.layoutY! + height / 2,
  };
}

// `scheduleDraw()` defers the actual canvas draw to a `requestAnimationFrame`
// callback, so most of `drawCanvas()`'s body never runs during a test unless
// that frame is explicitly flushed — real rAF timing isn't something a test
// should depend on.
let rafQueue: Array<() => void>;

function flushRaf(): void {
  const queue = rafQueue;
  rafQueue = [];
  queue.forEach((cb) => cb());
}

function manyFilesTimeline(): TimelineData {
  const files: FileChange[] = Array.from({ length: 12 }, (_, i) => ({
    filename: `f${i}.ts`,
    old_path: null,
    new_path: `src/f${i}.ts`,
    change_type: 'ADD',
    lines_added: 1,
    lines_removed: 0,
  }));
  const commit: CommitEvent = {
    timestamp: 1700000000,
    datetime: new Date(1700000000 * 1000).toISOString(),
    commit_hash: 'h0',
    author: 'a',
    message: 'add many files',
    files_changed: files,
    lines_added: 12,
    lines_removed: 0,
    cumulative_lines: 12,
    cumulative_files: 12,
  };
  return {
    metadata: {
      schema_version: 1,
      repo_name: 'many-files',
      github_repo: null,
      total_commits: 1,
      total_contributors: 1,
      total_files: 12,
      date_range: { start: commit.datetime, end: commit.datetime },
    },
    timeline: [commit],
    contributors: { a: { email: 'a@b.com', commits: 1, lines_added: 12, lines_removed: 0, files_changed: 12, first_commit: commit.timestamp, last_commit: commit.timestamp } },
    files: Object.fromEntries(
      files.map((f) => [f.new_path as string, { changes: 1, lines_added: 1, lines_removed: 0, authors: ['a'], first_change: commit.timestamp, last_change: commit.timestamp }])
    ),
  };
}

describe('timeline-viz', () => {
  let el: TimelineViz | undefined;

  beforeEach(() => {
    // Avatar resolution hits the network (GitHub API / Gravatar); keep tests
    // offline and let the existing identicon fallback chain handle it.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline in tests')))
    );
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    if (el) unmount(el);
    el = undefined;
    vi.unstubAllGlobals();
  });

  it('mounts and draws without throwing, given real data', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 2 });
    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
    expect(el.shadowRoot?.querySelector('svg')).not.toBeNull();
  });

  it('renders no inspector panel until a node is selected', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 2 });
    expect(el.shadowRoot?.querySelector('.inspector')).toBeNull();
  });

  it('advancing currentTime does not throw', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 0 });
    el.currentTime = 1;
    await el.updateComplete;
    el.currentTime = 2;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });

  it('clicking the root node selects it and shows the inspector', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 2 });
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    // Center of the 800x600 stubbed viewport — the root node sits at the
    // origin of tree-space, which the center of the canvas maps to at the
    // default (no pan/zoom) transform.
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
    await el.updateComplete;

    expect(el.selectedNode).not.toBeNull();
    expect(el.shadowRoot?.querySelector('.inspector')).not.toBeNull();
  });

  it('closing the inspector clears the selection', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 2 });
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
    await el.updateComplete;
    expect(el.selectedNode).not.toBeNull();

    const closeButton = el.shadowRoot?.querySelector('.inspector-close') as HTMLButtonElement;
    closeButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await el.updateComplete;

    expect(el.selectedNode).toBeNull();
    expect(el.shadowRoot?.querySelector('.inspector')).toBeNull();
  });

  it('rebuilds cleanly when swapped to a different dataset', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 2 });
    const other = sampleTimelineData();
    other.metadata.repo_name = 'other-repo';
    el.data = other;
    el.currentTime = 0;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });

  it('flushing a scheduled draw frame runs the canvas draw pipeline without throwing', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 0 });
    flushRaf();

    el.currentTime = 1;
    await el.updateComplete;
    flushRaf();
    el.currentTime = 2;
    await el.updateComplete;
    flushRaf();

    // Select a node too — draws the selection highlight/glow branch.
    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 300 }));
    await el.updateComplete;
    flushRaf();

    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });

  it('double-clicking a cluster expands it into individual files', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: manyFilesTimeline(), currentTime: 0 });

    // Find the actual cluster node's computed position rather than guessing
    // a screen coordinate and hoping it lands there — the 12-file fixture
    // (past CLUSTER_THRESHOLD=8) is known to produce exactly one cluster
    // under `src/`.
    const layout = layoutOf(el);
    const clusterEntry = Array.from(layout!.nodeByPath.values()).find((n) => n.data.isCluster);
    expect(clusterEntry, 'fixture should have produced a cluster node').toBeDefined();
    const clusterPath = clusterEntry!.data.path;

    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    const { clientX, clientY } = clientCoordsFor(el, clusterEntry!);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
    await el.updateComplete;
    expect(el.selectedNode?.data.path).toBe(clusterPath);
    expect(el.selectedNode?.data.isCluster).toBe(true);

    canvas.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX, clientY }));
    await el.updateComplete;

    // Expanding replaces the single cluster with its individual file nodes —
    // the cluster's synthetic path should no longer exist in the rebuilt
    // layout, and every one of the 12 real files should now have its own
    // node instead.
    const rebuiltLayout = layoutOf(el);
    expect(rebuiltLayout!.nodeByPath.has(clusterPath)).toBe(false);
    for (let i = 0; i < 12; i += 1) {
      expect(rebuiltLayout!.nodeByPath.has(`src/f${i}.ts`)).toBe(true);
    }
    // Selection is deliberately cleared on expand — the just-clicked cluster
    // node no longer exists in the rebuilt tree.
    expect(el.selectedNode).toBeNull();
  });

  it('samples down commits when more than MAX_SPARKS_PER_TICK land in one tick', async () => {
    const timeline: CommitEvent[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: 1700000000 + i,
      datetime: new Date((1700000000 + i) * 1000).toISOString(),
      commit_hash: `h${i}`,
      author: 'a',
      message: `commit ${i}`,
      files_changed: [{ filename: `f${i}.ts`, old_path: null, new_path: `f${i}.ts`, change_type: 'ADD', lines_added: 1, lines_removed: 0 }],
      lines_added: 1,
      lines_removed: 0,
      cumulative_lines: i + 1,
      cumulative_files: i + 1,
    }));
    const data: TimelineData = {
      metadata: {
        schema_version: 1,
        repo_name: 'many-commits',
        github_repo: null,
        total_commits: 10,
        total_contributors: 1,
        total_files: 10,
        date_range: { start: timeline[0].datetime, end: timeline[9].datetime },
      },
      timeline,
      contributors: { a: { email: 'a@b.com', commits: 10, lines_added: 10, lines_removed: 0, files_changed: 10, first_commit: timeline[0].timestamp, last_commit: timeline[9].timestamp } },
      files: Object.fromEntries(
        timeline.map((c) => [c.files_changed[0].new_path as string, { changes: 1, lines_added: 1, lines_removed: 0, authors: ['a'], first_change: c.timestamp, last_change: c.timestamp }])
      ),
    };

    el = await mount<TimelineViz>('timeline-viz', { data, currentTime: 0 });
    // A single jump from 0 straight to the last commit puts all 10 commits
    // in range for one `shootContributors` call — past MAX_SPARKS_PER_TICK
    // (8), forcing the reservoir-sampling branch instead of "spark every one".
    el.currentTime = 9;
    await el.updateComplete;

    const svg = el.shadowRoot!.querySelector('svg')!;
    // At most 8 sparks fired (one target each, since each commit here
    // touches exactly one file), never one per commit.
    expect(svg.querySelectorAll('path').length).toBeLessThanOrEqual(8);
  });

  it('skips a commit whose author has no matching contributor entry, without throwing', async () => {
    const data = sampleTimelineData();
    // A data inconsistency — commit references an author name absent from
    // the contributors map — that `shootContributors` must tolerate rather
    // than crash on (no avatar exists to animate from).
    data.timeline[1].author = 'Ghost Author';

    el = await mount<TimelineViz>('timeline-viz', { data, currentTime: 0 });
    el.currentTime = 1;
    await el.updateComplete;

    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });

  it('skips a commit with no files changed, without throwing', async () => {
    const data = sampleTimelineData();
    data.timeline[1].files_changed = [];

    el = await mount<TimelineViz>('timeline-viz', { data, currentTime: 0 });
    el.currentTime = 1;
    await el.updateComplete;

    // No targets resolved for that commit, so no spark path for it —
    // distinct from the "throws" failure mode this test is really guarding.
    expect(el.shadowRoot?.querySelector('svg')).not.toBeNull();
  });

  it('renders a bot-group-toggle in the controls, defaulted to grouped', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: sampleTimelineData(), currentTime: 0 });
    const toggle = el.shadowRoot!.querySelector('bot-group-toggle') as (HTMLElement & { grouped: boolean }) | null;
    expect(toggle).not.toBeNull();
    expect(toggle!.grouped).toBe(true);
  });

  it('defaults to grouping bot contributors into one Automated avatar', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: timelineWithBots(), currentTime: 3 });
    expect(Object.keys(contributorsOf(el)).sort()).toEqual(['Alice', 'Automated', 'Bob']);
  });

  it('switching to Individual gives every bot its own avatar', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: timelineWithBots(), currentTime: 3 });
    const toggle = el.shadowRoot!.querySelector('bot-group-toggle')!;
    toggle.dispatchEvent(new CustomEvent('bot-group-change', { detail: { grouped: false }, bubbles: true }));
    await el.updateComplete;

    expect(Object.keys(contributorsOf(el)).sort()).toEqual(['Alice', 'Bob', 'Claude Opus 5', 'blacksmith-sh[bot]'].sort());
  });

  it('resolves spark origin for a bot-authored commit against the shared Automated avatar without throwing', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: timelineWithBots(), currentTime: 2 });
    el.currentTime = 3;
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector('svg')).not.toBeNull();
  });

  it('groups a bot author into "Automated" in the file inspector\'s contributor list', async () => {
    el = await mount<TimelineViz>('timeline-viz', { data: timelineWithBots(), currentTime: 3 });
    const layout = layoutOf(el);
    const fileNode = layout!.nodeByPath.get('src/index.ts');
    expect(fileNode, 'fixture should have a node for src/index.ts').toBeDefined();

    const canvas = el.shadowRoot?.querySelector('canvas') as HTMLCanvasElement;
    const { clientX, clientY } = clientCoordsFor(el, fileNode!);
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX, clientY }));
    await el.updateComplete;

    expect(el.selectedNode?.data.path).toBe('src/index.ts');
    const extra = el.shadowRoot?.querySelector('.inspector-extra')?.textContent ?? '';
    expect(extra).toContain('Automated');
    expect(extra).not.toContain('Claude Opus 5');
  });
});
