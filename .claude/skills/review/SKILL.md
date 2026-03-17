---
name: review
description: Check all open PRs, resolve conflicts, update branches, address Claude and Greptile review concerns, fix CI failures, and retrigger reviewers until clean
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# PR Review Sweep

You are performing a full review sweep across all open PRs in this repository. Your goal is to bring every PR to a clean, mergeable state: no conflicts, CI passing, all reviewer comments addressed, and reviewers re-triggered until satisfied.

---

## Step 0: Worktree Isolation

Before doing anything else, run `/worktree` to get an isolated copy of the repo. CLAUDE.md mandates that every session starts with `/worktree` to prevent cross-session interference. All subsequent steps run inside the worktree.

---

## Step 1: Discover Open PRs

```bash
gh pr list --repo optave/codegraph --state open --json number,title,headRefName,baseRefName,mergeable,statusCheckRollup,reviewDecision --limit 50
```

Record each PR's number, branch, base, merge status, and CI state.

---

## Step 2: Process Each PR

For **each** open PR, perform the following steps in order. Process PRs one at a time to avoid cross-contamination.

### 2a. Switch to the PR branch

Ensure the working tree is clean before switching to avoid cross-PR contamination:

```bash
if [ -n "$(git status --porcelain)" ]; then
  git stash push -m "pre-checkout stash"
fi
```

Then check out the PR branch:

```bash
gh pr checkout <number>
```

### 2b. Resolve merge conflicts

Check if the PR has conflicts with its base branch:

```bash
gh pr view <number> --json mergeable --jq '.mergeable'
```

If `CONFLICTING`:

1. Merge the base branch into the head branch (never rebase):
   ```bash
   git merge origin/<base-branch>
   ```
2. **Do not assume which side to keep.** You must fully understand the context of both sides before resolving. If you don't know why a line was added — what feature it supports, what bug it fixes, what reviewer requested it — you cannot resolve the conflict correctly. Before touching any conflict:
   - Read the PR description and any linked issues (`gh pr view <number>`) to understand the PR's purpose and scope.
   - Check the PR's commit history (`git log --oneline origin/<base-branch>..HEAD -- <file>`) to understand *why* the conflicting line was changed on the PR side. Also check the base branch history (`git log --oneline HEAD..origin/<base-branch> -- <file>`) to understand *why* the base version exists.
   - Read Greptile and Claude review comments on the PR (`gh api repos/optave/codegraph/pulls/<number>/comments`, `gh api repos/optave/codegraph/issues/<number>/comments`) — a reviewer may have requested the change that caused the conflict.
   - Check what landed on main that introduced the other side (`git log --oneline HEAD..origin/<base-branch> -- <file>`) and read those PR descriptions too if needed.
   - Compare the PR's diff against its merge base (`git diff $(git merge-base origin/<base-branch> HEAD) HEAD -- <file>`) to see which side introduced an intentional change vs. which side carried stale code.
   - Only then choose the correct resolution. If the PR deliberately changed a line and main still has the old version, keep the PR's version. If main introduced a fix or new feature the PR doesn't have, keep main's version. If both sides made intentional changes, merge them together manually.
3. After resolving, stage the resolved files by name (not `git add .`), commit with: `fix: resolve merge conflicts with <base-branch>`
4. Push the updated branch.

### 2c. Check CI status

```bash
gh pr checks <number>
```

If any checks are failing:

1. Read the failing check logs:
   ```bash
   gh run view <run-id> --log-failed
   ```
2. Diagnose the failure — read the relevant source files, understand the error.
3. Fix the issue in code.
4. Run tests locally to verify: `npm test`
5. Run lint locally: `npm run lint`
6. Commit the fix with a descriptive message: `fix: <what was broken and why>`
7. Push and wait for CI to re-run. Check again:
   ```bash
   gh pr checks <number>
   ```
8. Repeat until CI is green.

### 2d. Gather all review comments

Fetch **all** review comments from both Claude and Greptile:

