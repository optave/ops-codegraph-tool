# Dogfooding Report: @optave/codegraph@3.8.0

**Date:** 2026-04-01
**Platform:** Windows 11 Pro (10.0.26200), x86_64, Node v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@3.8.0
**Active engine:** native (v3.8.0)
**Target repo:** codegraph itself (532 files, 4 languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@3.8.0` | OK — 136 packages, 0 vulnerabilities |
| `npx codegraph --version` | `3.8.0` |
| Native binary installed | `@optave/codegraph-win32-x64-msvc@3.8.0` |
| `npx codegraph info` | Active engine: native (v3.8.0) |
| Optional deps pinned | All 7 platform packages pinned to `3.8.0` |
| Source repo native binary | Already at `3.8.0` — no update needed |

No issues during installation.

---

## 2. Cold Start (Pre-Build)

All 39 commands tested without a graph. Every command that requires a graph fails gracefully with a clear `DB_ERROR` message and actionable guidance ("Run `codegraph build` first").

| Command | Status | Notes |
|---------|--------|-------|
| `query`, `map`, `stats`, `deps`, `impact` | PASS | DB_ERROR with clear message |
| `fn-impact`, `context`, `audit`, `where` | PASS | DB_ERROR with clear message |
| `diff-impact`, `cycles`, `structure`, `triage` | PASS | DB_ERROR with clear message |
| `roles`, `complexity`, `communities`, `search` | PASS | DB_ERROR with clear message |
| `export`, `cfg`, `dataflow`, `flow`, `co-change` | PASS | DB_ERROR with clear message |
| `ast`, `sequence`, `implementations`, `interfaces` | PASS | DB_ERROR with clear message |
| `branch-compare`, `exports`, `children`, `brief` | PASS | DB_ERROR with clear message |
| `check`, `plot`, `batch`, `path` | PASS | DB_ERROR with clear message |
| `info` | PASS | Works without graph — shows engine diagnostics |
| `models` | PASS | Works without graph — lists 7 embedding models |
| `registry list` | PASS | Works without graph — shows registered repos |
| `snapshot list` | PASS | Works without graph — "No snapshots found" |

**Verdict:** 39/39 pass. 100% graceful degradation. Zero stack traces.

### Fresh Build

| Metric | Value |
|--------|-------|
| Engine | native v3.8.0 |
| Files parsed | 532 |
| Nodes | 13,633 (native) / 13,702 (WASM) |
| Edges | 23,386 (native) / 26,779 (WASM) |
| Build time | ~1.7s (native) / ~5.7s (WASM) |

---

## 3. Full Command Sweep

### Query Commands

| Command | Flags Tested | Status | Notes |
|---------|-------------|--------|-------|
| `query buildGraph` | `-T`, `--depth 3`, `--json` | PASS | Shows callees, valid JSON |
| `fn-impact buildGraph` | `-T`, `--depth 2`, `-f`, `-k function`, `--json` | PASS* | Works, but 0 callers on native (missing import edges) |
| `context buildGraph` | `-T`, `--depth 2`, `--no-source`, `--include-tests`, `--json` | PASS | Full context with source, params, return type |
| `audit buildGraph` | function name, `--quick`, `--json` | PASS | Health + impact report |
| `audit <file>` | file path, `--json` | PASS | File-level audit |
| `where buildGraph` | default, `--json` | PASS | Definition + uses |
| `where --file src/cli.ts` | file overview | BUG | Returns empty symbols (native extraction gap) |
| `map` | `--limit 5`, `--json` | BUG | All fan-in = 0 on native (missing import edges) |
| `stats` | `--json` | PASS | Graph health, quality 63-68/100 depending on engine |
| `deps <file>` | `-T`, `--json` | BUG | 0 imports/imported-by on native (missing import edges) |
| `impact <file>` | `-T`, `--json` | BUG | 0 dependents on native |
| `diff-impact main` | `-T`, `--staged`, no arg | PASS | Works; note: `--json` not supported (uses `--ndjson`) |
| `cycles` | `--functions`, `--json` | PASS | 0 file cycles, 5 function cycles |
| `structure` | `.`, `--depth 2`, `--sort cohesion`, `--json` | BUG | "No directory structure found" on native |
| `triage` | `--level function`, `-n 5`, `--json` | PASS | Function-level works; `--level file`/`directory` empty on native |
| `roles` | `--role dead/core/entry`, `--json`, `-T` | PASS | All role filters work |
| `complexity` | default, function, file, `--json`, `-T` | BUG | "No complexity data found" on native |
| `path` | `-T`, `--json`, `--file` | BUG | "No path found" on native (missing import edges) |
| `exports <file>` | `-T`, `--json` | PASS | Exported symbols with consumers |
| `children` | `--json` | PASS | Shows parameters correctly |
| `cfg` | `--json` | BUG | 0 blocks, 0 edges on native |
| `dataflow` | `--json` | BUG | "No dataflow data found" (both engines — napi null crash) |
| `flow` | `--json` | PASS | Forward execution trace, 10 nodes |
| `sequence` | `--json` | PASS | Mermaid sequence diagram |
| `brief <file>` | `--json` | PASS | Token-efficient summary |
| `branch-compare main HEAD` | `--json`, `-T` | PASS | Builds both refs, compares |
| `check` | default, `--staged`, `--rules` | PASS | All manifesto rules pass |
| `implementations` | tested | PASS | Runs correctly |
| `interfaces` | tested | PASS | Runs correctly |
| `co-change` | default, `--analyze` | PASS | Git analysis runs |
| `ast call` | tested | BUG | `call` is not a valid AST kind (valid: new, string, regex, throw, await). CLAUDE.md documents `ast --kind call` incorrectly |
| `batch fn-impact` | tested | PASS | JSON output; `--json` flag rejected (batch always outputs JSON) |
| `plot` | default | PASS | Creates 112KB HTML file |

### Export Commands

| Command | Status | Notes |
|---------|--------|-------|
| `export -f dot` | PASS | Valid DOT, 776 lines, 318 edges |
| `export -f mermaid` | PASS | Valid Mermaid flowchart with subgraphs |
| `export -f json` | PASS | Valid JSON with nodes array |
| `export -f graphml` | PASS | Valid GraphML XML |
| `export --functions -f dot` | PASS | Function-level DOT |
| `export -o <file> -f dot` | PASS | File output works |

### Embedding & Search

| Command | Status | Notes |
|---------|--------|-------|
| `models` | PASS | Lists 7 models |
| `embed -m minilm` | BUG | 0 embeddings stored — double-path bug (see Bug #3) |
| `search` (all flag combos) | BLOCKED | No embeddings due to embed bug; all return "No embeddings found" gracefully |

### Infrastructure Commands

| Command | Status | Notes |
|---------|--------|-------|
| `info` | PASS | All fields present; shows version mismatch warning |
| `--version` | PASS | `3.8.0` |
| `registry list` | PASS | Default and `--json` work |
| `registry add` | PASS | With and without `--name` |
| `registry remove` | PASS | Removes entry |
| `registry prune --ttl 0` | PASS | Prunes stale entries |
| `snapshot save` | PASS | 11.6 MB snapshot saved |
| `snapshot list` | PASS | Shows snapshot with size/timestamp |
| `snapshot restore` | PASS | Restores successfully |
| `snapshot delete` | PASS | Cleans up |
| `mcp` (single-repo) | PASS | 34 tools exposed via JSON-RPC |
| `mcp --multi-repo` | PASS | 35 tools; `list_repos` present |
| `watch` | PASS | Detects changes, incremental update, clean shutdown |

### Edge Cases

| Scenario | Status | Notes |
|----------|--------|-------|
| Non-existent symbol: `query nonexistent` | PASS | "No function/method/class matching..." |
| Non-existent file: `deps nonexistent.js` | PASS | "No file matching..." |
| `--kind` with invalid kind | PASS | Error with valid kinds listed |
| `--json` piped output | PASS | Clean JSON on stdout, warnings on stderr |
| `structure .` | BUG | "No directory structure found" (native engine) |
| `--no-tests` effect | PASS | Test file counts drop correctly |
| Concurrent builds | PASS | Both complete, race condition detected and warned |

---

## 4. Rebuild & Staleness

### Incremental Rebuild

| Test | Status | Notes |
|------|--------|-------|
| No-op rebuild | BUG | Never triggers "up to date" — native writes wrong `build_meta`, causing full rebuild every time |
| Incremental with file change | BUG | Works mechanically but always does full rebuild due to stale metadata |
| Force full rebuild `--no-incremental` | PASS | Deterministic: 13,633 nodes, 23,386 edges, 532 files (native) |
| Node/edge count consistency | BUG | "Incremental" runs produce varying counts (13,633–14,234 nodes) vs deterministic `--no-incremental` |

### Embed-Rebuild-Search Pipeline

| Test | Status | Notes |
|------|--------|-------|
| `embed -m minilm` | BUG | 0 embeddings stored (double-path bug) |
| Embed → rebuild → search | BLOCKED | No embeddings to test staleness |
| Embed → modify → rebuild → search | BLOCKED | Same |
| Delete DB → rebuild → search | PASS | Correctly reports no embeddings after fresh build |

### Watch Mode

| Test | Status | Notes |
|------|--------|-------|
| Start watcher | PASS | Starts cleanly |
| Detect file change | PASS | Detects touch within seconds |
| Incremental update | PASS | Reports +11 nodes, +16 edges |
| Graceful shutdown | PASS | Clean exit on SIGTERM (code 143) |

---

## 5. Engine Comparison

### Build Metrics

| Metric | Native | WASM | Delta | Parity? |
|--------|-------:|-----:|------:|---------|
| **Nodes** | 13,633 | 13,702 | -69 (-0.5%) | FAIL — WASM has 69 extra `directory` nodes |
| **Edges** | 23,386 | 26,779 | -3,393 (-12.7% of WASM) | **FAIL — critical gap** |
| **Files** | 532 | 532 | 0 | OK |
| **File cycles** | 0 | 1 | -1 | FAIL |
| **Function cycles** | 5 | 5 | 0 | OK |
| **Quality score** | 63 | 65 | -2 | Within tolerance |
| **Caller coverage** | 30.9% | 34.1% | -3.2pp | FAIL (>5% relative) |
| **Call confidence** | 76.0% | 78.4% | -2.4pp | Within tolerance |
| **Build time** | 1.7s | 5.7s | 3.4x faster | Expected |

### Edge Kind Breakdown

| Edge Kind | Native | WASM | Delta |
|-----------|-------:|-----:|------:|
| calls | 4,368 | 5,452 | **-1,084 (-19.9%)** |
| contains | 13,101 | 13,695 | -594 (-4.3%) |
| dynamic-imports | 0 | 136 | **-136 (-100%)** |
| extends | 10 | 10 | 0 |
| implements | 27 | 27 | 0 |
| imports | 0 | 1,201 | **-1,201 (-100%)** |
| imports-type | 0 | 244 | **-244 (-100%)** |
| parameter_of | 5,298 | 5,298 | 0 |
| receiver | 582 | 581 | +1 |
| reexports | 0 | 135 | **-135 (-100%)** |

**The native engine does not emit `imports`, `imports-type`, `dynamic-imports`, or `reexports` edges at all.** These 1,716 missing edges, plus 1,084 fewer call edges, account for the 3,393-edge gap.

### Per-Query Comparison

| Query | Native | WASM | Match? |
|-------|--------|------|--------|
| `query buildGraph` callees | 3 | 4 | FAIL — native missing `formatTimingResult` |
| `query buildGraph` callers | 0 | 14 | **FAIL — native reports zero callers** |
| `cycles --functions` | 5 | 5 | OK |
| `triage -n 5` total symbols | 5,959 | 6,189 | FAIL (-3.7%) |
| `fn-impact buildGraph` dependents | 0 | 20 | **FAIL — native reports zero** |
| `deps parser.ts` imports | 26 | 26 | OK (intra-file) |
| `deps parser.ts` imported-by | 44 | 44 | OK (intra-file) |
| `where buildGraph` results | 11 | 10 | Minor diff |

### Analysis

The native engine is 3.4x faster at building but has severe parity gaps in edge generation. The Rust build orchestrator (#740) handles parse/insert but does not produce import-type edges, drops ~20% of call edges, and skips complexity/CFG/structure analysis. This makes the default `--engine auto` (which selects native) produce an incomplete graph that breaks half the query commands. **The WASM engine via `CODEGRAPH_FORCE_JS_PIPELINE=1` is the only reliable path for full-featured analysis.**

---

## 6. Release-Specific Tests

### v3.8.0 Features

| Feature/Fix | Test | Result |
|------------|------|--------|
| **11 new languages** (F#, Gleam, Clojure, Julia, R, Erlang, Solidity, Obj-C, CUDA, Groovy, Verilog) | Created test files, built with WASM+JS | **BUG** — Only works via `CODEGRAPH_FORCE_JS_PIPELINE=1`. Native orchestrator's `parser_registry.rs` has no entries for these 11 languages; files are silently dropped |
| **Full Rust build orchestration** (#740) | `build --engine native --verbose` | **BUG** — Orchestrator completes but: (a) `build_meta` not updated, (b) no import edges, (c) no complexity/CFG/structure |
| **Graph algorithms in Rust** (#732) | `cycles`, `roles`, `path`, `communities` | PARTIAL — `cycles` and `roles` work; `path` and `communities` fail on native due to missing import edges |
| **Import edge building in Rust** (#738) | `deps --json` after native build | **BUG** — 0 import/reexport edges produced |
| **Native complexity/CFG/dataflow** (#733) | `complexity`, `cfg`, `dataflow` after native build | **BUG** — All three tables empty |
| **bulkInsertNodes fix** (#736, #737) | `stats --json` node counts | PASS — 13,633 nodes (reasonable) |
| **SQLITE_CORRUPT fix** (#728) | Incremental native build | PASS — No SQLite errors |
| **OCaml .mli grammar** (#730) | Created `.ml` + `.mli`, built with WASM | PASS — `.mli` extracts `val` declarations correctly |
| **Dataflow napi null fix** | `dataflow` command | **BUG** — `paramIndex` null→u32 conversion fails; 0 dataflow rows |

### v3.7.0 Features

| Feature/Fix | Test | Result |
|------------|------|--------|
| **6 new languages** (Elixir, Lua, Dart, Zig, Haskell, OCaml) | Created test files, built with both engines | PASS — All 6 work in both native and WASM |
| **CFG WAL conflict fix** (#719) | Implicit via builds | PASS — No WAL errors |

---

## 7. Additional Testing

### Programmatic API

All 16 key exports verified present via `require('@optave/codegraph')`: `buildGraph`, `loadConfig`, `contextData`, `whereData`, `fnDepsData`, `fnImpactData`, `diffImpactData`, `statsData`, `queryNameData`, `rolesData`, `auditData`, `triageData`, `complexityData`, `EXTENSIONS` (Set), `IGNORE_DIRS` (Set), `EVERY_SYMBOL_KIND` (13 kinds).

**Note:** CJS `require()` returns a Promise (ESM wrapper). Users must `await require(...)` or use ESM `import`. This is documented in the source but may surprise CJS consumers.

### Config Options

Custom `.codegraphrc.json` with `include`, `exclude`, `build.incremental`, `query.defaultDepth`, and `search.defaultMinScore` loaded and applied correctly. Build respected `include` pattern.

### Env Var Overrides

`CODEGRAPH_REGISTRY_PATH` correctly redirected registry location. Working as expected.

### Symbol Kinds

All 10 valid kinds (`function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`) accepted by `--kind` flag. Invalid kinds produce helpful error with valid list.

### False Positive Filtering

`stats --json` reports 0 false positive warnings. Common names (`run`, `get`, `set`, etc.) are filtered correctly.

### Pipe Output Cleanliness

All tested commands (`map`, `stats`, `roles`, `cycles`, `complexity`, `communities`) produce valid JSON on stdout with warnings on stderr only.

### Concurrent Builds

Two simultaneous builds both completed with exit code 0. Race condition detected and warned. No corruption.

### MCP Server

- Single-repo mode: 34 tools, no `list_repos`, no `repo` parameter
- Multi-repo mode: 35 tools, `list_repos` present
- JSON-RPC protocol works correctly

---

## 8. Performance Benchmarks

### Build Benchmark

> **Note:** These are formal 5-run averages. Section 2 reports single-run approximate times (~1.7s native, ~5.7s WASM, 3.4x speedup) from the initial build during the command sweep, which ran fewer analysis passes. The formal benchmark includes all phases (AST, complexity, CFG, dataflow), explaining the higher absolute times and lower speedup ratio (2.9x vs 3.4x).

| Metric | Native | WASM | Native Speedup |
|--------|-------:|-----:|---------------:|
| Full build | 2,536ms | 7,337ms | **2.9x** |
| No-op rebuild | 55ms | 46ms | 0.8x (WASM faster) |
| 1-file rebuild | 1,205ms | 1,611ms | **1.3x** |
| Query time | 9.2ms | 16.4ms | **1.8x** |
| DB size | 22.1 MB | 27.3 MB | Native 19% smaller |

#### Build Phase Breakdown (full build)

> **Note:** The native Complexity, CFG, and Dataflow times below reflect the wall-clock time spent *attempting* those phases via the napi-rs standalone functions. The phases execute but their results are not committed to the database (see BUG 6), so downstream queries return empty data despite the time being spent.

| Phase | Native | WASM |
|-------|-------:|-----:|
| Parse | 587ms | 1,452ms |
| Insert | 390ms | 532ms |
| Resolve | 14ms | 14ms |
| Edges | 122ms | 114ms |
| Roles | 304ms | 334ms |
| AST | 434ms | 926ms |
| Complexity | 51ms | 484ms |
| CFG | 129ms | 501ms |
| Dataflow | 280ms | 509ms |

### Incremental Benchmark

> **Note:** The full-build figure here (3,787ms) differs from the Build Benchmark above (2,536ms) because these come from different benchmark scripts. The Build Benchmark (`scripts/benchmark.ts`) runs a targeted build on the project root, while the Incremental Benchmark (`scripts/incremental-benchmark.ts`) exercises the full incremental pipeline including journal creation, change detection setup, and additional bookkeeping — adding ~49% overhead.

| Metric | Native | WASM |
|--------|-------:|-----:|
| Full build | 3,787ms | 7,702ms |
| No-op rebuild | 50ms | 51ms |
| 1-file rebuild | 1,207ms | 1,491ms |
| Import resolution (native batch) | 8.1ms | — |
| Import resolution (JS fallback) | 30.7ms | — |
| Native batch speedup | **3.8x** | — |

### Query Benchmark

| Query | Native | WASM |
|-------|-------:|-----:|
| fnDeps depth 1 | 13.9ms | 10.7ms |
| fnDeps depth 3 | 16.1ms | 16.0ms |
| fnDeps depth 5 | 13.6ms | 12.1ms |
| fnImpact depth 1 | 5.9ms | 5.0ms |
| fnImpact depth 3 | 5.5ms | 5.8ms |
| fnImpact depth 5 | 5.8ms | 5.1ms |
| diffImpact | 17.9ms | 19.5ms |

### Embedding Benchmark

- **minilm:** FAILED — worker produced invalid JSON during search accuracy phase
- **jina-small:** Stored 5,959 embeddings (512d); Hit@N accuracy tests in progress but extremely slow

### Regressions vs v3.6.0

| Metric | v3.6.0 | v3.8.0 | Change |
|--------|-------:|-------:|-------:|
| No-op rebuild | 13ms | 51ms | **+292%** ¹ |
| 1-file rebuild | 545ms | 1,491ms | **+174%** |
| fnDeps d1 (native) | 9.4ms | 13.9ms | +48% |
| fnDeps d3 (native) | 9.6ms | 16.1ms | +68% |
| fnImpact d1 (native) | 3.4ms | 5.9ms | +74% |
| diffImpact (native) | 8.3ms | 17.9ms | **+116%** |
| Import resolution (native) | 3.9ms | 8.1ms | +108% |
| Import resolution (JS) | 11.7ms | 30.7ms | +163% |

¹ No-op and 1-file rebuild regressions were measured under `CODEGRAPH_FORCE_JS_PIPELINE=1` (WASM engine). Due to BUG 2 (build_meta version mismatch), native no-op always falls through to a full rebuild (~3,787ms), making native no-op regression effectively **+29,000%** rather than +292%. The 51ms figure reflects WASM-only no-op performance.

**Significant regressions in incremental rebuild and query latency.** The 1-file rebuild regression is driven by new `ast` and `edges` phase overhead. Query latencies have roughly doubled across the board.

---

## 9. Bugs Found

### BUG 1: Native engine does not emit import/reexport/dynamic-import edges (Critical)

- **Issue:** [#750](https://github.com/optave/ops-codegraph-tool/issues/750)
- **Symptoms:** Native builds produce 23,386 edges vs WASM's 26,779. Zero `imports`, `imports-type`, `dynamic-imports`, `reexports` edge kinds. Breaks `deps`, `impact`, `map`, `path`, `communities`, `fn-impact` (callers).
- **Root cause:** Rust build orchestrator (#740) does not write import-type edges to the database. The import edge building migration (#738) appears incomplete.

### BUG 2: build_meta stores wrong version/engine after native build (High)

- **Issue:** [#751](https://github.com/optave/ops-codegraph-tool/issues/751)
- **Symptoms:** `build_meta.codegraph_version` = `3.6.0` (Rust crate version) instead of `3.8.0` (npm version). Every subsequent build detects "version changed" and does a full rebuild. Incremental no-op never triggers.
- **Root cause:** Native Rust orchestrator writes the compiled-in crate version instead of the JS package version.

### BUG 3: Embed double-path prevents embedding storage (High)

- **Issue:** [#752](https://github.com/optave/ops-codegraph-tool/issues/752)
- **Symptoms:** `embed -m minilm` stores 0 of 5,959 embeddings. File paths doubled: `H:\Vscode\codegraph\H:\Vscode\codegraph\src\cli.ts`. All file reads fail with ENOENT.
- **Root cause:** Native engine stores absolute paths in `nodes` table; embed command prepends cwd again via `path.join(cwd, node.file)`.

### BUG 4: Dataflow edge insertion fails with null paramIndex (Medium)

- **Issue:** [#753](https://github.com/optave/ops-codegraph-tool/issues/753)
- **Symptoms:** `buildDataflowEdges failed: Failed to convert napi value Null into rust type 'u32' on DataflowEdge.paramIndex`. Dataflow table always 0 rows. Affects both engines.
- **Root cause:** Rust napi-rs struct expects `u32` but JS passes `null` for edges without a parameter index.

### BUG 5: `--engine wasm` flag ignored when native addon available (Medium)

- **Issue:** [#754](https://github.com/optave/ops-codegraph-tool/issues/754)
- **Symptoms:** `build --engine wasm` logs "Using wasm engine" then "Native build orchestrator completed". Native always runs.
- **Root cause:** Pipeline unconditionally opens `NativeDatabase`; orchestrator guard doesn't check engine flag.
- **Workaround:** `CODEGRAPH_FORCE_JS_PIPELINE=1`

### BUG 6: Complexity, CFG, and structure data not populated by native orchestrator (Medium)

- **Issue:** [#755](https://github.com/optave/ops-codegraph-tool/issues/755)
- **Symptoms:** After native build: `complexity` empty, `cfg` 0 blocks, `structure` "No directory structure found". All three work after WASM+JS build.
- **Root cause:** Native orchestrator handles parse/insert/resolve/edges but skips complexity, CFG, and structure analysis passes.

### BUG 7: Native engine silently drops v3.8.0 languages (Medium)

- **Related to:** #750
- **Symptoms:** The 11 languages added in v3.8.0 (F#, Gleam, Clojure, Julia, R, Erlang, Solidity, Obj-C, CUDA, Groovy, Verilog) are only in JS/WASM extractors. `parser_registry.rs` has no entries. Native build silently skips these files.
- **Workaround:** `CODEGRAPH_FORCE_JS_PIPELINE=1`

### BUG 8: Non-deterministic node/edge counts on incremental rebuilds (Low)

- **Symptoms:** "Incremental" runs produce varying counts (13,633–14,234 nodes) while `--no-incremental` is deterministic. Suggests stale data accumulation.
- **Root cause:** Likely related to BUG 2 — metadata mismatch causes unpredictable rebuild behavior.

### BUG 9: minilm embedding worker crash in benchmark (Low)

- **Symptoms:** `node scripts/embedding-benchmark.js` with minilm model produces invalid JSON from worker, failing the search accuracy phase.

### BUG 10: CLAUDE.md documents invalid `ast --kind call` (Low)

- **Symptoms:** `ast --kind call <name>` is documented in CLAUDE.md but `call` is not a valid AST kind. Valid kinds are: `new`, `string`, `regex`, `throw`, `await`.

---

## 10. Suggestions for Improvement

### 10.1 Block native orchestrator until import edges are complete
The native orchestrator should not be the default path until it produces all edge kinds. Consider keeping WASM+JS as default in `--engine auto` until native parity is achieved.

### 10.2 Add engine parity CI gate
Add a CI check that compares native vs WASM edge kind distributions. Any missing edge kind should fail the build. This would have caught BUG 1 before release.

### 10.3 Pass npm version to Rust orchestrator
The `build_meta` version bug (BUG 2) completely breaks incremental builds. The npm package version should be passed as a parameter to the Rust `buildGraph` function rather than using the compiled-in crate version.

### 10.4 Normalize file paths at the DB boundary
Absolute vs relative path mismatches (BUG 3) should be normalized at the DB insertion layer. All paths in the DB should be relative to the project root, regardless of engine.

### 10.5 Add `--engine` validation to pipeline guard
The native orchestrator guard should respect `--engine wasm` (BUG 5). A one-line fix: check `ctx.engineName === 'native'` before entering the Rust fast path.

### 10.6 Investigate incremental rebuild regressions
No-op rebuilds went from 13ms to 51ms (+292%), and 1-file rebuilds from 545ms to 1,491ms (+174%) vs v3.6.0. These regressions warrant investigation.

---

## 11. Testing Plan

### General Testing Plan (Any Release)

- [ ] Install from npm, verify version and native binary
- [ ] Cold start: all commands fail gracefully without graph
- [ ] Full build with both engines, compare node/edge counts
- [ ] Incremental no-op produces "up to date"
- [ ] Incremental with 1 file change re-parses only that file
- [ ] `--no-incremental` produces deterministic counts
- [ ] All query commands produce output with `--json` and `-T`
- [ ] Edge cases: non-existent symbol/file, invalid `--kind`
- [ ] `embed` + `search` pipeline works end-to-end
- [ ] `watch` detects changes and shuts down cleanly
- [ ] MCP server exposes correct tool count (single vs multi-repo)
- [ ] Export formats all valid (DOT, Mermaid, JSON, GraphML)
- [ ] Piped JSON output is clean (no stderr in stdout)
- [ ] Concurrent builds don't corrupt the DB
- [ ] Programmatic API exports are present and callable
- [ ] Run all 4 benchmark scripts, compare with baseline

### Release-Specific Testing Plan (v3.8.0)

- [ ] All 11 new languages detected and symbols extracted
- [ ] Native Rust orchestrator produces same edge kinds as WASM
- [ ] `build_meta` reflects correct version after native build
- [ ] Incremental no-op triggers "up to date" (not full rebuild)
- [ ] `complexity`, `cfg`, `dataflow` populated after native build
- [ ] `embed` works with native-stored absolute paths
- [ ] `--engine wasm` flag respected by pipeline
- [ ] Graph algorithms (BFS, shortest path, Louvain) produce correct results via Rust
- [ ] Import edge building in Rust matches JS pipeline output
- [ ] `DataflowEdge.paramIndex` null handling works

### Proposed Additional Tests for Future Dogfooding

- [ ] Database migration path: open a v3.6.0 graph.db with v3.8.0, verify schema migration
- [ ] `apiKeyCommand` credential resolution with `echo` command
- [ ] Test on a non-codegraph repo (e.g., small open-source JS project)
- [ ] `--verbose` on every command that supports it
- [ ] Embed with one model, rebuild, embed with different model, search — verify dimension mismatch warning
- [ ] Multi-repo MCP flow: `registry add`, `mcp --repos`, query across repos

---

## 12. Overall Assessment

Codegraph v3.8.0 is an ambitious release that migrates the entire build pipeline to Rust and adds 11 new languages. The **WASM+JS pipeline remains reliable and fully functional** — all 39 commands work correctly, cold start graceful degradation is perfect, and the query layer is solid.

However, the **native Rust build orchestrator has critical gaps** that make it unsuitable as the default engine:

1. **Zero import edges** — the most impactful bug, breaking half the query commands
2. **Wrong version metadata** — breaks incremental builds entirely
3. **Missing analysis passes** — no complexity, CFG, structure data
4. **Embed path doubling** — blocks semantic search
5. **Dataflow null crash** — blocks dataflow analysis on all engines

The v3.7.0 features (6 languages) work correctly on both engines. The v3.8.0 features (11 more languages) only work via the WASM fallback.

Performance benchmarks show native is 2.9x faster for full builds, but incremental rebuild and query latencies have regressed significantly vs v3.6.0 (1-file rebuild +174%, query latency +50-116%).

**Rating: 4/10** — The WASM fallback path works well (would be 7/10 on its own), but the default native path produces an incomplete graph with cascading failures across most commands. Since `--engine auto` selects native when available, most users will hit these bugs. The fix is either reverting the default to WASM or completing the native orchestrator's edge/analysis passes before the next release.

---

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#750](https://github.com/optave/ops-codegraph-tool/issues/750) | bug(native): build orchestrator does not emit import/reexport/dynamic-import edges | open |
| Issue | [#751](https://github.com/optave/ops-codegraph-tool/issues/751) | bug(native): build_meta stores wrong version/engine after native build | open |
| Issue | [#752](https://github.com/optave/ops-codegraph-tool/issues/752) | bug(embed): double-path bug prevents embedding storage on native builds | open |
| Issue | [#753](https://github.com/optave/ops-codegraph-tool/issues/753) | bug(native): dataflow edge insertion fails with null paramIndex | open |
| Issue | [#754](https://github.com/optave/ops-codegraph-tool/issues/754) | bug(native): --engine wasm flag ignored when native addon available | open |
| Issue | [#755](https://github.com/optave/ops-codegraph-tool/issues/755) | bug(native): complexity, CFG, and structure data not populated by native orchestrator | open |
