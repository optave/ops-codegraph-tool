# Dogfood Report — codegraph v2.1.0

**Date:** 2026-02-23
**Platform:** Windows 11 Pro (win32-x64), Node v22.18.0
**Native binary:** `@optave/codegraph-win32-x64-msvc` 2.1.0
**Active engine:** native v0.1.0 (auto-detected)
**Target repo:** codegraph itself (92 files, JS + Rust)

---

## 1. Test Summary

| Area | Result |
|------|--------|
| `npm install` | OK — native binary + WASM grammars built successfully |
| `npm test` | **494 passed**, 5 skipped, 0 failures |
| `npm run lint` | Clean — no issues |
| Native engine build | 500 nodes, 724 edges |
| WASM engine build | 527 nodes, 699 edges |
| Incremental rebuild (no changes) | Correctly detected "Graph is up to date" |

---

## 2. Commands Tested

All 22 CLI commands were exercised against the codegraph codebase:

| Command | Status | Notes |
|---------|--------|-------|
| `build .` | OK | Both `--engine native` and `--engine wasm` |
| `build .` (incremental) | OK | Correctly skips unchanged files |
| `map` | OK | |
| `stats` | OK | |
| `cycles` | OK | 0 file-level, 2 function-level |
| `deps <file>` | OK | |
| `impact <file>` | OK | |
| `fn <name>` | OK | |
| `fn-impact <name>` | OK | |
| `context <name>` | OK | Full source + deps + callers + tests |
| `explain <file>` | OK | Data flow analysis is very useful |
| `explain <function>` | OK | |
| `where <name>` | OK | |
| `diff-impact main` | OK | 56 functions changed, 31 callers affected |
| `export --format dot` | OK | |
| `export --format mermaid` | OK | |
| `export --format json` | OK | |
| `structure` | OK | 18 directories, cohesion scores |
| `hotspots` | OK | |
| `models` | OK | 7 models listed |
| `info` | OK | Correctly reports native engine |
| `--version` | OK | `2.1.0` |

### Edge cases tested

| Scenario | Result |
|----------|--------|
| Non-existent symbol (`query nonexistent`) | Graceful message: "No results for..." |
| Non-existent file (`deps nonexistent.js`) | Graceful message: "No file matching..." |
| Non-existent symbol (`fn nonexistent`) | Graceful message: "No function/method/class..." |
| `--json` flag on all supporting commands | Correct JSON output |
| `--no-tests` on fn, fn-impact, context, explain, where, diff-impact | Correctly filters test files |
| `--file` filter on fn | Correctly scopes results |

---

## 3. Bugs Found & Fixed

### BUG: `--no-tests` flag missing on `map`, `deps`, `impact`, `hotspots`, `stats`, `query` CLI commands

**Severity:** Medium
**Commit reference:** `ec158c3` claims to add `--no-tests` to these commands, but the CLI option was never wired up.

**Symptoms:**
- `codegraph map --no-tests` → `error: unknown option '--no-tests'`
- `codegraph deps <file> --no-tests` → `error: unknown option '--no-tests'`
- `codegraph impact <file> --no-tests` → `error: unknown option '--no-tests'`
- `codegraph hotspots --no-tests` → `error: unknown option '--no-tests'`
- `codegraph stats --no-tests` → `error: unknown option '--no-tests'`
- `codegraph query <name> --no-tests` → `error: unknown option '--no-tests'`

**Root cause:** The underlying data functions (`moduleMapData`, `fileDepsData`, `impactAnalysisData`, `hotspotsData`) all accept a `noTests` option and implement filtering, but the Commander CLI option definitions in `cli.js` were never updated to add `-T, --no-tests` and pass it through. Additionally, `queryNameData` and `statsData` lacked `noTests` support entirely.

**Fix:**
- Added `-T, --no-tests` option and `noTests: !opts.tests` passthrough to all six commands in `cli.js`
- Added `noTests` filtering to `queryNameData` (nodes, callees, callers) and `statsData` (file list, hotspots)
- Added `no_tests` schema property and handler passthrough to MCP tools: `query_function`, `file_deps`, `impact_analysis`, `module_map`
- Standardized all `--no-tests` help text to `'Exclude test/spec files from results'`

**Verification:**
- `deps src/builder.js --no-tests` → "Imported by" drops from 5 to 1 (filters 4 test files)
- `impact src/parser.js --no-tests` → Total drops from 30 to 8 files
- `stats --no-tests` → File count drops from 92 to 59
- `query buildGraph --no-tests` → Test callers filtered out
- All 494 tests still pass after fix

