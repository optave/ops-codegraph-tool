---
name: release
description: Prepare a codegraph release — update CHANGELOG, ROADMAP, BACKLOG, README, create PR
argument-hint: "[version e.g. 3.1.1]  (optional — auto-detects from commits)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# Release

You are preparing a release for `@optave/codegraph`.

**Version argument:** `$ARGUMENTS`
- If a version was provided (e.g. `3.1.1`), use it as the target version.
- If no version was provided (empty or blank `$ARGUMENTS`), you will auto-detect it in Step 1b.

**Important: this skill does NOT bump versions.** The publish workflow (`publish.yml`) handles version bumping in `package.json`, `Cargo.toml`, `package-lock.json`, and `optionalDependencies` atomically — after building native binaries and publishing to npm. Bumping versions in the release PR would cause CI failures because the native prebuilt binary wouldn't exist at the new version yet.

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
   Do **not** create the `release/VERSION` branch here — Step 7 creates it once VERSION is known.

## Step 1a: Gather context

Run these in parallel:
1. `git log --oneline v<previous-tag>..HEAD` — all commits since the last release tag (use `git describe --tags --match "v*" --abbrev=0` to find the previous tag)
2. Read `CHANGELOG.md` (first 80 lines) — understand the format
3. Read `package.json` — current version
4. `git describe --tags --match "v*" --abbrev=0` — find the previous stable release tag

## Step 1b: Determine version (if not provided)

If `$ARGUMENTS` is empty or blank, determine the semver bump from the commits gathered in Step 1a.

**The conventional commit prefix (`feat:`, `fix:`, `perf:`, etc.) is a hint, not the verdict.** Contributors frequently use `feat(scope):` for internal refactors, perf improvements, or extractor/engine accuracy fixes that don't actually add any user-facing feature. The version bump is determined by **what users observe**, not by the commit prefix.

### The real test for a minor bump

A commit only counts as **minor** if a user running codegraph could observe a genuinely new capability — specifically, one of:

1. **A new CLI command** (new top-level subcommand registered in `cli.ts`)
2. **A new CLI flag** on an existing command that unlocks behavior previously unavailable
3. **A new MCP tool** (new entry in the MCP tool list)
4. **A new output format / field** (new JSON schema field, new export format, new column in table output)
5. **A new configuration option** (new `.codegraphrc.json` field that changes behavior)
6. **A new public programmatic API export** from `index.ts`

Things that are **NOT minor bumps** even if prefixed `feat:`:
- Extractor/parser accuracy improvements ("resolve named function references", "track class instantiation") — these make existing queries more accurate but add no new CLI surface. Classify as **Bug Fixes** in the CHANGELOG.
- Native/engine performance refactors ("port X to Rust", "move Y to native") — these are perf improvements. Classify as **Performance**.
- Internal plumbing changes (build pipeline, DB schema migrations, cache tuning) — patch.

### Decision procedure

Scan every commit between the last tag and HEAD. For each `feat:` or `feat(scope):` commit:

1. Read the PR body (`gh pr view <N> --json title,body`) or the commit body
2. Ask: *does this add a new command, flag, MCP tool, output format, config option, or public API export that didn't exist before?*
3. If yes → counts toward minor
4. If no → treat as patch (and re-categorize in the CHANGELOG: accuracy → Bug Fixes, speed → Performance, internals → Chores)

Apply these rules in priority order:

| Condition | Bump |
|-----------|------|
| Any commit has a `BREAKING CHANGE:` / `BREAKING-CHANGE:` footer, or uses `!` suffix (`feat!:`, `fix!:`, etc.) | **major** |
| Any `feat:` commit passes the "real test" above (adds new CLI command/flag/MCP tool/output field/config/public API export) | **minor** |
| Everything else — including `feat:` commits that are really accuracy fixes, perf refactors, or internal plumbing | **patch** |

Given the current version `MAJOR.MINOR.PATCH` from `package.json`, compute the new version:
- **major** → `(MAJOR+1).0.0`
- **minor** → `MAJOR.(MINOR+1).0`
- **patch** → `MAJOR.MINOR.(PATCH+1)`

### Before committing to the bump

When the detection lands on **minor**, state the specific new CLI surface before proceeding — e.g.:

