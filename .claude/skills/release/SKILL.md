---
name: release
description: Prepare a codegraph release — bump versions, update CHANGELOG, ROADMAP, BACKLOG, README, create PR
argument-hint: "[version e.g. 3.1.1]  (optional — auto-detects from commits)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Release

You are preparing a release for `@optave/codegraph`.

**Version argument:** `$ARGUMENTS`
- If a version was provided (e.g. `3.1.1`), use it as the target version.
- If no version was provided (empty or blank `$ARGUMENTS`), you will auto-detect it in Step 1b.

---

## Step 0: Isolate and sync

1. **Create a worktree** — run `/worktree` to get an isolated copy of the repo. All subsequent steps run inside the worktree.
2. **Sync with main** — fetch origin and check how far behind the current branch is:
   ```bash
   git fetch origin
   git rev-list --count HEAD..origin/main
   ```
   If the count is > 0 (behind main), detach to `origin/main` so all subsequent work starts from the latest main:
   ```bash
   git checkout origin/main
   ```
   Do **not** create the `release/VERSION` branch here — Step 8 creates it once VERSION is known.

## Step 1a: Gather context

Run these in parallel:
1. `git log --oneline v<previous-tag>..HEAD` — all commits since the last release tag (use `git describe --tags --match "v*" --abbrev=0` to find the previous tag)
2. Read `CHANGELOG.md` (first 80 lines) — understand the format
3. Read `package.json` — current version
4. `git describe --tags --match "v*" --abbrev=0` — find the previous stable release tag

## Step 1b: Determine version (if not provided)

If `$ARGUMENTS` is empty or blank, determine the semver bump from the commits gathered in Step 1a.

Scan **every commit message** between the last tag and HEAD. Apply these rules in priority order:

| Condition | Bump |
|-----------|------|
| Any commit has a `BREAKING CHANGE:` or `BREAKING-CHANGE:` footer, **or** uses the `!` suffix (e.g. `feat!:`, `fix!:`, `refactor!:`) | **major** |
| Any `feat:` commit **or** any `feat(scope):` where the scope is **not** in the internal list below | **minor** |
| Everything else (`fix:`, `refactor:`, `perf:`, `chore:`, `docs:`, `test:`, `ci:`, etc.) | **patch** |

**Internal scopes — treat as patch, not minor:** The following scopes represent internal developer tooling and infrastructure, not user-facing features. A `feat:` commit with one of these scopes counts as a **patch**, not a minor bump:

`architect`, `bench`, `ci`, `claude`, `deps-audit`, `dogfood`, `hooks`, `housekeep`, `release`, `skills`, `sweep`, `test-health`, `titan`

For example, `feat(titan): first full pipeline run` is internal tooling — patch. But `feat(cfg): control-flow graph generation` is user-facing — minor.

Given the current version `MAJOR.MINOR.PATCH` from `package.json`, compute the new version:
- **major** → `(MAJOR+1).0.0`
- **minor** → `MAJOR.(MINOR+1).0`
- **patch** → `MAJOR.MINOR.(PATCH+1)`

Print the detected bump reason and the resolved version, e.g.:
> Detected **minor** bump (found `feat:` commits). Version: 3.1.0 → **3.2.0**

> Detected **patch** bump (all `feat` commits use internal scopes: `titan`, `skills`). Version: 3.4.0 → **3.4.1**

Use the resolved version as `VERSION` for all subsequent steps.

If `$ARGUMENTS` was provided, use it directly as `VERSION`.

## Step 2: Bump version in package.json

Edit `package.json` to set `"version": "VERSION"`.

Also bump `crates/codegraph-core/Cargo.toml` — set the `version` field in `[package]` to match `VERSION`. This keeps the Rust crate version in sync with the npm package.

**Do NOT bump:**
- `optionalDependencies` versions — synced automatically by `scripts/sync-native-versions.js` during the publish workflow

Then run `npm install --package-lock-only` to update `package-lock.json`.

## Step 3: Update CHANGELOG.md

The CHANGELOG doubles as **release notes** — it's what users see on the GitHub release page. Write it for humans, not machines.

Add a new section at the top (below the header) following the existing format:

```
## [X.Y.Z](https://github.com/optave/codegraph/compare/vPREVIOUS...vX.Y.Z) (YYYY-MM-DD)

**One-line summary.** Expanded description of the release highlights — what's new, what's better, what's fixed. This paragraph should tell a user whether they should upgrade and why.

### Features
* **scope:** description ([#PR](url))

### Bug Fixes
* **scope:** description ([#PR](url))

### Performance
* **scope:** description ([#PR](url))

### Refactors
* description ([#PR](url))

### Chores
* **scope:** description ([#PR](url))
```

