#!/usr/bin/env bash
# rebuild-graph.sh — PostToolUse hook for Edit and Write tools
# Incrementally updates the codegraph after source file edits.
# On the first edit of a stale session (no full rebuild in >24h), upgrades
# to a full rebuild so complexity/dataflow/cohesion data stays fresh.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract file path and normalize backslashes — all in node to avoid
# bash backslash issues on Windows/Git Bash
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=(JSON.parse(d).tool_input?.file_path||'').replace(/\\\\/g,'/');
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Only rebuild for source files codegraph tracks.
# Skip docs, configs, test fixtures, and non-code files.
#
# The real allowlist is EXTENSIONS (src/shared/constants.ts), derived from
# LANGUAGE_REGISTRY (src/domain/parser.ts) — the single source of truth for
# every language codegraph parses. `npm run build` snapshots it to
# dist/hook-extensions.txt (see scripts/gen-hook-extensions.mjs) so this
# hook can do a fast native bash/grep check on every Edit/Write instead of
# spawning a second Node process, or hand-copying the list, on every edit.
#
# The case statement below is only a fallback for before the first build
# (no dist/hook-extensions.txt yet). tests/unit/hook-extensions.test.ts
# fails if it ever drifts behind EXTENSIONS — keep it updated when
# LANGUAGE_REGISTRY gains a new extension.
EXT=".${FILE_PATH##*.}"
GENERATED_EXT_LIST="$PROJECT_DIR/dist/hook-extensions.txt"
if [ -f "$GENERATED_EXT_LIST" ]; then
  grep -qxF "$EXT" "$GENERATED_EXT_LIST" || exit 0
else
  case "$EXT" in
    .R|.bash|.c|.cc|.cjs|.clj|.cljc|.cljs|.cpp|.cs|.cu|.cuh|.cxx|.dart|.erl|.ex|.exs|.fs|.fsi|.fsx|.gemspec|.gleam|.go|.groovy|.gvy|.h|.hcl|.hpp|.hrl|.hs|.java|.jl|.js|.jsx|.kt|.kts|.lua|.m|.mjs|.ml|.mli|.php|.phtml|.py|.pyi|.r|.rake|.rb|.rs|.scala|.sh|.sol|.sv|.swift|.tf|.ts|.tsx|.v|.zig)
      ;;
    *)
      exit 0
      ;;
  esac
fi

# Skip test fixtures — they're copied to tmp dirs anyway
if echo "$FILE_PATH" | grep -qE '(fixtures|__fixtures__|testdata)/'; then
  exit 0
fi

# Guard: codegraph DB must exist (project has been built at least once)
DB_PATH="$PROJECT_DIR/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# --- Staleness check ---
# If no full rebuild has happened in >24h, upgrade this one build to
# --no-incremental so complexity/dataflow/cohesion are recomputed for
# all files. Subsequent edits in the same session stay incremental.
# See docs/guides/incremental-builds.md for what incremental skips.
MARKER="$PROJECT_DIR/.codegraph/last-full-build"
BUILD_FLAGS=""
STALE_SECONDS=86400  # 24 hours

if [ ! -f "$MARKER" ]; then
  # No marker = never had a tracked full rebuild — do one now
  BUILD_FLAGS="--no-incremental"
else
  # Check marker age (cross-platform: use node for reliable epoch math)
  MARKER_AGE=$(node -e "
    const fs = require('fs');
    try {
      const mtime = fs.statSync('${MARKER//\\/\\\\}').mtimeMs;
      console.log(Math.floor((Date.now() - mtime) / 1000));
    } catch { console.log('999999'); }
  " 2>/dev/null) || MARKER_AGE=999999

  if [ "$MARKER_AGE" -gt "$STALE_SECONDS" ]; then
    BUILD_FLAGS="--no-incremental"
  fi
fi

# Run the build
BUILD_OK=0
if command -v codegraph &>/dev/null; then
  codegraph build "$PROJECT_DIR" -d "$DB_PATH" $BUILD_FLAGS 2>/dev/null && BUILD_OK=1 || true
else
  node "${CLAUDE_PROJECT_DIR:-$PROJECT_DIR}/src/cli.js" build "$PROJECT_DIR" -d "$DB_PATH" $BUILD_FLAGS 2>/dev/null && BUILD_OK=1 || true
fi

# Update marker only if we did a full rebuild AND it succeeded
if [ -n "$BUILD_FLAGS" ] && [ "$BUILD_OK" -eq 1 ]; then
  mkdir -p "$(dirname "$MARKER")"
  touch "$MARKER"
fi

exit 0
