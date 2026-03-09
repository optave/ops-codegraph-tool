#!/bin/bash
# Hook: block git commit if README.md, CLAUDE.md, or ROADMAP.md might need updating but aren't staged.
# Runs as a PreToolUse hook on Bash tool calls.
#
# Policy:
#   - If NO docs are staged but source files changed → deny (docs weren't considered)
#   - If SOME docs are staged → allow (developer reviewed and chose which to update)
#   - If commit message contains "docs check acknowledged" → allow (explicit bypass)

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.command||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

# Only act on git commit commands
if ! echo "$COMMAND" | grep -qE '^\s*git\s+commit'; then
  exit 0
fi

# Allow explicit bypass via commit message
if echo "$COMMAND" | grep -q 'docs check acknowledged'; then
  exit 0
fi

# Check which docs are staged
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
README_STAGED=$(echo "$STAGED_FILES" | grep -c '^README.md$' || true)
CLAUDE_STAGED=$(echo "$STAGED_FILES" | grep -c '^CLAUDE.md$' || true)
ROADMAP_STAGED=$(echo "$STAGED_FILES" | grep -c 'ROADMAP.md$' || true)

# If all three are staged, all good
if [ "$README_STAGED" -gt 0 ] && [ "$CLAUDE_STAGED" -gt 0 ] && [ "$ROADMAP_STAGED" -gt 0 ]; then
  exit 0
fi

# Heuristic: flag if source files, constants, or parser files changed
NEEDS_CHECK=$(echo "$STAGED_FILES" | grep -cE '(src/|cli\.js|constants\.js|parser\.js|package\.json|grammars/)' || true)

if [ "$NEEDS_CHECK" -gt 0 ]; then
  DOCS_STAGED=$((README_STAGED + CLAUDE_STAGED + ROADMAP_STAGED))

  # If at least one doc is staged, developer considered docs — allow with info
  if [ "$DOCS_STAGED" -gt 0 ]; then
    exit 0
  fi

  # No docs staged at all — block
  MISSING=""
  [ "$README_STAGED" -eq 0 ] && MISSING="README.md"
  [ "$CLAUDE_STAGED" -eq 0 ] && MISSING="${MISSING:+$MISSING, }CLAUDE.md"
  [ "$ROADMAP_STAGED" -eq 0 ] && MISSING="${MISSING:+$MISSING, }ROADMAP.md"

  node -e "
    const missing = process.argv[1];
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: missing + ' not staged but source files were changed. Review whether these docs need updating — README.md (language support table, feature list, command docs), CLAUDE.md (architecture table, supported languages, key design decisions), and ROADMAP.md (phase status, new features, deliverables). If they truly do not need changes, re-run the commit with docs check acknowledged.'
      }
    }));
  " "$MISSING"
  exit 0
fi

# Non-source changes (tests only, docs, etc.) — allow without doc updates
exit 0
