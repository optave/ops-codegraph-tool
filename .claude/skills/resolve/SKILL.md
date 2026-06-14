---
name: resolve
description: Resolve merge conflicts on a PR with full context awareness — identifies which PR introduced each conflicting change, understands both sides' intent, and resolves without silently dropping functionality.
argument-hint: "<pr-number>"
allowed-tools: Bash, Read
---

# /resolve — Context-Aware Conflict Resolution

Resolve merge conflicts on a given PR by understanding the intent of *both* sides of every conflict. For each conflicting hunk, the skill finds which PR on the base branch introduced those lines, reads that PR's description and diff, reads the current PR's description and diff, and resolves the conflict so no intentional functionality from either side is lost.

If a conflict is genuinely ambiguous — the skill cannot determine which side's change is intentional without human judgment — it stops and explains rather than guessing.

## Arguments

- First positional argument: the GitHub PR number (required, e.g. `/resolve 1490`)
- Set `PR_NUMBER` from `$ARGUMENTS` (trim whitespace, strip leading `#`)

Validation:
```bash
PR_NUMBER=$(echo "${ARGUMENTS:-}" | tr -d '[:space:]#')
if ! echo "$PR_NUMBER" | grep -qE '^[0-9]+$'; then
  echo "ERROR: PR number must be a positive integer (got: '${ARGUMENTS:-<empty>}')"
  echo "Usage: /resolve <pr-number>  e.g. /resolve 1490"
  exit 1
fi
echo "Resolving conflicts on PR #$PR_NUMBER"
```

---

## Phase 0 — Pre-flight

Verify required tools and environment before doing any real work.

```bash
for tool in git gh jq; do
  # > /dev/null 2>&1: suppress command path on success and "not found" message on failure — the || clause provides the error message
  command -v "$tool" > /dev/null 2>&1 || { echo "ERROR: required tool '$tool' not found in PATH"; exit 1; }
done
# > /dev/null 2>&1: suppress git's own "fatal: not a git repository" — our message is more actionable
git rev-parse --show-toplevel > /dev/null 2>&1 || { echo "ERROR: not in a git repository"; exit 1; }

# Validate PR number (re-parse here since Phase 0 is self-contained)
PR_NUMBER=$(echo "${ARGUMENTS:-}" | tr -d '[:space:]#')
if ! echo "$PR_NUMBER" | grep -qE '^[0-9]+$'; then
  echo "ERROR: PR number must be a positive integer (got: '${ARGUMENTS:-<empty>}')"
  exit 1
fi

# Guard against a previously aborted merge left in place — if MERGE_HEAD exists but
# .codegraph/resolve/ was already cleaned, the next `git merge` call would fail immediately.
if git rev-parse --verify MERGE_HEAD > /dev/null 2>&1; then
  echo "ERROR: An in-progress merge (MERGE_HEAD) already exists."
  echo "Run: git merge --abort && rm -rf .codegraph/resolve"
  echo "Then re-run /resolve $PR_NUMBER"
  exit 1
fi

# Detect repo slug dynamically so the skill works in any fork or renamed org
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null \
  || git remote get-url origin | sed -E 's|.*github\.com[:/](.+)(\.git)?$|\1|')
if [ -z "$REPO" ]; then
  echo "ERROR: could not detect GitHub repo slug — ensure 'gh' is authenticated or 'origin' points to GitHub"
  exit 1
fi
echo "Detected repo: $REPO"

# Verify PR exists and is open
gh pr view "$PR_NUMBER" --repo "$REPO" --json number,state,headRefName,baseRefName \

  --jq '"PR #\(.number) [\(.state)] \(.headRefName) → \(.baseRefName)"' \
  || { echo "ERROR: PR #$PR_NUMBER not found or inaccessible"; exit 1; }
```

