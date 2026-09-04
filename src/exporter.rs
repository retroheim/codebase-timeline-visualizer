//! Assembles the analyzer's output into the JSON shape the frontend expects
//! and writes it to disk.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;

use serde::Serialize;

use crate::analyzer::{CommitAuthor, CommitData, Contributor, FileStat};

/// Wire-format version, written into every `timeline.json` as
/// `metadata.schema_version`. Bump it whenever a field is added, removed, or
/// changes meaning, and update `frontend/src/types.ts` in the same commit —
/// the frontend refuses a file it does not understand rather than rendering
/// half of it. `src/exporter.rs`'s contract test pins the emitted key set.
pub const SCHEMA_VERSION: u32 = 2;

#[derive(Serialize)]
pub struct DateRange {
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Serialize)]
pub struct Metadata {
    pub schema_version: u32,
    pub repo_name: String,
    pub github_repo: Option<String>,
    pub total_commits: usize,
    pub total_contributors: usize,
    pub total_files: usize,
    pub date_range: DateRange,
}

#[derive(Serialize)]
pub struct TimelineEvent {
    pub timestamp: i64,
    pub datetime: String,
    pub commit_hash: String,
    pub author: String,
    pub message: String,
    pub files_changed: Vec<crate::analyzer::FileChange>,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub cumulative_lines: i64,
    pub cumulative_files: usize,
    pub co_authors: Vec<CommitAuthor>,
}

#[derive(Serialize)]
pub struct TimelineData {
    pub metadata: Metadata,
    pub timeline: Vec<TimelineEvent>,
    pub contributors: HashMap<String, Contributor>,
    pub files: HashMap<String, FileStat>,
}

pub fn create_timeline_data(
    commits: Vec<CommitData>,
    contributors: HashMap<String, Contributor>,
    files: HashMap<String, FileStat>,
    repo_name: String,
    github_repo: Option<String>,
) -> TimelineData {
    let total_files = files.len();
    let date_range = DateRange {
        start: commits.first().map(|c| c.datetime.clone()),
        end: commits.last().map(|c| c.datetime.clone()),
    };

    let mut cumulative_lines: i64 = 0;
    // Live file set as of each commit. This used to emit the run's final
    // `total_files` on every event, so the "files over time" series was a flat
    // line that happened to end at the right value.
    let mut live_files: HashSet<String> = HashSet::new();
    let timeline = commits
        .into_iter()
        .map(|c| {
            cumulative_lines += c.lines_added as i64 - c.lines_removed as i64;
            for change in &c.files_changed {
                let path = change
                    .new_path
                    .as_deref()
                    .or(change.old_path.as_deref())
                    .unwrap_or(&change.filename);
                if change.change_type == "DELETE" {
                    live_files.remove(path);
                } else {
                    // A rename adds the new path; the old one is carried by
                    // the delta's DELETE half where git reports one.
                    live_files.insert(path.to_string());
                    if let (Some(old), Some(new)) = (&change.old_path, &change.new_path) {
                        if old != new {
                            live_files.remove(old);
                        }
                    }
                }
            }
            TimelineEvent {
                timestamp: c.timestamp,
                datetime: c.datetime,
                commit_hash: c.hash,
                author: c.author,
                message: c.message,
                files_changed: c.files_changed,
                lines_added: c.lines_added,
                lines_removed: c.lines_removed,
                cumulative_lines,
                cumulative_files: live_files.len(),
                co_authors: c.co_authors,
            }
        })
        .collect::<Vec<_>>();

    TimelineData {
        metadata: Metadata {
            schema_version: SCHEMA_VERSION,
            repo_name,
            github_repo,
            total_commits: timeline.len(),
            total_contributors: contributors.len(),
            total_files,
            date_range,
        },
        timeline,
        contributors,
        files,
    }
}

pub fn export_json(data: &TimelineData, output_path: &Path) -> Result<(), String> {
    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    // Stream straight to the file instead of building the whole document as
    // one String first — on a large repo that String is the peak allocation
    // of the entire run.
    let file = fs::File::create(output_path).map_err(|e| e.to_string())?;
    serde_json::to_writer_pretty(io::BufWriter::new(file), data).map_err(|e| e.to_string())?;
    println!("Timeline data exported to {}", output_path.display());
    Ok(())
}

/// Inline a JSON payload into a `<script>` body. A raw `</script>` inside the
/// data — entirely possible in a commit message — would close the tag early and
/// spill the rest of the timeline into the document as markup, so the sequence
/// is broken up. `<\/` is not valid JSON escaping but *is* valid JavaScript
/// string escaping, and the payload is parsed as JS here, not as JSON.
fn escape_for_script(json: &str) -> String {
    json.replace("</", "<\\/").replace("\u{2028}", "\\u2028")
}

