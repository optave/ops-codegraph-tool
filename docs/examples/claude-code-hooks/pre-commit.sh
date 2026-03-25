#!/usr/bin/env bash
# pre-commit.sh — PreToolUse hook for Bash (git commit)
# Thin wrapper that runs all codegraph pre-commit checks in a single
# Node.js process: cycles (blocking), dead exports (blocking),
# signature warnings (informational), diff-impact (informational).

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

# Only trigger on git commit commands
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+commit\b'; then
  exit 0
fi

# Guard: codegraph DB must exist
WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"
if [ ! -f "$WORK_ROOT/.codegraph/graph.db" ]; then
  exit 0
fi

# Guard: must have staged changes
STAGED=$(git diff --cached --name-only 2>/dev/null) || true
if [ -z "$STAGED" ]; then
  exit 0
fi

# Load session edit log
LOG_FILE="$WORK_ROOT/.claude/session-edits.log"
EDITED_FILES=""
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)
fi

# Run all checks in a single Node.js process
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
STRIP_FLAG=$(node -e "const [M,m]=process.versions.node.split('.').map(Number); console.log(M>=23?'--strip-types':'--experimental-strip-types')")
RESULT=$(node $STRIP_FLAG "$HOOK_DIR/pre-commit-checks.ts" "$WORK_ROOT" "$EDITED_FILES" "$STAGED" 2>/dev/null) || true

if [ -z "$RESULT" ]; then
  exit 0
fi

# Parse action
ACTION=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).action||'allow')}catch{process.stdout.write('allow')}})" 2>/dev/null) || ACTION="allow"

if [ "$ACTION" = "deny" ]; then
  REASON=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{process.stdout.write(JSON.parse(d).reason||'')}catch{}})" 2>/dev/null) || true
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$REASON"
  exit 0
fi

# Inject informational context (non-blocking)
CONTEXT=$(echo "$RESULT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const c=JSON.parse(d).context||[];if(c.length)process.stdout.write(c.join('\n\n'))}catch{}})" 2>/dev/null) || true

if [ -n "$CONTEXT" ]; then
  ESCAPED=$(printf '%s' "$CONTEXT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)))" 2>/dev/null) || true
  if [ -n "$ESCAPED" ]; then
    node -e "
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          additionalContext: JSON.parse(process.argv[1])
        }
      }));
    " "$ESCAPED" 2>/dev/null || true
  fi
fi

exit 0