```bash
# PR review comments (inline code comments)
gh api repos/optave/codegraph/pulls/<number>/comments --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, path: .path, line: .line, created_at: .created_at}'

# PR reviews (top-level review bodies)
gh api repos/optave/codegraph/pulls/<number>/reviews --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, state: .state}'

# Issue-style comments (includes @greptileai trigger responses)
gh api repos/optave/codegraph/issues/<number>/comments --paginate --jq '.[] | {id: .id, user: .user.login, body: .body, created_at: .created_at}'
```

### 2e. Address every comment

For **each** review comment — including minor suggestions, nits, style feedback, and optional improvements:

1. **Read the comment carefully.** Understand what the reviewer is asking for.
2. **Read the relevant code** at the file and line referenced.
3. **Make the change.** Even if the comment is marked as "nit" or "suggestion" or "minor" — address it. The goal is zero outstanding comments.
4. **If you disagree** with a suggestion (e.g., it would introduce a bug or contradicts project conventions), do NOT silently ignore it. Reply to the comment explaining why you chose a different approach.
5. **Reply to each comment** explaining what you did:
   ```bash
   gh api repos/optave/codegraph/pulls/<number>/comments/<comment-id>/replies \
     -f body="Fixed — <brief description of what was changed>"
   ```
   For issue-style comments, reply on the issue:
   ```bash
   gh api repos/optave/codegraph/issues/<number>/comments \
     -f body="Addressed: <summary of changes made>"
   ```

### 2f. Commit and push fixes

After addressing all comments for a PR:

1. Stage only the files you changed.
2. Group changes by concern — each logically distinct fix gets its own commit (e.g., one commit for a missing validation, another for a naming change). Do not lump all feedback into a single commit.
3. Use descriptive messages per commit: `fix: <what this specific change does> (#<number>)`
4. Push to the PR branch.

### 2g. Re-trigger reviewers

**Greptile:** Always re-trigger after pushing fixes. Post a comment:

```bash
gh api repos/optave/codegraph/issues/<number>/comments \
  -f body="@greptileai"
```

**Claude (claude-code-review / claude bot):** Only re-trigger if you addressed something Claude specifically suggested. If you did:

```bash
gh api repos/optave/codegraph/issues/<number>/comments \
  -f body="@claude"
```

If all changes were only in response to Greptile feedback, do NOT re-trigger Claude.

### 2h. Wait and re-check

After re-triggering:

1. Wait for the new reviews to come in (check after a reasonable interval).
2. Fetch new comments again (repeat Step 2d).
3. If there are **new** comments from Greptile or Claude, go back to Step 2e and address them.
4. **Repeat this loop for a maximum of 3 rounds.** If after 3 rounds there are still actionable comments, mark the PR as "needs human review" in the summary table and move to the next PR.
5. Verify CI is still green after all changes.

---

## Step 3: Summary

After processing all PRs, output a summary table:

```
| PR | Branch | Conflicts | CI | Comments Addressed | Reviewers Re-triggered | Status |
|----|--------|-----------|----|--------------------|----------------------|--------|
| #N | branch | resolved/none | green/red | N comments | greptile, claude | ready/needs-work |
```

---

## Rules

- **Never rebase.** Always `git merge <base>` to resolve conflicts.
- **Never force-push** unless fixing a commit message that fails commitlint. Amend + force-push is the only way to fix a pushed commit title (messages are part of the SHA). This is safe on feature branches. For all other problems, fix with a new commit.
- **Address ALL comments**, even minor/nit/optional ones. Leave zero unaddressed.
- **Always reply to comments** explaining what was done. Don't just fix silently.
- **Always re-trigger Greptile** after pushing fixes — it must confirm satisfaction.
- **Only re-trigger Claude** if you addressed Claude's feedback specifically.
- **No co-author lines** in commit messages.
- **No Claude Code references** in commit messages or comments.
- **Run tests and lint locally** before pushing any fix.
- **One concern per commit** — don't lump conflict resolution with code fixes.
- **Flag scope creep.** If a PR's diff contains files unrelated to its stated purpose (e.g., a docs PR carrying `src/` or test changes from a merged feature branch), flag it immediately. Split the unrelated changes into a separate branch and PR. Do not proceed with review until the PR is scoped correctly — scope creep is not acceptable.
- If a PR is fundamentally broken beyond what review feedback can fix, note it in the summary and skip to the next PR.
