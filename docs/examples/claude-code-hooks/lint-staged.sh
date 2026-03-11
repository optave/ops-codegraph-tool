#!/usr/bin/env bash
# lint-staged.sh — PreToolUse hook for Bash (git commit)
# Blocks commits if staged src/ or tests/ files have lint errors.
# Only checks files that were edited in this session.

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

# Guard: must have staged changes
STAGED=$(git diff --cached --name-only 2>/dev/null) || true
if [ -z "$STAGED" ]; then
  exit 0
fi

WORK_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || WORK_ROOT="${CLAUDE_PROJECT_DIR:-.}"

# Load session edit log to scope to files we actually edited
LOG_FILE="$WORK_ROOT/.claude/session-edits.log"
if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
  exit 0
fi
EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

# Filter staged files to src/ and tests/ that were edited in this session
declare -a FILES_TO_LINT=()
while IFS= read -r file; do
  case "$file" in
    src/*.js|src/*.ts|src/*.tsx|tests/*.js|tests/*.ts|tests/*.tsx) ;;
    *) continue ;;
  esac
  if echo "$EDITED_FILES" | grep -qxF "$file"; then
    FILES_TO_LINT+=("$file")
  fi
done <<< "$STAGED"

if [ "${#FILES_TO_LINT[@]}" -eq 0 ]; then
  exit 0
fi

# Run biome check on the specific files.
# Intentional fail-open: if biome crashes or OOMs (non-zero exit with no output),
# the commit is allowed through. We only block when there is actionable lint output.
cd "$WORK_ROOT" || exit 0
LINT_OUTPUT=$(npx biome check --no-errors-on-unmatched "${FILES_TO_LINT[@]}" 2>&1) || LINT_EXIT=$?

if [ "${LINT_EXIT:-0}" -ne 0 ] && [ -n "$LINT_OUTPUT" ]; then
  # Truncate output to first 30 lines to keep denial message readable
  TRUNCATED=$(echo "$LINT_OUTPUT" | head -30)
  REASON="BLOCKED: Lint errors in staged files. Fix before committing:
$TRUNCATED"

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
