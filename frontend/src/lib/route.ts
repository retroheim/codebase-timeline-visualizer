// Trivial hash-based routing: `#/<projectId>/<view>`, e.g. `#/my-repo/growth`.
// No router library — this app has one shell and six views, and every other
// bit of state management in this codebase (playback, tree layout) is
// hand-rolled rather than pulling in a framework for a small, fixed shape.
// Deliberately does NOT carry `currentTime`: writing it on every scrub/
// playback tick would spam `history.replaceState` for no real benefit.

export type ViewMode = 'tree' | 'calendar' | 'leaderboard' | 'growth' | 'treemap' | 'commits';

export const VIEW_MODES: { mode: ViewMode; label: string }[] = [
  { mode: 'tree', label: 'Tree' },
  { mode: 'calendar', label: 'Calendar' },
  { mode: 'leaderboard', label: 'Leaderboard' },
  { mode: 'growth', label: 'Growth' },
  { mode: 'treemap', label: 'Treemap' },
  { mode: 'commits', label: 'Commits' },
];

const DEFAULT_VIEW: ViewMode = 'tree';

function isViewMode(value: string): value is ViewMode {
  return VIEW_MODES.some((v) => v.mode === value);
}

export interface RouteState {
  projectId: string | null;
  view: ViewMode;
}

/** Parses `#/<projectId>/<view>` (or just `#/<projectId>`). Never throws —
 *  an unparseable or unknown-view hash falls back to no project / the
 *  default view rather than leaving the shell in a broken state. */
export function parseHash(hash: string): RouteState {
  const trimmed = hash.replace(/^#\/?/, '');
  if (!trimmed) return { projectId: null, view: DEFAULT_VIEW };

  const [projectId, view] = trimmed.split('/');
  return {
    projectId: projectId || null,
    view: view && isViewMode(view) ? view : DEFAULT_VIEW,
  };
}

export function formatHash(state: RouteState): string {
  if (!state.projectId) return '#/';
  return `#/${state.projectId}/${state.view}`;
}
