---
name: housekeep
description: Local repo maintenance — clean stale worktrees, remove dirt files, sync with main, update codegraph, prune branches, and verify repo health
argument-hint: "[--full | --dry-run | --skip-update]  (default: full cleanup)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# /housekeep — Local Repository Maintenance

Clean up the local repo: remove stale worktrees, delete dirt/temp files, sync with main, update codegraph to latest, prune merged branches, and verify repo health. The "spring cleaning" routine.

## Arguments

- `$ARGUMENTS` may contain:
  - `--full` — run all phases (default behavior)
  - `--dry-run` — show what would be cleaned without actually doing it
  - `--skip-update` — skip the codegraph npm update phase
  - No arguments — full cleanup

## Phase 0 — Pre-flight

1. Confirm we're in the codegraph repo root (check `package.json` with `"name": "@optave/codegraph"`)
2. Parse `$ARGUMENTS`:
   - `DRY_RUN=true` if `--dry-run`
   - `SKIP_UPDATE=true` if `--skip-update`
3. Record current branch: `git branch --show-current`
4. Record current git status: `git status --short`
5. Warn the user if there are uncommitted changes — housekeeping works best from a clean state

## Phase 1 — Audit & Clean Worktrees

> **Always report disk usage first.** Worktree bloat (per-worktree `node_modules/`, `target/`, `dist/`) is the single largest source of disk waste in this repo — a fresh worktree with `npm install` + a Rust build is ~3GB. Even when no worktree is technically "stale" by branch criteria, the disk footprint must be surfaced so the user can decide what to keep.

### 1a. Total worktree disk usage

Always print this, even on `--dry-run`. Use `du -sk` (kilobytes) so the pipeline is portable across BSD (macOS) and GNU (Linux) — `sort -h` is a GNU coreutils extension and is rejected by stock macOS `sort`.

```bash
du -sh .claude/worktrees 2>/dev/null
# Portable per-worktree sort: kilobytes through sort -n, then format back to human-readable.
du -sk .claude/worktrees/*/ 2>/dev/null | sort -n | awk '{
  k=$1; $1=""; sub(/^ /, "");
  if (k >= 1048576)      printf "%.1fG\t%s\n", k/1048576, $0;
  else if (k >= 1024)    printf "%.1fM\t%s\n", k/1024, $0;
  else                   printf "%dK\t%s\n", k, $0;
}'
```

If the total exceeds **5GB**, raise it as a finding in the report regardless of whether any individual worktree is stale.

### 1b. List git-tracked worktrees

```bash
git worktree list
```

Cross-reference against `.claude/worktrees/*` on disk — directories there that aren't in `git worktree list` are **orphaned** (prunable). Worktrees in the list whose directory is missing are also prunable.

### 1c. Identify stale worktrees

A worktree is stale if:
- Its directory no longer exists on disk, OR it exists on disk but is not in `git worktree list` (orphaned)
- It has no uncommitted changes AND its branch has been merged to main
- Its branch has no commits ahead of `origin/main` AND the branch's last commit is more than 7 days old
  (check: `git log -1 --format=%ci <branch>` — `git worktree list` does not expose creation timestamps)
- It matches the sub-agent pattern `.claude/worktrees/agent-<hex>` AND has no uncommitted changes AND its branch has no commits ahead of `origin/main` (sub-agent worktrees are typically ephemeral and orphaned after the agent finishes)

### 1d. Identify bloated worktrees (NEW)

