#!/usr/bin/env bash
# assert-worktree.sh — abort if cwd is the main repo checkout, not an isolated worktree.
#
# CLAUDE.md ("Parallel Sessions") requires every code-changing session to run in
# its own worktree: multiple Claude Code instances share this repo, and a
# dispatched agent that branch-mutates the main checkout can yank another
# session's branch out from under it. `oversee-dispatch.js` injects a
# WORKTREE_GUARD block into every prompt that performs branch-mutating git
# operations, instructing the agent to run this script first — keep the
# invocation path (`.claude/scripts/assert-worktree.sh`) in sync if this ever
# moves.
#
# Usage: invoke as a subprocess before git switch/checkout/push — do NOT source.
#        (Sourcing with `exit 1` / `set -euo pipefail` would kill the parent shell.)
#
# Exits 1 (with message) when `git rev-parse --show-toplevel` resolves to the main
# repo path; exits 0 when cwd is inside a linked worktree.

set -euo pipefail

toplevel=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "ABORT: not inside a git repository"; exit 1; }
git_common=$(git rev-parse --git-common-dir 2>/dev/null) || { echo "ABORT: cannot determine git common dir"; exit 1; }

# In a linked worktree, --git-common-dir points at the MAIN repo's .git directory
# (e.g. /path/to/main/.git). In the main repo itself it is just ".git". Normalize
# both to absolute paths and compare.
# Note: `set -e` does NOT propagate into command substitutions, so an inner `cd`
# failure would silently leave abs_common empty and produce a false-OK exit 0.
# Capture, then reject an empty string explicitly (fail closed).
abs_common=$(cd "$toplevel" && cd "$(dirname "$git_common")" && pwd) || { echo "ABORT: could not resolve git common dir path"; exit 1; }
[ -n "$abs_common" ] || { echo "ABORT: abs_common is empty — git common dir resolution failed"; exit 1; }
abs_toplevel=$(cd "$toplevel" && pwd)

# If the common dir's parent IS the toplevel, we are in the main repo. In a linked
# worktree the common dir's parent is the MAIN repo, never the worktree.
if [ "$abs_common" = "$abs_toplevel" ]; then
  echo "ABORT: cwd ($abs_toplevel) is the MAIN repo checkout, not an isolated worktree."
  echo "Branch-mutating git operations (switch, checkout -b, push) must run inside the"
  echo "assigned worktree — see CLAUDE.md 'Parallel Sessions'."
  exit 1
fi

echo "OK: cwd ($abs_toplevel) is a linked worktree (main repo at $abs_common)."
exit 0
