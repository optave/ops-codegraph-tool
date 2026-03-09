#!/usr/bin/env bash
# check-cycles.sh — PreToolUse hook for Bash (git commit)
# Blocks commits if circular dependencies involve files edited in this session.

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
if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
  exit 0
fi
EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

# Run check with cycles predicate on staged changes
RESULT=$(node "$WORK_ROOT/src/cli.js" check --staged --json -T 2>/dev/null) || true

if [ -z "$RESULT" ]; then
  exit 0
fi

# Check if cycles predicate failed — but only block if a cycle involves
# a file that was edited in this session
CYCLES_FAILED=$(echo "$RESULT" | EDITED="$EDITED_FILES" node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    try {
      const data=JSON.parse(d);
      const cyclesPred=(data.predicates||[]).find(p=>p.name==='cycles');
      if(!cyclesPred || cyclesPred.passed) return;
      const edited=new Set(process.env.EDITED.split('\\n').filter(Boolean));
      // Filter to cycles that involve at least one file we edited
      const relevant=(cyclesPred.cycles||[]).filter(
        cycle=>cycle.some(f=>edited.has(f))
      );
      if(relevant.length===0) return;
      const summary=relevant.slice(0,5).map(c=>c.join(' -> ')).join('\\n  ');
      const extra=relevant.length>5?'\\n  ... and '+(relevant.length-5)+' more':'';
      process.stdout.write(summary+extra);
    }catch{}
  });
" 2>/dev/null) || true

if [ -n "$CYCLES_FAILED" ]; then
  REASON="BLOCKED: Circular dependencies detected involving files you edited:
  $CYCLES_FAILED
Fix the cycles before committing."

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
