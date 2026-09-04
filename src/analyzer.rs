//! Git repository analysis: walks commit history and extracts a
//! per-commit / per-contributor / per-file shape for the frontend to render.

use std::collections::BTreeSet;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, FixedOffset};
use git2::{Delta, Oid, Repository, Sort};
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use rayon::prelude::*;
use regex::Regex;
use serde::Serialize;

use crate::github;

#[derive(Serialize, Clone)]
pub struct FileChange {
    pub filename: String,
    pub old_path: Option<String>,
    pub new_path: Option<String>,
    pub change_type: String,
    pub lines_added: u32,
    pub lines_removed: u32,
}

/// A `Co-authored-by:` trailer on a commit message — GitHub's convention for
/// crediting a second author (human or bot) who doesn't have their own
/// commit. Without parsing these, a tool that only reads `commit.author()`
/// silently drops anyone credited this way.
#[derive(Serialize, Clone)]
pub struct CommitAuthor {
    pub name: String,
    pub email: String,
}

#[derive(Serialize, Clone)]
pub struct CommitData {
    pub hash: String,
    pub author: String,
    pub email: String,
    pub timestamp: i64,
    pub datetime: String,
    pub message: String,
    pub files_changed: Vec<FileChange>,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub total_files: usize,
    pub co_authors: Vec<CommitAuthor>,
}

#[derive(Serialize)]
pub struct Contributor {
    pub email: String,
    pub commits: u32,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub files_changed: u32,
    pub first_commit: i64,
    pub last_commit: i64,
}

#[derive(Serialize)]
pub struct FileStat {
    pub changes: u32,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub authors: Vec<String>,
    pub first_change: i64,
    pub last_change: i64,
}

pub struct GitAnalyzer {
    repo: Repository,
}

fn change_type_name(status: Delta) -> &'static str {
    match status {
        Delta::Added => "ADD",
        Delta::Deleted => "DELETE",
        Delta::Modified => "MODIFY",
        Delta::Renamed => "RENAME",
        Delta::Copied => "COPY",
        Delta::Typechange => "TYPECHANGE",
        _ => "UNKNOWN",
    }
}

fn format_datetime(seconds: i64, offset_minutes: i32) -> String {
    let offset = FixedOffset::east_opt(offset_minutes * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap());
    match DateTime::from_timestamp(seconds, 0) {
        Some(utc) => utc.with_timezone(&offset).to_rfc3339(),
        None => String::new(),
    }
}

impl GitAnalyzer {
    /// Takes a `Path` rather than a `&str` so callers never have to lossily
    /// convert — a non-UTF-8 repo path used to silently degrade to ".".
    pub fn open(repo_path: impl AsRef<Path>) -> Result<Self, String> {
        let repo = Repository::open(repo_path).map_err(|e| format!("Not a Git repository: {e}"))?;
        Ok(Self { repo })
    }

    /// "owner/repo" if the origin remote points at github.com.
    pub fn github_slug(&self) -> Option<String> {
        let remote = self.repo.find_remote("origin").ok()?;
        let url = remote.url().ok()?;
        github::parse_slug(url)
    }

