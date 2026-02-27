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
DB_PATH="${CLAUDE_PROJECT_DIR:-.}/.codegraph/graph.db"
if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Run incremental build (skips unchanged files via hash check)
if command -v codegraph &>/dev/null; then
  codegraph build "${CLAUDE_PROJECT_DIR:-.}" -d "$DB_PATH" 2>/dev/null || true
else
  npx --yes @optave/codegraph build "${CLAUDE_PROJECT_DIR:-.}" -d "$DB_PATH" 2>/dev/null || true
fi

exit 0
