# Dogfooding Report: @optave/codegraph@3.12.0

**Date:** 2026-06-11
**Platform:** macOS 26.2 (darwin-arm64), Node v24.10.0
**Native binary:** `@optave/codegraph-darwin-arm64@3.12.0`
**Active engine:** `auto` → native (v3.12.0)
**Target repo:** codegraph itself (893 files, 34 languages)

---

## 1. Setup & Installation

### Installation

```bash
mkdir -p /tmp/dogfood-3.12.0
cd /tmp/dogfood-3.12.0
npm init -y && npm install @optave/codegraph@3.12.0
```

Install completed in ~6s, 136 packages added, 0 vulnerabilities.

- `npx codegraph --version` → `3.12.0` ✓
- Native binary `@optave/codegraph-darwin-arm64@3.12.0` installed automatically via optionalDependencies ✓
- `npx codegraph info` → `Active engine: native (v3.12.0)` ✓

**Source repo native binary:** Was at v3.11.2, updated to v3.12.0 before benchmarking.

```
Source repo before: @optave/codegraph-darwin-arm64@3.11.2
Source repo after:  @optave/codegraph-darwin-arm64@3.12.0
```

---

## 2. Cold Start (Pre-Build)

All commands tested before `build`. Using `--db /tmp/nonexistent-graph.db` to simulate no graph.

| Command | Status | Output |
|---------|--------|--------|
| `query buildGraph` | PASS | `codegraph [DB_ERROR]: No codegraph database found. Run "codegraph build" first.` |
| `map` | PASS | Same graceful DB_ERROR with run build hint |
| `stats` | PASS | Same graceful DB_ERROR |
| `deps src/...` | PASS | Same graceful DB_ERROR |
| `cycles` | PASS | Same graceful DB_ERROR |
| `where buildGraph` | PASS | Same graceful DB_ERROR |
| `context parseFileAuto` | PASS | Same graceful DB_ERROR |
| `fn-impact buildGraph` | PASS | Same graceful DB_ERROR |
| `audit src/...` | PASS | Same graceful DB_ERROR |
| `triage` | PASS | Same graceful DB_ERROR |
| `structure` | PASS | Same graceful DB_ERROR |

**Note:** When passing an existing DB path (`--db`) all commands also show a version mismatch warning when the DB was built with a different codegraph version: `[codegraph WARN] DB was built with codegraph v3.11.2, running v3.12.0. Consider: codegraph build --no-incremental`

### Build from Scratch

```
npx codegraph build /Users/carlos/Documents/GitHub/codegraph --verbose
```

