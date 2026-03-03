#!/usr/bin/env bash
# show-diff-impact.sh — PreToolUse hook for Bash (git commit)
# Runs `codegraph diff-impact --staged -T` before commits and injects
# the impact summary as additionalContext. Informational only — never blocks.

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

# Run diff-impact and capture output
IMPACT=$(node "$WORK_ROOT/src/cli.js" diff-impact --staged -T 2>/dev/null) || true

if [ -z "$IMPACT" ]; then
  exit 0
fi

# Escape for JSON embedding
ESCAPED=$(printf '%s' "$IMPACT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>process.stdout.write(JSON.stringify(d)));
" 2>/dev/null) || true

if [ -z "$ESCAPED" ]; then
  exit 0
fi

# Inject as additionalContext — never block
node -e "
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: '[codegraph diff-impact] Pre-commit blast radius:\\n' + JSON.parse(process.argv[1])
    }
  }));
" "$ESCAPED" 2>/dev/null || true

exit 0
