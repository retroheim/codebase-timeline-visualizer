//! Cloning/refreshing a remote repository for a `GitUrl`-sourced project.
//!
//! Shells out to the system `git` binary (`std::process::Command`) rather
//! than enabling git2's `https`/`ssh` Cargo features: those pull in
//! `openssl-sys`/`libssh2-sys` for functionality the Docker image already
//! ships (and doesn't otherwise use) via the installed `git` CLI, and
//! `src/analyzer.rs`'s own tests already shell out to `git` — this extends
//! an existing pattern into production code rather than introducing a new
//! one.

use std::path::Path;
use std::process::Command;

use regex::Regex;
use std::sync::OnceLock;

fn url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    // `file://` is included deliberately: it grants no capability a
    // `LocalPath`-sourced project doesn't already have (arbitrary local
    // filesystem access is already possible via `path`, unclone'd) — and
    // it's git's standard local-transport scheme, the normal way to test
    // git plumbing against a fixture without a network dependency.
    PATTERN.get_or_init(|| {
        Regex::new(r"^(https://|git://|ssh://|file://|git@[\w.-]+:)").expect("valid regex")
    })
}

/// Rejects anything that isn't a recognizable git URL, and — critically —
/// anything starting with `-`. The value is passed as a positional argv
/// element (`Command::arg` never goes through a shell, so shell-metacharacter
/// injection is structurally impossible), but `git` itself parses a
/// leading-dash argument as a flag rather than a URL, so e.g.
/// `--upload-pack=...` would be interpreted as an option. Combined with
/// always invoking `git clone -- <url> <dest>` (the `--` stops option
/// parsing) below, this is defense in depth rather than the sole guard.
pub fn validate_git_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("Git URL must not be empty".to_string());
    }
    if url.starts_with('-') {
        return Err("Git URL must not start with '-'".to_string());
    }
    if !url_pattern().is_match(url) {
        return Err(format!(
            "Unrecognized git URL scheme: {url} (expected https://, git://, ssh://, file://, or user@host:path)"
        ));
    }
    Ok(())
}

/// Full clone — never `--depth 1`. `analyze_commits` needs the complete
/// history; a shallow clone would silently truncate the timeline with no
/// error surfaced anywhere.
pub fn clone_repo(url: &str, dest: &Path) -> Result<(), String> {
    validate_git_url(url)?;
    run_git(&["clone", "--", url, &dest.to_string_lossy()], None)
}

/// Refreshes an existing clone to match its upstream branch exactly,
/// discarding any local changes (there shouldn't be any — this directory is
/// server-managed, not user-edited). Resets to `@{u}` (the branch `clone`
/// configured as upstream) rather than `FETCH_HEAD`, since a bare `fetch
/// origin` can update multiple remote-tracking refs and leave `FETCH_HEAD`
/// pointing at whichever one was fetched last.
pub fn update_repo(dest: &Path) -> Result<(), String> {
    run_git(&["fetch", "origin"], Some(dest))?;
    run_git(&["reset", "--hard", "@{u}"], Some(dest))
}

fn userinfo_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    // Matches the `user:pass@`/`token@` userinfo segment of a URL with an
    // explicit scheme, e.g. `https://TOKEN@github.com/...` or
    // `https://user:pass@host/...` — the common ways this tool's own
    // `https://<credential>@host/...` registration pattern embeds a secret.
    // Deliberately does *not* touch scp-style `git@host:path` (no `://`):
    // that `git@` is a fixed, passwordless SSH convention, not a credential.
    PATTERN.get_or_init(|| Regex::new(r"^(\w+://)[^/@]+@").expect("valid regex"))
}

/// Strips embedded credentials from a URL before it can end up somewhere
/// that gets persisted or served back over an unauthenticated API — see
/// `run_git`'s error formatting below and `Project::redacted` in registry.rs.
pub(crate) fn redact_url(url: &str) -> String {
    userinfo_pattern().replace(url, "$1***@").into_owned()
}

