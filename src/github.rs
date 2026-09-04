//! Parses a git remote URL into a GitHub "owner/repo" slug, if it's a
//! github.com remote. Handles both SSH (`git@github.com:owner/repo.git`)
//! and HTTPS (`https://github.com/owner/repo.git`) forms.

use regex::Regex;
use std::sync::OnceLock;

fn pattern() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Anchored at the start and restricted to GitHub's owner/repo charset.
        // An unanchored `github\.com` matched any host merely *containing* it
        // (`evilgithub.com/a/b`, `https://host/github.com/a/b`), and the slug
        // that produced is interpolated into an api.github.com URL the browser
        // then fetches.
        Regex::new(
            r"^(?:https?://|git://|ssh://git@|git@)github\.com[:/]([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$",
        )
        .expect("valid regex")
    })
}

pub fn parse_slug(remote_url: &str) -> Option<String> {
    let caps = pattern().captures(remote_url)?;
    Some(format!("{}/{}", &caps[1], &caps[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ssh_remote() {
        assert_eq!(
            parse_slug("git@github.com:owner/repo.git"),
            Some("owner/repo".to_string())
        );
    }

    #[test]
    fn parses_https_remote() {
        assert_eq!(
            parse_slug("https://github.com/owner/repo.git"),
            Some("owner/repo".to_string())
        );
        assert_eq!(
            parse_slug("https://github.com/owner/repo"),
            Some("owner/repo".to_string())
        );
    }

    #[test]
    fn non_github_remote_is_none() {
        assert_eq!(parse_slug("https://gitlab.com/owner/repo.git"), None);
    }

    /// A host that merely contains "github.com", or carries it as a path
    /// segment, must not produce a slug — that slug ends up in an
    /// api.github.com URL the browser fetches.
    #[test]
    fn lookalike_hosts_are_none() {
        assert_eq!(parse_slug("https://evilgithub.com/owner/repo"), None);
        assert_eq!(
            parse_slug("https://evil.example/github.com/owner/repo"),
            None
        );
        assert_eq!(
            parse_slug("https://github.com.evil.example/owner/repo"),
            None
        );
    }

    #[test]
    fn path_traversal_and_query_are_rejected() {
        assert_eq!(parse_slug("https://github.com/owner/../../etc"), None);
        assert_eq!(parse_slug("https://github.com/owner/repo?x=1"), None);
        assert_eq!(parse_slug("https://github.com/owner/repo#frag"), None);
    }

    #[test]
    fn ssh_scheme_form_parses() {
        assert_eq!(
            parse_slug("ssh://git@github.com/owner/repo.git"),
            Some("owner/repo".to_string())
        );
    }
}
