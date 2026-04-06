#!/usr/bin/env bash
# commitlint-local.sh — PreToolUse hook for Bash (git commit)
# Validates commit message format locally before the commit runs,
# catching violations that would fail CI commitlint.
# Delegates validation to commitlint-check.js.

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

# Skip --amend without -m (reuses existing message)
if echo "$COMMAND" | grep -qE '\-\-amend' && ! echo "$COMMAND" | grep -qE '\s-m\s'; then
  exit 0
fi

# Skip heredoc-style messages (shell code only; can't validate pre-execution)
if echo "$COMMAND" | grep -qE '\$\(cat <<'; then
  exit 0
fi

# Extract the commit message from -m flag using node for robust parsing
MSG=$(echo "$COMMAND" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const cmd = d;
    let msg = '';
    // Match -m \"...\" or -m '...'
    const dq = cmd.match(/-m\s+\"([\\s\\S]*?)\"(?:\s|$)/);
    if (dq) { msg = dq[1]; }
    else {
      const sq = cmd.match(/-m\s+'([^']*)'/);
      if (sq) { msg = sq[1]; }
    }
    // Unescape \\n to real newlines
    msg = msg.replace(/\\\\n/g, '\\n');
    process.stdout.write(msg);
  });
" 2>/dev/null) || true

if [ -z "$MSG" ]; then
  exit 0
fi

# Run commitlint checks
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
VIOLATIONS=$(node "$HOOK_DIR/commitlint-check.js" "$MSG" 2>/dev/null) || true

if [ -n "$VIOLATIONS" ]; then
  REASON="Commit message fails commitlint rules:"$'\n'"${VIOLATIONS}"$'\n'"Fix the message to match conventional commit format."
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$REASON"
fi

exit 0