A worktree is **bloated** if it is not stale (so we can't just remove it) but contains regeneratable build artifacts taking significant disk space. Check each non-stale worktree for:

- `node_modules/` (typically ~1.8GB)
- `target/` (Rust build cache, typically ~1.4GB)
- `dist/` (compiled TS output)
- `.codegraph/graph.db*` (rebuildable via `codegraph build`) — measure **only the `graph.db` and `graph.db-journal` files**, not the whole `.codegraph/` directory, because cleanup in §1e only removes those files. Measuring the whole directory would overstate the freed space.

For each worktree, sum the artifact sizes and emit a per-worktree subtotal so the 500MB threshold can be evaluated without manually regrouping flat output. Uses `du -sk` (kilobytes) with `sort -n` for portability — `sort -h` is GNU-only and breaks on stock macOS.

```bash
for wt in .claude/worktrees/*/; do
  total_kb=0
  breakdown=""
  for sub in node_modules target dist; do
    if [ -d "$wt$sub" ]; then
      sz=$(du -sk "$wt$sub" 2>/dev/null | awk '{print $1}')
      [ -n "$sz" ] && total_kb=$((total_kb + sz)) && breakdown="$breakdown  $sub=${sz}K"
    fi
  done
  # .codegraph: only measure the two files we will actually remove
  for f in "$wt.codegraph/graph.db" "$wt.codegraph/graph.db-journal"; do
    if [ -f "$f" ]; then
      sz=$(du -sk "$f" 2>/dev/null | awk '{print $1}')
      [ -n "$sz" ] && total_kb=$((total_kb + sz)) && breakdown="$breakdown  $(basename "$f")=${sz}K"
    fi
  done
  [ "$total_kb" -gt 0 ] && printf "%d\t%s\t%s\n" "$total_kb" "$wt" "$breakdown"
done | sort -n | awk -F'\t' '{
  k=$1;
  if (k >= 1048576)      printf "%.1fG\t%s%s\n", k/1048576, $2, $3;
  else if (k >= 1024)    printf "%.1fM\t%s%s\n", k/1024, $2, $3;
  else                   printf "%dK\t%s%s\n", k, $2, $3;
}'
```

Flag any worktree whose combined build artifact size exceeds **500MB** (512000 kilobytes).

### 1e. Clean up

**For orphaned directories** (on disk but not in `git worktree list`):

> **Critical: orphaned directories may still contain uncommitted work.** A worktree's git registration can be dropped (failed `git worktree add`, manual `git worktree prune`, etc.) while the user's source edits remain on disk. `rm -rf` on such a directory is permanent data loss.

Before offering removal, run `git -C <path> status --short` to check for uncommitted changes:

```bash
# NOTE: iterate with `while IFS= read -r dir`, never `for dir in $ORPHANED_DIRS` —
# the Bash tool in Claude Code runs under zsh, which does NOT word-split an
# unquoted multi-line variable the way bash does. `for dir in $ORPHANED_DIRS`
# would silently collapse every orphaned directory into a single iteration
# whose $dir is the whole newline-joined blob, breaking `git -C "$dir"` the
# moment more than one orphaned directory exists.
printf '%s\n' "$ORPHANED_DIRS" | while IFS= read -r dir; do
  [ -z "$dir" ] && continue
  if [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
    changes=$(git -C "$dir" status --short 2>/dev/null)
    if [ -n "$changes" ]; then
      echo "SKIP $dir — has uncommitted changes:"
      echo "$changes" | sed 's/^/    /'
      continue
    fi
  fi
  # Safe to offer removal — confirm with user first
  echo "ORPHANED (clean): $dir"
done
```

Only after confirming the directory is clean (no uncommitted changes) AND the user has explicitly approved removal, run `rm -rf <path>`. Then run `git worktree prune` to clear any dangling refs. Apply the same "Never force-remove a worktree with uncommitted changes" rule that protects stale worktrees in `git worktree list` — orphaned dirs get the same guardrail.

**For prunable worktrees** (in list but directory missing):
```bash
git worktree prune
```

**For stale worktrees with merged branches:**
- List them with their disk size and **always ask the user for confirmation before removing**, regardless of `--full`
- If confirmed:
  ```bash
  git worktree remove <path>
  git branch -d <branch>  # only if fully merged
  ```

**For bloated (non-stale) worktrees:**
- List them with a per-artifact size breakdown
- Ask the user whether to **clean build artifacts only** (keep the source) — these regenerate on the next `npm install` / `cargo build` / `codegraph build`
- If confirmed, for each selected worktree:
  ```bash
  rm -rf <worktree>/node_modules
  rm -rf <worktree>/target
  rm -rf <worktree>/dist
  rm -f  <worktree>/.codegraph/graph.db <worktree>/.codegraph/graph.db-journal
  ```
- **Never run `npm install` / `cargo clean` inside the target worktree** — it may be in use by another Claude Code session

**If `DRY_RUN`:** List everything that would be removed with sizes, don't do it.

> **Never force-remove** a worktree with uncommitted changes. List it as "has uncommitted work" and skip — but still report its disk size so the user knows what it's costing.
> **Never delete source files** in a bloated worktree — only delete the four regeneratable artifact paths above.

## Phase 2 — Delete Dirt Files

Remove temporary and generated files that accumulate over time. There are two distinct categories of dirt that require different discovery commands:

- **Gitignored dirt** (files matching `.gitignore` patterns — e.g. `coverage/`, `.DS_Store`, `*.log`, `.codegraph/graph.db-journal`): use `git clean -fdX --dry-run` to list them. `git ls-files --others --exclude-standard` silently omits these because `--exclude-standard` suppresses gitignored entries.
- **Untracked non-ignored files** (stray files not in `.gitignore` — e.g. `*.tmp.*`, `*.bak`, `*.orig`): use `git ls-files --others --exclude-standard` to list them.

Run both commands and union the results to get the full set of candidate dirt files.

### 2a. Known dirt patterns

Search for and remove files found by the two discovery commands above (never touch tracked files):
- `*.tmp.*`, `*.bak`, `*.orig` files in the repo (but NOT in `node_modules/`)
- `.DS_Store` files
- `*.log` files in repo root (not in `node_modules/`)
- Empty directories (except `.codegraph/`, `.claude/`, `node_modules/`)
- `coverage/` directory (regenerated by `npm run test:coverage`)
- `.codegraph/graph.db-journal` (SQLite WAL leftovers)

**Stale lock files** (`.codegraph/*.lock` older than 1 hour): Before removing, first check if `lsof` is available (`command -v lsof`). If `lsof` is **not installed** (common in Docker/CI minimal containers where it exits 127), **skip lock file removal entirely** and print a warning: `"lsof not available — skipping lock file cleanup (cannot verify no process holds the file)"`. When `lsof` IS available, use `lsof "$f"` to verify no process holds the file. If the file is held, **skip it** and warn — concurrent Claude Code sessions may hold legitimate long-lived locks.

```bash
if ! command -v lsof > /dev/null 2>&1; then
  echo "lsof not available — skipping lock file cleanup (cannot verify no process holds the file)"
else
  for f in .codegraph/*.lock; do
    [ -f "$f" ] || continue
    age=$(( $(date +%s) - $(stat --format='%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null) ))
    [ -z "$age" ] && continue
    if [ "$age" -gt 3600 ] && ! lsof "$f" > /dev/null 2>&1; then
      if [ "$DRY_RUN" = "true" ]; then
        echo "[DRY RUN] Would remove stale lock: $f"
      else
        echo "Removing stale lock: $f"
        rm "$f"
      fi
    elif [ "$age" -gt 3600 ]; then
      echo "Lock file $f is old but still held by a process — ask user before removing"
    fi
  done
fi
```

### 2b. Large untracked files

Find untracked files (both gitignored and non-ignored) larger than 1MB. Use both discovery commands and union the paths:
```bash
# Non-ignored untracked files
git ls-files --others --exclude-standard | while read f; do
  size=$(stat --format='%s' "$f" 2>/dev/null || stat -f '%z' "$f" 2>/dev/null)
  [ -z "$size" ] && continue
  if [ "$size" -gt 1048576 ]; then echo "$f ($size bytes)"; fi
done
# Gitignored files (strip the leading "Would remove " prefix from dry-run output)
git clean -fdX --dry-run | sed 's/^Would remove //' | while read f; do
  # Skip directory entries — stat returns inode size, not content size
  [ -d "$f" ] && continue
  size=$(stat --format='%s' "$f" 2>/dev/null || stat -f '%z' "$f" 2>/dev/null)
  [ -z "$size" ] && continue
  if [ "$size" -gt 1048576 ]; then echo "$f ($size bytes) [gitignored]"; fi
done
```

Flag these for user review — they might be accidentally untracked binaries.

### 2c. Clean up

**If `DRY_RUN`:** List all files that would be removed with their sizes.

**Otherwise:**
- Remove known dirt patterns automatically
- For large untracked files: list and ask the user

> **Never delete** files that are tracked by git. Only clean untracked/ignored files.

## Phase 3 — Sync with Main

### 3a. Fetch latest

```bash
git fetch origin
```

### 3b. Check main branch status

```bash
git log HEAD..origin/main --oneline
```

If main has new commits:
- If on main: `git pull --no-rebase origin main`
- If on a feature branch: inform the user how many commits behind main they are
  - Suggest: `git merge origin/main` (never rebase — per project rules)

### 3c. Check for diverged branches

List local branches that have diverged from their remote tracking branch:
```bash
git for-each-ref --format='%(refname:short) %(upstream:track)' refs/heads/
```

Flag any branches marked `[ahead N, behind M]` — these may need attention.

## Phase 4 — Prune Merged Branches

### 4a. Find merged branches

```bash
git branch --merged origin/main
```

### 4b. Safe to delete

Branches that are:
- Fully merged into main
- Not `main` itself
- Not the current branch
- Not a worktree branch (check `git worktree list`)

### 4c. Prune remote tracking refs

```bash
git remote prune origin
```

This removes local refs to branches that no longer exist on the remote.

### 4d. Clean up

**If `DRY_RUN`:** List branches that would be deleted.

**Otherwise:** For each merged branch, ask the user for confirmation before deleting:
```
Delete merged branch '<branch>'? (y/n)
```
If confirmed, delete the branch:
```bash
git branch -d <branch>  # safe delete, only if fully merged
```

> **Never use `git branch -D`** (force delete). If `-d` fails, the branch has unmerged work — skip it.
> **Always confirm before deleting** — consistent with worktree removal in Phase 1c.

## Phase 5 — Update Codegraph

**Skip if `SKIP_UPDATE` is set.**

> **Source-repo guard:** This phase is only meaningful when codegraph is installed as a *dependency* of a consumer project. Because the pre-flight confirms we are inside the codegraph *source* repo (`"name": "@optave/codegraph"`), comparing the dev version to the published release and running `npm install` would be a no-op — codegraph is not one of its own dependencies. **Skip this entire phase** when running inside the source repo and print:
> `Codegraph: skipped (running inside source repo — update via git pull / branch sync instead)`

## Phase 6 — Verify Repo Health

Quick health checks to catch issues:

### 6a. Graph integrity

```bash
npx codegraph stats
```

If the graph is stale (built from a different commit), rebuild:
```bash
npx codegraph build
```

### 6b. Node modules integrity

```bash
npm ls --depth=0 2>&1 | grep -cE "missing|invalid|WARN"
```

If issues found: `npm install` to fix.

### 6c. Git integrity

```bash
git fsck --no-dangling 2>&1 | head -20
```

Flag any errors (rare but important).

## Phase 7 — Report

Print a summary to the console (no file needed — this is a local maintenance task):

```
=== Housekeeping Report ===

Worktrees:  total .claude/worktrees/ size 57G (32 worktrees)
            removed 2 stale (4.2G freed), 1 has uncommitted work (skipped)
            cleaned build artifacts in 3 active worktrees (9.6G freed)
Dirt files: cleaned 5 temp files (12KB), 1 large untracked flagged
Branches:   pruned 3 merged branches, 2 remote refs
Main sync:  up to date (or: 4 commits behind — merge suggested)
Codegraph:  v3.1.2 → v3.1.3 updated (or: already latest)
Graph:      rebuilt (was stale) (or: fresh)
Node mods:  OK (or: fixed 2 missing deps)
Git:        OK

Status: CLEAN ✓
```

> **Always include the worktree total** at the top of the Worktrees line, even when no worktrees were removed. This is the metric that surfaces hidden disk bloat — without it, multi-GB worktree accumulations go invisible to the user.

**If `DRY_RUN`:** prefix with `[DRY RUN]` and show what would happen without doing it.

## Rules

- **Never force-delete** anything — use safe deletes only (`git branch -d`, `git worktree remove`)
- **Never rebase** — sync with main via merge only (per project rules)
- **Never delete tracked files** — only clean untracked/ignored dirt
- **Never delete worktrees with uncommitted changes** — warn and skip
- **Always report worktree disk usage** — even when nothing is removed, the total must appear in the report. Worktree bloat is the #1 source of disk waste in this repo
- **Bloated-but-active worktrees:** only delete the four regeneratable artifact paths (`node_modules/`, `target/`, `dist/`, `.codegraph/graph.db*`). Never touch source files in a worktree you don't own
- **Ask before deleting large untracked files** — they might be intentional
- **This is a local-only operation** — no pushes, no remote modifications, no PR creation
- **Idempotent** — running twice should be safe (second run finds nothing to clean)
- **`--dry-run` is sacred** — it must NEVER modify anything, only report