Rules:
- **Write for users, not developers.** Describe what changed from the user's perspective, not the implementation details. "MCP server connects reliably on first attempt" beats "defer heavy imports in MCP server"
- The bold summary paragraph at the top is the most important part — it's the TL;DR that appears in release notifications
- Categorize every commit since the last tag (skip docs-only and benchmark-only commits unless they're notable)
- Use the conventional commit scope as the bold prefix
- Link every PR number
- Include a Performance section if there are performance improvements
- Read previous CHANGELOG entries to match the tone and detail level

## Step 4: Update ROADMAP.md

Read `docs/roadmap/ROADMAP.md` and update:
1. **Version header** — update `Current version: X.Y.Z`
2. **Phase status table** — if any phase moved from Planned to In Progress (or completed), update the status column
3. **Task-level progress** — for any roadmap tasks that have been completed or partially completed by commits in this release:
   - Add a progress note with version and PR links
   - Add checklist items: `- ✅` for done, `- 🔲` for remaining
   - Check actual code exists (glob/grep for new files/directories mentioned in PRs) before marking tasks complete

## Step 5: Update BACKLOG.md

Read `docs/roadmap/BACKLOG.md` and check if any backlog items were completed or partially completed by commits in this release.

- Backlog items are organized into tiers (1, 1b–1g, 2, 3) with an ID, title, and description per row
- Completed items are marked with strikethrough title (`~~Title~~`) and a `**DONE**` suffix with a description of what was shipped and PR links
- If a feature in this release matches a backlog item:
  - Strike through the title: `~~Title~~`
  - Add `**DONE** — description of what shipped (PR links)` at the end of the row
  - Check the "Depends on" column of other items — if they depended on the newly completed item, note that they are now unblocked
- Update the `Last updated` date at the top of the file

## Step 6: Update README.md

Read `README.md` and check if any new user-facing features from this release need to be documented:

1. **Commands table** — if a new CLI command was added, add it to the commands section
2. **MCP tools table** — if new MCP tools were added, add them to the AI integration section
3. **Feature descriptions** — if a major new capability was added (new analysis type, new output format, etc.), add it to the relevant section
4. **Roadmap section** — if a phase status changed, update the roadmap summary at the bottom
5. **Roadmap ordering cross-check** — verify the README roadmap list matches `docs/roadmap/ROADMAP.md` in **phase order, phase names, and phase count**. ROADMAP.md is the source of truth. Specifically:
   - Extract the phase sequence from both files
   - If any phases are reordered, missing, renamed, or merged in README relative to ROADMAP.md, fix README to match
   - Completed phases should keep their historical version markers (e.g., "Complete (v3.0.0)")
   - This check runs every release, not only when phase status changes — drift accumulates silently
6. **Version references** — only update version-specific references (e.g., install commands). Historical milestone markers like "Complete (v3.0.0)" should stay as-is
7. If nothing user-facing changed (pure refactors, bug fixes, internal improvements), no README update is needed — **but still run the roadmap ordering cross-check (item 5)**

## Step 7: Verify package-lock.json

Run `grep` to confirm the new version appears in `package-lock.json` and that all `@optave/codegraph-*` optional dependency entries are complete (have version, resolved, integrity, cpu, os fields). Flag any incomplete entries — they indicate an unpublished platform binary.

**Critical: verify `libc` fields on Linux entries.** Some npm versions (notably v11+) silently strip the `libc` field when regenerating the lock file via `npm install --package-lock-only`. Without `libc`, npm may install glibc binaries on musl systems (Alpine) and vice versa. Check:

```bash
grep -A12 'codegraph-linux' package-lock.json | grep -c libc
# Expected: 3 (one each for linux-arm64-gnu, linux-x64-gnu, linux-x64-musl)
```

If the count is less than 3, manually restore the missing fields:
- `-gnu` packages: `"libc": ["glibc"]`
- `-musl` packages: `"libc": ["musl"]`

Place the `libc` array after the `cpu` array in each entry.

## Step 8: Create branch, commit, push, PR

1. Create branch: `git checkout -b release/VERSION` (if on detached HEAD from Step 0, this creates the branch at the current commit)
2. Stage only the files you changed: `CHANGELOG.md`, `package.json`, `package-lock.json`, `docs/roadmap/ROADMAP.md`, `docs/roadmap/BACKLOG.md` if changed, `README.md` if changed
3. Commit: `chore: release vVERSION`
4. Push: `git push -u origin release/VERSION`
5. Create PR:

```
gh pr create --title "chore: release vVERSION" --body "$(cat <<'EOF'
## Summary
- Bump version to VERSION
- Add CHANGELOG entry for all commits since previous release
- Update ROADMAP progress

## Test plan
- [ ] `npm install` succeeds with updated lock file
- [ ] CHANGELOG renders correctly on GitHub
- [ ] ROADMAP checklist items match actual codebase state
EOF
)"
```

## Important reminders

- **No co-author lines** in commit messages
- **No Claude Code references** in commit messages or PR descriptions
- The publish workflow (`publish.yml`) handles: optionalDependencies version sync, npm publishing, git tagging, and the post-publish version bump PR
- If you find issues (incomplete lock entries, phantom packages), fix them in a separate commit with a descriptive message
