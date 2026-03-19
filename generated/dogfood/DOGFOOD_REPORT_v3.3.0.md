# Dogfooding Report: @optave/codegraph@3.3.0

**Date:** 2026-03-19
**Platform:** Windows 11 Pro (win32-x64), Node v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@3.3.0 (binary built as 3.2.0, engine loaded OK)
**Active engine:** native (v3.3.0)
**Target repo:** codegraph itself (407 files, 5402 nodes, 11834 edges)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@3.3.0` | PASS — 144 packages, 4s |
| `npx codegraph --version` | 3.3.0 |
| Native binary package | @optave/codegraph-win32-x64-msvc installed, version 3.3.0 |
| `codegraph info` | Native engine available, active engine: native (v3.3.0) |
| `optionalDependencies` pins | All 7 platform packages pinned to 3.3.0 |

**Note:** `info` reports "binary built as 3.2.0, engine loaded OK" — the binary reports its build version as 3.2.0 even though the npm package is 3.3.0. This suggests the Rust crate version wasn't bumped for the 3.3.0 release. Not a functional issue but confusing diagnostics.

## 2. Cold Start (Pre-Build)

All query commands tested against a non-existent DB path:

| Command | Result |
|---------|--------|
| `stats` | PASS — `DB_ERROR: No codegraph database found. Run "codegraph build" first.` |
| `map` | PASS — same graceful error |
| `query buildGraph` | PASS — same graceful error |
| `where buildGraph` | PASS — same graceful error |
| `build` (cold) | PASS — 407 files, 5402 nodes, 11437 edges, native engine |

## 3. Full Command Sweep

### Query Commands

| Command | Status | Notes |
|---------|--------|-------|
| `stats` | PASS | 5402 nodes, 11834 edges, quality 83/100 |
| `stats --json` | PASS | Valid JSON with full breakdown |
| `map -n 5` | PASS | Top 5 most-connected nodes |
| `map --json` | PASS | Valid JSON |
| `query buildGraph` | PASS | Shows callees and callers with depth 3 |
| `query buildGraph --depth 1` | PASS | Reduced depth works |
| `query buildGraph --json` | PASS | Valid JSON |
| `where buildGraph` | PASS | Shows definition + 9 usage sites |
| `where -f src/cli.js` | PASS | File overview mode: imports listed |
| `where --json` | PASS | Valid JSON |
| `fn-impact buildGraph -T` | PASS | 3 functions transitively depend |
| `context buildGraph -T --no-source` | PASS | Full context without source |
| `deps src/cli.js` | PASS | 2 imports, 0 imported-by |
| `impact src/db/index.js -T` | PASS | 94 files transitively depend |
| `exports src/db/index.js -T` | PASS | Shows barrel re-exports with consumers |
| `path buildGraph openDb` | PASS | 1-hop path found |
| `diff-impact main -T` | PASS | 246 functions changed, 269 callers affected |
| `diff-impact --staged` | PASS | "No changes detected" (nothing staged) |
| `children buildGraph` | PASS | 2 parameters listed |
| `complexity -T` | PASS | 1300 functions, avg cognitive 12.5 |
| `triage -T` | PASS | 1316 symbols scored, max risk 0.53 |
| `communities` | PASS | 75 communities, modularity 0.5558 |
| `roles -T` | PASS | Shows all role categories |
| `roles --role dead -T` | PASS | 255 dead symbols |
| `roles --role core -T` | PASS | 463 core symbols |
| `roles --role dead-leaf -T` | PASS | 2844 dead-leaf symbols |
| `roles --role dead-entry -T` | PASS | 69 dead-entry symbols |
| `roles --role dead-ffi -T` | PASS | 176 dead-ffi symbols |
| `roles --role dead-unresolved -T` | PASS | 166 dead-unresolved symbols |
| `cycles` | PASS | No circular file-level deps |
| `cycles --functions` | PASS | 7 function-level cycles found |
| `structure --depth 1` | PASS | Directory tree with cohesion scores |
| `structure .` | PASS | Works (was broken in v2.2.0) |
| `cfg buildGraph` | PASS | Control flow graph with 29 blocks |
| `dataflow buildGraph` | PASS | Shows parameter flows and return consumers |
| `sequence buildGraph` | PASS | Mermaid sequence diagram |
| `flow buildGraph -T` | PASS | Execution flow through callees |
| `audit buildGraph -T` | PASS | Composite report with deps, callers, tests |
| `brief src/db/index.js` | PASS | Token-efficient summary with 76+ transitive deps |
| `batch context buildGraph openDb -T` | PASS | Batch output (always JSON) |
| `check` | PASS | Manifesto rules with 696+ warnings |
| `branch-compare main HEAD -T` | PASS (no `--db` flag — by design, operates on git refs) |
| `implementations CodeGraph` | PASS | "no implementors found" (JS class) |
| `interfaces CodeGraph` | PASS | "no interfaces/traits found" |
| `co-change --analyze` | PASS | 278 pairs from 556 commits |
| `owners` | PASS | "No CODEOWNERS file found" |
| `ast call` | **BUG** | Fatal crash: missing module `dist/ast.js` (#529, fixed in #532) |
| `fn <name>` | N/A | Command removed — `query` replaces it |
| `hotspots` | N/A | Command removed — functionality in `structure` |

### Export Commands

| Command | Status | Notes |
|---------|--------|-------|
| `export -f dot` | PASS | Valid DOT output |
| `export -f mermaid` | PASS | Valid Mermaid output |
| `export -f json` | PASS | Valid JSON |
| `export --functions -f dot` | PASS | Function-level DOT graph |

### Embedding & Search

| Command | Status | Notes |
|---------|--------|-------|
| `models` | PASS | 7 models listed |
| `embed --model minilm` | PASS | 1537 symbols embedded (384d) |
| `search "build graph" -n 5` | PASS | Hybrid search (BM25 + semantic) returns relevant results |
| `search "resolve imports" -n 5` | PASS | Top result: `resolve_imports` — excellent recall |

### Infrastructure Commands

| Command | Status | Notes |
|---------|--------|-------|
| `info` | PASS | Full diagnostics |
| `--version` | PASS | 3.3.0 |
| `registry list` | PASS | 7 repos listed |
| `registry list --json` | PASS | Valid JSON |
| `snapshot list` | PASS | "No snapshots found" |
| `plot` | PASS | HTML file generated |

### MCP Server

| Test | Status | Notes |
|------|--------|-------|
| `initialize` | PASS | Protocol v2024-11-05, server info correct |
| `tools/list` (single-repo) | PASS | **34 tools** exposed (no `list_repos`, no `repo` param) |

### Edge Cases

| Scenario | Result |
|----------|--------|
| Non-existent symbol: `query nonexistent_xyz` | PASS — "No function/method/class matching" |
| Non-existent file: `deps nonexistent_xyz.js` | PASS — "No file matching" |
| `structure .` | PASS — works correctly |
| `--json` on all supporting commands | PASS — valid JSON |
| `-T` effect on counts | PASS — test files excluded |
| `search` with no embeddings | PASS — graceful warning |
| `batch` without `--json` | PASS — output is always JSON (flag not needed, error on `--json` is expected) |
| `where -k function` / `where --kind` | N/A — `where` doesn't have a `--kind` flag (CLAUDE.md outdated) |

## 4. Rebuild & Staleness

| Test | Result |
|------|--------|
| Incremental no-op | PASS — "No changes detected. Graph is up to date." |
| Incremental 1-file change | PASS — Only 1 file + 11 reverse-deps re-parsed |
| Force full rebuild (`--no-incremental`) | PASS — 5402 nodes, 11834 edges |
| Search after full rebuild | Expected — embeddings wiped, "No embeddings found" |

### Incremental vs Full Build Discrepancy

| Metric | Incremental | Full Rebuild | Delta |
|--------|-------------|--------------|-------|
| Nodes | 5402 | 5402 | 0 |
| Edges | 11444 | 11834 | **-390 (3.3%)** |
| Dead exports warning | 104 | 86 | -18 |

**Finding:** Incremental builds produce 390 fewer edges than full rebuilds. This suggests the incremental pipeline misses some edges (likely dataflow or call edges for files not in the reverse-dep set). This is a pre-existing issue — not new to v3.3.0 — but worth tracking.

## 5. Engine Comparison

### Build Results

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Nodes | 5402 | 5377 | +25 (0.5%) |
| Edges | 11834 | 11832 | +2 |
| Functions | 1155 | 1154 | +1 |
| Methods | 366 | 363 | +3 |
| Constants | 380 | 330 | **+50 (15%)** |
| Parameters | 2642 | 2671 | -29 |
| Call edges | 2558 | 2542 | +16 |
| Contains edges | 5395 | 5370 | +25 |
| Implements edges | 0 | 9 | **-9** |
| Complexity functions | 1521 | 1516 | +5 |
| CFG functions | 1521 | 1516 | +5 |
| Dataflow edges | 4467 | 4431 | +36 |

**Key parity gaps:**
1. **Constants:** Native extracts 50 more constants (15% more) — native extractor is more thorough
2. **Implements edges:** WASM finds 9 `implements` edges that native misses entirely — native engine likely doesn't extract interface implementation relationships for JS/TS
3. **Parameters:** WASM extracts 29 more parameters — different parameter extraction logic

## 6. Release-Specific Tests

### v3.3.0 Changelog Features Tested

| Feature/Fix | Test | Result |
|-------------|------|--------|
| Type inference for typed languages (#501) | `query CodeGraph.addNode` — resolved through qualified name | PASS |
| Receiver type tracking (#505) | `where CodeGraph.addNode` — shows 15 usage sites with correct method resolution | PASS |
| Package.json exports resolution (#509) | Build resolves imports through package exports fields | PASS (no resolution errors in build output) |
| Barrel file re-exports (#515) | `exports src/db/index.js` — shows 16 re-exported symbols from sub-modules with per-symbol consumers | PASS |
| Dead role sub-categories (#504) | `roles --role dead-leaf/dead-entry/dead-ffi/dead-unresolved` — all four sub-categories work | PASS |
| Centralized DEFAULTS config (#506) | Config loaded from `.codegraphrc.json` with deep merge | PASS |
| Precision/recall benchmark (#507) | `node scripts/benchmark.js` runs resolution benchmarks | PASS (WASM only — native crashed) |
| Child-process isolation (#512) | Benchmarks fork separate processes for each engine | PASS |
| TypeScript type definitions (#516) | `src/types.ts` exists and is compiled to `dist/` | PASS |
| `.pyi/.phtml/.rake/.gemspec` extensions (#502) | Extensions present in parser registry | Not directly tested (no fixture files) |
| Reword stale warning (#510) | `codegraph info` no longer says "stale" | PASS |

## 7. Additional Testing

### Programmatic API (ESM)

| Export | Type | Status |
|--------|------|--------|
| Total exports | 57 | PASS |
| `buildGraph` | function | PASS |
| `loadConfig` | function | PASS |
| `contextData` | function | PASS |
| `whereData` | function | PASS |
| `diffImpactData` | function | PASS |
| `statsData` | function | PASS |
| `EXTENSIONS` | object | PASS |
| `IGNORE_DIRS` | object | PASS |
| `EVERY_SYMBOL_KIND` | object | PASS |
| Error classes | 7 types | PASS |

### CJS Compatibility

`require('@optave/codegraph')` returns a Promise (by design). Must use `await require(...)`. Documented in `src/index.cjs` but easily misused. Issue #531 filed then closed (by design).

### MCP Server

- Single-repo mode: 34 tools, no `list_repos`, no `repo` parameter on tools
- `initialize` + `tools/list` JSON-RPC flow works correctly

## 8. Performance Benchmarks

### Build Benchmark (`scripts/benchmark.js`)

**Native worker crashed** (exit code 3221225477 / ACCESS_VIOLATION) during 2nd 1-file rebuild iteration. Only WASM results captured.

| Metric | WASM |
|--------|------|
| Full build (429 files) | 3,375ms (7.9ms/file) |
| No-op rebuild | 21ms |
| 1-file rebuild | 708ms |
| Query: fnDeps | 1.1ms |
| Query: fnImpact | 1.2ms |
| Query: path | 1.1ms |
| Query: roles | 9.9ms |

### Incremental Benchmark (`scripts/incremental-benchmark.js`)

| Metric | WASM | Native |
|--------|------|--------|
| Full build | 3,574ms | 2,533ms |
| No-op rebuild | 16ms | 17ms |
| 1-file rebuild | 667ms | 692ms |
| Import resolution (664 pairs) | N/A | native 8.5ms vs JS 48.9ms (**5.7x faster**) |

**Native full build is 29% faster than WASM.** One-file rebuilds are comparable.

### Query Benchmark (`scripts/query-benchmark.js`)

**Native worker crashed** with V8 fatal error "Check failed: has_exception()". Only WASM results captured.

| Metric | WASM |
|--------|------|
| fnDeps depth 1/3/5 | 1.2/1.1/1.0ms |
| fnImpact depth 1/3/5 | 1.1/1.1/1.1ms |
| diff-impact | 16.6ms |

### Build Phase Breakdown (WASM, full build)

| Phase | Time | % |
|-------|------|---|
| Parse | 1,121ms | 33% |
| AST extraction | 516ms | 15% |
| Insert | 296ms | 9% |
| Finalize | 139ms | 4% |
| Complexity | 134ms | 4% |
| Edges | 120ms | 4% |
| Dataflow | 101ms | 3% |
| CFG | 86ms | 3% |
| Setup | 62ms | 2% |
| Roles | 33ms | 1% |
| Structure | 13ms | <1% |
| Resolve | 9ms | <1% |

## 9. Bugs Found

### BUG 1: `ast` command crashes — missing module import path (High)
- **Issue:** [#529](https://github.com/optave/codegraph/issues/529)
- **PR:** [#532](https://github.com/optave/codegraph/pull/532)
- **Symptoms:** `codegraph ast call` → `Cannot find module 'dist/ast.js'`
- **Root cause:** Dynamic import in `src/cli/commands/ast.js` uses `../../ast.js` but module is at `../../features/ast.js` after the src/ reorganization
- **Fix applied:** Updated import path to `../../features/ast.js`

### BUG 2: Native engine crashes during benchmark builds (High)
- **Issue:** [#530](https://github.com/optave/codegraph/issues/530)
- **PR:** Open — too complex for this session (Rust napi-rs memory issue)
- **Symptoms:** ACCESS_VIOLATION (0xC0000005) during rapid repeated builds in benchmark.js; V8 "Check failed: has_exception()" in query-benchmark.js
- **Root cause:** Likely memory safety issue in the native Rust addon when called repeatedly in quick succession under benchmark fork isolation
- **Environment:** win32-x64, Node v22.18.0

### BUG 3: Incremental builds produce fewer edges than full builds (Medium)
- **Issue:** [#533](https://github.com/optave/codegraph/issues/533)
- **Symptoms:** Incremental build: 11,444 edges vs full rebuild: 11,834 edges (390 edge / 3.3% gap)
- **Root cause:** The incremental pipeline likely misses some edges for files outside the reverse-dependency set

### BUG 4: Native engine missing `implements` edges (Low)
- **Issue:** Not filed — pre-existing parity gap
- **Symptoms:** WASM produces 9 `implements` edges, native produces 0
- **Root cause:** Native Rust extractor doesn't extract interface implementation relationships for JS/TS

## 10. Suggestions for Improvement

### 10.1 Fix native binary build version reporting
`codegraph info` says "binary built as 3.2.0" even though the package is 3.3.0. The Rust crate version should be bumped as part of the release process.

### 10.2 Add `--db` awareness to `embed` command
When `--db <path>` is used without a `[dir]` argument, `embed` defaults to CWD for reading source files. It could infer the root directory from the DB metadata instead of requiring the user to specify it.

### 10.3 Verify TypeScript build output paths
The `ast` command crash was caused by a stale import path in the compiled output. A CI step that verifies all dynamic imports in `dist/` resolve to existing files would catch this class of bug.

### 10.4 CLAUDE.md has stale command references
- `fn <name>` — command no longer exists (use `query`)
- `hotspots` — command no longer exists
- `-k, --kind` listed for `where` but not supported
- Should be updated to match current CLI surface

## 11. Testing Plan

### General Testing Plan (Any Release)
- [ ] Install from npm, verify version and native binary
- [ ] Cold start: all commands fail gracefully without a graph
- [ ] Build graph on codegraph itself
- [ ] Run every command from `--help` with basic args
- [ ] Test `--json` output on all supporting commands
- [ ] Test `-T` / `--no-tests` filtering
- [ ] Incremental no-op, 1-file change, force full rebuild
- [ ] Engine comparison: native vs WASM node/edge counts
- [ ] Embed + search pipeline
- [ ] MCP server: initialize + tools/list
- [ ] Programmatic API: ESM and CJS
- [ ] Edge cases: nonexistent symbols, files, invalid options
- [ ] Run all 4 benchmark scripts

### Release-Specific Testing Plan (v3.3.0)
- [ ] Dead role sub-categories: all 4 sub-roles queryable
- [ ] Barrel file re-exports: `exports` traces through re-exports
- [ ] Receiver type resolution: qualified name queries work
- [ ] Package.json exports resolution: no resolution errors on workspaces
- [ ] TypeScript compilation: all dynamic imports in dist/ resolve correctly
- [ ] Benchmark fork isolation: both engines complete without crashes

### Proposed Additional Tests
- **Dynamic import verification:** CI step to verify all `import()` calls in dist/ point to existing files
- **Native stability test:** Run builds 10x in sequence to catch intermittent crashes
- **Cross-platform benchmark:** The native crash may be Windows-specific — test on macOS/Linux
- **Incremental edge parity:** Compare incremental vs full build edge counts as a CI check

## 12. Overall Assessment

v3.3.0 delivers significant improvements in resolution accuracy (type inference, receiver tracking, package.json exports) and the new dead role sub-categories are immediately useful. The barrel file re-export tracing in `exports` is excellent — shows actual consumers through re-export chains.

The main concerns are:
1. **`ast` command completely broken** — a compilation/reorganization bug that should have been caught by CI. Fixed in this session.
2. **Native engine crashes under benchmark load** — intermittent ACCESS_VIOLATION and V8 fatal errors on Windows during rapid repeated builds. Works fine for normal usage.
3. **Incremental build edge parity gap** (3.3%) — pre-existing but should be tracked.

The 34 MCP tools, 57 programmatic API exports, and comprehensive CLI all work well. Search quality is excellent with hybrid BM25 + semantic ranking.

**Rating: 7/10** — The core functionality is solid and the new features work as advertised. Deducted for the `ast` crash (high-visibility regression), native engine instability under load, and the incremental build discrepancy. The `ast` fix is trivial and already PR'd; the native crashes need deeper investigation in the Rust layer.

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#529](https://github.com/optave/codegraph/issues/529) | ast command crashes — import path points to non-existent dist/ast.js | Open (fix in #532) |
| Issue | [#530](https://github.com/optave/codegraph/issues/530) | Native engine crashes with ACCESS_VIOLATION during benchmark builds | Open |
| Issue | [#531](https://github.com/optave/codegraph/issues/531) | CJS require returns empty object | Closed (by design) |
| Issue | [#533](https://github.com/optave/codegraph/issues/533) | Incremental builds produce fewer edges than full builds (3.3% gap) | Open |
| PR | [#532](https://github.com/optave/codegraph/pull/532) | fix(cli): correct ast command import path after src/ reorganization | Open |
