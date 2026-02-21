#!/bin/bash
# Hook: block git commit if README.md might need updating but isn't staged.
# Runs as a PreToolUse hook on Bash tool calls.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Only act on git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  exit 0
fi

# Check if README.md is staged
README_STAGED=$(git diff --cached --name-only 2>/dev/null | grep -c '^README.md$')

if [ "$README_STAGED" -gt 0 ]; then
  # README is staged, all good
  exit 0
fi

# Check if there are any staged files that might warrant a README update
# (new language support, new commands, new features, config changes)
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)

# Heuristic: flag if source files, constants, or parser files changed
NEEDS_CHECK=$(echo "$STAGED_FILES" | grep -cE '(src/|cli\.js|constants\.js|parser\.js|package\.json|grammars/)' || true)

if [ "$NEEDS_CHECK" -gt 0 ]; then
  # Don't block, but inject context so Claude checks README
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "README.md is not staged but source files were changed. Review whether README.md needs updating (language support table, feature list, command docs, etc.) before committing. If README truly does not need changes, re-run the commit with README check acknowledged."
    }
  }'
  exit 0
fi

# Non-source changes (tests only, docs, etc.) — allow without README
exit 0
