---
name: dogfood
description: Run a full dogfooding session against a published codegraph release — install from npm, test all commands, compare engines, find bugs, and write a report
argument-hint: <version>
allowed-tools: Bash, Read, Write, Glob, Grep, Task, Edit
---

# Dogfooding Session for @optave/codegraph@$ARGUMENTS

You are running a comprehensive dogfooding session for codegraph **v$ARGUMENTS**.
Your goal is to install the published package, exercise every feature, compare engines, find bugs, and produce a structured report.

> **Reference:** Read `generated/DOGFOOD-REPORT-2.1.0.md` and `generated/DOGFOOD_REPORT_v2.2.0.md` (if present) for the format and depth expected. Match or exceed that quality.

---

## Phase 0 — Setup

1. Create a **temporary working directory** (e.g., `/tmp/dogfood-$ARGUMENTS` or a system temp).
2. Run `npm init -y` there, then `npm install @optave/codegraph@$ARGUMENTS`.
3. Verify the install: `npx codegraph --version` should print `$ARGUMENTS`.
4. **Verify the native binary installed.** The native Rust addon is delivered as a platform-specific optional dependency. Check that the correct one exists:
   ```bash
   ls node_modules/@optave/codegraph-*/
   ```
   Expected packages by platform:
   - Windows x64: `@optave/codegraph-win32-x64-msvc`
   - macOS ARM: `@optave/codegraph-darwin-arm64`
   - macOS x64: `@optave/codegraph-darwin-x64`
   - Linux x64: `@optave/codegraph-linux-x64-gnu`

   If the native package is **missing** or a different version than `$ARGUMENTS`, file it as a bug — the `optionalDependencies` in `package.json` may have a pinned version mismatch. Verify by checking:
   ```bash
   node -e "const p = require('@optave/codegraph/package.json'); console.log(p.optionalDependencies)"
   ```
   Then confirm the native engine actually loads:
   ```bash
   npx codegraph info
   ```
   This should report `engine: native`. If it falls back to `wasm`, record why.
5. Record: platform, OS version, Node version, native binary package name + version, engine reported by `info`.
6. **Do NOT rebuild the graph yet.** The first phase tests commands against the codegraph source repo without a pre-existing graph.

---

## Phase 1 — Cold Start (No Graph)

Using the installed binary (`npx codegraph` from the temp dir, pointed at the codegraph source repo):

1. **Self-discover all commands:** Run `npx codegraph --help` and extract every command and subcommand (including `registry list|add|remove|prune`).
2. Run each command **before** running `build`. Record which ones:
   - Fail gracefully with a helpful message (PASS)
   - Crash with a stack trace (BUG)
   - Silently return empty/wrong results without warning (BUG)
3. Then run `npx codegraph build <path-to-codegraph-repo>` and record: file count, node count, edge count, time taken, engine used.

---

## Phase 2 — Full Command Sweep

After the graph is built, exercise **every** command and subcommand. Discover the list from `--help` but use this reference to ensure thorough flag coverage:

### Query commands
Test each with `-j`/`--json` and `-T`/`--no-tests` where supported:

| Command | Key flags to exercise |
|---------|----------------------|
| `query <name>` | `--depth <n>`, `--db <path>` |
| `impact <file>` | |
| `map` | `-n/--limit <number>` |
| `stats` | |
| `deps <file>` | |
| `fn <name>` | `--depth <n>`, `-f/--file <path>`, `-k/--kind <kind>` |
| `fn-impact <name>` | `--depth <n>`, `-f/--file`, `-k/--kind` |
| `context <name>` | `--depth <n>`, `-f/--file`, `-k/--kind`, `--no-source`, `--include-tests` |
| `explain <target>` | test with both a file path and a function name |
| `where <name>` | also test `where -f <file>` for file-overview mode |
| `diff-impact [ref]` | `--staged`, test vs `main`, vs `HEAD`, and with no arg (unstaged) |
| `cycles` | `--functions` for function-level cycles |
| `structure [dir]` | `--depth <n>`, `--sort cohesion\|fan-in\|fan-out\|density\|files` |
| `hotspots` | `--metric fan-in\|fan-out\|density\|coupling`, `--level file\|directory`, `-n/--limit` |

### Export commands
| Command | Flags |
|---------|-------|
| `export` | `-f dot`, `-f mermaid`, `-f json`, `--functions`, `-o <file>` |

### Embedding & search
| Command | Flags |
|---------|-------|
| `models` | (no flags) |
| `embed [dir]` | `-m minilm` (use this — `jina-code` default requires HF auth) |
| `search <query>` | `-n/--limit`, `--min-score`, `-k/--kind`, `--file <pattern>`, multi-query with `;` separator, `--rrf-k` |

