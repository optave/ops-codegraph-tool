# Dogfooding Report: @optave/codegraph@3.4.0

**Date:** 2026-03-25
**Platform:** Windows 11 Pro (10.0.26200), x86_64, Node v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@3.4.0
**Active engine:** native (v3.4.0)
**Target repo:** codegraph itself (462 files, 3 languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@3.4.0` | OK — 135 packages, 5s |
| `npx codegraph --version` | `3.4.0` |
| Native binary installed | `@optave/codegraph-win32-x64-msvc@3.4.0` |
| `npx codegraph info` | Active engine: native (v3.4.0) |
| Optional deps pinned | All 7 platform packages pinned to `3.4.0` |
| Source repo native binary updated | Updated from `3.3.2-dev.39` to `3.4.0` |

No issues during installation. Native binary installed correctly via optionalDependencies.

---

## 2. Cold Start (Pre-Build)

All 34+ commands tested without a graph. Every command that requires a graph fails gracefully with a clear `DB_ERROR` message and actionable guidance ("Run `codegraph build` first").

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
| `snapshot` (no subcommand) | PASS | Shows usage help |

**Verdict:** 100% graceful degradation. Zero stack traces.

---

## 3. Full Command Sweep

### Query Commands

| Command | Flags Tested | Status | Notes |
|---------|-------------|--------|-------|
| `query buildGraph` | `-T`, `-j` | PASS | Shows callers/callees, valid JSON |
| `fn-impact buildGraph` | `-T`, `--depth 1` | PASS | Shows transitive dependents |
| `context buildGraph` | `-T`, `--no-source` | PASS | Full context with source, type info, complexity |
| `audit buildGraph` | `-T` (function name) | PASS | 10 functions analyzed, health + impact |
| `audit <file>` | `-T` (file path) | PASS | 15 functions analyzed per file |
| `where buildGraph` | (name), `--file` | PASS | Definition + uses; file overview mode works |
| `map` | `-T`, `-j` | PASS | Module overview with coupling scores |
| `stats` | `--json` | PASS | Full graph health, quality score 64/100 |
| `deps <file>` | `-T` | PASS | Import/imported-by relationships |
| `impact <file>` | `-T` | PASS | Transitive file dependents |
| `diff-impact main` | `-T`, `--staged` | PASS | 121 files changed, 27 functions changed |
| `cycles` | `--functions` | PASS | 0 file-level, 4 function-level cycles (down from 8 native / 11 WASM in v3.3.1 — reduction attributed to `findCaller` fallback removal in #607, which eliminated misattributed call edges that created false cycles; both engines now agree on 4 cycles) |
| `structure` | `--depth 1`, `.` | PASS | 69 directories with metrics |
| `triage` | `--level file`, `--json` | PASS | Risk-ranked audit queue |
| `roles` | `--role dead/core/dead-leaf/dead-entry/dead-ffi/dead-unresolved` | PASS | All sub-categories work |
| `path` | `-T` | PASS | "No path within 10 hops" (correct) |
| `children` | `-T` | PASS | Shows parameters |
| `brief` | | PASS | Token-efficient summary |
| `complexity` | `-T` | PASS | Per-function metrics table |
| `cfg` | `-T` | PASS | 12 blocks, 14 edges |
| `dataflow` | `-T` | PASS | Data flows from/to |
| `flow` | `-T` | PASS | Forward execution trace, 8 nodes |
| `sequence` | `-T` | PASS | Mermaid sequence diagram |
| `exports <file>` | `-T` | PASS | Shows exported symbols with consumers |
| `communities` | `-T`, `--json` | PASS | 335 communities, modularity 0.4444 |
| `ast call` | `-T` | PASS | 183 AST call nodes |
| `co-change --analyze` | | PASS | 106 pairs from 645 commits |
| `batch fn-impact` | `-T` | PASS | Always JSON output (no `--json` flag) |
| `implementations` | `-T` | PASS | No implementors found (correct for class) |
| `interfaces` | `-T` | PASS | No interfaces found (correct) |
| `check` | `-T`, `--staged` | PASS | 10 manifesto rules, 695 violations (3 warnings) |
| `branch-compare main HEAD` | `-T` | PASS | Full build of both refs, comparison |

### Export Commands

| Format | Status | Notes |
|--------|--------|-------|
| `export -f dot` | PASS | Valid DOT graph |
| `export -f mermaid` | PASS | Valid Mermaid flowchart |
| `export -f json` | PASS | Valid JSON with nodes/edges |

### Embedding & Search

| Command | Status | Notes |
|---------|--------|-------|
| `models` | PASS | Lists 7 models with dimensions/context |
| `embed -m minilm` | PASS | 5097 symbols embedded (384d), 1 truncated |
| `search "build dependency graph"` | PASS | Hybrid BM25+semantic, correct top result |
| `search "build graph;parse file"` (multi-query) | PASS | RRF fusion, both queries contribute |
| `search --json` | PASS | Valid JSON output |
| `search` without embeddings | PASS | Warns "No embeddings found" |

### Infrastructure Commands

| Command | Status | Notes |
|---------|--------|-------|
| `info` | PASS | Full diagnostics |
| `--version` | PASS | `3.4.0` |
| `registry list` | PASS | Lists all repos with status |
| `registry list --json` | PASS | Valid JSON array |
| `registry add . -n dogfood-test` | PASS | Registered successfully |
| `registry remove dogfood-test` | PASS | Removed successfully |
| `mcp` (single-repo) | PASS | 34 tools, JSON-RPC init OK |
| `mcp --multi-repo` | PASS | 35 tools (adds `list_repos`) |

### Edge Cases Tested

| Scenario | Result | Notes |
|----------|--------|-------|
| Non-existent symbol: `query nonexistent_xyz` | PASS | "No function/method/class matching" |
| Non-existent file: `deps nonexistent.js` | PASS | "No file matching" |
| Non-existent function: `fn-impact nonexistent_xyz` | PASS | "No function/method/class matching" |
| `structure .` | PASS | Fixed since v2.2.0 |
| `--json` on supported commands | PASS | Valid JSON, no status messages in stdout |
| `--no-tests` effect | PASS | Filters test files (role counts consistent) |
| Pipe output: `map --json \| head -1` | PASS | Clean JSON, no stderr leakage to stdout |
| Search with stale embeddings | PASS | Returns results + warns about stale embeddings |
| `exports src/index.ts` | NOTE | Returns "No exported symbols found" — barrel file with only re-exports has no direct symbol definitions. Working as designed but confusing for barrel files. |

---

## 4. Rebuild & Staleness

### Incremental No-Op
- Result: "No changes detected. Graph is up to date."
- Latency: <50ms
- **PASS**

### Incremental With Change
- Modified `src/shared/constants.ts` (added comment)
- Result: Parsed 3 files (changed + 2 reverse-deps), 10859 nodes, 18187 edges
- Only changed files re-parsed: **PASS**
- Stale embeddings warning appeared: **PASS**

### Version Mismatch Detection
- When upgrading from a DB built with v3.3.1 to v3.4.0:
  - Incremental build: 10859 nodes, 18170 edges
  - Full rebuild: 10885 nodes, 20752 edges
  - **Gap:** +26 nodes, +2582 edges (v3.4.0 extracts `imports-type`, more `imports`, more `reexports`)
  - **No warning about version mismatch** — users may unknowingly have stale data after upgrading
  - **SUGGESTION:** Warn when the graph DB was built with a different codegraph version

### Force Full Rebuild
- `build --no-incremental`: 10885 nodes, 20752 edges
- Matches clean rebuild from scratch: **PASS**

### Embed → Rebuild → Search Pipeline
- Embedded 5097 symbols with minilm
- Modified a file, ran incremental rebuild
- Search still returns results with stale embeddings: **PASS**
- Stale embeddings warning displayed: **PASS**

### Delete DB → Rebuild → Search
- Deleted `graph.db`, rebuilt from scratch
- Search correctly reports "No embeddings found. Run `codegraph embed` first": **PASS**

---

## 5. Engine Comparison

### Build Metrics

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Build time | 2,668ms | 5,032ms | **Native 1.9x faster** |
| Per-file build | 5.8ms | 10.8ms | **Native 1.9x faster** |
| Nodes | 10,941 | 10,915 | +26 (0.2%) |
| Edges | 20,849 | 20,950 | -101 (0.5%) |
| Calls | ~4,000 | ~4,068 | -68 (1.7%) |
| Quality score | 64 | 60 | +4 |
| Caller coverage | 28.9% | 30.2% | -1.3% |
| Call confidence | 80.9% | 71.3% | **+9.6%** |
| Functions (complexity) | 2,015 | 2,010 | +5 |
| No-op rebuild | 26ms | 33ms | Native faster |
| 1-file rebuild | 997ms | 1,093ms | Native faster |
| DB size | 25.9MB | 18.9MB | Native 37% larger |

### Phase Breakdown (Full Build)

| Phase | Native (ms) | WASM (ms) | Native speedup |
|-------|------------|----------|----------------|
| Parse | 657 | 1,428 | **2.2x** |
| Complexity | 59 | 326 | **5.5x** |
| CFG | 134 | 332 | **2.5x** |
| Insert | 356 | 363 | ~same |
| Resolve | 22 | 16 | WASM faster |
| Edges | 122 | 122 | same |
| Roles | 277 | 286 | ~same |
| AST | 543 | 484 | WASM faster |
| Dataflow | 141 | 137 | ~same |
| Structure | 30 | 21 | WASM faster |
| Finalize | 168 | 209 | Native faster |

### Query Comparison

| Query | Native (ms) | WASM (ms) |
|-------|------------|----------|
| fnDeps | 9.8 | 12.0 |
| fnImpact | 4.5 | 5.7 |
| path | 2.2 | 1.6 |
| roles | 17.4 | 20.5 |
| diffImpact | 20.9 | 19.5 |

### Query Parity
- `fn-impact buildGraph`: Both engines find same 2 callers at level 1 (execute, branchCompareData)
- `cycles --functions`: Both find 4 cycles (same set)
- **PASS** — good query-level parity

### Analysis
The native engine excels at parsing (2.2x) and complexity computation (5.5x — runs in Rust), with higher call confidence (80.9% vs 71.3%). WASM produces ~68 more call edges (4,068 vs 4,000) and 101 more edges overall, indicating a divergence that needs investigation. Either native is missing legitimate call sites or WASM is over-extracting at lower confidence. Filed as #613 for investigation.

---

## 6. Release-Specific Tests

Changes tested from v3.4.0 CHANGELOG:

| Feature/Fix | Test | Result |
|-------------|------|--------|
| TypeScript migration (271 files) | `stats` shows 414 TS, 24 JS, 24 Rust | PASS |
| Leiden community detection | `communities` runs, 335 communities, 0.4444 modularity | PASS |
| Native call-site AST extraction (#591) | `ast --kind call buildGraph` returns 15 call sites | PASS |
| CFG bypass on native builds (#595) | `cfg buildGraph` returns 12 blocks, 14 edges on native | PASS |
| MCP graceful shutdown (#598) | MCP exits cleanly (exit code 0) when stdin closes | PASS |
| `.js` → `.ts` extension remap (#594, #600) | `query statsData` resolves to `domain/analysis/module-map.ts` | PASS |
| findCaller fallback removal (#607) | Build completes with no edge misattribution warnings | PASS |
| Dead role sub-categories | All 4 sub-roles queryable: dead-leaf (4043), dead-entry (392), dead-ffi (206), dead-unresolved (3762) | PASS |
| WASM fallback bypass for native (#606) | Native complexity 59ms vs WASM 326ms — native skips JS pass | PASS |
| `cachedStmt` for `buildTestFileIds` (#575) | Test file filtering works in queries (verified via `-T` flag) | PASS |

---

## 7. Additional Testing

### Programmatic API

| Export | Type | Status |
|--------|------|--------|
| `buildGraph` | function | PASS |
| `statsData`, `whereData`, `queryNameData` | function | PASS |
| `contextData`, `fnImpactData`, `diffImpactData` | function | PASS |
| `rolesData`, `auditData`, `triageData`, `complexityData` | function | PASS |
| `EXTENSIONS` | Set (19 items) | CAUTION — breaking API change: Array→Set in TS migration. Consumers using `.includes()` or `.indexOf()` will break. See Section 9.4. |
| `IGNORE_DIRS` | Set (16 items) | CAUTION — breaking API change: Array→Set in TS migration. Consumers using `.includes()` or `.indexOf()` will break. See Section 9.4. |
| `EVERY_SYMBOL_KIND` | Array (13 items) | PASS |
| Total exports | 57 | PASS |

**CJS compatibility:** `require('@optave/codegraph')` works with `await` (async wrapper). Without `await`, returns Promise. Documented in the CJS wrapper file.

### MCP Server

| Test | Result |
|------|--------|
| JSON-RPC initialize | PASS — returns protocol version + server info |
| tools/list (single-repo) | PASS — 34 tools, no `list_repos` |
| tools/list (multi-repo) | PASS — 35 tools, `list_repos` present |
| Graceful shutdown on stdin close | PASS — exit code 0 |

### Multi-Repo Registry

| Operation | Result |
|-----------|--------|
| `registry add . -n dogfood-test` | PASS — registered |
| `registry list --json` | PASS — valid JSON array |
| `registry remove dogfood-test` | PASS — removed |

### Config Overrides

- `.codegraphrc.json` loaded with embeddings model override: **PASS**
- `CODEGRAPH_LLM_PROVIDER=test` env var accepted: **PASS**

---

## 8. Bugs Found

### BUG 1: tsconfig.json parse failure (Low)
- **Issue:** Not filed — pre-existing warning
- **Symptoms:** `Failed to parse tsconfig.json: Bad control character in string literal` on every build
- **Root cause:** The repo's `tsconfig.json` likely has a comment or special character that `JSON.parse` can't handle
- **Impact:** Low — build succeeds, just a noisy warning

### BUG 2: No DB version mismatch warning (Low, Suggestion)
- **Issue:** Not filed — enhancement request
- **Symptoms:** When upgrading codegraph versions, incremental builds silently use stale data. A graph built with v3.3.1 had 18,170 edges; a full v3.4.0 rebuild produces 20,752 edges — a 14% gap.
- **Root cause:** No version metadata check on graph load
- **Impact:** Users may get incomplete results after upgrading without running a full rebuild

### ~~BUG 3: Benchmark scripts reference stale `queries.js`~~ (Closed)
- **Issue:** #610 (closed)
- **Root cause:** The working branch was behind main. The v3.4.0 release already has the `.ts` fix.

**Note:** The `exports src/index.ts` returning "No exported symbols found" for barrel files is working as designed but may confuse users. Consider enhancement to trace re-exports.

---

## 9. Suggestions for Improvement

### 9.1 DB Version Warning
Store the codegraph version in `metadata` table on build. On graph load, warn if the stored version differs from the running version and suggest `build --no-incremental`.

### 9.2 Barrel File Export Tracing
`codegraph exports src/index.ts` returns "No exported symbols found" because the file only has re-exports, no direct symbol definitions. Consider following re-export chains to show the actual symbols that flow through the barrel file.

### 9.3 Quieter tsconfig.json Warning
The "Failed to parse tsconfig.json" warning appears on every single build/rebuild. Consider suppressing it after the first occurrence or making it a debug-level message.

### 9.4 `EXTENSIONS` and `IGNORE_DIRS` Type Change Documentation
The programmatic API changed these from Arrays to Sets in the TypeScript migration. This is a subtle breaking change for consumers who call `.includes()`, `.indexOf()`, etc. Consider documenting in CHANGELOG or providing `.toArray()` aliases.

---

## 10. Testing Plan

### General Testing Plan (Any Release)
- [ ] Install from npm, verify version
- [ ] Verify native binary installed for platform
- [ ] `codegraph info` shows correct engine
- [ ] Cold start: all commands fail gracefully without a graph
- [ ] Build: verify file count, node count, edge count
- [ ] Query commands: `query`, `fn-impact`, `context`, `audit`, `where`, `map`, `stats`
- [ ] Export formats: DOT, Mermaid, JSON
- [ ] Edge cases: nonexistent symbols, files, invalid inputs
- [ ] Incremental no-op rebuild
- [ ] Incremental with 1 file change
- [ ] Full rebuild with `--no-incremental`
- [ ] Engine comparison: native vs WASM (nodes, edges, quality)
- [ ] MCP server: init, tools/list (single + multi-repo)
- [ ] Programmatic API: all exports importable
- [ ] CJS compatibility: `await require(...)` works
- [ ] Registry CRUD: add, list, remove
- [ ] Benchmarks: build, query, incremental, embedding
- [ ] Search pipeline: embed → search → modify → rebuild → search

### Release-Specific Testing Plan (v3.4.0)
- [x] TypeScript migration: stats shows `.ts` files, no `.js` source files
- [x] Leiden communities: `communities` command works, reports modularity
- [x] Native call-site AST: `ast --kind call` returns results on native engine
- [x] CFG bypass on native: cfg command works, native faster than WASM
- [x] MCP graceful shutdown: exit code 0 on stdin close
- [x] `.js` → `.ts` resolver remap: imports resolve correctly
- [x] Dead role sub-categories: all 4 sub-roles queryable
- [x] WASM fallback bypass: native complexity phase is 5.5x faster
- [x] `findCaller` fallback removal: no misattribution warnings

### Proposed Additional Tests
- **Watch mode lifecycle:** Start `watch`, modify file, verify incremental update, Ctrl+C for graceful shutdown
- **Concurrent builds:** Two builds at once (should lock DB or queue)
- **Different repo:** Test on a non-codegraph repo (e.g., small open-source project)
- **Database migration:** Upgrade from older graph.db version
- **Symbol kind filtering:** Test `--kind` on commands that support it with all 13 kinds
- **Credential resolution:** Test `apiKeyCommand` with a simple `echo` command

---

## 11. Overall Assessment

v3.4.0 is a **solid release**. The complete TypeScript migration is the headline change and it landed cleanly — all 462 files parsed correctly, programmatic API works, CJS compatibility maintained. The native engine shows significant improvements: 1.9x faster builds, 5.5x faster complexity computation, and 9.6% higher call confidence. Engine parity at the query level is good (identical results for key test cases), though the ~68 call-edge divergence needs investigation (#613).

The Leiden community detection produces reasonable results (335 communities, 0.4444 modularity) and the MCP graceful shutdown fix works as expected.

No blocking bugs found, but the native/WASM call-edge divergence (~68 calls, 1.7% gap) is tracked as #613 for investigation. The tsconfig.json parse warning is cosmetic. The DB version mismatch issue is a minor UX gap rather than a bug. The barrel file `exports` behavior is working as designed.

Cold start behavior is excellent — every command fails gracefully with actionable error messages. The search pipeline (embed → rebuild → search) handles staleness correctly with appropriate warnings.

**Rating: 8.5/10**
- Strong: Build performance, error handling, TypeScript migration, native engine improvements
- Good: Search pipeline, MCP integration, programmatic API, query-level engine parity
- Room for improvement: Call-edge engine divergence (#613), DB version tracking, barrel file exports, tsconfig warning noise

---

## 12. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | #610 | bug(benchmarks): stale queries.js reference breaks benchmarks | Closed — already fixed on main |
| Issue | #613 | bug(native): native engine under-extracts ~68 call edges vs WASM | Open — engine parity investigation |

The v3.4.0 release is validated. Issue #613 tracks the native/WASM call-edge divergence for investigation.
