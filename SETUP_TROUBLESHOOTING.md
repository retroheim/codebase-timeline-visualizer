# Setup Troubleshooting Guide

This guide helps you resolve common setup issues with the Codebase Timeline Visualizer.

## Fastest path: Nix

If you have Nix installed, skip everything below:

```bash
nix develop
```

This gives you Rust, `cmake`, `pkg-config`, and Node 22 in one shell, matching exactly what CI uses.

## Common Issues & Solutions

### Issue: `git2`/`libgit2-sys` fails to build

**Symptoms:**
```
error: failed to run custom build command for `libgit2-sys`
CMake Error: CMake was not found
```

**Cause:** `git2` vendors and compiles libgit2 from source, which needs a C toolchain.

**Solutions:**
- **Nix**: `nix develop` (has `cmake` + `pkg-config` already)
- **Debian/Ubuntu**: `sudo apt-get install cmake pkg-config build-essential`
- **macOS**: `xcode-select --install` (provides a C compiler), then `brew install cmake pkg-config`
- **Windows**: install [CMake](https://cmake.org/download/) and add it to PATH, plus a C++ toolchain (Visual Studio Build Tools)

### Issue: "Not a Git repository" when running `analyze`

**Symptoms:**
```
Error: Not a Git repository: /some/path
```

**Cause:** the path doesn't have a `.git` directory at its root.

**Solutions:**
- Point `analyze` at the repository root, not a subdirectory
- Verify with `ls -a /path/to/repo` — you should see `.git`

### Issue: Port already in use

**Symptoms:**
```
Error: Could not bind to port 3001: Address already in use
```

**Solutions:**
```bash
codevis serve --port 3002
```

Or find and stop whatever's already using the port:
```bash
lsof -i :3001        # macOS/Linux
netstat -ano | findstr :3001   # Windows
```

### Issue: Frontend shows "Timeline visualization will appear here" forever

**Cause:** `serve` is pointed at a data file that doesn't exist yet, or the frontend hasn't been built.

**Solutions:**
```bash
# Generate the data file serve is looking for
codevis analyze /path/to/repo -o timeline.json

# Make sure the frontend is actually built (serve reads frontend/build)
cd frontend && npm run build && cd ..
```

### Issue: `cargo` / `rustc` not found

**Solutions:**
- **Nix**: `nix develop`
- **Otherwise**: install via [rustup](https://rustup.rs/) — `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`

### Issue: `node`/`npm` not found

**Solutions:**
- **Nix**: `nix develop`
- **Otherwise**: install from [nodejs.org](https://nodejs.org/) (need 22+) or via `nvm install 22`

## Testing your setup

```bash
# Build
cargo build --release

# Run the test suite
cargo test

# Smoke-test the CLI against a throwaway repo
mkdir /tmp/test-repo && cd /tmp/test-repo
git init && git config user.email you@example.com && git config user.name You
echo "hello" > test.txt && git add . && git commit -m "Test commit"
cd -
./target/release/codevis analyze /tmp/test-repo -o /tmp/test-timeline.json -v

# Web interface
cd frontend && npm install && npm run build && cd ..
./target/release/codevis serve --data /tmp/test-timeline.json
# → http://localhost:3001
```

## Minimum requirements

- **Rust**: stable channel (see `rust-version` in `Cargo.toml` if pinned)
- **Node.js**: 22+
- **Git**: any recent version
- **cmake** + **pkg-config**: for building `git2`

## Getting help

- Check [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the full setup walkthrough
- Check [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) if something's behaving in a way that looks intentional but confusing
- Run `codevis --help` / `codevis <subcommand> --help` for CLI usage
- Open an issue on GitHub if none of the above covers it
