//! Cross-checks what the docs *claim* about the source tree against the
//! source tree itself, so a renamed function, a moved file, or a bumped
//! `SCHEMA_VERSION` doesn't silently rot in prose that nothing else ever
//! re-reads. Runs as part of the normal `cargo test`, so CI catches drift on
//! every push — no separate lint step to remember to run.
//!
//! Deliberately conservative: a false negative (a stale reference this
//! doesn't catch) is acceptable, a false positive (failing CI over a
//! placeholder like `foo.rs` in a naming-convention example, or `owner/repo`
//! as a slug pattern) is not. See the heuristics inline for exactly what
//! gets skipped and why.
//!
//! `docs/solutions/**` is deliberately out of scope: those documents narrate
//! a past incident, including code as it looked *then* — holding them to
//! "does this still exist" would be checking the wrong thing.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Every markdown doc this check holds accountable.
fn doc_relative_paths() -> &'static [&'static str] {
    &[
        "README.md",
        "SECURITY.md",
        "SETUP_TROUBLESHOOTING.md",
        "CLAUDE.md",
        "docs/ARCHITECTURE.md",
        "docs/GETTING_STARTED.md",
        "docs/WORKFLOWS.md",
    ]
}

fn read_docs() -> Vec<(PathBuf, String)> {
    let root = repo_root();
    doc_relative_paths()
        .iter()
        .map(|rel| {
            let path = root.join(rel);
            let content = fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("could not read {}: {e}", path.display()));
            (path, content)
        })
        .collect()
}

/// Every inline single-backtick span in `text`, skipping fenced (` ``` `)
/// code blocks — a Mermaid diagram or shell snippet inside one isn't prose
/// making a claim about a specific file or symbol.
fn backtick_spans(text: &str) -> Vec<String> {
    let mut spans = Vec::new();
    let mut in_fence = false;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let mut start: Option<usize> = None;
        for (i, c) in line.char_indices() {
            if c != '`' {
                continue;
            }
            match start {
                None => start = Some(i + 1),
                Some(s) => {
                    spans.push(line[s..i].to_string());
                    start = None;
                }
            }
        }
    }
    spans
}

/// Recursively concatenates every `.rs`/`.ts` file's text under `dir`, for
/// a cheap "does this identifier appear anywhere" search. Skips build
/// output and third-party code — neither is where a doc-referenced symbol
/// would be defined or meaningfully used.
fn source_text() -> &'static str {
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        const SKIP_DIRS: &[&str] = &[
            "target",
            "node_modules",
            "build",
            "dist",
            "coverage",
            ".git",
        ];
        let mut buf = String::new();
        let mut stack = vec![repo_root()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if path.is_dir() {
                    if !SKIP_DIRS.contains(&name.as_ref()) {
                        stack.push(path);
                    }
                    continue;
                }
                if matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("rs") | Some("ts")
                ) {
                    if let Ok(text) = fs::read_to_string(&path) {
                        buf.push_str(&text);
                        buf.push('\n');
                    }
                }
            }
        }
        buf
    })
}

const PATH_EXTENSIONS: &[&str] = &["rs", "ts", "md", "json", "toml", "yml", "nix", "html"];
// Any of these appearing in a backtick span means it's a shell command, a
// regex/glob literal, a CSS value, a generic type, an HTTP route, or a URL —
// never one of this repo's own multi-segment file paths.
const PATH_DISQUALIFYING_CHARS: &[char] = &[
    '<', '>', '{', '}', '[', ']', '*', '\\', '@', ':', '#', '(', ')', ' ',
];

/// Bare (no `/`) top-level filenames worth checking individually — deliberately
/// short and explicit rather than "any bare `*.rs`/`*.ts`", which would flag
/// every generic example filename in prose (`foo.rs`, `auth_test.rs`, `mod.rs`,
/// `timeline.json` used as a generic noun, a historically-removed
/// `static.yml`) as if it were a specific, checkable claim.
const TOP_LEVEL_FILES: &[&str] = &[
    "README.md",
    "SECURITY.md",
    "SETUP_TROUBLESHOOTING.md",
    "CLAUDE.md",
    "LICENSE",
    "Cargo.toml",
    "flake.nix",
    "docker-compose.yml",
    "Dockerfile",
];

/// A relative path this repo's docs would plausibly write out, resolved
/// against the repo root — with one fallback: `lib/x.ts`/`components/x.ts`
/// are the docs' own established shorthand for `frontend/src/lib/x.ts`/
/// `frontend/src/components/x.ts` (every "Frontend (`frontend/src/`)"
/// section states the base path once rather than repeating it per entry).
fn resolve_repo_path(span: &str) -> Option<PathBuf> {
    let root = repo_root();
    let direct = root.join(span);
    if direct.exists() {
        return Some(direct);
    }
    if span.starts_with("lib/") || span.starts_with("components/") {
        let shorthand = root.join("frontend/src").join(span);
        if shorthand.exists() {
            return Some(shorthand);
        }
    }
    None
}

fn is_checkable_multi_segment_path(span: &str) -> bool {
    !span.is_empty()
        && !span.starts_with("http")
        && !span.starts_with('/') // an HTTP route (`/api/...`), not a filesystem path
        && span.contains('/')
        && !span.contains(PATH_DISQUALIFYING_CHARS)
        && span
            .rsplit('.')
            .next()
            .is_some_and(|ext| PATH_EXTENSIONS.contains(&ext))
}

