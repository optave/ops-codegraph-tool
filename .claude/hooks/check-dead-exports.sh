#!/usr/bin/env bash
# check-dead-exports.sh — PreToolUse hook for Bash (git commit)
# Blocks commits if any src/ file edited in THIS SESSION has exports with zero consumers.
# Uses the session edit log to scope checks to files you actually touched.

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

# Load session edit log to scope checks to files we actually edited
LOG_FILE="$WORK_ROOT/.claude/session-edits.log"
if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
  exit 0
fi
EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

# Check each staged source file that was edited in this session
DEAD_EXPORTS=""

while IFS= read -r file; do
  # Only check source files
  case "$file" in
    src/*.js|src/*.ts|src/*.tsx) ;;
    *) continue ;;
  esac

  # Only check files edited in this session
  if ! echo "$EDITED_FILES" | grep -qxF "$file"; then
    continue
  fi

  RESULT=$(node "$WORK_ROOT/src/cli.js" exports "$file" --unused --json 2>/dev/null) || true
  if [ -z "$RESULT" ]; then
    continue
  fi

  # Extract unused export names
  UNUSED=$(echo "$RESULT" | node -e "
    let d='';
    process.stdin.on('data',c=>d+=c);
    process.stdin.on('end',()=>{
      try {
        const data=JSON.parse(d);
        const unused=data.results||[];
        if(unused.length>0){
          process.stdout.write(unused.map(u=>u.name+' ('+data.file+':'+u.line+')').join(', '));
        }
      }catch{}
    });
  " 2>/dev/null) || true

  if [ -n "$UNUSED" ]; then
    DEAD_EXPORTS="${DEAD_EXPORTS:+$DEAD_EXPORTS; }$UNUSED"
  fi
done <<< "$STAGED"

if [ -n "$DEAD_EXPORTS" ]; then
  REASON="BLOCKED: Dead exports (zero consumers) detected in files you edited: $DEAD_EXPORTS. Either add consumers, remove the exports, or verify these are intentionally public API."

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

exit 0