    pub fn analyze_commits(&self) -> Result<Vec<CommitData>, String> {
        let mut revwalk = self.repo.revwalk().map_err(|e| e.to_string())?;
        revwalk.push_head().map_err(|e| e.to_string())?;
        // TOPOLOGICAL is what makes ties correct: `Sort::TIME` alone yields
        // children before parents, and the stable `sort_by_key` below then
        // preserves that reversed order for every run of commits sharing an
        // author timestamp (scripted commits, rebases, imports). Topological
        // ordering constrains parent-before-child independently of the clock,
        // so tied commits still play back in the order they were created.
        revwalk
            .set_sorting(Sort::TOPOLOGICAL | Sort::TIME | Sort::REVERSE)
            .map_err(|e| e.to_string())?;

        let oids: Vec<Oid> = revwalk
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        // Built once from HEAD's tree (not the working directory — this
        // repo may be `core.bare = true` with no workdir even though files
        // exist on disk, and reading via the tree also means a dirty
        // uncommitted .gitignore edit can't skew the analysis). Shared
        // read-only across every worker thread below.
        let gitignore = build_head_gitignore(&self.repo)?;
        let co_author_re = co_author_regex();

        // Each rayon worker thread needs its own `Repository` handle since
        // `git2::Repository` wraps a raw libgit2 pointer that isn't
        // Sync/safely shareable across threads. `map_init` opens one
        // Repository per thread *for this call* (not a process-global
        // thread_local!) — that scoping matters: a persistent thread_local
        // cache leaks a stale handle across separate `analyze_commits()`
        // calls that reuse the same pooled rayon thread but point at a
        // different repo (e.g. sequential test fixtures each backed by
        // their own tempdir), causing intermittent "object not found"
        // errors once the earlier repo's tempdir is gone.
        let repo_path: PathBuf = self.repo.path().to_path_buf();

        let results: Vec<Result<CommitData, String>> = oids
            .par_iter()
            .map_init(
                || {
                    Repository::open(&repo_path)
                        .map_err(|e| format!("failed to reopen repo in worker: {e}"))
                },
                |repo_result, oid| {
                    let repo = repo_result.as_ref().map_err(|e| e.clone())?;
                    let commit = repo
                        .find_commit(*oid)
                        .map_err(|e| format!("commit {oid}: {e}"))?;
                    Self::extract_commit_data(repo, &commit, &gitignore, &co_author_re)
                        .map_err(|e| format!("commit {oid}: {e}"))
                },
            )
            .collect();

        // One unreadable commit should not throw away the whole history — this
        // is a visualization, and a timeline missing one commit is far more
        // useful than no timeline at all. The error names the offending OID so
        // the skip is diagnosable rather than silent.
        let mut commits = Vec::with_capacity(results.len());
        let mut skipped = 0usize;
        for result in results {
            match result {
                Ok(commit) => commits.push(commit),
                Err(e) => {
                    skipped += 1;
                    eprintln!("Warning: skipping unreadable {e}");
                }
            }
        }
        if skipped > 0 && commits.is_empty() {
            return Err(format!(
                "No commits could be read ({skipped} failed); see the warnings above"
            ));
        }
        if skipped > 0 {
            eprintln!("Warning: {skipped} commit(s) skipped out of {}", oids.len());
        }

        commits.sort_by_key(|c| c.timestamp);
        Ok(commits)
    }

    fn extract_commit_data(
        repo: &Repository,
        commit: &git2::Commit,
        gitignore: &Gitignore,
        co_author_re: &Regex,
    ) -> Result<CommitData, String> {
        let new_tree = commit.tree().map_err(|e| e.to_string())?;
        let old_tree = if commit.parent_count() > 0 {
            Some(
                commit
                    .parent(0)
                    .map_err(|e| e.to_string())?
                    .tree()
                    .map_err(|e| e.to_string())?,
            )
        } else {
            None
        };

        let mut diff_opts = git2::DiffOptions::new();
        diff_opts.context_lines(0).interhunk_lines(0);

        let diff = repo
            .diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut diff_opts))
            .map_err(|e| e.to_string())?;

        let num_deltas = diff.deltas().len();
        let line_counts = std::cell::RefCell::new(vec![(0u32, 0u32); num_deltas]);
        // The file callback fires once per delta, in delta order, before that
        // delta's hunk/line callbacks. Track it with a Cell so the line
        // callback below knows which delta's counters to update.
        let next_idx = std::cell::Cell::new(0usize);
        let current_idx = std::cell::Cell::new(None::<usize>);

        diff.foreach(
            &mut |_delta, _progress| {
                current_idx.set(Some(next_idx.get()));
                next_idx.set(next_idx.get() + 1);
                true
            },
            None,
            None,
            Some(&mut |_delta, _hunk, line: git2::DiffLine| {
                if let Some(idx) = current_idx.get() {
                    if let Some(entry) = line_counts.borrow_mut().get_mut(idx) {
                        match line.origin() {
                            '+' => entry.0 += 1,
                            '-' => entry.1 += 1,
                            _ => {}
                        }
                    }
                }
                true
            }),
        )
        .map_err(|e| e.to_string())?;

        let line_counts = line_counts.into_inner();

        let mut files_changed = Vec::new();
        let mut lines_added = 0u32;
        let mut lines_removed = 0u32;

        for idx in 0..diff.deltas().len() {
            let delta = diff.get_delta(idx).expect("delta index in range");
            let old_path = delta
                .old_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());
            let new_path = delta
                .new_file()
                .path()
                .map(|p| p.to_string_lossy().into_owned());

            let (added, removed) = line_counts.get(idx).copied().unwrap_or((0, 0));

            let path_for_match = new_path.as_deref().or(old_path.as_deref());
            // Filtered against HEAD's `.gitignore`, not the ignore rules in
            // effect at the time of this historical commit — a path that
            // used to be tracked-and-relevant but is now excluded (a vendored
            // dependency, a generated-output directory added to `.gitignore`
            // well after it was first committed) shouldn't keep bloating
            // file/contributor stats just because it once mattered.
            if path_for_match
                .is_some_and(|p| gitignore.matched_path_or_any_parents(p, false).is_ignore())
            {
                continue;
            }

            let filename = new_path
                .as_deref()
                .or(old_path.as_deref())
                .and_then(|p| p.rsplit('/').next())
                .unwrap_or("unknown")
                .to_string();

            files_changed.push(FileChange {
                filename,
                old_path,
                new_path,
                change_type: change_type_name(delta.status()).to_string(),
                lines_added: added,
                lines_removed: removed,
            });

            lines_added += added;
            lines_removed += removed;
        }

        let author = commit.author();
        let when = author.when();
        let timestamp = when.seconds();
        let message = commit.message().unwrap_or("").to_string();
        let co_authors = parse_co_authors(&message, co_author_re);

        Ok(CommitData {
            hash: commit.id().to_string(),
            author: author.name().unwrap_or("unknown").to_string(),
            email: author.email().unwrap_or("unknown").to_string(),
            timestamp,
            datetime: format_datetime(timestamp, when.offset_minutes()),
            message,
            total_files: files_changed.len(),
            files_changed,
            lines_added,
            lines_removed,
            co_authors,
        })
    }
}

