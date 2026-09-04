# CLAUDE.md

Guidance for agents and new contributors working in this repo.

## What this is

`codevis` analyzes a Git repository into `timeline.json` and animates it in the
browser. Two halves, one wire format:

- `src/` — Rust. CLI (`clap`), git history analysis (`git2` + `rayon`), an
  `axum` server, and a JSON exporter.
- `frontend/` — TypeScript. Lit 3 web components, d3 for layout and
  transitions, canvas for the tree, SVG for contributor avatars.

## Build, test, lint

These are exactly what CI runs (`.github/workflows/pipeline.yml`). A change is
"done" when all of them pass.

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo tarpaulin --fail-under 80 --out Stdout   # coverage gate, see below

cd frontend
npm test               # vitest
npm run test:coverage  # vitest --coverage, thresholds in vite.config.ts
npx tsc --noEmit
npm run build          # tsc --noEmit && vite build
```

`nix develop` (see `flake.nix`) provides Rust, Node, cmake, pkg-config, and
`cargo-tarpaulin`.

Coverage is a floor, not a target to chase for its own sake: `cargo tarpaulin
--fail-under 80` and the `thresholds` block in `frontend/vite.config.ts` exist
to catch a real regression (a deleted test file, a new untested module), not
to gate every PR on hitting some percentage. Raise the numbers as coverage
grows; don't lower them to make a failing change pass.

Run the thing end to end:

```bash
cargo run --release -- analyze . -o timeline.json
cd frontend && npm run build && cd ..
cargo run --release -- serve --data timeline.json   # http://localhost:3001
```

## Gotchas that are not visible from reading one file

- **Do not cache the per-thread `git2::Repository` in a `thread_local!`.**
  `analyze_commits` uses `map_init` so each handle's lifetime is scoped to
  *that call*, not to the rayon worker thread. Rayon's pool is global and
  outlives calls, so a thread-lifetime cache hands a later call a handle
  pointing at an earlier, possibly deleted repository — surfacing as
  intermittent "object not found". See `src/analyzer.rs` and
  `docs/solutions/rayon-thread-affinity-resource-scoping.md`.
- **The `Diff::foreach` delta index is correlated by hand.** The file callback
  fires once per delta before that delta's line callbacks, and a `Cell` carries
  the index across. Nothing in the type system holds this together, so a
  refactor can silently attribute one file's line counts to another. The test
  `line_stats_match_known_diff` pins exact counts — keep it that way. See
  `docs/solutions/git2-diff-foreach-line-counting.md`.
- **`files` is keyed by full repo-relative path, not basename.** It used to be
  the basename, which merged every `mod.rs` in the tree into one entry and never
  matched the full path the frontend looks up. `file_key()` in
  `src/analyzer.rs` is the single place that decides this.
- **Merge commits are diffed against their first parent only.** Lines merged in
  are therefore counted twice — once on the branch commit, once on the merge.
  This is deliberate (`git log --first-parent` semantics); see the known
  limitations in `docs/ARCHITECTURE.md`.
- **`serve` binds loopback by default.** `timeline.json` carries author names
  and email addresses. `--host 0.0.0.0` is opt-in and containers must pass it.
- **`frontend/build` is resolved relative to the process working directory** by
  `ServeDir` in `src/server.rs`. Running the installed binary from elsewhere
  serves no static assets.

## Conventions this codebase already follows

- Rust errors are `Result<_, String>` with human-readable messages, mapped at
  the boundary via `.map_err(|e| e.to_string())`. No `anyhow`, no custom error
  enum.
- Every `src/*.rs` opens with a `//!` module header saying what it owns.
- Comments explain *why*, not *what* — especially where a simpler-looking
  alternative is wrong. Match that; a comment restating the code is noise.
- The wire format is snake_case on both sides. `frontend/src/types.ts` mirrors
  the `Serialize` structs in `src/analyzer.rs` and `src/exporter.rs` by hand,
  so **any field change is a two-file change**, guarded by
  `src/exporter.rs`'s contract test.
- Pure logic lives in `frontend/src/lib/` and is unit-tested; components in
  `frontend/src/components/` own DOM and lifecycle. Put new math in `lib/`.

## When changing things

- CLI flags, ports, or paths: update `README.md` and
  `docs/GETTING_STARTED.md` in the same commit.
- CI jobs: update `docs/WORKFLOWS.md`, which claims to describe what CI
  actually does.
- The wire format: bump `SCHEMA_VERSION` in `src/exporter.rs` and update
  `frontend/src/types.ts`.
- Renaming/moving a `.rs`/`.ts` file, renaming a function `README.md`/
  `SECURITY.md`/`SETUP_TROUBLESHOOTING.md`/`CLAUDE.md`/`docs/*.md` mention by
  name, or bumping `SCHEMA_VERSION`: `cargo test` already catches a doc left
  pointing at the old name via `tests/docs_accuracy.rs` — update the doc, not
  the test, unless the test's own heuristics are what's wrong. New doc files
  need adding to that test's `doc_relative_paths()` to be covered at all.

## Docs map

| Task | Read |
|---|---|
| Setting up, running it | `docs/GETTING_STARTED.md` |
| Build or environment failure | `SETUP_TROUBLESHOOTING.md` |
| Touching the analyzer or the radial layout | `docs/ARCHITECTURE.md` (has a "known limitations" section — read before "fixing" anything there) |
| CI/CD, Pages deploy | `docs/WORKFLOWS.md` |
| A bug class that bit us before | `docs/solutions/` |
| Security posture, reporting | `SECURITY.md` |
