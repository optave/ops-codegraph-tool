#!/usr/bin/env bash
# track-edits.sh — PostToolUse hook for Edit and Write tools
# Logs each edited file path to .claude/session-edits.log so that
# guard-git.sh can validate commits against actually-edited files.
# In worktrees each session gets its own log automatically.
# Always exits 0 (informational only, never blocks).

set -euo pipefail

INPUT=$(cat)

# Extract file_path from tool_input JSON
FILE_PATH=$(echo "$INPUT" | node -e "
  let d='';
  process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const p=JSON.parse(d).tool_input?.file_path||'';
    if(p)process.stdout.write(p);
  });
" 2>/dev/null) || true

if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Normalize Windows-style separators before any dirname/git splitting below —
# dirname (GNU coreutils) only splits on '/', so a backslash-delimited path
# would make it silently no-op and return ".". Only touch paths that
# unambiguously look like a Windows absolute path (drive letter prefix), so a
# POSIX path containing a literal backslash in a filename is left untouched.
# Uses grep/tr rather than a bash case pattern/parameter expansion so the
# match is byte-based, not affected by the shell's active locale.
if printf '%s' "$FILE_PATH" | grep -qE '^[A-Za-z]:[\\/]'; then
  FILE_PATH=$(printf '%s' "$FILE_PATH" | tr '\\' '/')
fi

# Resolve the git worktree that actually owns the edited file, rather than
# the hook process's own ambient cwd. Edit/Write tool calls carry only an
# absolute file_path with no associated "current directory" state, so the
# hook's ambient cwd is not guaranteed to match the worktree the file lives
# in (see issue #1838) — this mirrors the `-C "$WORK_DIR"` pattern
# guard-git.sh already uses on the read side of this same check.
#
# Walk up to the nearest existing ancestor directory first: Write can target
# a not-yet-created nested directory, and `git -C` requires an existing path.
SEARCH_DIR=$(dirname "$FILE_PATH")
while [ ! -d "$SEARCH_DIR" ] && [ "$SEARCH_DIR" != "/" ] && [ -n "$SEARCH_DIR" ]; do
  SEARCH_DIR=$(dirname "$SEARCH_DIR")
done

PROJECT_DIR=""
if [ -n "$SEARCH_DIR" ] && [ -d "$SEARCH_DIR" ]; then
  PROJECT_DIR=$(git -C "$SEARCH_DIR" rev-parse --show-toplevel 2>/dev/null) || true
fi
if [ -z "$PROJECT_DIR" ]; then
  PROJECT_DIR=$(git rev-parse --show-toplevel 2>/dev/null) || PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
fi
LOG_FILE="$PROJECT_DIR/.claude/session-edits.log"

# Normalize to relative path with forward slashes. Canonicalize both sides
# via realpath first (walking up to the nearest existing ancestor, since
# Write can target a not-yet-created nested path) — on Windows the same
# directory can be reported as either its long form or its auto-generated
# 8.3 short-name alias (e.g. "runneradmin" vs "RUNNER~1") depending on which
# API produced it, and a naive string-based path.relative() treats those as
# unrelated trees, producing a long chain of spurious '../' segments.
REL_PATH=$(node -e "
  const fs = require('fs');
  const path = require('path');

  function realpathWalkUp(p) {
    let dir = path.resolve(p);
    let tail = '';
    while (true) {
      try {
        const real = fs.realpathSync(dir);
        return tail ? path.join(real, tail) : real;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) return path.resolve(p);
        tail = tail ? path.join(path.basename(dir), tail) : path.basename(dir);
        dir = parent;
      }
    }
  }

  const abs = realpathWalkUp(process.argv[1]);
  const base = realpathWalkUp(process.argv[2]);
  const rel = path.relative(base, abs).split(path.sep).join('/');
  process.stdout.write(rel);
" "$FILE_PATH" "$PROJECT_DIR" 2>/dev/null) || true

if [ -z "$REL_PATH" ]; then
  exit 0
fi

# Append timestamped entry
mkdir -p "$(dirname "$LOG_FILE")"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $REL_PATH" >> "$LOG_FILE"

exit 0
