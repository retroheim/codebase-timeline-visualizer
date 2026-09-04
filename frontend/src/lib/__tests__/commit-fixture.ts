// Shared CommitEvent/FileChange builders for tests. Every field has a sane
// default so a test only has to name the ones it cares about — the single
// source of truth `co_authors`/schema fields get updated in, instead of the
// six independently-hand-rolled local `commit()`/`file()` factories this
// replaces (frontend/src/lib/__tests__/{as-of,calendar,commit-table,
// contributor-stats,growth}.test.ts and components/__tests__/fixtures.ts)
// silently drifting from each other and from the real CommitEvent shape.

import type { CommitAuthor, CommitEvent, FileChange } from '../../types';

export function makeFileChange(overrides: Partial<FileChange> = {}): FileChange {
  const path = overrides.new_path ?? overrides.old_path ?? overrides.filename ?? 'file.ts';
  return {
    filename: path.split('/').pop() ?? path,
    old_path: null,
    new_path: path,
    change_type: 'ADD',
    lines_added: 1,
    lines_removed: 0,
    ...overrides,
  };
}

export function makeCommit(overrides: Partial<CommitEvent> & { files?: FileChange[]; coAuthors?: CommitAuthor[] } = {}): CommitEvent {
  const { files, coAuthors, ...rest } = overrides;
  const filesChanged = rest.files_changed ?? files ?? [];
  const timestamp = rest.timestamp ?? 0;
  return {
    timestamp,
    datetime: new Date(timestamp * 1000).toISOString(),
    commit_hash: `h${timestamp}`,
    author: 'a',
    message: 'm',
    files_changed: filesChanged,
    lines_added: filesChanged.reduce((s, f) => s + f.lines_added, 0),
    lines_removed: filesChanged.reduce((s, f) => s + f.lines_removed, 0),
    cumulative_lines: 0,
    cumulative_files: 0,
    co_authors: coAuthors ?? [],
    ...rest,
  };
}
