#!/usr/bin/env bash
# track-edits.sh — PostToolUse hook for Edit and Write tools
# Logs each edited file path to .claude/session-edits.log so that
# guard-git.sh can validate commits against actually-edited files.
# In worktrees each session gets its own log automatically.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract file_path from tool_input JSON
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.file_path||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

# Normalize to relative path with forward slashes
REL_PATH=$(node -e "
  const path = require('path');
  const abs = path.resolve(process.argv[1]);
  const base = path.resolve(process.argv[2]);
  const rel = path.relative(base, abs).split(path.sep).join('/');
  process.stdout.write(rel);
" "$FILE_PATH" "$PROJECT_DIR" 2>/dev/null) || true

if [ -z "$REL_PATH" ]; then
  exit 0
fi

# Append timestamped entry
mkdir -p "$(dirname "$LOG_FILE")"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $REL_PATH" >> "$LOG_FILE"

exit 0