#[test]
fn every_multi_segment_file_path_in_the_docs_exists() {
    let mut missing = Vec::new();
    for (doc_path, content) in read_docs() {
        let mut seen = HashSet::new();
        for span in backtick_spans(&content) {
            if !is_checkable_multi_segment_path(&span) || !seen.insert(span.clone()) {
                continue;
            }
            if resolve_repo_path(&span).is_none() {
                missing.push(format!("{}: `{span}`", doc_path.display()));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "docs reference a file path that doesn't exist on disk:\n{}",
        missing.join("\n")
    );
}

#[test]
fn every_bare_top_level_filename_in_the_docs_exists() {
    let root = repo_root();
    let mut missing = Vec::new();
    for (doc_path, content) in read_docs() {
        let mut seen = HashSet::new();
        for span in backtick_spans(&content) {
            if !TOP_LEVEL_FILES.contains(&span.as_str()) || !seen.insert(span.clone()) {
                continue;
            }
            if !root.join(&span).exists() {
                missing.push(format!("{}: `{span}`", doc_path.display()));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "docs reference a top-level file that doesn't exist on disk:\n{}",
        missing.join("\n")
    );
}

/// `` `identifier()` ``, optionally qualified (`` `Type::method()` ``,
/// `` `module::function()` ``) — the bare identifier after the last `::` is
/// what gets searched for, since that's the part a rename/typo would break.
fn function_ref_identifier(span: &str) -> Option<&str> {
    let inner = span.strip_suffix("()")?;
    if inner.is_empty() {
        return None;
    }
    let ident = inner.rsplit("::").next().unwrap_or(inner);
    let mut chars = ident.chars();
    let first_ok = chars.next().is_some_and(|c| c.is_alphabetic() || c == '_');
    let rest_ok = chars.all(|c| c.is_alphanumeric() || c == '_');
    (first_ok && rest_ok).then_some(ident)
}

#[test]
fn every_function_reference_in_the_docs_appears_somewhere_in_the_source_tree() {
    let text = source_text();
    let mut missing = Vec::new();
    let mut checked = HashSet::new();
    for (doc_path, content) in read_docs() {
        for span in backtick_spans(&content) {
            let Some(ident) = function_ref_identifier(&span) else {
                continue;
            };
            if !checked.insert(ident.to_string()) {
                continue;
            }
            let pattern = Regex::new(&format!(r"\b{}\b", regex::escape(ident))).unwrap();
            if !pattern.is_match(text) {
                missing.push(format!(
                    "{}: `{span}` (identifier `{ident}`)",
                    doc_path.display()
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "docs reference a function/method that doesn't appear anywhere in src/ or frontend/src/:\n{}",
        missing.join("\n")
    );
}

#[test]
fn every_relative_markdown_link_in_the_docs_resolves() {
    static LINK_RE: OnceLock<Regex> = OnceLock::new();
    let link_re = LINK_RE.get_or_init(|| Regex::new(r"\]\(([^)]+)\)").unwrap());

    let mut missing = Vec::new();
    for (doc_path, content) in read_docs() {
        let doc_dir = doc_path.parent().expect("doc has a parent dir");
        for caps in link_re.captures_iter(&content) {
            let target = &caps[1];
            if target.starts_with("http://")
                || target.starts_with("https://")
                || target.starts_with("mailto:")
            {
                continue;
            }
            // Strip a `#anchor` fragment — a heading anchor isn't a filesystem
            // path, and the file it's attached to is what matters here.
            let target = target.split('#').next().unwrap_or(target);
            if target.is_empty() {
                continue; // a same-page `#anchor` link
            }
            if !doc_dir.join(target).exists() {
                missing.push(format!(
                    "{}: ]({}) -> {}",
                    doc_path.display(),
                    &caps[1],
                    doc_dir.join(target).display()
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "docs contain a relative markdown link that doesn't resolve:\n{}",
        missing.join("\n")
    );
}

/// `docs/ARCHITECTURE.md` states the current `SCHEMA_VERSION` in prose
/// ("currently `N`") — this pins that number against the actual constant in
/// `src/exporter.rs`'s source text, so a version bump that forgets the doc
/// update fails loudly instead of leaving the doc quietly wrong.
#[test]
fn schema_version_claimed_in_architecture_doc_matches_the_source_constant() {
    let root = repo_root();
    let exporter_src =
        fs::read_to_string(root.join("src/exporter.rs")).expect("read src/exporter.rs");
    let actual: u32 = Regex::new(r"pub const SCHEMA_VERSION: u32 = (\d+);")
        .unwrap()
        .captures(&exporter_src)
        .unwrap_or_else(|| panic!("src/exporter.rs no longer defines SCHEMA_VERSION as expected — update this test's pattern"))
        .get(1)
        .unwrap()
        .as_str()
        .parse()
        .unwrap();

    let arch =
        fs::read_to_string(root.join("docs/ARCHITECTURE.md")).expect("read docs/ARCHITECTURE.md");
    let claimed: u32 = Regex::new(r"SCHEMA_VERSION.*?currently `(\d+)`")
        .unwrap()
        .captures(&arch)
        .unwrap_or_else(|| {
            panic!("docs/ARCHITECTURE.md no longer states \"SCHEMA_VERSION (currently `N`...)\" — update this test's pattern or restore that sentence")
        })
        .get(1)
        .unwrap()
        .as_str()
        .parse()
        .unwrap();

    assert_eq!(
        claimed, actual,
        "docs/ARCHITECTURE.md claims SCHEMA_VERSION is currently {claimed}, but src/exporter.rs defines it as {actual} — update the doc"
    );
}
