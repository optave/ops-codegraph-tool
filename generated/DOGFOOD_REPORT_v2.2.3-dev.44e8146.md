# Dogfooding Report: @optave/codegraph@2.2.3-dev.44e8146

**Date:** 2026-02-23
**Platform:** Windows 11 Pro 10.0.26200, x64 (MINGW64)
**Node.js:** v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@2.2.3-dev.44e8146
**Active engine:** native (v0.1.0)
**Target repo:** codegraph itself (92 files, 2 languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@2.2.3-dev.44e8146` | PASS — 207 packages, 0 vulnerabilities |
| `npx codegraph --version` | `2.2.3-dev.44e8146` |
| Native binary package | `@optave/codegraph-win32-x64-msvc@2.2.3-dev.44e8146` |
| `codegraph info` engine | `native (v0.1.0)` |
| `optionalDependencies` version match | All 4 platform packages pinned to `2.2.3-dev.44e8146` |
| `require('@optave/codegraph/package.json')` | **BUG** — `ERR_PACKAGE_PATH_NOT_EXPORTED` (filed #78, fixed in PR #79) |

**Note:** 2 npm deprecation warnings for `prebuild-install` and `boolean` — not codegraph issues (upstream `better-sqlite3` deps).

---

## 2. Cold Start (Pre-Build)

All commands tested without a `.codegraph/graph.db` in the working directory:

| Command | Result | Notes |
|---------|--------|-------|
| `stats` | PASS | Graceful "No codegraph database" message |
| `map` | PASS | Graceful error |
| `deps src/builder.js` | PASS | Graceful error |
| `fn buildGraph` | PASS | Graceful error |
| `fn-impact buildGraph` | PASS | Graceful error |
| `context buildGraph` | PASS | Graceful error |
| `explain src/builder.js` | PASS | Graceful error |
| `where buildGraph` | PASS | Graceful error |
| `diff-impact` | PASS | Graceful error |
| `search "query"` | PASS | Graceful error |
| `structure` | PASS | Graceful error |
| `hotspots` | PASS | Graceful error |
| `models` | PASS | Lists models (no DB needed) |
| `registry list` | PASS | Lists repos (no DB needed) |
| `info` | PASS | Shows diagnostics |
| `--version` | PASS | `2.2.3-dev.44e8146` |
| **`cycles`** | **BUG** | Stack trace: `TypeError: Cannot open database because the directory does not exist` |
| **`export`** | **BUG** | Same stack trace |
| **`embed`** | **BUG** | Same stack trace |

**Root cause:** `cycles`, `export`, and `embed` bypassed the `openReadonlyOrFail()` guard. Filed as #77, fixed in PR #79.

---

## 3. Full Command Sweep

### Build
```
npx codegraph build <repo> --verbose
Engine: native (v0.1.0)
Files: 92, Nodes: 530, Edges: 719 (reported as 823 in stats due to structure edges)
```

### Query Commands

| Command | Status | Notes |
|---------|--------|-------|
| `query buildGraph` | PASS | Shows callers/callees |
| `query buildGraph --json` | PASS | Valid JSON |
| `query buildGraph -T` | PASS | Filtered from 30 to 16 callees |
| `impact src/builder.js` | PASS | 3 transitive dependents |
| `map --limit 10` | PASS | Top files with coupling scores |
| `map --json` | PASS | Valid JSON |
| `stats` | PASS | 530 nodes, 823 edges, quality 82/100 |
| `stats --json` | PASS | Full JSON with quality metrics |
| `stats -T` | PASS | Filters to 403 nodes, 59 files |
| `deps src/builder.js` | PASS | 7 imports, 3 importers, 10 definitions |
| `fn buildGraph -T` | PASS | 16 callees, 1 caller |
| `fn buildGraph --depth 2 -T` | PASS | Deep traversal |
| `fn buildGraph --kind function -T` | PASS | Kind filter works |
| `fn-impact buildGraph -T` | PASS | 1 transitive dependent |
| `context buildGraph -T` | PASS | Source, params, deps, callers |
| `context buildGraph -T --no-source` | PASS | Metadata only with summaries |
| `explain src/builder.js` | PASS | File-level summary |
| `explain buildGraph` | PASS | Function-level summary |
| `where buildGraph` | PASS | Definition + usage |
| `where -f src/builder.js` | PASS | File overview mode |
| `diff-impact main` | PASS | No function changes on this branch |
| `diff-impact --staged` | PASS | "No changes detected" |
| `diff-impact main --format mermaid` | PASS | Mermaid flowchart output |
| `cycles` | PASS | 1 file-level cycle |
| `cycles --functions` | PASS | 2 function-level cycles |
| `structure` | PASS | 18 directories with metrics |
| `structure .` | PASS | Works (v2.2.0 bug fixed) |
| `structure --depth 1` | PASS | Truncated to top level |
| `structure --sort cohesion` | PASS | Sorted by cohesion |
| `structure --json` | PASS | Valid JSON |
| `hotspots` | PASS | By fan-in |
| `hotspots --metric fan-out --level directory` | PASS | Directory-level |
| `hotspots --metric density --json` | PASS | Valid JSON |
| `export -f dot` | PASS | Graphviz output |
| `export -f mermaid` | PASS | Mermaid graph |
| `export -f json` | PASS | Valid JSON |
| `export --functions -f dot` | PASS | Function-level graph |
| `models` | PASS | 7 models listed |
| `embed --model minilm` | PASS | 395 embeddings, 384d |
| `search "build dependency graph"` | PASS | Results with scores |
| `search "parse file; extract functions"` | PASS | Multi-query RRF |
| `search --kind method` | PASS | Kind filter |
| `search --file "builder"` | PASS | File pattern filter |
| `search (no embeddings)` | PASS | "No embeddings found" message |
| `registry list` | PASS | Lists registered repos |
| `registry list --json` | PASS | Valid JSON |
| `registry add` | PASS | Registers repo |
| `registry remove` | PASS | Removes entry |
| `registry prune --ttl 0` | PASS | Prunes all expired |
| `watch` | PASS | Starts, watches, exits on Ctrl+C |
| `info` | PASS | Full diagnostics |

### Edge Cases

| Scenario | Result | Notes |
|----------|--------|-------|
| Non-existent symbol: `query nonexistent` | PASS | "No results" message |
| Non-existent file: `deps nonexistent.js` | PASS | "No file matching" message |
| Non-existent function: `fn nonexistent` | PASS | "No function/method/class matching" |
| Invalid kind: `--kind invalidkind` | PASS | "Invalid kind" with valid list |
| `--json` on all supporting commands | PASS | Valid JSON output |
| `--no-tests` effect | PASS | 503→403 nodes, 92→59 files |
| Pipe output: `map --json` | PASS | Clean JSON, no status messages |
| `search` with no embeddings | PASS | "No embeddings found" warning |

---

## 4. Rebuild & Staleness

### Incremental Rebuilds

| Scenario | Result | Notes |
|----------|--------|-------|
| No-op rebuild (no changes) | PASS | "Graph is up to date" — 0 files reparsed |
| Touch file (mtime change, same content) | PASS | Tier 1 detects 1 file, Tier 2 self-heals (hash unchanged) |
| Full rebuild `--no-incremental` | PASS | 530 nodes, 719 edges — identical to initial build |
| Node/edge count stability | PASS | All counts match across rebuilds |

### Three-Tier Change Detection

Working correctly:
- **Tier 0 (journal):** Skipped when no journal entries
- **Tier 1 (mtime+size):** Correctly identifies files needing hash check
- **Tier 2 (content hash):** Self-heals metadata for unchanged files

### Embed-Rebuild-Search Pipeline

| Scenario | Result | Notes |
|----------|--------|-------|
| Embed → search | PASS | Results returned |
| Embed → no-op rebuild → search | PASS | Embeddings survive |
| Embed → full rebuild → search | PASS | Embeddings cleared, "No embeddings found" |
| Delete DB → rebuild → search | PASS | Clean state, no stale data |

---

## 5. Engine Comparison

### Build Metrics

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Files parsed | 92 | 92 | 0 |
| Nodes | 530 | 530 | 0 |
| Edges (build output) | 719 | 719 | 0 |
| Edges (stats) | 823 | 823 | 0 |
| Call edges | 582 | 582 | 0 |
| Functions | 345 | 345 | 0 |
| Methods | 49 | 49 | 0 |
| Structs | 23 | 23 | 0 |
| Quality score | 82 | 82 | 0 |
| Caller coverage | 55.6% | 55.6% | 0 |
| Call confidence | 99.3% | 99.3% | 0 |

**Perfect parity.** Zero differences across all metrics.

### Per-Query Comparison

| Query | Native | WASM | Match |
|-------|--------|------|-------|
| `fn buildGraph -T` | 15 callees, 2 callers | 15 callees, 2 callers | YES |
| `cycles --functions` | 2 cycles (same members) | 2 cycles (same members) | YES |

---

## 6. Release-Specific Tests

Changes since v2.2.0 (48 commits):

| Feature/Fix | Test | Result |
|-------------|------|--------|
| `perf: reduce WASM boundary crossings` | Engine parity maintained | PASS |
| `fix: handle concurrent file edits and symlink loops` | Touch-and-rebuild | PASS |
| `fix: use busy-wait sleep instead of Atomics.wait` | Build completes without errors | PASS |
| `feat: add Mermaid output to diff-impact` | `diff-impact --format mermaid` | PASS |
| `feat: add /dogfood skill` | Running this session | PASS |
| `fix: change default embedding model to nomic-v1.5` | Config shows `nomic-v1.5` default | PASS |
| `fix: track mv/git mv/cp commands in session edit log` | Hooks infrastructure | N/A (hooks) |
| `fix: use PR instead of direct push for green-path` | CI workflow change | N/A (CI) |

---

## 7. Additional Testing

### MCP Server

| Test | Result | Notes |
|------|--------|-------|
| Single-repo mode: `tools/list` | PASS | 16 tools, no `list_repos`, no `repo` params |
| Multi-repo mode: `tools/list` | PASS | 17 tools, `list_repos` present |
| JSON-RPC `initialize` | PASS | Protocol version 2024-11-05 |

### Programmatic API

All exports verified present and correct type:

| Export | Type | Notes |
|--------|------|-------|
| `buildGraph` | function | |
| `loadConfig` | function | |
| `openDb` | function | |
| `findDbPath` | function | |
| `contextData` | function | |
| `explainData` | function | |
| `whereData` | function | |
| `fnDepsData` | function | |
| `diffImpactData` | function | |
| `statsData` | function | |
| `isNativeAvailable` | function | Returns `true` on this platform |
| `EXTENSIONS` | Set (15 entries) | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.tf`, `.hcl`, `.py`, `.go`, etc. |
| `IGNORE_DIRS` | Set (16 entries) | `node_modules`, `.git`, `dist`, `build`, etc. |
| `ALL_SYMBOL_KINDS` | Array (10 entries) | All valid symbol kinds |
| `MODELS` | Object (7 models) | `minilm`, `jina-small`, `jina-base`, `jina-code`, `nomic`, `nomic-v1.5`, `bge-large` |

### Config & Env Vars

| Test | Result |
|------|--------|
| `.codegraphrc.json` overrides `query.defaultDepth` | PASS |
| `.codegraphrc.json` overrides `search.defaultMinScore` | PASS |
| `CODEGRAPH_LLM_PROVIDER` env var | PASS |
| `CODEGRAPH_LLM_MODEL` env var | PASS |
| `apiKeyCommand` credential resolution | PASS — `echo test-key` returns `test-key` |

### Multi-Repo Registry Flow

| Step | Result |
|------|--------|
| `registry add . --name dogfood-test` | PASS |
| `registry list --json` | PASS — entry present |
| `registry remove dogfood-test` | PASS |
| `registry prune --ttl 0` | PASS — clears all expired |

---

## 8. Bugs Found

### BUG 1: `cycles`, `export`, `embed` crash without graph.db (Medium)
- **Issue:** [#77](https://github.com/optave/codegraph/issues/77)
- **PR:** [#79](https://github.com/optave/codegraph/pull/79)
- **Symptoms:** Running `codegraph cycles`, `codegraph export`, or `codegraph embed` without a graph.db produces a `TypeError: Cannot open database because the directory does not exist` stack trace instead of the graceful error message other commands show.
- **Root cause:** These three command handlers used `new Database(findDbPath(opts.db))` directly instead of the `openReadonlyOrFail()` helper that checks for DB existence first.
- **Fix applied:** Replaced `new Database(findDbPath(opts.db), { readonly: true })` with `openReadonlyOrFail(opts.db)` in cli.js for `export` and `cycles`. Added `fs.existsSync()` guard in `buildEmbeddings()` since it needs write access (can't use `openReadonlyOrFail`). Removed unused `Database` and `findDbPath` imports.

### BUG 2: `package.json` not in exports map (Low)
- **Issue:** [#78](https://github.com/optave/codegraph/issues/78)
- **PR:** [#79](https://github.com/optave/codegraph/pull/79)
- **Symptoms:** `require('@optave/codegraph/package.json')` throws `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- **Root cause:** The `exports` field in `package.json` only maps `"."` and doesn't include `"./package.json"`.
- **Fix applied:** Added `"./package.json": "./package.json"` to the exports map.

---

## 9. Suggestions for Improvement

### 9.1 Add `--json` flag to `search` command
The `search` command lacks `--json` output. Every other query command supports it, so this inconsistency is surprising for programmatic users.

### 9.2 Vitest should exclude worktree directories
`npm test` picks up test files from `.claude/worktrees/`, causing failures in worktree copies that lack WASM grammars. The vitest config should exclude `.claude/**` from test discovery.

### 9.3 `search --file` should support glob patterns
`search --file "src/*.js"` returned 0 results while `search --file "builder"` worked. The `--file` flag is substring-only, but glob patterns would be more intuitive and consistent with other tools.

### 9.4 Consider adding `--exclude-worktrees` or similar to `registry prune`
`registry prune --ttl 0` removes all entries including the main project, which can be surprising. A flag to preserve specific entries would help.

---

## 10. Testing Plan

### General Testing Plan (Any Release)

- [ ] Install from npm, verify `--version` and `codegraph info`
- [ ] Verify native binary matches package version
- [ ] Test all commands without graph.db (graceful errors)
- [ ] Build graph, verify node/edge/file counts
- [ ] Test all query commands with `-T`, `--json`, and default flags
- [ ] Test edge cases: non-existent symbols, files, invalid kinds
- [ ] Test incremental rebuild (no-op, touch, modify, full)
- [ ] Test embed → rebuild → search pipeline
- [ ] Compare native vs WASM engine parity
- [ ] Test MCP server (single-repo and multi-repo modes)
- [ ] Verify programmatic API exports
- [ ] Test config overrides and env vars
- [ ] Test registry CRUD operations
- [ ] Run `npm test` and `npm run lint`

### Release-Specific Testing Plan (v2.2.3-dev.44e8146)

- [x] WASM boundary crossing optimization doesn't break engine parity
- [x] Concurrent file edit handling works (touch-and-rebuild)
- [x] Mermaid output for `diff-impact` works
- [x] Default embedding model is `nomic-v1.5` (not `jina-code`)
- [x] Dogfood skill runs successfully

### Proposed Additional Tests

- **Database migration:** Test upgrading from older graph.db formats (v1→v4)
- **Large repo:** Test on a repo with 1000+ files for performance
- **Concurrent builds:** Two `build` commands at once
- **Watch + query:** Start `watch`, modify file, query to verify live update
- **Model mismatch:** Embed with `minilm`, then `search --model nomic` — should warn about dimension mismatch
- **Config `excludeTests` default:** Set in `.codegraphrc.json`, verify all commands respect it

---

## 11. Overall Assessment

v2.2.3-dev.44e8146 is a solid incremental release. The core functionality — parsing, graph building, querying, impact analysis, and engine parity — all work correctly. The native/WASM parity is **perfect** (zero differences across all metrics), which is impressive.

The two bugs found are both in error handling paths, not core functionality:
1. Three commands crash instead of showing a helpful message when no graph exists
2. `package.json` missing from exports map

Both have straightforward fixes (PR #79 submitted). No data corruption, no wrong results, no security issues.

The three-tier incremental change detection works well, correctly handling mtime-only changes vs actual content changes. The embed-rebuild-search pipeline is clean — full rebuilds properly clear stale embeddings.

**Rating: 8/10**

Deductions:
- -1 for three commands crashing on cold start (medium severity, easy to hit)
- -0.5 for missing `--json` on search command (inconsistency)
- -0.5 for vitest picking up worktree tests (dev experience issue)

Positives:
- Perfect engine parity
- Clean incremental builds with three-tier detection
- All 16 MCP tools work in single-repo mode, 17 in multi-repo
- Comprehensive programmatic API
- Config and env var overrides work correctly
- Graceful error handling on most commands

---

## 12. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#77](https://github.com/optave/codegraph/issues/77) | bug: cycles, export, embed crash without graph.db | Open — fix in PR #79 |
| Issue | [#78](https://github.com/optave/codegraph/issues/78) | bug: package.json not in exports map | Open — fix in PR #79 |
| PR | [#79](https://github.com/optave/codegraph/pull/79) | fix(cli): graceful error for cycles, export, embed when no graph.db exists | Open |
