#!/usr/bin/env bash
# snapshot-pre-bash.sh — PreToolUse hook for Bash tool calls
# Snapshots `git status --porcelain` to a temp file before each Bash call so
# that track-bash-writes.sh (PostToolUse) can diff the before/after state and
# log files newly modified by the command to .claude/session-edits.log.
# Always exits 0 (informational only, never blocks).

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

# Skip commands that can NEVER write files — reduces snapshot overhead for the
# most common read-only Bash calls.  Only include commands that have no
# write-capable flags/modes at all.  Notably absent:
#   - echo, printf  — write files via shell redirections (echo … > file)
#   - find          — can write via -exec sed -i, -exec cp, -delete, etc.
#   - awk           — can write via redirection or getline
# sed is intentionally NOT in this list because `sed -i` modifies files in-place.
if echo "$COMMAND" | grep -qE '^\s*(ls|cat|head|tail|grep|git\s+(log|status|diff|show|branch|remote|fetch|rev-parse|stash\s+list|ls-files|blame|describe|tag|config\s+--get)|gh\s+(pr|issue|repo)\s+(view|list|status)|pwd|which|node\s+-e|node\s+-p|npx\s+--version|wc|sort|uniq)\b'; then
  exit 0
fi

# Resolve the project root (worktree-aware — each worktree has its own .claude/)
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Key the snapshot file to (project root, command) so concurrent Bash calls
# within the same session don't overwrite each other's baseline.
# Claude Code can issue multiple Bash tool calls in parallel; using just the
# project hash would mean call B's pre-hook overwrites call A's snapshot before
# A's post-hook runs, silently dropping A's file writes from session-edits.log.
# Including a hash of the command makes each concurrent call use a distinct file.
PROJECT_HASH=$(echo "$PROJECT_DIR" | node -e "
  const crypto = require('crypto');
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    process.stdout.write(crypto.createHash('sha1').update(d.trim()).digest('hex').slice(0,8));
  });
" 2>/dev/null) || PROJECT_HASH="default"

CMD_HASH=$(echo "$COMMAND" | node -e "
  const crypto = require('crypto');
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    process.stdout.write(crypto.createHash('sha1').update(d.trim()).digest('hex').slice(0,8));
  });
" 2>/dev/null) || CMD_HASH="default"

SNAPSHOT_FILE="/tmp/claude-bash-snapshot-${PROJECT_HASH}-${CMD_HASH}.txt"

# Capture current git status --porcelain.
# Lines look like: "XY filename" or "XY orig -> dest" (rename).
# We only care about the status marker and path — porcelain is stable across git versions.
git -C "$PROJECT_DIR" status --porcelain 2>/dev/null > "$SNAPSHOT_FILE" || true

exit 0
