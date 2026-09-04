# GitHub Workflows

One workflow runs in this repo (`static.yml` was removed — see Pages deploys below). This document describes what they actually do — not an aspirational list.

## CI/CD Pipeline (`.github/workflows/pipeline.yml`)

Triggers: push/PR to `main`/`develop`, plus a weekly Monday-06:00 cron for the security job.

| Job | Runs when | What it does |
|---|---|---|
| `test` | always | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test --release`, `cargo tarpaulin --fail-under 80` (line-coverage floor) |
| `security` | push, schedule | `cargo audit` (advisory-db scan of `Cargo.lock`) — a known advisory fails the job — plus CodeQL analysis (JavaScript, for the frontend) |
| `frontend-test` | always | `npm ci`, `npm test` (vitest), `npm run test:coverage` (vitest coverage-v8, thresholds in `vite.config.ts`), `tsc --noEmit` in `frontend/` |
| `frontend` | push to `main`, after `test`+`frontend-test` | `npm ci` + `npm run build` in `frontend/`, uploads `frontend/build` as a Pages artifact |
| `deploy` | push to `main`, after `test`+`frontend` | Deploys the uploaded artifact to GitHub Pages |
| `dependency-review` | pull requests only | `actions/dependency-review-action` |
| `release` | push to `main` with a `release:` commit message | Builds the release binary and attaches `target/release/codevis` + `README.md` to a GitHub Release |

Rust dependency versions are pinned via `Cargo.lock`, which is checked into the repo — `cargo test`/`build` in CI use exactly what's committed, not "whatever's latest."

## Pages deploys

`pipeline.yml`'s `frontend` + `deploy` jobs are the only path to GitHub Pages.

There used to be a second workflow, `static.yml`, which uploaded the **entire
repository checkout** (`path: '.'`) as the Pages artifact on every push to
`main`. Two problems: it competed with `pipeline.yml` for the same Pages
environment, so which deploy won was a race, and it published every file in the
repo rather than just the built frontend. It was removed rather than fixed —
`pipeline.yml` already deploys `frontend/build` after the tests pass.

Note that a Pages deploy serves the frontend with no `/api/timeline` behind it,
so the published site shows the "no data" placeholder unless the data is
inlined. `codevis export --format html` is the way to share a real timeline.

## Dependency updates (`.github/dependabot.yml`)

Three ecosystems, all weekly (Monday 09:00):
- `cargo` — the Rust dependencies in `Cargo.toml`/`Cargo.lock`
- `npm` — `frontend/package.json`
- `github-actions` — the workflow files themselves

## What's *not* here

No cross-platform matrix, no PyPI publishing, no SonarCloud, no automated issue triage — none of that exists in this repo. If you need it, it has to be built, not assumed.
