#!/usr/bin/env bash
# post-git-ops.sh — PostToolUse hook for Bash tool calls
# Detects git operations that change file state (rebase, revert, cherry-pick,
# merge, pull) and:
#   1. Rebuilds the codegraph incrementally (fixes stale dependency context)
#   2. Logs changed files to session-edits.log (so commit validation works)
#   3. Clears stale entries from codegraph-checked.log (so remind hook re-fires)
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

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# --- 1. Rebuild codegraph ---
DB_PATH="$PROJECT_DIR/.codegraph/graph.db"
if [ -f "$DB_PATH" ]; then
  if command -v codegraph &>/dev/null; then
    codegraph build "$PROJECT_DIR" -d "$DB_PATH" 2>/dev/null || true
  else
    node "$PROJECT_DIR/src/cli.js" build "$PROJECT_DIR" -d "$DB_PATH" 2>/dev/null || true
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

# --- 3. Clear stale entries from codegraph-checked.log ---
# After a git op that changes files, the remind-codegraph hook should
# re-fire for those files so the agent re-checks context/impact.
CHECKED_LOG="$PROJECT_DIR/.claude/codegraph-checked.log"
if [ -n "$CHANGED_FILES" ] && [ -f "$CHECKED_LOG" ]; then
  PATTERNS_FILE=$(mktemp)
  echo "$CHANGED_FILES" > "$PATTERNS_FILE"
  grep -vFf "$PATTERNS_FILE" "$CHECKED_LOG" > "${CHECKED_LOG}.tmp" 2>/dev/null || true
  mv "${CHECKED_LOG}.tmp" "$CHECKED_LOG"
  rm -f "$PATTERNS_FILE"
fi

exit 0