> Detected **minor** bump. New user-facing surface:
> - New CLI command: `codegraph trends` ([#920](...))
> - New `--architecture` flag on `codegraph check` ([#925](...))
>
> Version: 3.9.3 → **3.10.0**

If you cannot name a specific new command/flag/tool/output/config/public API export, the bump is **patch**, not minor. Example:

> Detected **patch** bump. The `feat(js-extractor)` commit ([#947](...)) is an extractor accuracy improvement — it adds edges but no new CLI surface. The `feat(native)` commit ([#937](...)) is a perf refactor — no new commands or flags. Both belong under Bug Fixes / Performance in the CHANGELOG.
>
> Version: 3.9.3 → **3.9.4**

Use the resolved version as `VERSION` for all subsequent steps.

If `$ARGUMENTS` was provided, use it directly as `VERSION`.

## Step 2: Update CHANGELOG.md

The CHANGELOG doubles as **release notes** — it's what users see on the GitHub release page. Write it for humans, not machines.

Add a new section at the top (below the header) following the existing format:

```
## [X.Y.Z](https://github.com/optave/ops-codegraph-tool/compare/vPREVIOUS...vX.Y.Z) (YYYY-MM-DD)

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

## Step 3: Update ROADMAP.md

Read `docs/roadmap/ROADMAP.md` and update:
1. **Version header** — update `Current version: X.Y.Z`
2. **Phase status table** — if any phase moved from Planned to In Progress (or completed), update the status column
3. **Task-level progress** — for any roadmap tasks that have been completed or partially completed by commits in this release:
   - Add a progress note with version and PR links
   - Add checklist items: `- ✅` for done, `- 🔲` for remaining
   - Check actual code exists (glob/grep for new files/directories mentioned in PRs) before marking tasks complete

## Step 4: Update BACKLOG.md

Read `docs/roadmap/BACKLOG.md` and check if any backlog items were completed or partially completed by commits in this release.

- Backlog items are organized into tiers (1, 1b–1g, 2, 3) with an ID, title, and description per row
- Completed items are marked with strikethrough title (`~~Title~~`) and a `**DONE**` suffix with a description of what was shipped and PR links
- If a feature in this release matches a backlog item:
  - Strike through the title: `~~Title~~`
  - Add `**DONE** — description of what shipped (PR links)` at the end of the row
  - Check the "Depends on" column of other items — if they depended on the newly completed item, note that they are now unblocked
- Update the `Last updated` date at the top of the file

## Step 5: Update README.md

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

## Step 6: Verify `libc` fields in package-lock.json

Some npm versions (notably v11+) silently strip the `libc` field from Linux entries in `package-lock.json`. Without `libc`, npm may install glibc binaries on musl systems (Alpine) and vice versa.

Even though this skill does not bump versions, check that `libc` fields are present — they can go missing after any `npm install` run:

```bash
grep -A12 'codegraph-linux' package-lock.json | grep -c libc
# Expected: ≥3 (one each for linux-arm64-gnu, linux-x64-gnu, linux-x64-musl)
```

If the count is less than 3, restore the missing fields in a separate commit:
- `-gnu` packages: `"libc": ["glibc"]`
- `-musl` packages: `"libc": ["musl"]`

Place the `libc` array after the `cpu` array in each entry.

## Step 7: Create branch, commit, push, PR

1. Create branch: `git checkout -b release/VERSION` (if on detached HEAD from Step 0, this creates the branch at the current commit)
2. Stage only the files you changed: `CHANGELOG.md`, `docs/roadmap/ROADMAP.md`, `docs/roadmap/BACKLOG.md` if changed, `README.md` if changed, `package-lock.json` if libc fields were fixed
3. Commit: `docs: prepare release notes for vVERSION`
4. Push: `git push -u origin release/VERSION`
5. Create PR:

```
gh pr create --title "docs: prepare release notes for vVERSION" --body "$(cat <<'EOF'
## Summary
- Add CHANGELOG entry for vVERSION (all commits since previous release)
- Update ROADMAP progress

**After merging:** create a GitHub Release with tag `vVERSION` to trigger the publish workflow, which handles version bumping, native binary builds, and npm publishing.

## Test plan
- [ ] CHANGELOG renders correctly on GitHub
- [ ] ROADMAP checklist items match actual codebase state
EOF
)"
```

## Step 8: Post-merge instructions

After the PR is merged, remind the user:

> **Next step:** Go to GitHub → Releases → "Draft a new release" → tag `vVERSION` → target `main` → title `vVERSION` → auto-generate release notes or paste the CHANGELOG section → Publish.
>
> This triggers the publish workflow which will:
> 1. Build native binaries for all 6 platforms with the correct version
> 2. Publish platform packages and main package to npm
> 3. Push a version bump PR (`package.json`, `Cargo.toml`, `package-lock.json`) back to main

## Important reminders

- **No version bumps in this PR** — the publish workflow handles `package.json`, `Cargo.toml`, `package-lock.json`, and `optionalDependencies` atomically after building native binaries
- **No co-author lines** in commit messages
- **No Claude Code references** in commit messages or PR descriptions
- If you find `libc` field issues in package-lock.json, fix them in a separate commit with a descriptive message
