#!/usr/bin/env bash
# Block PR creation if the body contains AI attribution (case-insensitive)

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

deny_pr() {
  local reason="$1"
  node -e "
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: process.argv[1]
      }
    }));
  " "$reason"
  exit 0
}

check_attribution() {
  local text="$1"
  local source="$2"
  if echo "$text" | grep -qiE 'generated with claude|generated with \[claude|co-authored-by:.*claude|co-authored-by:.*anthropic|built with claude|claude\.ai'; then
    deny_pr "BLOCKED: Remove AI attribution lines (Co-Authored-By with Claude/Anthropic, 'Generated with Claude', 'Built with Claude', claude.ai URLs) from the PR ${source}."
  fi
}

check_attribution "$cmd" "body"

# Also check --body-file path (handles both --body-file <path> and --body-file=<path>)
BODY_FILE=$(echo "$cmd" | grep -oE '\-\-body-file[[:space:]]+[^[:space:]]+' | awk '{print $2}' || true)
if [ -z "$BODY_FILE" ]; then
  BODY_FILE=$(echo "$cmd" | grep -oE '\-\-body-file=[^[:space:]]+' | sed 's/--body-file=//' || true)
fi
if [ -n "$BODY_FILE" ] && [ -f "$BODY_FILE" ]; then
  check_attribution "$(cat "$BODY_FILE")" "body file"
fi

exit 0