fn run_git(args: &[&str], current_dir: Option<&Path>) -> Result<(), String> {
    let mut command = Command::new("git");
    command.args(args);
    if let Some(dir) = current_dir {
        command.current_dir(dir);
    }
    // Bound how long a hung network operation can wedge this project's
    // analyze job — and, since the caller holds `try_start_analyzing`'s
    // guard for the duration, every future retry for this project too.
    command
        .env("GIT_HTTP_LOW_SPEED_LIMIT", "1000")
        .env("GIT_HTTP_LOW_SPEED_TIME", "30")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=30",
        );

    let redacted_args: Vec<String> = args.iter().map(|a| redact_url(a)).collect();
    let output = command
        .output()
        .map_err(|e| format!("Could not run git {redacted_args:?}: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "git {redacted_args:?} failed: {}",
            redact_url(stderr.trim())
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redact_url_masks_embedded_basic_auth_and_bearer_tokens() {
        assert_eq!(
            redact_url("https://user:token@github.com/owner/repo.git"),
            "https://***@github.com/owner/repo.git"
        );
        assert_eq!(
            redact_url("https://ghp_abc123@github.com/owner/repo.git"),
            "https://***@github.com/owner/repo.git"
        );
    }

    #[test]
    fn redact_url_leaves_credential_free_urls_and_scp_style_untouched() {
        assert_eq!(
            redact_url("https://github.com/owner/repo.git"),
            "https://github.com/owner/repo.git"
        );
        // scp-style `git@host:path` has no `://` — the fixed `git` username
        // isn't a credential, so it's intentionally not touched.
        assert_eq!(
            redact_url("git@github.com:owner/repo.git"),
            "git@github.com:owner/repo.git"
        );
    }

    #[test]
    fn accepts_https_and_ssh_and_scp_style_urls() {
        assert!(validate_git_url("https://github.com/owner/repo.git").is_ok());
        assert!(validate_git_url("ssh://git@github.com/owner/repo.git").is_ok());
        assert!(validate_git_url("git@github.com:owner/repo.git").is_ok());
        assert!(validate_git_url("git://example.com/repo.git").is_ok());
        assert!(validate_git_url("file:///home/user/bare-repo.git").is_ok());
    }

    #[test]
    fn rejects_empty_and_whitespace_only() {
        assert!(validate_git_url("").is_err());
        assert!(validate_git_url("   ").is_err());
    }

    #[test]
    fn rejects_leading_dash_even_with_a_plausible_looking_scheme() {
        assert!(validate_git_url("--upload-pack=/bin/sh").is_err());
        assert!(validate_git_url("-https://github.com/x/y").is_err());
    }

    #[test]
    fn rejects_a_bare_local_path() {
        assert!(validate_git_url("/home/user/repo").is_err());
        assert!(validate_git_url("relative/path").is_err());
    }

    #[test]
    fn rejects_unrecognized_scheme() {
        assert!(validate_git_url("ftp://example.com/repo.git").is_err());
        assert!(validate_git_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn clone_then_update_round_trips_against_a_local_bare_repo() {
        let src_dir = tempfile::TempDir::new().unwrap();
        let run = |args: &[&str], dir: &Path| {
            let status = Command::new("git")
                .args(args)
                .current_dir(dir)
                .env("GIT_AUTHOR_NAME", "Test User")
                .env("GIT_AUTHOR_EMAIL", "test@example.com")
                .env("GIT_COMMITTER_NAME", "Test User")
                .env("GIT_COMMITTER_EMAIL", "test@example.com")
                .status()
                .expect("run git");
            assert!(status.success(), "git {args:?} failed");
        };
        run(&["init", "-q", "-b", "main"], src_dir.path());
        std::fs::write(src_dir.path().join("a.txt"), "one").unwrap();
        run(&["add", "."], src_dir.path());
        run(&["commit", "-q", "-m", "first"], src_dir.path());

        let dest_dir = tempfile::TempDir::new().unwrap();
        let clone_dest = dest_dir.path().join("clone");
        let url = format!("file://{}", src_dir.path().display());
        clone_repo(&url, &clone_dest).unwrap();
        assert!(clone_dest.join("a.txt").exists());

        std::fs::write(src_dir.path().join("b.txt"), "two").unwrap();
        run(&["add", "."], src_dir.path());
        run(&["commit", "-q", "-m", "second"], src_dir.path());

        update_repo(&clone_dest).unwrap();
        assert!(clone_dest.join("b.txt").exists());
    }

    /// A failed clone's error message embeds the full argv (see `run_git`),
    /// so without redaction a credentialed URL that fails to clone would
    /// leak straight into `ProjectStatus::Error` — persisted and served the
    /// same way a successful clone's URL is.
    #[test]
    fn failed_clone_error_message_redacts_embedded_credentials() {
        let dest_dir = tempfile::TempDir::new().unwrap();
        let dest = dest_dir.path().join("clone");
        // Port 1 is a privileged port essentially never listening — this
        // fails fast (connection refused) rather than waiting out the
        // low-speed timeout.
        let err = clone_repo("https://user:s3cr3t@127.0.0.1:1/nope.git", &dest).unwrap_err();
        assert!(
            !err.contains("s3cr3t"),
            "error must not leak the credential: {err}"
        );
        assert!(
            err.contains("***@127.0.0.1"),
            "error should show the redacted form: {err}"
        );
    }
}