### BUG: guard-git hook doesn't validate branch names on `gh pr create`

**Severity:** Low
**Symptom:** PR #46 was created with branch `worktree-dogfood-testing` which failed the CI branch name check.

**Root cause:** The hook only validated on `git push`, not `gh pr create`. Also, commands prefixed with `cd "..." &&` (standard in worktree sessions) didn't match the `^\s*git\s+` pattern.

**Fix:** Extended the hook to validate on both `git push` and `gh pr create`, and updated all patterns to match commands after `cd` prefixes.

---

## 4. Observations

### 4.1 Engine Parity Gap (Native vs WASM)

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Nodes | 500 | 527 | +27 (+5.4%) |
| Edges | 724 | 699 | -25 (-3.5%) |
| Functions | 315 | 342 | +27 |
| Call edges | 591 | 566 | -25 |
| Call confidence | 96.8% | 99.3% | +2.5pp |
| Graph quality | 83/100 | 82/100 | -1 |

The native engine extracts 27 fewer function symbols but resolves 25 more call edges. This suggests the native engine may be merging/deduplicating some symbols while being better at call-site resolution. The WASM engine has higher confidence (99.3% vs 96.8%) but lower caller coverage (55.5% vs 60.4%).

**Recommendation:** The parity test (`build-parity.test.js`) exists but only checks a small fixture. Consider adding a snapshot test on a larger fixture (or the codegraph repo itself) to track parity drift between engines.

### 4.2 `structure` Cohesion of 0.00 for Test Directories

All test directories show `cohesion=0.00`, which is technically correct (tests import source, not each other) but may alarm users who don't understand the metric. Consider hiding cohesion for test directories or adding a note.

---

## 5. Suggestions for Improvement

### 5.1 UX: Default `--no-tests` in Config — IMPLEMENTED

Many codebases have large test directories. A `.codegraphrc.json` option like `"excludeTests": true` would let users default to production-only views:
```json
{
  "excludeTests": true
}
```
This would save typing `-T` on every command while still allowing `--include-tests` to override.

**Implementation:** Added `query.excludeTests` to config defaults (`config.js`). CLI loads config at startup and uses a `resolveNoTests()` helper: `--include-tests` flag always overrides to include, `-T` always excludes, otherwise falls back to config value. All commands with `--no-tests` now also accept `--include-tests`.

### 5.2 UX: `map` Could Show Coupling Score — IMPLEMENTED

The `map` command shows fan-in/fan-out bars, but doesn't show the actual coupling score (in+out combined). The `stats` command shows "Top 5 coupling hotspots" — `map` could integrate this as a column since it already has the data.

**Implementation:** Added `coupling` field (in+out) to `moduleMapData` and display as `=NNN` column in `map` output.

### 5.3 UX: `explain` Is the Most Useful Command for AI Workflows — IMPLEMENTED

The `explain` command produces the most AI-agent-friendly output — structured sections (exports, internals, data flow) that give an LLM exactly the context it needs. Consider:
- Making it the default recommendation in the README for AI workflows
- Adding a `--depth` option to recursively explain dependencies

**Implementation:** Added `--depth <n>` option (default 0) to the `explain` command. When depth > 0 on a function target, recursively explains each callee's structure (callees, callers, signature, tests) up to N levels deep with cycle-safe visited tracking. Works with both text and JSON output.

### 5.4 Performance: Status Messages to stderr — IMPLEMENTED

The native engine still prints "Using native engine" to stdout, which pollutes piped output. Consider using `process.stderr.write` for status messages, keeping stdout clean for actual data output.

**Implementation:** Replaced all `console.log` status messages in `builder.js` with `info()` from the logger (which writes to stderr).

### 5.5 UX: `--no-tests` Help Text Consistency — ALREADY DONE

All commands now use `'Exclude test/spec files from results'` after this fix. Future commands should follow the same wording.

---

## 6. Overall Assessment

Codegraph v2.1.0 on Windows x64 with the native engine is **solid**. All 22 commands work correctly, edge cases are handled gracefully, the test suite is comprehensive (494 tests), and the native binary installs cleanly as an optional dependency.

The bugs found (missing `--no-tests` wiring on 6 CLI commands + 4 MCP tools, hook not catching `gh pr create`) are fixed in this PR. All 5 suggestions from section 5 have been implemented. The engine parity gap is the most significant technical observation — worth tracking but not blocking since both engines produce usable graphs.

**Rating: 9/10** — Production-ready with minor consistency issues. All suggestions addressed.

