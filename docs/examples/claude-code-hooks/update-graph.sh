#!/usr/bin/env bash
# update-graph.sh — PostToolUse hook for Edit and Write tools
# Incrementally updates the codegraph after source file edits.
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

# Only rebuild for source files codegraph tracks
# Skip docs, configs, test fixtures, and non-code files
case "$FILE_PATH" in
  *.js|*.ts|*.tsx|*.jsx|*.py|*.go|*.rs|*.java|*.cs|*.php|*.rb|*.tf|*.hcl)
    ;;
  *)
    exit 0
    ;;
esac

# Skip test fixtures — they're copied to tmp dirs anyway
if echo "$FILE_PATH" | grep -qE '(fixtures|__fixtures__|testdata)/'; then
  exit 0
fi

# Guard: codegraph DB must exist (project has been built at least once)
# Use git worktree root so each worktree uses its own DB (avoids WAL contention)
WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"
DB_PATH="$WORK_ROOT/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Run incremental build (skips unchanged files via hash check)
if command -v codegraph &>/dev/null; then
  codegraph build "$WORK_ROOT" -d "$DB_PATH" 2>/dev/null || true
else
  npx --yes @optave/codegraph build "$WORK_ROOT" -d "$DB_PATH" 2>/dev/null || true
fi

exit 0
