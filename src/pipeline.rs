//! The repo-path-to-`TimelineData` pipeline, shared by the `analyze` CLI
//! command and the server's project-registry analyze jobs. Kept CLI-agnostic
//! (no stdout writes beyond the optional `verbose` progress lines, no file
//! I/O) so a route handler can call it directly and decide independently
//! whether/where to persist the result.

use std::path::Path;

use crate::analyzer::GitAnalyzer;
use crate::exporter::{self, TimelineData};

pub fn analyze_repository(repo_path: &Path, verbose: bool) -> Result<TimelineData, String> {
    if !repo_path.exists() {
        return Err(format!(
            "Repository path does not exist: {}",
            repo_path.display()
        ));
    }
    if verbose {
        println!("Analyzing repository: {}", repo_path.display());
    }

    // No `.git` precheck: it rejects bare repos that git2 opens fine, and
    // `GitAnalyzer::open` already reports "Not a Git repository" with the
    // underlying libgit2 reason. One source of truth beats two.
    let analyzer = GitAnalyzer::open(repo_path)?;

    if verbose {
        println!("Extracting commit history...");
    }
    let commits = analyzer.analyze_commits()?;
    if verbose {
        println!("Found {} commits", commits.len());
        println!("Calculating contributor statistics...");
    }
    let contributors = crate::analyzer::contributor_stats(&commits);
    if verbose {
        println!("Calculating file statistics...");
    }
    let files = crate::analyzer::file_stats(&commits);

    if verbose {
        println!("Creating timeline data...");
    }
    let repo_name = repo_path
        .canonicalize()
        .unwrap_or_else(|_| repo_path.to_path_buf())
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let github_repo = analyzer.github_slug();

    Ok(exporter::create_timeline_data(
        commits,
        contributors,
        files,
        repo_name,
        github_repo,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

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

        std::fs::write(path.join("a.txt"), "one\n").unwrap();
        run(&["add", "a.txt"]);
        run(&["commit", "-q", "-m", "first"]);

        std::fs::write(path.join("b.txt"), "two\n").unwrap();
        run(&["add", "b.txt"]);
        run(&["commit", "-q", "-m", "second"]);

        dir
    }

    #[test]
    fn errors_on_a_nonexistent_path() {
        // Not `.unwrap_err()`: that requires the Ok variant (`TimelineData`)
        // to implement `Debug` too, which it deliberately doesn't.
        match analyze_repository(Path::new("/no/such/path/at/all"), false) {
            Err(err) => assert!(err.contains("does not exist"), "err: {err}"),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn errors_on_a_path_that_is_not_a_git_repo() {
        let dir = TempDir::new().unwrap();
        match analyze_repository(dir.path(), false) {
            Err(err) => assert!(err.contains("Not a Git repository"), "err: {err}"),
            Ok(_) => panic!("expected an error"),
        }
    }

    #[test]
    fn produces_timeline_data_matching_the_commits_made() {
        let repo = sample_repo();
        let data = analyze_repository(repo.path(), false).unwrap();

        assert_eq!(data.metadata.total_commits, 2);
        assert_eq!(data.metadata.total_files, 2);
        assert_eq!(data.timeline.len(), 2);
        assert_eq!(data.contributors.len(), 1);
        assert!(data.files.contains_key("a.txt"));
        assert!(data.files.contains_key("b.txt"));
    }

    #[test]
    fn repo_name_falls_back_to_the_directory_name() {
        let repo = sample_repo();
        let data = analyze_repository(repo.path(), false).unwrap();
        let expected = repo.path().file_name().unwrap().to_string_lossy();
        assert_eq!(data.metadata.repo_name, expected);
    }

    #[test]
    fn verbose_mode_does_not_change_the_result() {
        let repo = sample_repo();
        let quiet = analyze_repository(repo.path(), false).unwrap();
        let verbose = analyze_repository(repo.path(), true).unwrap();
        assert_eq!(quiet.metadata.total_commits, verbose.metadata.total_commits);
    }
}