/// Build a single self-contained HTML file: the built frontend with its JS and
/// CSS inlined, plus the timeline data embedded so it needs no server. The
/// frontend prefers `window.__CODEVIS_TIMELINE__` over fetching `/api/timeline`
/// when the global is present.
pub fn export_html(
    timeline_json: &str,
    frontend_build: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let index_path = frontend_build.join("index.html");
    let index = fs::read_to_string(&index_path).map_err(|e| {
        format!(
            "Could not read {} ({e}). Build the frontend first: cd frontend && npm run build",
            index_path.display()
        )
    })?;

    let asset = |url: &str| -> Result<String, String> {
        // Vite emits absolute URLs like `/assets/index-abc123.js`; resolve them
        // against the build directory rather than the filesystem root.
        let rel = url.trim_start_matches('/');
        let path = frontend_build.join(rel);
        fs::read_to_string(&path)
            .map_err(|e| format!("Could not inline asset {}: {e}", path.display()))
    };

    let script_re = regex::Regex::new(r#"<script\b[^>]*\bsrc="([^"]+)"[^>]*></script>"#)
        .map_err(|e| e.to_string())?;
    let link_re = regex::Regex::new(r#"<link\b[^>]*\bhref="([^"]+\.css)"[^>]*>"#)
        .map_err(|e| e.to_string())?;

    let mut html = index.clone();

    for caps in script_re.captures_iter(&index) {
        let contents = asset(&caps[1])?;
        html = html.replace(
            &caps[0],
            &format!("<script type=\"module\">\n{contents}\n</script>"),
        );
    }
    for caps in link_re.captures_iter(&index) {
        let contents = asset(&caps[1])?;
        html = html.replace(&caps[0], &format!("<style>\n{contents}\n</style>"));
    }

    let bootstrap = format!(
        "<script>window.__CODEVIS_TIMELINE__ = {};</script>",
        escape_for_script(timeline_json)
    );
    // Before everything else in <head> so the data is defined by the time the
    // module script runs.
    html = match html.find("<head>") {
        Some(idx) => {
            let insert_at = idx + "<head>".len();
            format!("{}{}{}", &html[..insert_at], bootstrap, &html[insert_at..])
        }
        None => format!("{bootstrap}{html}"),
    };

    if let Some(parent) = output_path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::write(output_path, html).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analyzer::FileChange;

    fn change(change_type: &str, path: &str) -> FileChange {
        let is_delete = change_type == "DELETE";
        FileChange {
            filename: path.rsplit('/').next().unwrap().to_string(),
            old_path: if change_type == "ADD" {
                None
            } else {
                Some(path.to_string())
            },
            new_path: if is_delete {
                None
            } else {
                Some(path.to_string())
            },
            change_type: change_type.to_string(),
            lines_added: 1,
            lines_removed: 0,
        }
    }

    fn commit(hash: &str, timestamp: i64, files: Vec<FileChange>) -> CommitData {
        CommitData {
            hash: hash.to_string(),
            author: "Test User".to_string(),
            email: "test@example.com".to_string(),
            timestamp,
            datetime: "2020-01-01T00:00:00+00:00".to_string(),
            message: format!("commit {hash}"),
            lines_added: files.iter().map(|f| f.lines_added).sum(),
            lines_removed: files.iter().map(|f| f.lines_removed).sum(),
            total_files: files.len(),
            files_changed: files,
            co_authors: Vec::new(),
        }
    }

    fn build(commits: Vec<CommitData>) -> TimelineData {
        create_timeline_data(
            commits,
            HashMap::new(),
            HashMap::new(),
            "repo".to_string(),
            None,
        )
    }

    /// `cumulative_files` is the live file count as of each event. It used to
    /// be the run's final total repeated on every event, so the series was a
    /// flat line that merely ended at the right value.
    #[test]
    fn cumulative_files_tracks_the_live_file_set() {
        let data = build(vec![
            commit("a", 1, vec![change("ADD", "src/one.rs")]),
            commit("b", 2, vec![change("ADD", "src/two.rs")]),
            commit("c", 3, vec![change("DELETE", "src/one.rs")]),
        ]);

        let counts: Vec<_> = data.timeline.iter().map(|e| e.cumulative_files).collect();
        assert_eq!(counts, vec![1, 2, 1]);
    }

    #[test]
    fn cumulative_lines_is_a_running_total() {
        let data = build(vec![
            commit("a", 1, vec![change("ADD", "one.rs")]),
            commit("b", 2, vec![change("ADD", "two.rs")]),
        ]);

        let lines: Vec<_> = data.timeline.iter().map(|e| e.cumulative_lines).collect();
        assert_eq!(lines, vec![1, 2]);
    }

    #[test]
    fn date_range_spans_first_to_last_commit() {
        let data = build(vec![
            commit("a", 1, vec![change("ADD", "one.rs")]),
            commit("b", 2, vec![change("ADD", "two.rs")]),
        ]);
        assert!(data.metadata.date_range.start.is_some());
        assert!(data.metadata.date_range.end.is_some());
        assert_eq!(data.metadata.total_commits, 2);
    }

    /// The emitted JSON is the ONLY contract between Rust and
    /// `frontend/src/types.ts`, which mirrors these structs by hand. This test
    /// fails the moment a field is added, removed, or renamed on either side
    /// without the other being updated.
    #[test]
    fn emitted_json_matches_the_frontend_contract() {
        let data = build(vec![commit("a", 1, vec![change("ADD", "src/one.rs")])]);
        let value = serde_json::to_value(&data).expect("serializes");

        let keys = |v: &serde_json::Value| -> Vec<String> {
            let mut k: Vec<String> = v.as_object().expect("object").keys().cloned().collect();
            k.sort();
            k
        };

        assert_eq!(
            keys(&value),
            vec!["contributors", "files", "metadata", "timeline"]
        );
        assert_eq!(
            keys(&value["metadata"]),
            vec![
                "date_range",
                "github_repo",
                "repo_name",
                "schema_version",
                "total_commits",
                "total_contributors",
                "total_files",
            ]
        );
        assert_eq!(
            keys(&value["timeline"][0]),
            vec![
                "author",
                "co_authors",
                "commit_hash",
                "cumulative_files",
                "cumulative_lines",
                "datetime",
                "files_changed",
                "lines_added",
                "lines_removed",
                "message",
                "timestamp",
            ]
        );
        assert_eq!(
            keys(&value["timeline"][0]["files_changed"][0]),
            vec![
                "change_type",
                "filename",
                "lines_added",
                "lines_removed",
                "new_path",
                "old_path",
            ]
        );
        assert_eq!(value["metadata"]["schema_version"], SCHEMA_VERSION);
    }

    /// A commit message containing `</script>` must not be able to close the
    /// inlined data tag and spill the rest of the timeline into the document.
    #[test]
    fn script_payload_cannot_break_out_of_its_tag() {
        let escaped = escape_for_script(r#"{"message":"</script><img src=x onerror=alert(1)>"}"#);
        assert!(!escaped.contains("</script>"));
        assert!(escaped.contains(r"<\/script>"));
    }

    #[test]
    fn export_html_inlines_assets_and_data() {
        let dir = tempfile::TempDir::new().unwrap();
        let build_dir = dir.path().join("build");
        std::fs::create_dir_all(build_dir.join("assets")).unwrap();
        std::fs::write(build_dir.join("assets/app.js"), "console.log('hi');").unwrap();
        std::fs::write(build_dir.join("assets/app.css"), "body{color:red}").unwrap();
        std::fs::write(
            build_dir.join("index.html"),
            r#"<!doctype html><html><head><link rel="stylesheet" href="/assets/app.css"><script type="module" crossorigin src="/assets/app.js"></script></head><body></body></html>"#,
        )
        .unwrap();

        let out = dir.path().join("out.html");
        export_html(r#"{"timeline":[]}"#, &build_dir, &out).unwrap();

        let html = std::fs::read_to_string(&out).unwrap();
        assert!(html.contains("console.log('hi');"), "js not inlined");
        assert!(html.contains("body{color:red}"), "css not inlined");
        assert!(
            html.contains("window.__CODEVIS_TIMELINE__"),
            "data not inlined"
        );
        assert!(
            !html.contains("src=\"/assets/app.js\""),
            "asset link remains"
        );
        assert!(
            !html.contains("href=\"/assets/app.css\""),
            "asset link remains"
        );
    }

    #[test]
    fn export_html_without_a_build_explains_itself() {
        let dir = tempfile::TempDir::new().unwrap();
        let err = export_html(
            "{}",
            &dir.path().join("missing"),
            &dir.path().join("o.html"),
        )
        .expect_err("should fail");
        assert!(err.contains("npm run build"), "unhelpful error: {err}");
    }
}