Persist PR metadata for use in later phases (shell variables don't survive across code fences):

```bash
PR_NUMBER=$(echo "${ARGUMENTS:-}" | tr -d '[:space:]#')
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null \
  || git remote get-url origin | sed -E 's|.*github\.com[:/](.+)(\.git)?$|\1|')
mkdir -p .codegraph/resolve
# Trap ensures .codegraph/resolve/ is always cleaned up on non-zero exit, even after a crash.
# This prevents stale state from corrupting a future re-run (Phase 1 reads head-branch / base-branch
# from here, and an aborted merge would see stale values).
trap 'rm -rf .codegraph/resolve' ERR
echo "$REPO" > .codegraph/resolve/repo
gh pr view "$PR_NUMBER" --repo "$REPO" \

  --json number,headRefName,baseRefName,title,body \
  > .codegraph/resolve/pr-meta.json \
  || { echo "ERROR: failed to fetch PR #$PR_NUMBER metadata"; exit 1; }
jq -r '.headRefName' .codegraph/resolve/pr-meta.json > .codegraph/resolve/head-branch
jq -r '.baseRefName' .codegraph/resolve/pr-meta.json > .codegraph/resolve/base-branch
echo "$PR_NUMBER" > .codegraph/resolve/pr-number

HEAD_BRANCH=$(cat .codegraph/resolve/head-branch)
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
if [ "$HEAD_BRANCH" = "$BASE_BRANCH" ]; then
  echo "ERROR: PR head and base are the same branch ($HEAD_BRANCH) — nothing to merge"
  rm -rf .codegraph/resolve
  exit 1
fi

echo "Pre-flight passed. PR: $(jq -r '.title' .codegraph/resolve/pr-meta.json)"
```

**Exit condition:** Git repo confirmed, `gh` and `jq` available, repo slug detected, PR exists, metadata written to `.codegraph/resolve/`.


---

## Phase 1 — Branch Setup and Conflict Surface

Check out the PR branch and run `git merge` to surface all conflicts.

```bash
HEAD_BRANCH=$(cat .codegraph/resolve/head-branch)
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
PR_NUMBER=$(cat .codegraph/resolve/pr-number)
REPO=$(cat .codegraph/resolve/repo)

echo "Checking out PR branch: $HEAD_BRANCH"
gh pr checkout "$PR_NUMBER" --repo "$REPO" \

  || { echo "ERROR: failed to check out PR #$PR_NUMBER"; exit 1; }

echo "Fetching latest origin/$BASE_BRANCH..."
git fetch origin "$BASE_BRANCH" \
  || { echo "ERROR: failed to fetch origin/$BASE_BRANCH"; exit 1; }
```

Attempt the merge and capture which files conflict:

```bash
HEAD_BRANCH=$(cat .codegraph/resolve/head-branch)
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)

echo "Merging origin/$BASE_BRANCH into $HEAD_BRANCH..."
# Intentionally allow merge to fail — we want to capture the conflict state
git merge "origin/$BASE_BRANCH" --no-edit 2>&1 | tee .codegraph/resolve/merge-output.txt || true

# Identify conflicting files
# 2>/dev/null: suppress git's "not a git repo" or internal errors — the file will be empty if no conflicts, which we check below
git diff --name-only --diff-filter=U > .codegraph/resolve/conflicting-files.txt 2>/dev/null || true

CONFLICT_COUNT=$(wc -l < .codegraph/resolve/conflicting-files.txt | tr -d '[:space:]')
if [ "$CONFLICT_COUNT" -eq 0 ]; then
  echo "No conflicts — merge completed cleanly."
  # Clean up state files
  rm -rf .codegraph/resolve
  exit 0
fi

echo "Found $CONFLICT_COUNT conflicting file(s):"
cat .codegraph/resolve/conflicting-files.txt
```

Record the pre-merge HEAD (ORIG_HEAD is set automatically by git merge):

```bash
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
# ORIG_HEAD is the commit before the merge started (the PR branch tip)
git rev-parse ORIG_HEAD > .codegraph/resolve/orig-head \
  || { echo "ERROR: ORIG_HEAD not set — was git merge actually run?"; exit 1; }
git rev-parse "origin/$BASE_BRANCH" > .codegraph/resolve/merge-head
echo "PR tip before merge : $(cat .codegraph/resolve/orig-head)"
echo "Incoming base commit: $(cat .codegraph/resolve/merge-head)"
```

**Exit condition:** Conflicting files listed in `.codegraph/resolve/conflicting-files.txt`. `ORIG_HEAD` and `MERGE_HEAD` hashes saved.

---

## Phase 2 — Conflict Archaeology

For each conflicting file, identify **which commits and PRs on the base branch** introduced the conflicting lines. This tells us *why* the incoming side changed that code.

```bash
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
ORIG_HEAD=$(cat .codegraph/resolve/orig-head)
MERGE_HEAD=$(cat .codegraph/resolve/merge-head)
REPO=$(cat .codegraph/resolve/repo)

# file_key: collision-resistant short name derived from file path
# Uses printf+sha1sum to handle paths with underscores (src/foo_bar.ts and src/foo/bar.ts
# both become different keys, unlike tr '/' '_')
file_key() { printf '%s' "$1" | sha1sum | cut -c1-16; }


# Find all commits that came in from the base branch and touched conflicting files
mkdir -p .codegraph/resolve/incoming-prs
CONFLICTING_FILES=$(cat .codegraph/resolve/conflicting-files.txt)
TOTAL=$(echo "$CONFLICTING_FILES" | grep -c . || true)
i=0

while IFS= read -r FILE; do
  i=$((i + 1))
  echo "[$i/$TOTAL] Tracing incoming changes: $FILE"
  KEY=$(file_key "$FILE")


  # Commits from origin/<base> that are not yet in the PR branch (what came in from main)
  # 2>/dev/null: suppress git's "unknown revision" if ORIG_HEAD or MERGE_HEAD are temporarily unavailable — the empty file case is handled below
  git log --oneline "$ORIG_HEAD..$MERGE_HEAD" -- "$FILE" \
    > ".codegraph/resolve/incoming-commits-$KEY.txt" 2>/dev/null || true

  if [ ! -s ".codegraph/resolve/incoming-commits-$KEY.txt" ]; then
    echo "  (no direct commit history for $FILE on incoming side — likely an add/add conflict)"
  else
    echo "  Incoming commits touching $FILE:"
    cat ".codegraph/resolve/incoming-commits-$KEY.txt"

  fi
done < .codegraph/resolve/conflicting-files.txt
```

For each incoming commit, find the PR that introduced it:

```bash
REPO=$(cat .codegraph/resolve/repo)
mkdir -p .codegraph/resolve/source-prs

file_key() { printf '%s' "$1" | sha1sum | cut -c1-16; }

while IFS= read -r FILE; do
  KEY=$(file_key "$FILE")
  COMMIT_FILE=".codegraph/resolve/incoming-commits-$KEY.txt"

  [ -f "$COMMIT_FILE" ] || continue

  while IFS= read -r COMMIT_LINE; do
    SHA=$(echo "$COMMIT_LINE" | awk '{print $1}')
    [ -z "$SHA" ] && continue

    # Check if we already looked up this SHA
    PR_FILE=".codegraph/resolve/source-prs/$SHA.json"
    if [ -f "$PR_FILE" ]; then
      continue
    fi

    echo "Looking up PR for commit $SHA..."
    # gh api returns empty array if commit is not associated with a PR
    # 2>/dev/null: suppress gh's "HTTP 422" or network error output — the || clause writes an empty array so later steps handle it gracefully
    gh api "repos/$REPO/commits/$SHA/pulls" \

      --jq '[.[] | {number: .number, title: .title, body: .body, state: .state}]' \
      > "$PR_FILE" 2>/dev/null || echo '[]' > "$PR_FILE"

    PR_NUMS=$(jq -r '.[].number' "$PR_FILE")
    if [ -z "$PR_NUMS" ]; then
      echo "  Commit $SHA: not associated with a PR (direct push or squash merge)"
    else
      echo "  Commit $SHA → PR(s): $PR_NUMS"
    fi
  done < "$COMMIT_FILE"
done < .codegraph/resolve/conflicting-files.txt
```

Fetch full descriptions and diffs for each source PR:

```bash
REPO=$(cat .codegraph/resolve/repo)

mkdir -p .codegraph/resolve/source-pr-diffs

for PR_FILE in .codegraph/resolve/source-prs/*.json; do
  [ -f "$PR_FILE" ] || continue
  SOURCE_PR_NUMS=$(jq -r '.[].number' "$PR_FILE")
  [ -z "$SOURCE_PR_NUMS" ] && continue

  while IFS= read -r SOURCE_PR; do
    [ -z "$SOURCE_PR" ] && continue
    DIFF_FILE=".codegraph/resolve/source-pr-diffs/$SOURCE_PR.diff"
    META_FILE=".codegraph/resolve/source-pr-diffs/$SOURCE_PR.json"

    if [ ! -f "$META_FILE" ]; then
      echo "Fetching source PR #$SOURCE_PR description..."
      # 2>/dev/null: suppress gh's auth/network error text — the || clause writes a stub so the skill continues gracefully
      gh pr view "$SOURCE_PR" --repo "$REPO" \

        --json number,title,body,baseRefName,headRefName \
        > "$META_FILE" 2>/dev/null \
        || { echo "WARN: could not fetch PR #$SOURCE_PR metadata — skipping"; echo '{}' > "$META_FILE"; }
    fi

    if [ ! -f "$DIFF_FILE" ]; then
      echo "Fetching source PR #$SOURCE_PR diff..."
      # 2>/dev/null: suppress gh's auth/network error text — the || clause creates an empty file so the skill continues gracefully
      gh pr diff "$SOURCE_PR" --repo "$REPO" \

        > "$DIFF_FILE" 2>/dev/null \
        || { echo "WARN: could not fetch PR #$SOURCE_PR diff — skipping"; touch "$DIFF_FILE"; }
    fi
  done <<< "$SOURCE_PR_NUMS"
done
```

**Read and summarise all source PR context.** For each source PR found, read its title, body, and the relevant portion of its diff. Build a written understanding of what that PR was trying to accomplish.

For each file in `.codegraph/resolve/source-pr-diffs/*.json`:
- Read `number`, `title`, `body`
- Read the corresponding `.diff` file, focusing on hunks touching the conflicting files
- Note the PR's stated purpose and the specific lines it added/changed

**Exit condition:** For every conflicting file, the incoming commits have been traced to their source PRs. Descriptions and diffs are saved to `.codegraph/resolve/source-pr-diffs/`.

---

## Phase 3 — Current PR Context

Read the current PR's description and diff to understand its stated intent and scope.

```bash
PR_NUMBER=$(cat .codegraph/resolve/pr-number)
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
ORIG_HEAD=$(cat .codegraph/resolve/orig-head)

echo "=== Current PR #$PR_NUMBER ==="
jq -r '"Title: \(.title)\n\nDescription:\n\(.body)"' .codegraph/resolve/pr-meta.json

echo ""
echo "=== Commits on this PR branch ==="
git log --oneline "origin/$BASE_BRANCH..$ORIG_HEAD"

echo ""
echo "=== Files changed by this PR ==="
git diff --name-only "origin/$BASE_BRANCH..$ORIG_HEAD"
```

Read the diff for conflicting files only — these are the ones where context matters most:

```bash
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)
ORIG_HEAD=$(cat .codegraph/resolve/orig-head)

echo "=== This PR's changes to conflicting files ==="
while IFS= read -r FILE; do
  echo ""
  echo "--- $FILE ---"
  # Show what the current PR changed in this file relative to the base
  # 2>/dev/null: suppress git's "unknown revision" if the range is temporarily invalid — this is display-only context, not critical
  git diff "origin/$BASE_BRANCH..$ORIG_HEAD" -- "$FILE" 2>/dev/null || true
done < .codegraph/resolve/conflicting-files.txt
```

**Exit condition:** The current PR's title, description, commits, and per-file diffs for conflicting files have been read and understood.

---

## Phase 4 — Conflict Resolution

For each conflicting file, present the conflict with full context and resolve it.

**Resolution principles (apply in order):**

1. **Both sides changed the same line intentionally** → merge both changes manually, preserving the intent of each
2. **One side added a new feature; the other reorganised/reformatted** → keep the feature, apply the reorganisation around it
3. **Add/add conflict (both sides created the same file)** → take the more complete version (usually the one that landed in main, which may have further refinements), but verify the PR side didn't add anything that main's version is missing
4. **One side's change is clearly within scope of the other PR's description; the other side is unrelated** → keep the unrelated change, incorporate the in-scope change
5. **Cannot determine intent** → **STOP. Do not guess.** Explain both sides, what is unclear, and ask the user to decide.

For each conflicting file, run the following inspection block. Repeat for every file listed in `.codegraph/resolve/conflicting-files.txt`:

```bash
ORIG_HEAD=$(cat .codegraph/resolve/orig-head)
MERGE_HEAD=$(cat .codegraph/resolve/merge-head)
TOTAL=$(wc -l < .codegraph/resolve/conflicting-files.txt | tr -d '[:space:]')
i=0

file_key() { printf '%s' "$1" | sha1sum | cut -c1-16; }


while IFS= read -r FILE; do
  i=$((i + 1))
  echo "=== [$i/$TOTAL] Resolving: $FILE ==="

  # Show the full conflict markers as-is
  grep -n "^<<<<<<\|^======\|^>>>>>>" "$FILE" | head -40 || true

  # Show what the PR branch had before the merge
  echo "--- PR branch version (before merge) ---"
  # 2>/dev/null: suppress git's "does not exist in" message — the else branch tells the user the file is new
  git show "$ORIG_HEAD:$FILE" 2>/dev/null || echo "(file did not exist on PR branch before merge)"

  # Show what the incoming base has
  echo "--- Incoming base version ---"
  # 2>/dev/null: suppress git's "does not exist in" message — the else branch tells the user the file is new
  git show "$MERGE_HEAD:$FILE" 2>/dev/null || echo "(file did not exist on incoming base)"

  echo ""
  echo "--- Source PR context for $FILE ---"
  # Show which source PRs touched this file (from Phase: Conflict Archaeology)
  KEY=$(file_key "$FILE")
  COMMIT_FILE=".codegraph/resolve/incoming-commits-$KEY.txt"

  if [ -s "$COMMIT_FILE" ]; then
    while IFS= read -r COMMIT_LINE; do
      SHA=$(echo "$COMMIT_LINE" | awk '{print $1}')
      SOURCE_PR_FILE=".codegraph/resolve/source-prs/$SHA.json"
      if [ -f "$SOURCE_PR_FILE" ]; then
        # 2>/dev/null: suppress jq parse errors if the file was written as a stub {} — the || true means we skip this commit
        SOURCE_PR_NUMS=$(jq -r '.[].number' "$SOURCE_PR_FILE" 2>/dev/null || true)
        for SOURCE_PR in $SOURCE_PR_NUMS; do
          META=".codegraph/resolve/source-pr-diffs/$SOURCE_PR.json"
          if [ -f "$META" ]; then
            echo "  Source PR #$SOURCE_PR: $(jq -r '.title // "(no title)"' "$META")"
            echo "  Purpose: $(jq -r '.body // "(no description)"' "$META" | head -5)"
          fi
        done
      fi
    done < "$COMMIT_FILE"
  else
    echo "  (no commit trace found — likely an add/add conflict)"
  fi

  # After inspecting this output: edit $FILE to resolve the conflict, then continue to the next file.
  # The staging loop at the end of this phase will stage all resolved files together.
done < .codegraph/resolve/conflicting-files.txt
```

After understanding both sides:
- Edit the file to remove all `<<<<<<<`, `=======`, `>>>>>>>` markers
- Produce a resolved version that incorporates both sides' intentional changes
- Do NOT use `git checkout --theirs` or `git checkout --ours` blindly — always produce a reasoned merged result

If a conflict cannot be resolved with confidence:
```
STOP. Report to the user:
- File: <path>
- Conflict hunk: <show the markers>
- PR #<current> intent: <description of what this PR is trying to do here>
- PR #<source> intent: <description of what the source PR is trying to do here>
- Why it is ambiguous: <specific reason>
- Question for the user: <what decision is needed>
```

Stage resolved files **by name** (never `git add .`):

```bash
# Stage only the files listed as previously conflicting
while IFS= read -r FILE; do
  git add "$FILE" \
    || { echo "ERROR: failed to stage $FILE after conflict resolution"; exit 1; }
  echo "Staged: $FILE"
done < .codegraph/resolve/conflicting-files.txt
```

**Exit condition:** All conflicting files have been edited to remove conflict markers. All resolved files are staged. No `<<<<<<<` markers remain in any tracked file.

Verify no markers remain:
```bash
if git diff --cached | grep -q "^+<<<<<<< "; then
  echo "ERROR: staged diff still contains conflict markers (<<<<<<< lines) — do not commit"
  git diff --cached | grep -n "^+<<<<<<< " | head -10
  exit 1
fi
echo "No conflict markers in staged diff."
```

---

## Phase 5 — Verification

For every file that was in conflict, verify that intentional changes from **both** parents survived.

```bash
ORIG_HEAD=$(cat .codegraph/resolve/orig-head)
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)

echo "=== Verifying resolved files ==="
TOTAL=$(wc -l < .codegraph/resolve/conflicting-files.txt | tr -d '[:space:]')
i=0

while IFS= read -r FILE; do
  i=$((i + 1))
  echo "[$i/$TOTAL] Verifying $FILE"

  echo "  -- Changes vs incoming base (what we added beyond what base had) --"
  git diff "origin/$BASE_BRANCH" -- "$FILE" | head -60

  echo "  -- Changes vs PR tip before merge (what we kept from the PR) --"
  git diff "$ORIG_HEAD" -- "$FILE" | head -60
done < .codegraph/resolve/conflicting-files.txt
```

Manually review each diff output:
- The diff vs `origin/<base>` should contain **only** the PR's intentional additions — nothing from the PR should have been silently dropped
- The diff vs `ORIG_HEAD` should contain **only** the base branch's intentional additions — nothing from main should have been silently dropped
- If anything looks wrong, go back to Phase: Conflict Resolution and correct the resolution before continuing

**Exit condition:** For every resolved file, the diff against both parents shows only the expected delta with no unintended omissions.

---

## Phase 6 — Validation

Run tests and lint to confirm the resolution didn't break anything.

```bash
echo "=== Detecting test runner ==="
if [ -f "pnpm-lock.yaml" ] && command -v pnpm > /dev/null 2>&1; then TEST_CMD="pnpm test"
elif [ -f "pnpm-lock.yaml" ]; then TEST_CMD="npx pnpm test"

elif [ -f "yarn.lock" ] && command -v yarn > /dev/null 2>&1; then TEST_CMD="yarn test"
elif [ -f "package.json" ]; then TEST_CMD="npm test"
else
  echo "WARN: No recognised test runner found — skipping tests"
  TEST_CMD=""
fi
if [ -n "$TEST_CMD" ]; then
  echo "Running: $TEST_CMD"
  eval "$TEST_CMD" || { echo "ERROR: tests failed after conflict resolution — fix before committing"; exit 1; }
fi

```

```bash
echo "=== Detecting lint runner ==="
if [ -f "biome.json" ] && command -v npx > /dev/null 2>&1; then
  # Point biome at . and let biome.json's files.include/files.ignore govern scope
  LINT_CMD="npx biome check --reporter=summary ."
elif ls eslint.config.* > /dev/null 2>&1; then

  LINT_CMD="npx eslint ."
elif [ -f "package.json" ] && grep -q '"lint"' package.json; then
  LINT_CMD="npm run lint"
else
  echo "WARN: No recognised lint runner found — skipping lint"
  LINT_CMD=""
fi
if [ -n "$LINT_CMD" ]; then
  echo "Running: $LINT_CMD"
  eval "$LINT_CMD" || { echo "ERROR: lint failed after conflict resolution — fix before committing"; exit 1; }
fi

```

**Exit condition:** Tests and lint pass (or were not applicable). No new failures introduced by the resolution.

---

## Phase 7 — Commit and Push

Commit the resolved merge and push to the PR branch.

```bash
BASE_BRANCH=$(cat .codegraph/resolve/base-branch)

# Guard against empty commit (all staged changes might have been no-ops)
if git diff --cached --quiet; then
  echo "Nothing staged to commit — merge may have been a no-op after resolution."
  # Check if merge is actually complete
  if git diff --name-only --diff-filter=U | grep -q .; then
    echo "ERROR: Unstaged conflict files still exist — resolution is incomplete"
    exit 1
  fi
  echo "Merge is already clean — nothing to commit."
else
  git commit -m "fix: resolve merge conflicts with $BASE_BRANCH" \
    || { echo "ERROR: commit failed"; exit 1; }
  echo "Committed merge resolution."
fi

echo "Pushing to origin..."
git push \
  || { echo "ERROR: push failed — check branch protection or authentication"; exit 1; }
echo "Pushed successfully."
```

Clean up temporary state files:

```bash
rm -rf .codegraph/resolve
echo "Conflict resolution complete."
```

**Exit condition:** Merge commit exists on the remote PR branch. No conflict markers remain. CI will re-run on the new commit.

---

## Examples

- `/resolve 1490` — resolve conflicts on PR #1490 (fix/cha-incremental-scope-1441) by merging origin/main, tracing incoming changes to their source PRs, and resolving with full context
- `/resolve 1509` — resolve conflicts on PR #1509 where a new workflow file was added by both the PR and main (add/add conflict)
- `/resolve 3920` — resolve conflicts on any PR in the repository

---

## Rules

- **NEVER rebase.** Always `git merge origin/<base>` — this preserves the commit history and makes it safe to push without force.
- **NEVER use `git checkout --ours` or `git checkout --theirs` blindly.** These silently discard one side. Always produce a reasoned merged result.
- **NEVER commit with `git add .` or `git add -A`.** Stage only the files that were in conflict, by name.
- **NEVER guess on ambiguous conflicts.** Stop and explain to the user what is unclear and what decision is needed.
- **NEVER drop functionality silently.** If a line from either side is missing from the resolution, there must be a documented reason.
- **Read source PR descriptions before resolving.** A conflict cannot be resolved correctly without understanding what both sides were trying to accomplish.
- **Run tests and lint before pushing.** A clean merge that breaks tests is not ready to push.
- **No co-author lines** in commit messages.
- **No Claude Code references** in commit messages or comments.
- **Cleanup:** `.codegraph/resolve/` is created during the skill, removed automatically on any error exit (via `trap`), and removed after a successful push. If a crash left both `.codegraph/resolve/` stale **and** an in-progress merge (MERGE_HEAD), run `git merge --abort && rm -rf .codegraph/resolve` before re-running — Phase 0 will detect the leftover MERGE_HEAD and remind you.

