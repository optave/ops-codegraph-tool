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

# Skip read-only commands that can never write files — reduces snapshot overhead
# for the most common Bash calls (ls, cat, grep, git log, git status, etc.).
# sed is intentionally NOT in this list because `sed -i` modifies files in-place.
if echo "$COMMAND" | grep -qE '^\s*(ls|cat|head|tail|grep|find|git\s+(log|status|diff|show|branch|remote|fetch|rev-parse|stash\s+list|ls-files|blame|describe|tag|config\s+--get)|gh\s+(pr|issue|repo)\s+(view|list|status)|echo|printf|pwd|which|npx\s+--version|wc|sort|uniq|awk)\b'; then
  exit 0
fi

# Resolve the project root (worktree-aware — each worktree has its own .claude/)
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Key the snapshot file to the project root so parallel worktrees don't collide.
# Use a simple hash of the path — just enough to be unique per worktree.
PROJECT_HASH=$(echo "$PROJECT_DIR" | node -e "
  const crypto = require('crypto');
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    process.stdout.write(crypto.createHash('sha1').update(d.trim()).digest('hex').slice(0,8));
  });
" 2>/dev/null) || PROJECT_HASH="default"

SNAPSHOT_FILE="/tmp/claude-bash-snapshot-${PROJECT_HASH}.txt"

# Capture current git status --porcelain.
# Lines look like: "XY filename" or "XY orig -> dest" (rename).
# We only care about the status marker and path — porcelain is stable across git versions.
git -C "$PROJECT_DIR" status --porcelain 2>/dev/null > "$SNAPSHOT_FILE" || true

exit 0
