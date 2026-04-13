#!/usr/bin/env bash
# post-git-ops.sh — PostToolUse hook for Bash tool calls
# Detects git operations that change file state (rebase, revert, cherry-pick,
# merge, pull) and:
#   1. Runs a full codegraph rebuild (recomputes all analysis data, not just edges)
#   2. Logs changed files to session-edits.log (so commit validation works)
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract the command from tool_input JSON
COMMAND=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.command||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Only act on git operations that change file content
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+(rebase|revert|cherry-pick|merge|pull)\b'; then
  exit 0
fi

# Use git worktree root so each worktree session has its own state
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# --- 1. Full rebuild of codegraph ---
# Git operations (merge, rebase, pull) can change many files at once. A full
# rebuild ensures complexity, dataflow, and directory cohesion metrics are
# recomputed for all affected files — not just direct edits.
# See docs/guides/incremental-builds.md for what incremental skips.
DB_PATH="$PROJECT_DIR/.codegraph/graph.db"
if [ -f "$DB_PATH" ]; then
  BUILD_OK=0
  if command -v codegraph &>/dev/null; then
    codegraph build "$PROJECT_DIR" -d "$DB_PATH" --no-incremental 2>/dev/null && BUILD_OK=1 || true
  else
    npx --yes @optave/codegraph build "$PROJECT_DIR" -d "$DB_PATH" --no-incremental 2>/dev/null && BUILD_OK=1 || true
  fi
  # Update staleness marker only if the full rebuild succeeded
  if [ "$BUILD_OK" -eq 1 ]; then
    MARKER="$PROJECT_DIR/.codegraph/last-full-build"
    touch "$MARKER"
  fi
fi

# --- 2. Log changed files to session-edits.log ---
# ORIG_HEAD is set by rebase, revert, cherry-pick, merge, and pull.
# If the operation failed (conflicts), ORIG_HEAD may be stale — the
# diff will either fail or return nothing, which is safe.
CHANGED_FILES=$(git diff --name-only ORIG_HEAD HEAD 2>/dev/null) || true

if [ -n "$CHANGED_FILES" ]; then
  LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"
  mkdir -p "$(dirname "$LOG_FILE")"
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  while IFS= read -r rel_path; do
    if [ -n "$rel_path" ]; then
      echo "$TS $rel_path" >> "$LOG_FILE"
    fi
  done <<< "$CHANGED_FILES"
fi

exit 0