### Infrastructure commands
| Command | Flags |
|---------|-------|
| `info` | |
| `--version` | |
| `watch [dir]` | start, verify it detects a file change, then Ctrl+C |
| `registry list` | `-j/--json` |
| `registry add <dir>` | `-n/--name <custom>` |
| `registry remove <name>` | |
| `registry prune` | `--ttl <days>` |
| `mcp` | initialize via JSON-RPC stdin, verify tool list response |

### Edge cases to test
| Scenario | Expected |
|----------|----------|
| Non-existent symbol: `query nonexistent` | Graceful "No results" message |
| Non-existent file: `deps nonexistent.js` | Graceful "No file matching" message |
| Non-existent function: `fn nonexistent` | Graceful message |
| `structure .` | Should work (was a bug in v2.2.0 — verify fix) |
| `--json` on every command that supports it | Valid JSON output |
| `--no-tests` effect: compare counts with/without | Test file count should drop |
| `--kind` with invalid kind | Graceful error or ignored |
| `--verbose` on `build` | Should show per-file parsing details |
| `build --no-incremental` | Force full rebuild |
| `search` with no embeddings | Should warn, not crash |
| `embed` then `search` with dimension mismatch model | Should warn about mismatch |
| Pipe output: `codegraph map --json \| head -1` | Clean JSON, no status messages in stdout |

---

## Phase 3 — Rebuild & Staleness Testing

Test that incremental rebuilds, full rebuilds, and cross-feature state remain consistent. Codegraph uses three-tier change detection: journal → mtime+size → content hash.

1. **Incremental no-op:** Run `build` again with no file changes. It should report "Graph is up to date" and touch nothing. Verify node/edge counts are identical.
2. **Incremental with change:** Touch or slightly modify one source file, run `build` again. Verify with `--verbose`:
   - Only the changed file is re-parsed
   - Node IDs for unchanged symbols remain stable
   - Edge counts are consistent
   - The journal (`.codegraph/` directory) tracks the change
3. **Force full rebuild:** Run `build --no-incremental`. Compare node/edge counts with the incremental result — they should match exactly.
4. **Embed then rebuild:** Run `embed --model minilm`, then run `build` again (even with no changes). After the rebuild:
   - Run `search "build graph"` — do results still return? If embeddings reference stale node IDs, search will return 0 results
   - Compare embedding `node_id`s against actual node IDs in the graph (use `--json` outputs)