/// Builds a matcher from every `.gitignore` blob in HEAD's tree, each
/// anchored at its own directory the way git actually applies nested
/// ignore files. Reads via the tree (not the filesystem), so it works for
/// a `core.bare = true` repo with no `workdir()` and can't see an
/// uncommitted, working-tree-only `.gitignore` edit.
fn build_head_gitignore(repo: &Repository) -> Result<Gitignore, String> {
    let mut builder = GitignoreBuilder::new(".");

    let head = match repo.head() {
        // An empty repo (no commits yet) has no HEAD tree to read patterns
        // from — nothing to filter, not an error.
        Err(_) => return builder.build().map_err(|e| e.to_string()),
        Ok(head) => head,
    };
    let tree = head.peel_to_tree().map_err(|e| e.to_string())?;

    let mut add_err: Option<String> = None;
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        if entry.name_bytes() != b".gitignore" {
            return git2::TreeWalkResult::Ok;
        }
        let content = entry
            .to_object(repo)
            .ok()
            .and_then(|object| object.into_blob().ok())
            .and_then(|blob| std::str::from_utf8(blob.content()).ok().map(str::to_string));
        let Some(content) = content else {
            return git2::TreeWalkResult::Ok;
        };
        let base = PathBuf::from(dir);
        for line in content.lines() {
            if let Err(e) = builder.add_line(Some(base.clone()), line) {
                add_err = Some(e.to_string());
                return git2::TreeWalkResult::Abort;
            }
        }
        git2::TreeWalkResult::Ok
    })
    .map_err(|e| e.to_string())?;

    if let Some(e) = add_err {
        return Err(e);
    }
    builder.build().map_err(|e| e.to_string())
}

fn co_author_regex() -> Regex {
    // GitHub's trailer convention: `Co-authored-by: Name <email>`, one per
    // line, case-insensitive on the key the way `git interpret-trailers`
    // treats trailer keys generally.
    Regex::new(r"(?im)^co-authored-by:\s*(.+?)\s*<([^<>\s]+)>\s*$").expect("valid regex")
}

fn parse_co_authors(message: &str, re: &Regex) -> Vec<CommitAuthor> {
    re.captures_iter(message)
        .map(|caps| CommitAuthor {
            name: caps[1].trim().to_string(),
            email: caps[2].trim().to_string(),
        })
        .collect()
}

