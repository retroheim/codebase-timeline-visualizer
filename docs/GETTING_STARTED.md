# Getting Started

This guide will help you get the Codebase Timeline Visualizer up and running.

## Prerequisites

- Rust (stable) + `cmake` + `pkg-config` — needed to build `git2` (libgit2 is vendored, but the build itself needs a C toolchain)
- Node.js 22+
- Git

Or just use the provided Nix flake, which gives you all of the above in one shell:

```bash
nix develop
```

## Installation

1. **Clone the project:**
   ```bash
   git clone <repository-url>
   cd codebase-timeline-visualizer
   ```

2. **Build the CLI:**
   ```bash
   cargo build --release
   ```

3. **Install and build the frontend:**
   ```bash
   cd frontend
   npm install
   npm run build
   cd ..
   ```

## Quick Start

### Start the server and register a project from the browser

```bash
./target/release/codevis serve --port 3001
```

Open `http://localhost:3001`. This boots **multi-project mode** by default,
backed by a `./codevis-data` directory (registry + per-project data). Use the
project switcher in the header to register a repository — a local filesystem
path or a git URL the server clones — then trigger the analyze run and watch
its status until it's ready. Refresh any project later from the same menu to
re-analyze it (a local path is re-read, a git URL is `fetch`ed and reset to
its upstream).

`serve` binds loopback only by default. Project data includes full commit
history, author names, and email addresses, so serving it to other machines
is opt-in: pass `--host 0.0.0.0` when you actually want that. See
[`SECURITY.md`](../SECURITY.md) — multi-project mode lets any client that can
reach the port register a project, so that opt-in matters more than it did in
single-project mode.

### Analyzing from the CLI instead

```bash
./target/release/codevis analyze /path/to/your/repo -o timeline.json -v
```

This walks the repo's commit history (via `git2`/libgit2), computes per-commit file diffs, and writes a `timeline.json` with commits, contributors, and per-file stats — independent of the server, same as before.

### Legacy single-file serving

```bash
./target/release/codevis serve --port 3001 --data timeline.json
```

Passing `--data` explicitly serves exactly that one file at `/api/timeline`,
with no project registry involved — the original single-repo behavior, kept
for scripts and CI that already depend on it.

The visualization renders your repo as a radial constellation: directories and files branch out from the root, sized by how often they've been touched. Files above a per-directory threshold group into a single "N files" cluster node rather than cluttering the view individually. Press play to watch it grow commit by commit; click any node for details; scroll to zoom (individual files reveal once there's room for them). Five more views — an activity calendar heatmap, a contributor leaderboard, a growth chart, a file-churn treemap, and a commit table — are one click away in the view switcher.

Every view that shows a contributor's name — the leaderboard, the commit
table, and the radial tree's avatar ring — defaults to folding bot/AI-model
authors (Claude, Copilot, Codesmith, any `[bot]`-suffixed account, etc.) into
one **Automated** entry, so a repo with heavy AI-assisted commit activity
doesn't drown out its human contributors. Flip the **Automated / Individual**
toggle next to each view to see every bot broken out on its own.

The project switcher's clock icon (🕘) expands a short run history for that
project — timestamp, duration, and outcome of its last 20 analyze/refresh
runs — useful for spotting a refresh that silently started failing.

## CLI Commands

```bash
# Analyze a repository
codevis analyze /path/to/repo [-o timeline.json] [-v]

# Start the web interface — multi-project mode by default
codevis serve [-p 3001] [--host 127.0.0.1] [--data-dir codevis-data]

# Legacy single-file mode
codevis serve [-p 3001] [--host 127.0.0.1] [-d timeline.json]

# Export a standalone HTML file with the data inlined
codevis export <data.json> [--format html] [-o out.html] [--frontend-build frontend/build]
```

## Project API (multi-project mode)

The frontend's project switcher talks to this REST surface; it's usable directly too (e.g. `curl`):

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/projects` | list all registered projects |
| `POST` | `/api/projects` | register one — body `{"path": "..."}` or `{"url": "..."}`, optional `"display_name"` |
| `DELETE` | `/api/projects/:id` | remove a project and its on-disk data |
| `POST` | `/api/projects/:id/analyze` | trigger (or refresh) analysis — returns `202 {"job_id": "..."}` |
| `GET` | `/api/jobs/:job_id` | poll job status: `running` / `succeeded` / `failed` |
| `GET` | `/api/projects/:id/timeline` | that project's `timeline.json` |

## Project Structure

See the [README](../README.md#project-structure) for the full layout. In short: `src/` is the Rust analyzer/CLI/server, `frontend/` is the Lit + TypeScript + Vite web app.

## Development

### Running tests

```bash
cargo test
```

### Frontend dev server

```bash
cd frontend
npm run dev
```

This proxies `/api` requests to `localhost:3001`, so run `codevis serve` alongside it for live data.

### Code quality

```bash
cargo fmt
cargo clippy --all-targets -- -D warnings
cargo tarpaulin --fail-under 80 --out Stdout   # coverage floor
```

Frontend: `npm run test:coverage` in `frontend/` runs vitest with coverage
enabled against the thresholds in `frontend/vite.config.ts`.

## Troubleshooting

1. **`git2`/libgit2 fails to build** — make sure `cmake` and `pkg-config` are installed (or just use `nix develop`, which provides them).
2. **"Not a Git repository"** — the path passed to `analyze` needs a `.git` directory; point it at a repo root, not a subdirectory.
3. **Port already in use** — `codevis serve --port 3002`.
4. **Frontend shows "Timeline visualization will appear here"** — in legacy `--data` mode, no `timeline.json` exists at that path yet (run `analyze` first); in multi-project mode, no project is registered/selected yet, or the selected one hasn't finished analyzing.
5. **A project is stuck showing an error after restarting the server** — an in-flight analyze job can't survive a process restart; it's marked `Error("Interrupted by server restart")` rather than left hanging. Trigger a refresh from the project switcher to retry.

## Sharing a timeline

`codevis export timeline.json --format html` writes a single HTML file with the
built frontend and the timeline data inlined. It needs no server — open it
directly, mail it, drop it in a wiki. Build the frontend first (`cd frontend &&
npm run build`), since that is what gets inlined.

## Avatars and privacy

By default the page resolves contributor avatars from Gravatar (an MD5 of each
commit author's email) and GitHub's public API (the repository slug and a commit
SHA). Append `?avatars=local` to the URL to disable all of it and render
deterministic offline identicons instead — worth doing when the repository you
analyzed is private.

## Next Steps

- Try analyzing a large, active repo — that's where clustering and the weight-based sizing matter most.
- Click through a few file/directory nodes to see the inspector panel.
- Read [ARCHITECTURE.md](ARCHITECTURE.md) for how the visualization actually works under the hood.
