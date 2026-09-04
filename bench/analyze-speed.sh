#!/usr/bin/env bash
# Measurement harness for the ce-optimize "analyze-speed" run.
# Builds the release binary, times a real `analyze` run against a large
# fixture repo, and prints JSON metrics to stdout. Everything else (build
# output, analyze's own stdout) goes to stderr so stdout stays clean JSON.
set -euo pipefail

REPO_PATH="${BENCH_REPO_PATH:-/home/sierfeil/Documents/GitHub/video-editor}"
OUT_JSON="$(mktemp -t ce-optimize-bench-XXXXXX.json)"
trap 'rm -f "$OUT_JSON"' EXIT

cargo build --release --quiet >&2

START=$(date +%s.%N)
set +e
./target/release/codevis analyze "$REPO_PATH" -o "$OUT_JSON" >&2
EXIT_CODE=$?
set -e
END=$(date +%s.%N)

WALL=$(awk "BEGIN { printf \"%.3f\", $END - $START }")

if [ -f "$OUT_JSON" ]; then
  COMMITS=$(jq -r '.metadata.total_commits // 0' "$OUT_JSON" 2>/dev/null || echo 0)
  FILES=$(jq -r '.metadata.total_files // 0' "$OUT_JSON" 2>/dev/null || echo 0)
  CONTRIBUTORS=$(jq -r '.metadata.total_contributors // 0' "$OUT_JSON" 2>/dev/null || echo 0)
else
  COMMITS=0
  FILES=0
  CONTRIBUTORS=0
fi

printf '{"wall_seconds": %s, "exit_code": %d, "total_commits": %d, "total_files": %d, "total_contributors": %d}\n' \
  "$WALL" "$EXIT_CODE" "$COMMITS" "$FILES" "$CONTRIBUTORS"