pub fn contributor_stats(commits: &[CommitData]) -> HashMap<String, Contributor> {
    let mut contributors: HashMap<String, Contributor> = HashMap::new();

    for commit in commits {
        // A `Co-authored-by:` trailer credits a second name (often a bot —
        // GitHub's own convention for exactly this) with the same commit;
        // crediting only `commit.author` would silently drop them from
        // every contributor-facing view.
        let credited = std::iter::once((commit.author.as_str(), commit.email.as_str())).chain(
            commit
                .co_authors
                .iter()
                .map(|c| (c.name.as_str(), c.email.as_str())),
        );

        for (name, email) in credited {
            let entry = contributors
                .entry(name.to_string())
                .or_insert_with(|| Contributor {
                    email: email.to_string(),
                    commits: 0,
                    lines_added: 0,
                    lines_removed: 0,
                    files_changed: 0,
                    first_commit: commit.timestamp,
                    last_commit: commit.timestamp,
                });

            entry.commits += 1;
            entry.lines_added += commit.lines_added;
            entry.lines_removed += commit.lines_removed;
            entry.files_changed += commit.total_files as u32;
            entry.first_commit = entry.first_commit.min(commit.timestamp);
            entry.last_commit = entry.last_commit.max(commit.timestamp);
        }
    }

    contributors
}

/// Identity of a changed file for stats purposes: the full repo-relative
/// path, not the basename. Keying by basename collapses every `mod.rs` /
/// `Dockerfile` / `__init__.py` in the tree into one bucket, and the frontend
/// indexes this map with the full path it builds from `new_path`/`old_path`
/// (frontend/src/lib/file-tree.ts), so a basename key also never resolves for
/// anything below the repo root.
fn file_key(change: &FileChange) -> &str {
    change
        .new_path
        .as_deref()
        .or(change.old_path.as_deref())
        .unwrap_or(&change.filename)
}

