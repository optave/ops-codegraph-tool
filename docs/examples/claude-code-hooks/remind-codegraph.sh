#!/usr/bin/env bash
# remind-codegraph.sh — PreToolUse hook for Edit|Write
# Reminds the agent to use codegraph before editing a file.
# Only fires once per file per session (tracks in .claude/codegraph-checked.log).

set -euo pipefail

# Extract file_path from tool input
INPUT="${TOOL_INPUT:-}"
FILE_PATH=$(echo "$INPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const j=JSON.parse(d);
      const p = j.file_path || j.path || '';
      // Normalize backslashes
      console.log(p.replace(/\\\\/g,'/'));
    } catch { console.log(''); }
  });
" 2>/dev/null)

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize to relative path
REL_PATH="$FILE_PATH"
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  REL_PATH=$(node -e "
    const path = require('path');
    const abs = path.resolve(process.argv[1]);
    const base = path.resolve(process.argv[2]);
    console.log(path.relative(base, abs).replace(/\\\\/g,'/'));
  " "$FILE_PATH" "$CLAUDE_PROJECT_DIR" 2>/dev/null) || REL_PATH="$FILE_PATH"
fi

# Skip non-source files (docs, config, etc.)
case "$REL_PATH" in
  *.md|*.json|*.yml|*.yaml|*.toml|*.txt|*.lock|*.log|*.env*) exit 0 ;;
esac

# Check if we already reminded for this file
CHECKED_LOG="${CLAUDE_PROJECT_DIR:-.}/.claude/codegraph-checked.log"
if [ -f "$CHECKED_LOG" ] && grep -qF "$REL_PATH" "$CHECKED_LOG" 2>/dev/null; then
  exit 0
fi

# Record that we've reminded for this file
mkdir -p "$(dirname "$CHECKED_LOG")"
echo "$REL_PATH" >> "$CHECKED_LOG"

# Check if graph exists
if [ ! -f "${CLAUDE_PROJECT_DIR:-.}/.codegraph/graph.db" ]; then
  exit 0
fi

# Inject reminder as additionalContext
cat <<HOOK_OUTPUT
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "additionalContext": "[codegraph reminder] You are about to edit ${REL_PATH}. Did you run codegraph first? Before editing, always: (1) 'codegraph where <name>' to locate the symbol, (2) 'codegraph explain ${REL_PATH}' to understand the file, (3) 'codegraph context <name> -T' for full context, (4) 'codegraph fn-impact <name> -T' to check blast radius. If you already did this, proceed."
  }
}
HOOK_OUTPUT
