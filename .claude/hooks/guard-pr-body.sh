#!/usr/bin/env bash
# Block PR creation if the body contains "generated with" (case-insensitive)

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

# Only check gh pr create commands
echo "$COMMAND" | grep -qi 'gh pr create' || exit 0

# Block if body contains "generated with"
if echo "$COMMAND" | grep -qi 'generated with'; then
  echo "BLOCK: Remove any 'Generated with ...' line from the PR body." >&2
  exit 2
fi
