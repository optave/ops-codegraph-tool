#!/usr/bin/env bash
# Block PR creation if the body contains "generated with" (case-insensitive)

set -euo pipefail

INPUT=$(cat)

# Extract just the command field to avoid false positives on the description field
cmd=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.command||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

echo "$cmd" | grep -qi 'gh pr create' || exit 0

# Block if body contains "generated with"
if echo "$cmd" | grep -qi 'generated with'; then
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'BLOCKED: Remove any \'Generated with ...\' line from the PR body.'
      }
    }));
  "
  exit 0
fi

# Also check --body-file path
BODY_FILE=$(echo "$cmd" | grep -oP '(?<=--body-file\s)\S+' || true)
if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
  if grep -qi 'generated with' "$BODY_FILE"; then
    node -e "
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'BLOCKED: Remove any \'Generated with ...\' line from the PR body file.'
        }
      }));
    "
    exit 0
  fi
fi

exit 0
