#!/usr/bin/env bash
# Block PR creation if the body contains "generated with" (case-insensitive)

input="$CLAUDE_TOOL_INPUT"

# Only check gh pr create commands
echo "$input" | grep -qi 'gh pr create' || exit 0

# Block if body contains "generated with"
if echo "$input" | grep -qi 'generated with'; then
  echo "BLOCK: Remove any 'Generated with ...' line from the PR body." >&2
  exit 2
fi
