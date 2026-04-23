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

# Normalize: strip `git -C "<path>"` / `git -C <path>` so downstream subcommand
# patterns (git\s+push, git\s+commit, …) match regardless of whether `-C` is
# present. detect_work_dir still inspects the raw $COMMAND to find the target.
# The unquoted pattern requires a non-quote first char so it does not mis-match
# the opening `"` of a quoted path (which would leave a trailing `path"` in
# NCOMMAND). The pattern re-anchors on `git`, so multi-`-C` chains (e.g.
# `git -C /a -C /b push`) need a second pass to collapse the residual `-C`.
NCOMMAND=$(echo "$COMMAND" | sed -E 's/(^|\s|&&\s*)git[[:space:]]+-C[[:space:]]+"[^"]+"/\1git/g; s/(^|\s|&&\s*)git[[:space:]]+-C[[:space:]]+[^"[:space:]][^[:space:]]*/\1git/g')
NCOMMAND=$(echo "$NCOMMAND" | sed -E 's/(^|\s|&&\s*)git[[:space:]]+-C[[:space:]]+"[^"]+"/\1git/g; s/(^|\s|&&\s*)git[[:space:]]+-C[[:space:]]+[^"[:space:]][^[:space:]]*/\1git/g')

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
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+add\s+(\.\s*$|-A|--all)'; then
  deny "BLOCKED: 'git add .' / 'git add -A' stages ALL changes including other sessions' work. Stage specific files instead: git add <file1> <file2>"
fi

# git reset (unstaging / hard reset)
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+reset'; then
  deny "BLOCKED: 'git reset' can unstage or destroy other sessions' work. To unstage your own files, use: git restore --staged <file>"
fi

# git checkout -- <file> (reverting files)
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+checkout\s+--'; then
  deny "BLOCKED: 'git checkout -- <file>' reverts working tree changes and may destroy other sessions' edits. If you need to discard your own changes, be explicit about which files."
fi

# git restore (reverting) — EXCEPT git restore --staged (safe unstaging)
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+restore'; then
  if ! echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+restore\s+--staged'; then
    deny "BLOCKED: 'git restore <file>' reverts working tree changes and may destroy other sessions' edits. To unstage files safely, use: git restore --staged <file>"
  fi
fi

# git clean (delete untracked files)
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+clean'; then
  deny "BLOCKED: 'git clean' deletes untracked files that may belong to other sessions."
fi

# git stash (hides all changes)
if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+stash'; then
  deny "BLOCKED: 'git stash' hides all working tree changes including other sessions' work. In worktree mode, commit your changes directly instead."
fi

# --- Working directory detection ---

# Resolve the working directory a git command targets:
# - `git -C "<dir>" ...`   → the -C target (takes precedence — explicit git-level override)
# - `cd "<dir>" && git ...` → the cd target
# Falls back to empty string (caller uses cwd).
#
# Optional arg: target subcommand hint (e.g. `push`, `commit`). When given,
# narrows the search to the `&&`-separated segment whose git invocation runs
# that subcommand, so chained commands like
#   `git -C /a push && git -C /b commit -m ...`
# resolve each caller to its own worktree instead of always picking the last
# `git` token. Within the chosen segment the LAST `-C` wins (git's `-C` is
# cumulative, so the final `-C` is the effective CWD) — this closes the
# multi-`-C` bypass (`git -C /ok -C /bad push` resolves to `/bad`).
detect_work_dir() {
  local target_subcmd="${1:-}"
  local work_dir=""
  local search_str="$COMMAND"

  if [ -n "$target_subcmd" ]; then
    local segment
    segment=$(echo "$COMMAND" | awk -v tgt="$target_subcmd" 'BEGIN{RS="&&"}{
      if ($0 ~ "git[[:space:]]+([^|;&]*[[:space:]])?" tgt "([[:space:]]|$)") { print; exit }
    }')
    if [ -n "$segment" ]; then
      search_str="$segment"
    fi
  fi

  # `git -C` is the explicit git-level override and wins over any ambient cd prefix,
  # so check it first (e.g. `cd /tmp && git -C /worktree push` targets /worktree).
  # Greedy `.*-C` anchors on the LAST `-C` in the chosen segment.
  if echo "$search_str" | grep -qE 'git\s+([^&|;]*\s)?-C\s+'; then
    work_dir=$(echo "$search_str" | sed -nE 's/.*-C[[:space:]]+"([^"]+)".*/\1/p;t;s/.*-C[[:space:]]+([^[:space:]]+).*/\1/p')
  fi
  if [ -z "$work_dir" ] && echo "$COMMAND" | grep -qE '^\s*cd\s+'; then
    work_dir=$(echo "$COMMAND" | sed -nE 's/^\s*cd\s+"?([^"&]+)"?\s*&&.*/\1/p')
  fi
  # Trim trailing whitespace
  work_dir="${work_dir%"${work_dir##*[![:space:]]}"}"
  echo "$work_dir"
}

# --- Branch name validation helper ---

validate_branch_name() {
  local subcmd="${1:-}"
  local work_dir
  work_dir=$(detect_work_dir "$subcmd")

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

if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+push'; then
  validate_branch_name push
fi

# --- Branch name validation on gh pr create ---

if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)gh\s+pr\s+create'; then
  # `gh pr create` does not use `git -C`; detect_work_dir falls through to the
  # `cd` path or cwd. No subcommand hint to pass.
  validate_branch_name
fi

# --- Commit validation against edit log ---

if echo "$NCOMMAND" | grep -qE '(^|\s|&&\s*)git\s+commit'; then
  # Resolve the target worktree so the edit log and staged-file listing come
  # from the same repo the commit targets (e.g. `git -C <pr-worktree> commit`).
  WORK_DIR=$(detect_work_dir commit)
  if [ -n "$WORK_DIR" ] && [ -d "$WORK_DIR" ]; then
    PROJECT_DIR=$(git -C "$WORK_DIR" rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
    STAGED_FILES=$(git -C "$WORK_DIR" diff --cached --name-only 2>/dev/null) || true
  else
    PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
    STAGED_FILES=$(git diff --cached --name-only 2>/dev/null) || true
  fi
  LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

  # If no edit log exists, allow (backward compat for sessions without tracking)
  if [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; then
    exit 0
  fi

  # Get unique edited files from log
  EDITED_FILES=$(awk '{print $2}' "$LOG_FILE" | sort -u)

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
