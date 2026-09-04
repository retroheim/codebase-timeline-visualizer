import { makeCommit, makeFileChange } from '../../lib/__tests__/commit-fixture';
import type { CommitEvent, FileChange, TimelineData } from '../../types';

function file(path: string, linesAdded = 1, linesRemoved = 0, changeType = 'ADD'): FileChange {
  return makeFileChange({
    new_path: changeType === 'DELETE' ? null : path,
    old_path: changeType === 'DELETE' ? path : null,
    filename: path.split('/').pop() ?? path,
    change_type: changeType,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  });
}

function commit(
  timestamp: number,
  author: string,
  message: string,
  files: FileChange[],
  cumulativeLines: number,
  cumulativeFiles: number
): CommitEvent {
  return makeCommit({
    timestamp,
    commit_hash: `hash${timestamp}`,
    author,
    message,
    files,
    cumulative_lines: cumulativeLines,
    cumulative_files: cumulativeFiles,
  });
}

/** A small but structurally real TimelineData: two authors, a handful of
 *  files under two directories, spread across a few days. Shared across
 *  component tests so each one isn't hand-rolling its own fixture. */
export function sampleTimelineData(): TimelineData {
  const day1 = Date.UTC(2024, 0, 10, 12) / 1000;
  const day2 = Date.UTC(2024, 0, 11, 12) / 1000;
  const day3 = Date.UTC(2024, 0, 12, 12) / 1000;

  const timeline: CommitEvent[] = [
    commit(day1, 'Alice', 'init project', [file('src/index.ts', 10)], 10, 1),
    commit(day2, 'Bob', 'add widget', [file('src/widget.ts', 20), file('docs/readme.md', 5)], 35, 3),
    commit(day3, 'Alice', 'fix widget bug', [file('src/widget.ts', 3, 2)], 36, 3),
  ];

  return {
    metadata: {
      schema_version: 1,
      repo_name: 'sample-repo',
      github_repo: null,
      total_commits: timeline.length,
      total_contributors: 2,
      total_files: 3,
      date_range: { start: timeline[0].datetime, end: timeline[timeline.length - 1].datetime },
    },
    timeline,
    contributors: {
      Alice: {
        email: 'alice@example.com',
        commits: 2,
        lines_added: 13,
        lines_removed: 2,
        files_changed: 2,
        first_commit: day1,
        last_commit: day3,
      },
      Bob: {
        email: 'bob@example.com',
        commits: 1,
        lines_added: 25,
        lines_removed: 0,
        files_changed: 2,
        first_commit: day2,
        last_commit: day2,
      },
    },
    files: {
      'src/index.ts': { changes: 1, lines_added: 10, lines_removed: 0, authors: ['Alice'], first_change: day1, last_change: day1 },
      'src/widget.ts': {
        changes: 2,
        lines_added: 23,
        lines_removed: 2,
        authors: ['Bob', 'Alice'],
        first_change: day2,
        last_change: day3,
      },
      'docs/readme.md': { changes: 1, lines_added: 5, lines_removed: 0, authors: ['Bob'], first_change: day2, last_change: day2 },
    },
  };
}

export function emptyTimelineData(): TimelineData {
  return {
    metadata: {
      schema_version: 1,
      repo_name: 'empty-repo',
      github_repo: null,
      total_commits: 0,
      total_contributors: 0,
      total_files: 0,
      date_range: { start: null, end: null },
    },
    timeline: [],
    contributors: {},
    files: {},
  };
}

/** Mounts a custom element, waits for its first render, and hands it back
 *  along with a teardown function. Callers set properties before awaiting
 *  `updateComplete` themselves if they need pre-render state. */
export async function mount<T extends HTMLElement>(tagName: string, props: Partial<T> = {}): Promise<T> {
  const el = document.createElement(tagName) as T;
  Object.assign(el, props);
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el;
}

export function unmount(el: HTMLElement): void {
  el.remove();
}