pub fn file_stats(commits: &[CommitData]) -> HashMap<String, FileStat> {
    let mut files: HashMap<String, FileStat> = HashMap::new();
    let mut authors_seen: HashMap<String, BTreeSet<String>> = HashMap::new();

    for commit in commits {
        for change in &commit.files_changed {
            let key = file_key(change);
            let entry = files.entry(key.to_string()).or_insert_with(|| FileStat {
                changes: 0,
                lines_added: 0,
                lines_removed: 0,
                authors: Vec::new(),
                first_change: commit.timestamp,
                last_change: commit.timestamp,
            });

            entry.changes += 1;
            entry.lines_added += change.lines_added;
            entry.lines_removed += change.lines_removed;
            entry.first_change = entry.first_change.min(commit.timestamp);
            entry.last_change = entry.last_change.max(commit.timestamp);

            let seen = authors_seen.entry(key.to_string()).or_default();
            seen.insert(commit.author.clone());
            for co_author in &commit.co_authors {
                seen.insert(co_author.name.clone());
            }
        }
    }

    for (filename, authors) in authors_seen {
        if let Some(stat) = files.get_mut(&filename) {
            stat.authors = authors.into_iter().collect();
        }
    }

    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    /// Build a throwaway repo with a few real commits, via the actual `git`
    /// binary — exercises the same commit/diff/rename paths a real
    /// repository would hit, rather than fabricating diff objects by hand.
    fn sample_repo() -> TempDir {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };

        run(&["init", "-q"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "user.email", "test@example.com"]);

        std::fs::write(path.join("README.md"), "# Test Repository\n").unwrap();
        run(&["add", "README.md"]);
        run(&["commit", "-q", "-m", "Initial commit"]);

        std::fs::write(path.join("main.rs"), "fn main() {}\n").unwrap();
        run(&["add", "main.rs"]);
        run(&["commit", "-q", "-m", "Add main.rs"]);

        std::fs::write(
            path.join("main.rs"),
            "fn main() {\n    println!(\"hi\");\n}\n",
        )
        .unwrap();
        run(&["add", "main.rs"]);
        run(&["commit", "-q", "-m", "Update main.rs"]);

        dir
    }

    #[test]
    fn opens_valid_repo() {
        let dir = sample_repo();
        assert!(GitAnalyzer::open(dir.path().to_str().unwrap()).is_ok());
    }

    #[test]
    fn analyzes_commits() {
        let dir = sample_repo();
        let analyzer = GitAnalyzer::open(dir.path().to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();

        assert_eq!(commits.len(), 3);
        let messages: Vec<_> = commits.iter().map(|c| c.message.trim()).collect();
        assert!(messages.contains(&"Initial commit"));
        assert!(messages.contains(&"Add main.rs"));
        assert!(messages.contains(&"Update main.rs"));

        for commit in &commits {
            assert!(!commit.hash.is_empty());
            assert!(!commit.author.is_empty());
        }
    }

    #[test]
    fn line_stats_match_known_diff() {
        let dir = sample_repo();
        let analyzer = GitAnalyzer::open(dir.path().to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();

        let initial = commits
            .iter()
            .find(|c| c.message.trim() == "Initial commit")
            .expect("initial commit present");
        assert_eq!(initial.files_changed.len(), 1);
        assert_eq!(initial.files_changed[0].filename, "README.md");
        assert_eq!(initial.files_changed[0].lines_added, 1);
        assert_eq!(initial.files_changed[0].lines_removed, 0);

        let add_main = commits
            .iter()
            .find(|c| c.message.trim() == "Add main.rs")
            .expect("add main.rs commit present");
        assert_eq!(add_main.files_changed.len(), 1);
        assert_eq!(add_main.files_changed[0].filename, "main.rs");
        assert_eq!(add_main.files_changed[0].lines_added, 1);
        assert_eq!(add_main.files_changed[0].lines_removed, 0);

        let update_main = commits
            .iter()
            .find(|c| c.message.trim() == "Update main.rs")
            .expect("update main.rs commit present");
        assert_eq!(update_main.files_changed.len(), 1);
        assert_eq!(update_main.files_changed[0].filename, "main.rs");
        assert_eq!(update_main.files_changed[0].lines_added, 3);
        assert_eq!(update_main.files_changed[0].lines_removed, 1);
    }

    #[test]
    fn contributor_stats_aggregate() {
        let dir = sample_repo();
        let analyzer = GitAnalyzer::open(dir.path().to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let contributors = contributor_stats(&commits);

        assert_eq!(contributors.len(), 1);
        let stats = contributors.get("Test User").expect("Test User present");
        assert_eq!(stats.commits, 3);
    }

    #[test]
    fn file_stats_track_changes() {
        let dir = sample_repo();
        let analyzer = GitAnalyzer::open(dir.path().to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let files = file_stats(&commits);

        assert!(files.contains_key("README.md"));
        assert!(files.contains_key("main.rs"));
        assert_eq!(files["main.rs"].changes, 2);
        for stat in files.values() {
            assert!(stat.changes > 0);
        }
    }

    /// `file_stats` must key on the full repo-relative path. Keying on the
    /// basename merges same-named files from different directories into one
    /// bucket, and never matches the full path the frontend looks up.
    #[test]
    fn file_stats_keyed_by_full_path_not_basename() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };

        run(&["init", "-q"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "user.email", "test@example.com"]);

        for dir_name in ["alpha", "beta"] {
            std::fs::create_dir_all(path.join(dir_name)).unwrap();
            std::fs::write(path.join(dir_name).join("mod.rs"), "// stub\n").unwrap();
        }
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "Add two mod.rs files"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let files = file_stats(&analyzer.analyze_commits().unwrap());

        assert!(
            files.contains_key("alpha/mod.rs"),
            "keys: {:?}",
            files.keys()
        );
        assert!(
            files.contains_key("beta/mod.rs"),
            "keys: {:?}",
            files.keys()
        );
        assert!(!files.contains_key("mod.rs"), "basename key must not exist");
        assert_eq!(files["alpha/mod.rs"].changes, 1);
        assert_eq!(files["beta/mod.rs"].changes, 1);
    }

    /// The line counter correlates each `Diff::foreach` line callback back to
    /// its delta by hand. A linear history of plain adds is the shape least
    /// likely to expose a mistake there, so cover deletes, renames and merges.
    #[test]
    fn line_stats_cover_deletes_renames_and_merges() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .env("GIT_AUTHOR_NAME", "Test User")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test User")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };

        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "user.email", "test@example.com"]);

        std::fs::write(path.join("keep.txt"), "a\nb\n").unwrap();
        std::fs::write(path.join("gone.txt"), "x\ny\nz\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "seed"]);

        run(&["rm", "-q", "gone.txt"]);
        run(&["commit", "-q", "-m", "delete gone.txt"]);

        run(&["mv", "keep.txt", "renamed.txt"]);
        run(&["commit", "-q", "-m", "rename keep.txt"]);

        // A branch that touches a different file, merged back with a real
        // merge commit (--no-ff), so the merge has two parents.
        run(&["checkout", "-q", "-b", "side"]);
        std::fs::write(path.join("side.txt"), "s\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "side work"]);
        run(&["checkout", "-q", "main"]);
        run(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let find = |msg: &str| {
            commits
                .iter()
                .find(|c| c.message.trim() == msg)
                .unwrap_or_else(|| panic!("{msg} present"))
        };

        let deleted = find("delete gone.txt");
        assert_eq!(deleted.files_changed.len(), 1);
        assert_eq!(deleted.files_changed[0].change_type, "DELETE");
        assert_eq!(deleted.files_changed[0].lines_added, 0);
        assert_eq!(deleted.files_changed[0].lines_removed, 3);
        // git2 reports BOTH paths on a delete (the new side carries a null
        // OID, not a null path, so `new_path` is `Some` even here).
        // Consumers that key on `new_path.or(old_path)` therefore still get
        // the right path, and the frontend's old_path fallback is
        // belt-and-braces rather than the load-bearing case its comment
        // once implied.
        assert_eq!(
            deleted.files_changed[0].old_path.as_deref(),
            Some("gone.txt")
        );
        assert_eq!(
            deleted.files_changed[0].new_path.as_deref(),
            Some("gone.txt")
        );

        // Rename detection is deliberately not enabled (no `find_similar`), so
        // git reports a rename as a delete plus an add. Pinning it here means
        // turning detection on becomes a visible, deliberate change rather
        // than a silent shift in every downstream count.
        let renamed = find("rename keep.txt");
        let mut kinds: Vec<_> = renamed
            .files_changed
            .iter()
            .map(|f| f.change_type.as_str())
            .collect();
        kinds.sort_unstable();
        assert_eq!(kinds, vec!["ADD", "DELETE"]);

        // Merges are diffed against the first parent only, so the side
        // branch's work is attributed to the merge as well. Deliberate
        // (`git log --first-parent` semantics) and documented in
        // docs/ARCHITECTURE.md — pinned so a change to it is not silent.
        let merge = find("merge side");
        assert_eq!(merge.files_changed.len(), 1);
        assert_eq!(merge.files_changed[0].filename, "side.txt");
        assert_eq!(merge.files_changed[0].lines_added, 1);
    }

    /// Commits sharing an author timestamp must still play back parent-first.
    /// `Sort::TIME` alone yields children before parents, and the stable
    /// `sort_by_key` preserves that reversed order for ties.
    #[test]
    fn equal_timestamps_preserve_parent_first_order() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        let fixed = "2020-01-01T00:00:00+00:00";
        let run = |args: &[&str]| {
            let status = Command::new("git")
                .args(args)
                .current_dir(path)
                .env("GIT_AUTHOR_DATE", fixed)
                .env("GIT_COMMITTER_DATE", fixed)
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };

        run(&["init", "-q"]);
        run(&["config", "user.name", "Test User"]);
        run(&["config", "user.email", "test@example.com"]);

        for i in 1..=5 {
            std::fs::write(path.join(format!("f{i}.txt")), format!("{i}\n")).unwrap();
            run(&["add", "."]);
            run(&["commit", "-q", "-m", &format!("commit{i}")]);
        }

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let order: Vec<_> = commits.iter().map(|c| c.message.trim()).collect();

        assert_eq!(
            order,
            vec!["commit1", "commit2", "commit3", "commit4", "commit5"]
        );
    }

    fn git_in(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(path)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    /// A `Co-authored-by:` trailer must credit that name/email in
    /// `CommitData`, and both `contributor_stats` and `file_stats` must in
    /// turn count it — otherwise a bot or pairing partner credited only via
    /// the trailer is invisible everywhere the primary author shows up.
    #[test]
    fn co_authored_commits_credit_the_trailer() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        git_in(path, &["init", "-q"]);
        git_in(path, &["config", "user.name", "Test User"]);
        git_in(path, &["config", "user.email", "test@example.com"]);

        std::fs::write(path.join("a.txt"), "hi\n").unwrap();
        git_in(path, &["add", "."]);
        let message =
            "Add a.txt\n\nCo-authored-by: Codesmith <codesmith-bot@users.noreply.github.com>\n";
        std::fs::write(path.join(".msg"), message).unwrap();
        git_in(path, &["commit", "-q", "-F", ".msg"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        assert_eq!(commits.len(), 1);
        let commit = &commits[0];
        assert_eq!(commit.co_authors.len(), 1);
        assert_eq!(commit.co_authors[0].name, "Codesmith");
        assert_eq!(
            commit.co_authors[0].email,
            "codesmith-bot@users.noreply.github.com"
        );

        let contributors = contributor_stats(&commits);
        assert_eq!(
            contributors.len(),
            2,
            "contributors: {:?}",
            contributors.keys().collect::<Vec<_>>()
        );
        let bot = contributors.get("Codesmith").expect("Codesmith credited");
        assert_eq!(bot.commits, 1);
        assert_eq!(bot.email, "codesmith-bot@users.noreply.github.com");

        let files = file_stats(&commits);
        assert!(files["a.txt"].authors.contains(&"Codesmith".to_string()));
        assert!(files["a.txt"].authors.contains(&"Test User".to_string()));
    }

    /// A file path matching HEAD's `.gitignore` — even one committed and
    /// then later ignored, so it's still present in history — must be
    /// dropped from `files_changed` and everything downstream, not just
    /// hidden from a future `git status`.
    #[test]
    fn gitignored_paths_are_excluded_from_the_analysis() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        git_in(path, &["init", "-q"]);
        git_in(path, &["config", "user.name", "Test User"]);
        git_in(path, &["config", "user.email", "test@example.com"]);

        // Committed before any ignore rule existed for it — exactly the
        // "generated output got checked in, then .gitignore caught up"
        // shape this feature targets.
        std::fs::create_dir_all(path.join("dist")).unwrap();
        std::fs::write(path.join("dist/bundle.js"), "console.log(1)\n").unwrap();
        std::fs::write(path.join("src.rs"), "fn main() {}\n").unwrap();
        git_in(path, &["add", "."]);
        git_in(path, &["commit", "-q", "-m", "add dist and src"]);

        std::fs::write(path.join(".gitignore"), "dist/\n").unwrap();
        git_in(path, &["add", ".gitignore"]);
        git_in(path, &["commit", "-q", "-m", "ignore dist"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();

        let first = commits
            .iter()
            .find(|c| c.message.trim() == "add dist and src")
            .unwrap();
        let paths: Vec<_> = first
            .files_changed
            .iter()
            .map(|f| f.filename.as_str())
            .collect();
        assert_eq!(paths, vec!["src.rs"], "dist/bundle.js should be filtered");
        assert_eq!(first.total_files, 1);

        let files = file_stats(&commits);
        assert!(!files.contains_key("dist/bundle.js"));
        assert!(files.contains_key("src.rs"));
    }

    /// A directory-anchored pattern (`target/`, no leading slash) must match
    /// at any depth, not just directly under the repo root — the exact shape
    /// of a real Cargo/Rust `.gitignore` entry.
    #[test]
    fn gitignore_directory_pattern_matches_at_any_depth() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        git_in(path, &["init", "-q"]);
        git_in(path, &["config", "user.name", "Test User"]);
        git_in(path, &["config", "user.email", "test@example.com"]);

        std::fs::write(path.join(".gitignore"), "target/\n").unwrap();
        std::fs::create_dir_all(path.join("crates/foo/target/release")).unwrap();
        std::fs::write(path.join("crates/foo/target/release/bin"), "x").unwrap();
        std::fs::write(path.join("crates/foo/lib.rs"), "// lib\n").unwrap();
        git_in(path, &["add", "-f", "."]);
        git_in(path, &["commit", "-q", "-m", "nested target dir"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let files = file_stats(&commits);

        assert!(!files.contains_key("crates/foo/target/release/bin"));
        assert!(files.contains_key("crates/foo/lib.rs"));
    }

    /// A negated pattern (`!path`) must re-include a file that an earlier,
    /// broader pattern would otherwise have excluded.
    #[test]
    fn gitignore_negation_re_includes_a_path() {
        let dir = TempDir::new().expect("tempdir");
        let path = dir.path();
        git_in(path, &["init", "-q"]);
        git_in(path, &["config", "user.name", "Test User"]);
        git_in(path, &["config", "user.email", "test@example.com"]);

        std::fs::write(path.join(".gitignore"), "*.bin\n!keep.bin\n").unwrap();
        std::fs::write(path.join("drop.bin"), "x").unwrap();
        std::fs::write(path.join("keep.bin"), "x").unwrap();
        git_in(path, &["add", "-f", "."]);
        git_in(path, &["commit", "-q", "-m", "bins"]);

        let analyzer = GitAnalyzer::open(path.to_str().unwrap()).unwrap();
        let commits = analyzer.analyze_commits().unwrap();
        let files = file_stats(&commits);

        assert!(!files.contains_key("drop.bin"));
        assert!(files.contains_key("keep.bin"));
    }

    /// An empty repository (no commits, no HEAD) must not fail analysis just
    /// because there's no tree to read `.gitignore` patterns from.
    #[test]
    fn build_head_gitignore_on_an_empty_repo_matches_nothing() {
        let dir = TempDir::new().expect("tempdir");
        git_in(dir.path(), &["init", "-q"]);
        let repo = Repository::open(dir.path()).unwrap();
        let gitignore = build_head_gitignore(&repo).unwrap();
        assert!(!gitignore.matched("anything.txt", false).is_ignore());
    }

    // --- Cross-language parity fixture ---
    //
    // `contributor_stats`/`file_stats` here and `contributorStatsAsOf`/
    // `fileStatsAsOf` in frontend/src/lib/as-of.ts are two independently
    // maintained implementations of the same aggregation logic (including
    // Co-authored-by crediting), previously kept in sync only by a comment
    // claiming they mirror each other. This test and its TS counterpart
    // (frontend/src/lib/__tests__/as-of-parity.test.ts) both read
    // test-fixtures/contributor-parity.json and assert the *same* expected
    // output baked into that file, so a future divergence between the two
    // implementations fails whichever
    // side actually drifted, not just "some test somewhere."

    #[derive(serde::Deserialize)]
    struct FixtureRoot {
        timeline: Vec<FixtureCommit>,
        expected_contributors: HashMap<String, FixtureContributor>,
        expected_file_authors: HashMap<String, Vec<String>>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCommit {
        timestamp: i64,
        datetime: String,
        commit_hash: String,
        author: String,
        message: String,
        files_changed: Vec<FixtureFileChange>,
        lines_added: u32,
        lines_removed: u32,
        co_authors: Vec<FixtureCoAuthor>,
    }

    #[derive(serde::Deserialize)]
    struct FixtureFileChange {
        filename: String,
        old_path: Option<String>,
        new_path: Option<String>,
        change_type: String,
        lines_added: u32,
        lines_removed: u32,
    }

    #[derive(serde::Deserialize)]
    struct FixtureCoAuthor {
        name: String,
        email: String,
    }

    #[derive(serde::Deserialize)]
    struct FixtureContributor {
        commits: u32,
        lines_added: u32,
        lines_removed: u32,
        files_changed: u32,
    }

    #[test]
    fn contributor_and_file_stats_match_the_shared_cross_language_fixture() {
        let raw = std::fs::read_to_string("test-fixtures/contributor-parity.json")
            .expect("read test-fixtures/contributor-parity.json (run from the repo root)");
        let fixture: FixtureRoot = serde_json::from_str(&raw).expect("valid fixture JSON");

        let commits: Vec<CommitData> = fixture
            .timeline
            .into_iter()
            .map(|c| {
                let files_changed: Vec<FileChange> = c
                    .files_changed
                    .into_iter()
                    .map(|f| FileChange {
                        filename: f.filename,
                        old_path: f.old_path,
                        new_path: f.new_path,
                        change_type: f.change_type,
                        lines_added: f.lines_added,
                        lines_removed: f.lines_removed,
                    })
                    .collect();
                let total_files = files_changed.len();
                CommitData {
                    hash: c.commit_hash,
                    author: c.author,
                    email: String::new(),
                    timestamp: c.timestamp,
                    datetime: c.datetime,
                    message: c.message,
                    files_changed,
                    lines_added: c.lines_added,
                    lines_removed: c.lines_removed,
                    total_files,
                    co_authors: c
                        .co_authors
                        .into_iter()
                        .map(|a| CommitAuthor {
                            name: a.name,
                            email: a.email,
                        })
                        .collect(),
                }
            })
            .collect();

        let contributors = contributor_stats(&commits);
        for (name, expected) in &fixture.expected_contributors {
            let actual = contributors
                .get(name)
                .unwrap_or_else(|| panic!("fixture expected contributor {name} to be credited"));
            assert_eq!(actual.commits, expected.commits, "{name} commits");
            assert_eq!(
                actual.lines_added, expected.lines_added,
                "{name} lines_added"
            );
            assert_eq!(
                actual.lines_removed, expected.lines_removed,
                "{name} lines_removed"
            );
            assert_eq!(
                actual.files_changed, expected.files_changed,
                "{name} files_changed"
            );
        }

        let files = file_stats(&commits);
        for (path, expected_authors) in &fixture.expected_file_authors {
            let mut actual_authors = files
                .get(path)
                .unwrap_or_else(|| panic!("fixture expected file {path} to be tracked"))
                .authors
                .clone();
            actual_authors.sort();
            let mut expected_sorted = expected_authors.clone();
            expected_sorted.sort();
            assert_eq!(actual_authors, expected_sorted, "{path} authors");
        }
    }
}
