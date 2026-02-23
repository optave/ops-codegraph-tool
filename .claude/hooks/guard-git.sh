#!/usr/bin/env bash
# guard-git.sh — PreToolUse hook for Bash tool calls
# Blocks dangerous git commands that interfere with parallel sessions
# and validates commits against the session edit log.

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

# Act on git and gh commands (may appear after cd "..." &&)
if ! echo "$COMMAND" | grep -qE '(^|\s|&&\s*)(git|gh)\s+'; then
  exit 0
fi

deny() {
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

# --- Block dangerous commands ---

# git add . / git add -A / git add --all (broad staging)
if echo "$COMMAND" | grep -qE '^\s*git\s+add\s+(\.\s*$|-A|--all)'; then
  deny "BLOCKED: 'git add .' / 'git add -A' stages ALL changes including other sessions' work. Stage specific files instead: git add <file1> <file2>"
fi

# git reset (unstaging / hard reset)
if echo "$COMMAND" | grep -qE '^\s*git\s+reset'; then
  deny "BLOCKED: 'git reset' can unstage or destroy other sessions' work. To unstage your own files, use: git restore --staged <file>"
fi

# git checkout -- <file> (reverting files)
if echo "$COMMAND" | grep -qE '^\s*git\s+checkout\s+--'; then
  deny "BLOCKED: 'git checkout -- <file>' reverts working tree changes and may destroy other sessions' edits. If you need to discard your own changes, be explicit about which files."
fi

# git restore (reverting) — EXCEPT git restore --staged (safe unstaging)
if echo "$COMMAND" | grep -qE '^\s*git\s+restore'; then
  if ! echo "$COMMAND" | grep -qE '^\s*git\s+restore\s+--staged'; then
    deny "BLOCKED: 'git restore <file>' reverts working tree changes and may destroy other sessions' edits. To unstage files safely, use: git restore --staged <file>"
  fi
fi

# git clean (delete untracked files)
if echo "$COMMAND" | grep -qE '^\s*git\s+clean'; then
  deny "BLOCKED: 'git clean' deletes untracked files that may belong to other sessions."
fi

# git stash (hides all changes)
if echo "$COMMAND" | grep -qE '^\s*git\s+stash'; then
  deny "BLOCKED: 'git stash' hides all working tree changes including other sessions' work. In worktree mode, commit your changes directly instead."
fi

# --- Branch name validation helper ---

validate_branch_name() {
  # Try to get branch from the working directory where the command runs
  # Extract cd target if command starts with cd "..." && ...
  local work_dir=""
  if echo "$COMMAND" | grep -qE '^\s*cd\s+'; then
    work_dir=$(echo "$COMMAND" | sed -nE 's/^\s*cd\s+"?([^"&]+)"?\s*&&.*/\1/p')
  fi

  local BRANCH=""
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    BRANCH=$(git -C "$work_dir" rev-parse --abbrev-ref HEAD 2>/dev/null) || true
  fi
  if [ -z "$BRANCH" ]; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || true
  fi

  if [ -n "$BRANCH" ] && [ "$BRANCH" != "main" ] && [ "$BRANCH" != "HEAD" ]; then
    local PATTERN="^(feat|fix|docs|refactor|test|chore|ci|perf|build|release|dependabot|revert)/"
    if [[ ! "$BRANCH" =~ $PATTERN ]]; then
      deny "BLOCKED: Branch '$BRANCH' does not match required pattern. Branch names must start with: feat/, fix/, docs/, refactor/, test/, chore/, ci/, perf/, build/, release/, revert/"
    fi
  fi
}

# --- Branch name validation on push ---

if echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+push'; then
  validate_branch_name
fi

# --- Branch name validation on gh pr create ---

if echo "$COMMAND" | grep -qE '(^|\s|&&\s*)gh\s+pr\s+create'; then
  validate_branch_name
fi

# --- Commit validation against edit log ---

if echo "$COMMAND" | grep -qE '(^|\s|&&\s*)git\s+commit'; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
  LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

  # If no edit log exists, allow (backward compat for sessions without tracking)
  if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
    exit 0
  fi

  # Get unique edited files from log
  EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

  # Get staged files
  STAGED_FILES=$(git diff --cached --name-only 2>/dev/null) || true

  if [ -z "$STAGED_FILES" ]; then
    exit 0
  fi

  # Find staged files that weren't edited in this session
  UNEXPECTED=""
  while IFS= read -r staged_file; do
    if ! echo "$EDITED_FILES" | grep -qxF "$staged_file"; then
      UNEXPECTED="${UNEXPECTED:+$UNEXPECTED, }$staged_file"
    fi
  done <<< "$STAGED_FILES"

  if [ -n "$UNEXPECTED" ]; then
    deny "BLOCKED: These staged files were NOT edited in this session: $UNEXPECTED. They may belong to another session. Commit only your files: git commit <your-files> -m \"msg\""
  fi
fi

exit 0
