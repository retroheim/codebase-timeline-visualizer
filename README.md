<div align="center">

# ◈ Codebase Timeline Visualizer

**An animated, radial visualization of how a codebase grows — commit by commit.**

[![License: MIT](https://img.shields.io/badge/license-MIT-2fe6b8.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-stable-ff8a5c.svg)](Cargo.toml)
[![Node](https://img.shields.io/badge/node-22%2B-7fb8ff.svg)](frontend/package.json)

</div>

`codevis` parses a Git repository's history and replays it as an animated radial tree: files and directories branch outward from the root as commits land, contributor avatars fly to whatever they touched, and the whole thing scrubs like a video timeline.

## Features

- **Repository analysis**: parses Git commit history via `git2`/libgit2 and extracts per-commit, per-contributor, and per-file stats — filtered against HEAD's current `.gitignore` (not each historical commit's), and crediting `Co-authored-by:` trailers as full contributors, not just `commit.author`
- **Radial timeline animation**: files and directories grow outward from the repo root as commits play, sized by how often they're touched
- **Five more views**: an activity calendar heatmap, a contributor leaderboard, a cumulative growth chart, a file-churn treemap, and a sortable/filterable commit table — all over the same analyzed data
- **Contributor tracking**: avatars (resolved to real GitHub profile photos where possible) fly to the files each commit touches
- **Bot/AI-contributor grouping**: Claude, Copilot, Codesmith, `[bot]`-suffixed accounts, and other automated authors fold into one "Automated" identity by default, everywhere a contributor's name appears — toggle back to individual per-author entries any time
- **Click-to-inspect**: click any file, directory, or cluster node for its detail (edits, lines changed, contributors, first-seen date)
- **Multi-project backend**: register and analyze repositories straight from the web UI — by local path or git URL — switch between them, and refresh any of them without touching the CLI

Docs: [Getting Started](docs/GETTING_STARTED.md) · [Architecture](docs/ARCHITECTURE.md) · [Workflows](docs/WORKFLOWS.md)

## Quick Start

### Using Docker (Recommended)

```bash
# Clone the repository
git clone <repository-url>
cd codebase-timeline-visualizer

# Start the service
docker compose up -d

# Access the web interface at http://localhost:3001, and register a project
# (local path or git URL) from there — no CLI step required
```

One container serves the built frontend and the multi-project API. Project data
persists in `./codevis-data` on the host (see `docker-compose.yml`).

### Manual Installation

```bash
# Build the CLI (requires Rust + cmake + pkg-config)
cargo build --release

# Build the frontend
cd frontend && npm install && npm run build && cd ..
```

A `nix develop` shell (see `flake.nix`) provides Rust, Node, and everything else needed.

### Troubleshooting

If you encounter issues during setup, see [Setup Troubleshooting Guide](SETUP_TROUBLESHOOTING.md) or check `<repository-url>/issues`.

## Usage

### CLI Commands

```bash
# Analyze a repository directly (writes a bare timeline.json, no server involved)
./target/release/codevis analyze /path/to/repo

# Start the web interface — multi-project mode by default, backed by ./codevis-data
./target/release/codevis serve

# Legacy single-file mode: serve exactly one pre-analyzed timeline.json
./target/release/codevis serve --data timeline.json

# Export a standalone HTML file with the timeline data inlined
./target/release/codevis export timeline.json --format html
```

### Web Interface

The web interface provides interactive timeline visualization with:
- A project switcher to register a repo (local path or git URL), pick between
  previously analyzed projects, and refresh (re-analyze) any of them
- Six views over the same data: the radial tree, an activity calendar
  heatmap, a contributor leaderboard, a growth chart, a file-churn treemap,
  and a commit table
- Play/pause controls with adjustable speed
- Scrubbing timeline (drag to any point in history)
- Weight-based node sizing and clustering for large repos
- Contributor tracking with resolved GitHub avatars
- Click-to-inspect detail panel for any node

## GitHub Workflows

See [docs/WORKFLOWS.md](docs/WORKFLOWS.md) for what CI actually runs (build/test/lint, Pages deploy, dependency updates).

## Development

### Prerequisites

- Rust (stable) + cmake + pkg-config
- Node.js 22+
- Docker (optional)
- Git

### Local Development

```bash
# Clone the repository
git clone <repository-url>
cd codebase-timeline-visualizer

# Install frontend dependencies
cd frontend && npm install && cd ..

# Run tests
cargo test

# Start development servers
# Terminal 1: Backend
cargo run -- serve

# Terminal 2: Frontend
cd frontend && npm run dev
```

### Code Quality

```bash
# Format code
cargo fmt

# Lint code
cargo clippy --all-targets -- -D warnings

# Run tests
cargo test --release

# Coverage gate (floor, not a target — see CLAUDE.md)
cargo tarpaulin --fail-under 80 --out Stdout
```

Frontend equivalent: `npm test` / `npm run test:coverage` in `frontend/` (thresholds live in `frontend/vite.config.ts`).

### Docker development

```bash
# Rebuild the image after a source change
docker compose build

# Start the container
docker compose up
```

## Project Structure

```
codebase-timeline-visualizer/
├── src/                  # Rust backend + CLI (single `codevis` binary)
│   ├── analyzer.rs       # Git analysis logic (git2-based)
│   ├── pipeline.rs       # repo path -> TimelineData, shared by `analyze` and server-triggered jobs
│   ├── exporter.rs       # JSON export / timeline data assembly
│   ├── github.rs         # GitHub remote URL -> owner/repo parsing
│   ├── git_source.rs     # clone/refresh a project from a git URL (shells out to `git`)
│   ├── registry.rs       # multi-project registry (registry.json persistence)
│   ├── jobs.rs           # in-memory analyze-job status tracking
│   ├── server.rs         # axum dev server (legacy single-file /api/timeline + static assets)
│   ├── projects_api.rs   # multi-project REST surface (/api/projects, /api/jobs)
│   └── main.rs           # CLI entry point (clap)
├── frontend/             # Lit + TypeScript + Vite web application
│   ├── src/
│   │   ├── components/   # app-root, timeline-viz, calendar-heatmap, contributor-leaderboard,
│   │   │                 # growth-chart, churn-treemap, commit-log, view-switcher,
│   │   │                 # project-switcher, scope-toggle, bot-group-toggle
│   │   ├── lib/          # file-tree, file-similarity, geometry, tree-layout, github-avatar,
│   │   │                 # identicon, md5, route, playback, as-of, activity, calendar,
│   │   │                 # contributor-stats, contributor-color, bot-authors, branch-color,
│   │   │                 # growth, treemap-layout, commit-table
│   │   └── types.ts      # hand-mirrored TypeScript side of the Rust wire format — see
│   │                     # docs/ARCHITECTURE.md's "Wire format" section
│   └── index.html
├── docs/                 # Documentation
├── .github/              # GitHub workflows and configs
│   ├── workflows/        # CI/CD pipelines
│   └── dependabot.yml    # Dependency updates
├── Cargo.toml            # Rust project config
├── flake.nix             # Nix dev shell (Rust + Node) and build
├── Dockerfile            # Container definition (single image: binary + built frontend)
├── docker-compose.yml    # Single-service Docker setup
└── README.md             # This file
```

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Workflow

- All PRs require CI checks to pass
- Code must be formatted with `cargo fmt` and clean under `cargo clippy --all-targets -- -D warnings`
- `cargo test` and `npm test` (in `frontend/`) must pass, and `tsc --noEmit` must be clean
- `cargo audit` runs on pushes and fails the build on a known advisory
- Documentation must be updated

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- Documentation: [`docs/`](docs/) — start at [Getting Started](docs/GETTING_STARTED.md)
- Issues: `<repository-url>/issues`
- Discussions: `<repository-url>/discussions`