5. **Embed, modify, rebuild, search:** Modify a file, `build` again (incremental), then `search` without re-running `embed`. This is the most likely path to stale embeddings. Record whether results are correct, empty, or wrong.
6. **Full rebuild after incremental:** Delete `.codegraph/graph.db`, rebuild from scratch, then verify `search` still works (it shouldn't — embeddings should be gone too, or the tool should warn).
7. **Watch mode integration:** Start `watch`, modify a file in another terminal, verify the watcher detects the change and incrementally updates (check output). Then run a query to verify the graph reflects the change. Stop the watcher with Ctrl+C and verify graceful shutdown (journal flush).
8. Revert any file modifications before continuing.

---

## Phase 4 — Engine Comparison

1. Build with `--engine wasm`: record nodes, edges, time.
2. Build with `--engine native`: record nodes, edges, time.
3. Compare in a table: node count, edge count, function count, call edges, call confidence (from `stats`), graph quality score.
4. Note any significant parity gaps (>5% difference in any metric).
5. Run the same set of queries with both engines and flag any result differences:
   - `fn buildGraph` — compare callers/callees
   - `context parseFileAuto` — compare source extraction
   - `cycles --functions` — compare cycle detection
   - `stats --json` — full metric comparison
   - `hotspots --metric fan-in --json` — compare rankings

---

## Phase 5 — Changes Since Last Release

1. Read `CHANGELOG.md` to identify what changed in v$ARGUMENTS vs the previous version.
2. Read `package.json` for the previous version tag.
3. For **every feature added and bug fixed** in this release, write a targeted test:
   - Verify the feature works as described
   - Verify the bug is actually fixed
   - Try to break it with edge cases
4. Present results in a "Release-Specific Tests" table.

---

## Phase 6 — Thinking Space

Before writing the report, **stop and think** about:

- What testing approaches am I missing?
- **Cross-command pipelines:** Have I tested `build` → `embed` → `search` → modify → `build` → `search`? Have I tested `watch` detecting changes then `diff-impact`?
- **MCP server:** Have I tested the `mcp` command? Initialize via JSON-RPC on stdin, send `tools/list`, verify all 17 tools are present. Test single-repo mode (default — `list_repos` should be absent, no `repo` parameter on tools) vs `--multi-repo` mode.
- **Programmatic API:** Have I tested `require('@optave/codegraph')` or `import` from `index.js`? Key exports to verify: `buildGraph`, `loadConfig`, `openDb`, `findDbPath`, `contextData`, `explainData`, `whereData`, `fnDepsData`, `diffImpactData`, `statsData`, `isNativeAvailable`, `EXTENSIONS`, `IGNORE_DIRS`, `ALL_SYMBOL_KINDS`, `MODELS`.
- **Config options:** Have I tested `.codegraphrc.json`? Create one with `include`/`exclude` patterns, custom `aliases`, `build.incremental: false`, `query.defaultDepth`, `search.defaultMinScore`. Verify overrides work.
- **Env var overrides:** `CODEGRAPH_LLM_PROVIDER`, `CODEGRAPH_LLM_API_KEY`, `CODEGRAPH_LLM_MODEL`, `CODEGRAPH_REGISTRY_PATH`.
- **Credential resolution:** `apiKeyCommand` in config — does it shell out via `execFileSync` correctly? Test with a simple `echo` command.
- **Multi-repo registry flow:** `registry add .`, `registry list`, `mcp --repos <name>`, `registry remove <name>`, `registry prune --ttl 0`.
- **Concurrent usage:** Two builds at once, build while watching.
- **Different repo:** Have I tested on a repo besides codegraph itself? Try a small open-source project.
- **False positive filtering:** Does `stats` report false positives? Are `FALSE_POSITIVE_NAMES` (run, get, set, init, main, etc.) filtered from high-caller warnings?
- **Symbol kinds:** Test `--kind` with all valid kinds: function, method, class, interface, type, struct, enum, trait, record, module.
- **Database migrations:** If testing an upgrade path (older graph.db → new version), do schema migrations (v1→v4) run correctly?
- What would a real user hit that I haven't simulated?

Add any additional tests you identify here and run them before writing the final report.

---

## Phase 7 — File Bugs & Fix

For each bug found during testing:

### 7a. Check for duplicates

```bash
gh issue list --repo optave/codegraph --state open --search "<bug title keywords>"
```

If a matching issue already exists, skip creating a new one. Add a comment with your findings if you have new information.

### 7b. Open an issue

For each **new** bug, create a GitHub issue:

```bash
gh issue create --repo optave/codegraph \
  --title "bug: <concise title>" \
  --label "bug,dogfood" \
  --body "$(cat <<'ISSUE_EOF'
## Found during dogfooding v$ARGUMENTS

**Severity:** <Critical | High | Medium | Low>
**Command:** `codegraph <command that failed>`

## Reproduction

\`\`\`bash
<exact commands to reproduce>
\`\`\`

## Expected behavior

<what should happen>

## Actual behavior

<what actually happens — include output/stack traces>

## Root cause

<analysis if known>

## Suggested fix

<approach if known>
ISSUE_EOF
)"
```

Record the issue number for each bug.

### 7c. Fix and submit PRs

For each bug you can fix in this session:

1. Create a branch: `git checkout -b fix/dogfood-<short-description> main`
2. Implement the fix.
3. Run `npm test` to verify no regressions.
4. Run `npm run lint` to verify code style.
5. Commit with a message referencing the issue:
   ```
   fix(<scope>): <description>

   Closes #<issue-number>
   ```
   The `Closes #N` footer tells GitHub to auto-close the issue when the PR merges.
6. Push and open a PR:
   ```bash
   gh pr create --base main \
     --title "fix(<scope>): <description>" \
     --body "$(cat <<'PR_EOF'
   ## Summary
   <what was wrong and how this fixes it>

   ## Found during
   Dogfooding v$ARGUMENTS — see #<issue-number>

   ## Test plan
   - [ ] <how to verify the fix>
   PR_EOF
   )"
   ```
7. Return to the main working branch before continuing to the next bug.

If a bug is too complex to fix in this session, leave the issue open and note it in the report.

### 7d. Green path — no bugs found

If the entire dogfooding session finds **zero bugs**, the release is validated. Update the native binary version pins in the main repository to match:

1. In the codegraph repo (not the temp dir), edit `package.json` `optionalDependencies` to pin all `@optave/codegraph-*` packages to `$ARGUMENTS`.
2. Run `npm install` to update the lockfile.
3. Create a PR to update the native binary pins:
   ```bash
   git checkout -b chore/pin-native-binaries-v$ARGUMENTS main
   git add package.json package-lock.json
   git commit -m "chore: pin native binaries to v$ARGUMENTS after clean dogfood"
   gh pr create --base main \
     --title "chore: pin native binaries to v$ARGUMENTS" \
     --body "Validated in dogfooding session — zero bugs found."
   ```

This signals that v$ARGUMENTS has been manually verified end-to-end.

---

## Phase 8 — Cleanup

1. Delete the temporary directory.
2. Confirm no artifacts were left behind.

---

## Phase 9 — Report

Write the report to `generated/DOGFOOD_REPORT_v$ARGUMENTS.md` with this structure:

```markdown
# Dogfooding Report: @optave/codegraph@$ARGUMENTS

**Date:** <today>
**Platform:** <OS, arch, Node version>
**Native binary:** <package name and version, or "not available">
**Active engine:** <auto-detected engine>
**Target repo:** codegraph itself (<file count> files)

---

## 1. Setup & Installation
<Install results, native binary verification, any issues>

## 2. Cold Start (Pre-Build)
<Table of commands tested without a graph>

## 3. Full Command Sweep
<Table: Command | Status | Notes>

### Edge Cases Tested
<Table: Scenario | Result>

## 4. Rebuild & Staleness
<Incremental rebuild results>
<Embed-rebuild-search pipeline results>
<Watch mode results>

## 5. Engine Comparison
<Table: Metric | Native | WASM | Delta>
<Analysis of parity gaps>
<Per-query comparison results>

## 6. Release-Specific Tests
<What changed in this version>
<Table: Feature/Fix | Test | Result>

## 7. Additional Testing
<MCP server testing results>
<Programmatic API testing results>
<Config/env var testing results>
<Multi-repo registry testing results>
<Any other tests from Phase 6 thinking space>

## 8. Bugs Found
### BUG 1: <title> (<severity>)
- **Issue:** #<number> (link)
- **PR:** #<number> (link) or "open — too complex for this session"
- **Symptoms:**
- **Root cause:**
- **Fix applied:**

## 9. Suggestions for Improvement
### 9.1 <suggestion>
### 9.2 <suggestion>

## 10. Testing Plan

### General Testing Plan (Any Release)
<Checklist of standard tests every release should pass>

### Release-Specific Testing Plan (v$ARGUMENTS)
<Focused checklist based on CHANGELOG changes>

### Proposed Additional Tests
<Tests you thought of in Phase 6 that should be added to future dogfooding>

## 11. Overall Assessment
<Summary paragraph>
<Rating: X/10 with justification>

## 12. Issues & PRs Created
| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | #N | ... | open / closed via PR |
| PR | #N | ... | open / merged |
```

---

## Phase 10 — Commit the Report

The dogfood report **must** be committed to the repository — do not leave it as an untracked file.

1. **If bug-fix PRs were created during Phase 7:** Add the report to the **first** PR's branch:
   ```bash
   git checkout <first-pr-branch>
   git add generated/DOGFOOD_REPORT_v$ARGUMENTS.md
   git commit -m "docs: add dogfood report for v$ARGUMENTS"
   git push
   ```

2. **If no PRs were created** (zero bugs / green path): Create a dedicated PR for the report:
   ```bash
   git checkout -b docs/dogfood-report-v$ARGUMENTS main
   git add generated/DOGFOOD_REPORT_v$ARGUMENTS.md
   git commit -m "docs: add dogfood report for v$ARGUMENTS"
   git push -u origin docs/dogfood-report-v$ARGUMENTS
   gh pr create --base main \
     --title "docs: add dogfood report for v$ARGUMENTS" \
     --body "Dogfooding report for v$ARGUMENTS. See generated/DOGFOOD_REPORT_v$ARGUMENTS.md for full details."
   ```

3. **Verify** the report file appears in the PR diff before moving on.

---

## Rules

- Be thorough but honest. Don't inflate the rating.
- If codegraph crashes or produces wrong results when analyzing itself, **file it as a bug** — don't work around it.
- Report the raw truth. A dogfood report that finds 0 bugs is suspicious.
- Include exact command invocations and outputs for any bugs found.
- The report should be useful to a developer who wasn't in the session.

## Self-Improvement

This skill lives at `.claude/skills/dogfood/SKILL.md` in the codegraph repo. If during the dogfooding session you discover that this skill is missing steps, has outdated command references, or could be improved — **you are encouraged to edit it**. Fix inaccuracies, add missing test cases, update flag lists, and improve the phase instructions so the next dogfood run benefits from what you learned. Commit any skill improvements alongside the dogfood report.
