export interface FileChange {
  filename: string;
  old_path: string | null;
  new_path: string | null;
  change_type: string;
  lines_added: number;
  lines_removed: number;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

export interface CommitEvent {
  timestamp: number;
  datetime: string;
  commit_hash: string;
  author: string;
  message: string;
  files_changed: FileChange[];
  lines_added: number;
  lines_removed: number;
  cumulative_lines: number;
  cumulative_files: number;
  /** Credited via a `Co-authored-by:` trailer — e.g. a bot pairing with the
   *  primary author. Optional: a `timeline.json` from before this field
   *  existed (schema_version 1) genuinely lacks it. */
  co_authors?: CommitAuthor[];
}

export interface Contributor {
  email: string;
  commits: number;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  first_commit: number;
  last_commit: number;
}

export interface FileStat {
  changes: number;
  lines_added: number;
  lines_removed: number;
  authors: string[];
  first_change: number;
  last_change: number;
}

/// Wire-format version emitted by the Rust exporter (`SCHEMA_VERSION` in
/// src/exporter.rs). Bump both together. Files written before versioning
/// existed have no `schema_version` field at all.
export const SUPPORTED_SCHEMA_VERSION = 2;

export interface TimelineData {
  metadata: {
    schema_version?: number;
    repo_name: string;
    github_repo: string | null;
    total_commits: number;
    total_contributors: number;
    total_files: number;
    date_range: { start: string | null; end: string | null };
  };
  timeline: CommitEvent[];
  contributors: Record<string, Contributor>;
  files: Record<string, FileStat>;
}

// --- Multi-project registry types, hand-mirrored from src/registry.rs and
// src/jobs.rs. Independent response shapes, not part of TimelineData/
// SCHEMA_VERSION — a project's own timeline.json is unchanged by these.

export type ProjectSource = { kind: 'local_path'; path: string } | { kind: 'git_url'; url: string };

export type ProjectStatus =
  | { state: 'never_analyzed' }
  | { state: 'analyzing' }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export type RunOutcome = { state: 'succeeded' } | { state: 'failed'; message: string };

export interface AnalysisRun {
  started_at: number;
  finished_at: number;
  outcome: RunOutcome;
}

export interface Project {
  id: string;
  display_name: string;
  source: ProjectSource;
  status: ProjectStatus;
  last_analyzed: number | null;
  /** Most recent run first, capped server-side. */
  history: AnalysisRun[];
}

export type JobState = { state: 'running' } | { state: 'succeeded' } | { state: 'failed'; message: string };

export interface Job {
  id: string;
  project_id: string;
  state: JobState;
}