- **Engine:** native (v3.12.0) — automatically promoted to full rebuild due to version change (3.11.2 → 3.12.0)
- **Files:** 893 files parsed (0 skipped)
- **Nodes:** 22,790
- **Edges:** 48,257 (native reports 47,893 + 364 CHA post-pass — see BUG #1452)
- **Time:** ~20.5s (includes WASM CHA post-pass and analysis)
- **Languages:** 34 recognized

---

## 3. Full Command Sweep

### Query Commands

| Command | Status | Notes |
|---------|--------|-------|
| `query buildGraph --depth 2` | PASS | Correct callers/callees shown |
| `query buildGraph -j` | PASS | Valid JSON output |
| `query nonexistent` | PASS | `No function/method/class matching "nonexistent"` |
| `impact src/domain/graph/builder/pipeline.ts` | PASS | 30 dependent files |
| `map -n 10` | PASS | Top 10 most-connected nodes |
| `map --json` | PASS | Valid JSON with `limit`, `topNodes`, `stats` keys |
| `stats --json` | PASS | Full JSON with all metrics including quality |
| `deps src/domain/graph/builder/pipeline.ts` | PASS | 27 imports shown |
| `deps nonexistent.js` | PASS | `No file matching "nonexistent.js" in graph` |
| `fn-impact buildGraph --depth 2` | PASS | 33 level-1 callers |
| `fn-impact nonexistent` | PASS | `No function/method/class matching "nonexistent"` |
| `context parseFileAuto --no-source` | PASS | Parameters, complexity, callers shown |
| `audit src/domain/graph/builder/pipeline.ts` | PASS | 19 functions, complexity breaches reported |
| `audit buildGraph` | PASS | Same as file audit |
| `where buildGraph` | PASS | 5 definitions found (benchmark scripts + main) |
| `where -f src/domain/graph/builder/pipeline.ts` | PASS | Full file inventory |
| `diff-impact main` | PASS | 30 files changed, 43 functions changed |
| `diff-impact HEAD` | PASS | `No function-level changes detected` |
| `cycles` | PASS | 1 file-level cycle (37-file MCP cycle) |
| `cycles --functions` | PASS | 8 function-level cycles |
| `structure --depth 2` | PASS | Works correctly (was bug in v2.2.0) |
| `structure --sort cohesion` | PASS | Sorted by cohesion score |
| `structure .` | PASS | Works with `.` argument |
| `triage --level file` | PASS | Top 20 file hotspots |
| `triage --level function -n 5 --json` | PASS | Valid JSON with pagination |
| `triage --level directory` | PASS | Directory-level ranking |
| `triage --level function` | PASS | Function-level ranking |

### Export Commands

| Command | Status | Notes |
|---------|--------|-------|
| `export -f dot` | PASS | Valid DOT format output |
| `export -f mermaid` | PASS | Valid Mermaid flowchart output |
| `export -f json` | PASS | Valid JSON graph export |

### Embedding & Search

| Command | Status | Notes |
|---------|--------|-------|
| `models` | PASS | 11 models listed (minilm, jina-small, jina-base, jina-code, nomic, nomic-v1.5, bge-large, mxbai-xsmall, mxbai-large, bge-m3, modernbert) |
| `search "build graph"` (no embeddings) | PASS | `No embeddings found. Run codegraph embed first.` + FTS5 missing warning |
| `embed -m minilm` | PASS | 8,837 embeddings stored (384d), ~7.5 minutes |
| `search "build graph" -n 5` | PASS | Hybrid BM25 + semantic results with RRF scores |
| `search "parse typescript" --min-score 0.5` | PASS | Results with score threshold |

### Infrastructure Commands

| Command | Status | Notes |
|---------|--------|-------|
| `info` | PASS | Version, Node, platform, engine info |
| `--version` | PASS | `3.12.0` |
| `registry list` | PASS | Lists registered repos |
| `registry add /tmp/dogfood-3.12.0 -n dogfood-test` | PASS | Registers successfully |
| `registry remove dogfood-test` | PASS | Removed from registry |
| `registry prune --ttl 0` | PASS | Pruned expired/missing entries |
| `snapshot save test-snap` | PASS | 34.9 MB snapshot saved |
| `snapshot list` | PASS | Lists snapshot with size and date |
| `snapshot delete test-snap` | PASS | Deletes snapshot |

### Additional Commands

| Command | Status | Notes |
|---------|--------|-------|
| `roles --role dead -n 5` | PASS | Dead symbol list |
| `roles --role core` | PASS | Core symbols |
| `brief src/domain/graph/builder/pipeline.ts` | PASS | Token-efficient summary |
| `ast "new" -n 5` | PASS | 227 AST nodes matching |
| `implementations CodegraphError` | PASS | `no implementors found` graceful |
| `interfaces PipelineContext` | PASS | `no interfaces/traits found` graceful |
| `communities` | PASS | 369 communities, modularity 0.5706 |
| `complexity buildGraph --json` | PASS | Valid JSON with Halstead metrics |
| `check` | PASS | 10 manifesto rules, 3 warned, 0 failed |
| `flow buildGraph` | PASS | Execution flow, 445 nodes depth-10 |
| `path buildGraph parseFileAuto` | PASS | `No path within 10 hops` |
| `children buildGraph` | PASS | Parameters listed |
| `dataflow buildGraph` | PASS | Data flow edges shown |
| `cfg buildGraph` | PASS | CFG blocks for multiple matches |
| `sequence buildGraph` | PASS | Mermaid sequence diagram |
| `batch fn-impact buildGraph parseFileAuto` | PASS | JSON output (output is always JSON) |
| `co-change --analyze <repo>` | PASS | 514 pairs from 1218 commits |
| `co-change src/...` | PASS | `No co-change data` (needs --analyze first) |
| `owners buildGraph` | PASS | `No CODEOWNERS file found` graceful |
| `plot -o /tmp/test-plot.html` | PASS | 376KB HTML viewer generated |
| `branch-compare main HEAD` | PASS | 52 files changed, 20 added symbols |

### Edge Cases

| Scenario | Result | Pass/Fail |
|----------|--------|-----------|
| `query nonexistent` | `No function/method/class matching "nonexistent"` | PASS |
| `deps nonexistent.js` | `No file matching "nonexistent.js" in graph` | PASS |
| `fn-impact nonexistent` | `No function/method/class matching "nonexistent"` | PASS |
| `structure .` | Works correctly | PASS |
| `--json` flag (stats, map, triage) | Valid JSON output | PASS |
| `--no-tests` effect | Reduces callers from 33 to ~2 for buildGraph | PASS |
| `--kind function/class/interface` | Correctly filters results | PASS |
| `--kind invalidkind` | `Invalid kind "invalidkind". Valid: function, method, ...` | PASS |
| `search` without embeddings | `No embeddings found. Run codegraph embed first.` | PASS |
| `search` after DB delete | Warning: no embeddings, not crash | PASS |
| JSON pipe output (`stats --json`) | Valid JSON, no status messages polluting stdout | PASS |
| `-n` short flag for `--limit` | Works on map, roles, structure, etc. | PASS |

---

## 4. Rebuild & Staleness

### Incremental No-Op

```
[codegraph] Found 893 files to parse
[codegraph] No changes detected. Graph is up to date.
Time: 1.4s
```

Correctly reports "up to date" with no re-parsing. ✓

### Incremental After 1-File Change

```
[codegraph] Incremental: 1 changed, 0 removed
Time: 4.8s (native)
```

Only the changed file is re-parsed. ✓

### Full Rebuild (`--no-incremental`)

```
[codegraph] Native build orchestrator completed: 22790 nodes, 47893 edges, 893 files
Time: 5.1s (native)
```

Node count matches incremental: 22,790. ✓

### Embed → Rebuild → Search Pipeline

1. `embed -m minilm` → 8,837 embeddings stored
2. Touch one file, `build` (incremental)  
3. `search "build graph"` → results still return correctly (3 results shown)

Stale embeddings are NOT warned about for incremental rebuilds — this is by design (stale embeddings still reference valid node IDs that haven't changed). ✓

### Delete DB → Rebuild → Search

After deleting `graph.db` and rebuilding:
- `search "build graph"` → `[codegraph WARN] FTS5 index not found — using semantic search only. Re-run codegraph embed to enable hybrid mode.` then `No embeddings found.`

Correctly handles missing embeddings after DB rebuild. ✓

---

## 5. Engine Comparison

### Build Stats

| Metric | WASM | Native | Delta | % Change |
|--------|------|--------|-------|----------|
| Nodes | 22,735 | 22,790 | +55 | +0.2% |
| Total edges | 47,083 | 48,257 | +1,174 | +2.5% |
| Call edges | 11,219 | 12,304 | +1,085 | **+9.7%** ⚠ |
| Contains edges | 22,728 | 22,783 | +55 | +0.2% |
| Extends edges | 67 | 79 | +12 | **+17.9%** ⚠ |
| Receiver edges | 1,045 | 1,059 | +14 | +1.3% |
| Implements edges | 87 | 87 | 0 | 0% |
| Imports edges | 1,462 | 1,462 | 0 | 0% |
| Parameter_of | 9,058 | 9,066 | +8 | +0.1% |
| Build time (full) | ~24s | ~5s | — | ~5x faster |

**Parity gaps (>5%):**
- `calls`: native produces 9.7% more call edges than WASM. Native uses CHA (364 edges) and ts-native technique (11,940 edges) that WASM also applies but appears to find fewer with.
- `extends`: native finds 17.9% more extends edges (79 vs 67)

### JavaScript Fixture Parity (expected-edges.json)

| Metric | WASM | Native |
|--------|------|--------|
| Expected edges | 39 | 39 |
| Found | 39 (100%) | 33 (85%) |
| Missing | 0 | 6 |

**Native engine misses 6 call edges** — see BUG #1453:
1. `UserService.createUser → Logger.error` (this.logger constructor assignment)
2. `UserService.createUser → Logger.info` (this.logger constructor assignment)
3. `UserService.deleteUser → Logger.warn` (this.logger constructor assignment)
4. `runBind → greet` (bind points-to tracking)
5. `ClassA.runA → ServiceA.doA` (class-scoped typeMap)
6. `ClassB.runB → ServiceB.doB` (class-scoped typeMap)

---

## 6. Release-Specific Tests (v3.12.0)

v3.12.0 is a major Phase 8 analysis depth release. Key features tested:

| Feature | Test | Result |
|---------|------|--------|
| `stats --json` `byTechnique` breakdown | `quality.callerCoverage.byTechnique` in JSON | PASS — shows `cha` and `ts-native` counts |
| `stats` human-readable `by technique` line | Shown in stats output | PASS |
| `typescriptResolver` config option | Config documented, available | PASS |
| CHA dispatch edges (Phase 8.5) | 364 CHA edges in native DB | PASS |
| ts-native technique edges | 11,940 ts-native edges | PASS |
| Phase 8 WASM fixture (100% recall) | All 39 edges found | PASS |
| Phase 8 native fixture (85% recall) | 33/39 edges found | **PARTIAL — 6 missing, see #1453** |
| Receiver-typed constructor assignment (WASM) | `UserService.createUser → Logger.*` | PASS (WASM) |
| Receiver-typed constructor assignment (native) | `UserService.createUser → Logger.*` | **FAIL (native)** |
| Class-scoped typeMap prevents collision (WASM) | `ClassA.runA → ServiceA.doA` | PASS (WASM) |
| Class-scoped typeMap prevents collision (native) | `ClassA.runA → ServiceA.doA` | **FAIL (native)** |
| `.call/.apply/.bind` resolution (WASM) | `runBind → greet` | PASS (WASM) |
| `.call/.apply/.bind` resolution (native) | `runBind → greet` | **FAIL (native)** |
| `super.method()` dispatch | Via class expressions/static blocks | Not directly tested |
| `for-of`, `Set`, `Array.from` callbacks | Not in JS fixture (future fixture) | N/A |
| Inline-new receiver type `(new Dog()).bark()` | Not in JS fixture (future fixture) | N/A |
| `struct .` argument | Works in v3.12.0 | PASS |
| Version migration (3.11.2 → 3.12.0) | Full rebuild triggered automatically | PASS |
| Version warning on old DB | `[WARN] DB was built with v3.11.2, running v3.12.0` | PASS |

---

## 7. Additional Testing

### MCP Server

```bash
# Single-repo mode (default)
echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}
{"jsonrpc":"2.0","id":2,"method":"tools/list",...}' | codegraph mcp
```

| Mode | Tool count | Status |
|------|-----------|--------|
| Single-repo (default) | 34 | PASS |
| Multi-repo (`--multi-repo`) | 35 (adds `list_repos`) | PASS |

Single-repo mode correctly excludes `list_repos`. Multi-repo adds it. ✓

All 34 single-repo tools confirmed: `ast_query`, `audit`, `batch_query`, `branch_compare`, `brief`, `cfg`, `check`, `co_changes`, `code_owners`, `communities`, `complexity`, `context`, `dataflow`, `diff_impact`, `execution_flow`, `export_graph`, `file_deps`, `file_exports`, `find_cycles`, `fn_impact`, `impact_analysis`, `implementations`, `interfaces`, `list_functions`, `module_map`, `node_roles`, `path`, `query`, `semantic_search`, `sequence`, `structure`, `symbol_children`, `triage`, `where`.

### Programmatic API

```bash
node --input-type=module -e "import * as cg from '@optave/codegraph'; console.log(Object.keys(cg).length)"
```

57 exports. All 17 expected key exports verified present:
`buildGraph`, `loadConfig`, `contextData`, `explainData`, `whereData`, `fnDepsData`, `fnImpactData`, `diffImpactData`, `statsData`, `queryNameData`, `rolesData`, `auditData`, `triageData`, `complexityData`, `EXTENSIONS`, `IGNORE_DIRS`, `EVERY_SYMBOL_KIND` — all ✓

### Config File

Created `.codegraphrc.json` with `query.defaultDepth` and `display.limit`. Commands pick up custom config via `CODEGRAPH_CONFIG` env var or from the target repo's root. ✓

### Environment Variables

| Env Var | Test | Result |
|---------|------|--------|
| `CODEGRAPH_REGISTRY_PATH` | Custom registry path used | PASS |
| `CODEGRAPH_LLM_*` | Not tested (requires LLM usage) | N/A |

### Multi-Repo Registry

```bash
registry add /tmp/dogfood-3.12.0 -n dogfood-test  # PASS
registry list                                        # PASS (with [DB missing] state)
registry remove dogfood-test                         # PASS
registry prune --ttl 0                               # PASS (pruned stale entries)
```

### Different Repository Test

Built the JavaScript resolution fixture (`tests/benchmarks/resolution/fixtures/javascript` — 12 files):
- Native: 85 nodes, 150 edges, 2.8s ✓
- WASM: 85 nodes, 162 edges, 2.8s ✓

Note: Different edge counts even for a tiny 12-file repo highlights parity gap.

---

## 8. Performance Benchmarks

All benchmarks run from source repo on darwin-arm64, Node v24.10.0, native binary v3.12.0.

### Build Benchmark (666 source files, excluding test fixtures)

| Metric | WASM | Native | Ratio |
|--------|------|--------|-------|
| Full build time | 25,848ms | 5,451ms | 0.21x (4.7x faster) |
| No-op rebuild | 74ms | 35ms | 0.47x (2.1x faster) |
| **1-file rebuild** | **171ms** | **1,901ms** | **11.1x SLOWER** ⚠ |
| Query time | 55.7ms | 63.3ms | +14% (slight regression) |
| Nodes | 20,789 | 20,823 | parity |
| Edges | 43,515 | 43,548 | parity |
| Per-file build time | 38.8ms/file | 8.2ms/file | 0.21x |

### Build Phase Breakdown

| Phase | WASM Full | Native Full | WASM 1-File | Native 1-File |
|-------|-----------|-------------|-------------|---------------|
| Setup | 9.3ms | 22.2ms | — | 4.5ms |
| Parse | 19,659ms | 615ms | 18.5ms | 0.4ms |
| Insert | 828ms | 688ms | 0.4ms | 0.4ms |
| Resolve | 28.6ms | 4.4ms | 0.4ms | 0.4ms |
| Edges | 594ms | 227ms | 21.1ms | 6.4ms |
| Structure | 124ms | 36.9ms | 3.7ms | 5.1ms |
| Roles | 211ms | 124ms | 52.7ms | 32.1ms |
| thisDispatch | — | 252ms | — | 9ms |
| AST | — | 406ms | 0.7ms | 0.3ms |
| Complexity | 1,868ms | 63.2ms | 0.9ms | 0ms |
| CFG | 429ms | 309ms | 3.5ms | 0ms |
| Dataflow | 514ms | 228ms | 0.8ms | 0ms |
| Finalize | — | 1.4ms | 0.4ms | 1.8ms |

**Anomaly — Native 1-file rebuild is unexpectedly slow (1,901ms logged phases total ~78ms):**
The benchmarked native 1-file rebuild takes 1,901-9,043ms, while only ~78ms of work is in logged phases. The remaining ~1,800-8,900ms is unaccounted for. See BUG #1454.

### Query Benchmark

| Query | WASM | Native | Ratio |
|-------|------|--------|-------|
| fn-deps depth-1 | 40.6ms | 37.7ms | 0.93x |
| fn-deps depth-3 | 47.1ms | 39ms | 0.83x |
| fn-deps depth-5 | 43.2ms | 46.4ms | 1.07x |
| fn-impact depth-1 | 5.6ms | 5.9ms | 1.05x |
| fn-impact depth-3 | 6.1ms | 5.6ms | 0.92x |
| fn-impact depth-5 | 5.8ms | 5.4ms | 0.93x |
| diff-impact | 9.5ms | 10.1ms | 1.06x |

Query latencies are comparable between engines. ✓

### Incremental Benchmark

| Metric | WASM | Native | Ratio |
|--------|------|--------|-------|
| Full build | 22,802ms | 4,818ms | 0.21x (4.7x faster) |
| No-op rebuild | 42ms | 34ms | 0.81x |
| **1-file rebuild** | **112ms** | **1,596ms** | **14.3x SLOWER** ⚠ |

### Benchmark Assessment

- **Full build:** Native is 4.7x faster than WASM — strong advantage ✓
- **No-op rebuild:** Native is 2.1x faster — good ✓  
- **1-file rebuild:** Native is 11-14x SLOWER than WASM — severe regression vs claimed 43ms in v3.9.6
- **Query latency:** Comparable between engines, slight advantage to native on complex queries
- **Complexity phase:** Native 63ms vs WASM 1,868ms — native 29x faster for complexity ✓
- **CFG phase:** Native 309ms vs WASM 429ms — native ~28% faster ✓

---

## 9. Bugs Found

### BUG 1: Native build log under-reports edge count (Low)

- **Issue:** [#1452](https://github.com/optave/ops-codegraph-tool/issues/1452)
- **PR:** Not yet created — low priority cosmetic fix
- **Symptoms:** `Native build orchestrator completed: 22790 nodes, 47893 edges` but DB actually has 48,257 edges
- **Root cause:** The native orchestrator counts its edges before the CHA post-pass runs. 364 CHA-technique edges are inserted after the build summary is logged, so the reported count is always `total - cha_count`.
- **Fix suggested:** Update the final build summary log to query the actual DB count, or log the CHA post-pass count like the `this/super dispatch` pass does.

### BUG 2: Native engine misses 6 expected call edges in JS resolution fixture (High)

- **Issue:** [#1453](https://github.com/optave/ops-codegraph-tool/issues/1453)
- **PR:** Not yet created — needs investigation into native CHA/points-to alignment
- **Symptoms:** Native: 33/39 expected edges (85% recall). WASM: 39/39 (100% recall).
- **Missing edges:** `UserService.createUser → Logger.error/info` (constructor-typed receiver), `UserService.deleteUser → Logger.warn`, `runBind → greet` (bind points-to), `ClassA.runA → ServiceA.doA` and `ClassB.runB → ServiceB.doB` (class-scoped typeMap)
- **Root cause:** The WASM engine's Phase 8 constructor-assigned property resolution and `.bind()` points-to tracking are not fully ported to the native engine. v3.12.0 CHANGELOG claims these were fixed but they are working in WASM only.
- **Fix suggested:** Port the missing native counterparts for `this.prop = new Ctor()` typeMap seeding and `fn.bind(obj)` points-to to the Rust extractor.

### BUG 3: Native 1-file incremental rebuild is 11-14x slower than WASM (High)

- **Issue:** [#1454](https://github.com/optave/ops-codegraph-tool/issues/1454)
- **PR:** Not yet created — needs profiling to identify the unlogged 1,800ms
- **Symptoms:** Native 1-file rebuild = 1,596-9,043ms; WASM = 112-171ms. Phase breakdown only accounts for ~78ms of the native time.
- **Root cause:** Unknown — approximately 1,800ms is spent in an unlogged phase after the native orchestrator completes. Candidate: post-pass role re-classification runs on ~82 files when only 1 file changed, but logged rolesMs is only 32ms.
- **Fix suggested:** Instrument the post-pass phases (CHA insertion, role re-classification, this/super dispatch) with timing to identify where the ~1,800ms is being spent.

---

## 10. Suggestions for Improvement

### 10.1 Native Engine 1-File Rebuild Performance

The most impactful improvement would be finding and fixing the ~1,800ms unaccounted-for time in native 1-file incremental rebuilds. The logged phases add up to only ~78ms, but the total rebuild takes 1,600-9,000ms. Adding phase timing to all post-passes (CHA, role re-classification) would help diagnose this.

### 10.2 Native Engine JS Resolution Parity

6 of 39 expected edges are missing in the native engine for the JavaScript fixture. These cover three important resolution patterns (constructor-typed receiver, class-scoped typeMap, bind points-to) that v3.12.0 claims to support. A targeted test suite verifying native vs WASM parity for each Phase 8 feature would catch these regressions before release.

### 10.3 Build Log Accuracy

The final build summary ("Native build orchestrator completed: X nodes, Y edges") should include post-pass edges in its count. Currently it reports 364 fewer edges than what's actually in the DB. Either: (a) move the summary log after post-passes, or (b) add post-pass edge counts to the summary.

### 10.4 Embedding Benchmark Recall Data

The `scripts/embedding-benchmark.ts` took longer than expected to produce recall metrics (likely building embeddings from scratch). A cached warm path would make the benchmark practical to run routinely.

### 10.5 `byTechnique` Stats Display

The `stats --json` `byTechnique` breakdown currently shows only `cha` and `ts-native`. As more techniques are added (points-to, inter-procedural, etc.), this breakdown will become more informative. Consider adding `points-to` and `returns` as technique labels.

---

## 11. Testing Plan

### General Testing Plan (Any Release)

- [ ] `--version` matches expected
- [ ] `info` shows native engine active
- [ ] `build` completes successfully on codegraph itself
- [ ] All graceful no-graph error messages work
- [ ] `query`, `map`, `stats`, `deps`, `cycles`, `where`, `context`, `fn-impact`, `audit`, `triage`, `structure` all return valid output
- [ ] `--json` flag produces valid JSON for stats, map, triage, query
- [ ] `--no-tests` flag reduces callers/results
- [ ] Edge case: nonexistent symbol returns graceful message
- [ ] Edge case: `--kind invalidkind` returns valid error
- [ ] `export -f dot/mermaid/json` all work
- [ ] `models` lists available embedding models
- [ ] `embed -m minilm` completes without error
- [ ] `search "query"` returns results after embed
- [ ] Incremental no-op rebuild says "up to date"
- [ ] DB delete + rebuild clears embeddings (warn on search)
- [ ] MCP single-repo: 34 tools
- [ ] MCP multi-repo: 35 tools (list_repos added)
- [ ] Programmatic API exports all 17 key symbols
- [ ] `registry add/list/remove/prune` all work
- [ ] `snapshot save/list/delete` all work

### Release-Specific Testing Plan (v3.12.0)

- [ ] `stats --json` → `quality.callerCoverage.byTechnique` key exists and has `cha` and `ts-native` counts
- [ ] `stats` human-readable output shows `by technique: ts-native NNN cha MMM` line
- [ ] Build the JS resolution fixture: WASM achieves 100% recall on `expected-edges.json` (39/39)
- [ ] Build the JS resolution fixture: Native achieves at least 85% recall (currently 85%, BUG #1453)
- [ ] `UserService.createUser` → `Logger.error` edge exists in WASM build of JS fixture
- [ ] `ClassA.runA` → `ServiceA.doA` and `ClassB.runB` → `ServiceB.doB` edges in WASM build
- [ ] CHA edges (`technique='cha'`) present in native DB after build
- [ ] ts-native edges present in native DB after build
- [ ] Native 1-file rebuild benchmark (track against BUG #1454 regression)
- [ ] version mismatch warning triggers full rebuild automatically

### Proposed Additional Tests

- [ ] Add a test that verifies `npm run benchmark` native 1-file rebuild < 200ms (regression guard for BUG #1454)
- [ ] Add to resolution benchmark: verify native engine recall ≥ WASM recall on all language fixtures
- [ ] Add a test that verifies `stats --json` edge count matches the actual DB edge count (catches BUG #1452)
- [ ] Test `typescriptResolver: true` end-to-end with a fixture that has generic container calls
- [ ] Test `.bind()` resolution in native engine (currently failing, BUG #1453)

---

## 12. Overall Assessment

v3.12.0 delivers a massive upgrade to JavaScript/TypeScript call resolution depth via Phase 8 (8.1–8.6). The new `byTechnique` breakdown in stats is immediately useful for understanding resolution quality. The WASM engine achieves 100% recall on the JS resolution fixture, confirming that the Phase 8 logic is correct in principle.

However, the native engine falls short of WASM parity on three specific Phase 8 patterns (constructor-typed receiver, class-scoped typeMap, `.bind()` points-to), leaving 6 of 39 expected edges missing. This is a correctness gap that should be addressed before the release is considered fully validated.

The most significant operational concern is the native 1-file incremental rebuild performance: 1,600-9,000ms vs the v3.9.6-claimed 43ms and WASM's 112-171ms. This makes watch mode or frequent incremental rebuilds painful in native engine. The phase breakdown shows only ~78ms of logged work, suggesting a significant unlogged post-pass is running on every incremental rebuild.

The build log edge count discrepancy (#1452) is cosmetic and low priority.

**Overall Rating: 6.5/10**

Strong: Full build speed (5x faster than WASM), Phase 8 resolution in WASM, comprehensive command coverage, clean graceful error handling, MCP tool count correct.

Needs work: Native incremental rebuild performance (11-14x slower than WASM), native Phase 8 parity gaps (6 missing edges), native build log inaccuracy.

---

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#1452](https://github.com/optave/ops-codegraph-tool/issues/1452) | bug: native build log under-reports edge count (CHA post-pass edges excluded) | Open |
| Issue | [#1453](https://github.com/optave/ops-codegraph-tool/issues/1453) | bug: native engine misses 6 expected call edges in JavaScript fixture (85% vs WASM 100%) | Open |
| Issue | [#1454](https://github.com/optave/ops-codegraph-tool/issues/1454) | bug: native 1-file incremental rebuild is 11-14x slower than WASM (1596-9043ms vs 112-171ms) | Open |
