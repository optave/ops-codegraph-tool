#!/usr/bin/env bash
# track-bash-writes.sh — PostToolUse hook for Bash tool calls
# Compares `git status --porcelain` against the snapshot taken by
# snapshot-pre-bash.sh (PreToolUse) to detect files newly modified or
# created by the Bash command, then appends them to .claude/session-edits.log
# so that guard-git.sh can validate commits correctly.
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

# Resolve the project root (worktree-aware — each worktree has its own .claude/)
PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"

# Reproduce the same project hash used by snapshot-pre-bash.sh
PROJECT_HASH=$(echo "$PROJECT_DIR" | node -e "
  const crypto = require('crypto');
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    process.stdout.write(crypto.createHash('sha1').update(d.trim()).digest('hex').slice(0,8));
  });
" 2>/dev/null) || PROJECT_HASH="default"

SNAPSHOT_FILE="/tmp/claude-bash-snapshot-${PROJECT_HASH}.txt"

# If there is no snapshot (hook was not installed yet, or the pre-hook was
# skipped for a read-only command) we have no baseline — exit cleanly.
if [ ! -f "$SNAPSHOT_FILE" ]; then
  exit 0
fi

# Capture current state after the command ran
AFTER=$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null) || true

# Read the before-state
BEFORE=$(cat "$SNAPSHOT_FILE") || true

# Clean up the snapshot so it doesn't pollute the next command's pre-hook
rm -f "$SNAPSHOT_FILE"

# Build the set of paths that existed (as dirty) before the command ran.
# porcelain format: "XY path" or "XY original -> new" (rename).
# We extract every path token after the two-char status code.
parse_paths() {
  local status_output="$1"
  echo "$status_output" | awk '
    /^[ MADRCU?!]{2} / {
      # Drop the two-char status + space
      rest = substr($0, 4)
      # Handle rename: "old -> new"
      if (index(rest, " -> ") > 0) {
        n = split(rest, parts, " -> ")
        for (i = 1; i <= n; i++) {
          p = parts[i]
          gsub(/^"/, "", p); gsub(/"$/, "", p)
          if (p != "") print p
        }
      } else {
        gsub(/^"/, "", rest); gsub(/"$/, "", rest)
        if (rest != "") print rest
      }
    }
  '
}

BEFORE_PATHS=$(parse_paths "$BEFORE" | sort)
AFTER_PATHS=$(parse_paths "$AFTER" | sort)

if [ -z "$AFTER_PATHS" ]; then
  exit 0
fi

# Find paths present in AFTER but not in BEFORE — these were newly dirtied
# (modified, created, or renamed-to) by the Bash command.
NEW_PATHS=$(comm -13 <(echo "$BEFORE_PATHS") <(echo "$AFTER_PATHS")) || true

if [ -z "$NEW_PATHS" ]; then
  exit 0
fi

# Also exclude paths that were already tracked by track-edits.sh or other hooks
# (i.e. already in the session-edits.log) so we don't double-log.
LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"
ALREADY_LOGGED=""
if [ -f "$LOG_FILE" ] && [ -s "$LOG_FILE" ]; then
  ALREADY_LOGGED=$(awk '{print $2}' "$LOG_FILE" | sort -u)
fi

mkdir -p "$(dirname "$LOG_FILE")"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

while IFS= read -r rel_path; do
  if [ -z "$rel_path" ]; then
    continue
  fi
  # Skip if already in the log from a prior hook (Edit/Write/track-moves)
  if [ -n "$ALREADY_LOGGED" ] && echo "$ALREADY_LOGGED" | grep -qxF "$rel_path"; then
    continue
  fi
  echo "$TS $rel_path" >> "$LOG_FILE"
done <<< "$NEW_PATHS"

exit 0
