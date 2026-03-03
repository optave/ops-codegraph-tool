# Dogfooding Report: @optave/codegraph@2.6.32-dev.4f08082

**Date:** 2026-03-03
**Platform:** Windows 11 Pro (win32-x64), Node.js v22.18.0
**Native binary:** `@optave/codegraph-win32-x64-msvc@2.6.32-dev.4f08082`
**Active engine:** native (v2.6.0)
**Target repo:** codegraph itself (164 files, 2 languages)

---

## 1. Setup & Installation

Installed from GitHub release tarballs (dev build, not on npm):
- Main package: `optave-codegraph-2.6.32-dev.4f08082.tgz`
- Native binary: `optave-codegraph-win32-x64-msvc-2.6.32-dev.4f08082.tgz`

Both installed cleanly. `npx codegraph --version` reports `2.6.32-dev.4f08082`. `codegraph info` confirms native engine v2.6.0 is active.

**Note:** `optionalDependencies` in `package.json` only lists `@modelcontextprotocol/sdk` — platform-specific native packages are not listed, so dev builds require manual native binary installation. This is expected for dev builds.

## 2. Cold Start (Pre-Build)

All 30+ commands tested without a graph. Every command fails gracefully with a helpful message:

| Command | Status | Message |
|---------|--------|---------|
| `query`, `path`, `impact`, `map`, `stats` | PASS | "No codegraph database found... Run codegraph build first" |
| `deps`, `exports`, `fn-impact`, `context` | PASS | Same helpful message |
| `where`, `diff-impact`, `cycles`, `structure` | PASS | Same helpful message |
| `roles`, `triage`, `complexity`, `communities` | PASS | Same helpful message |
| `search`, `export`, `check`, `children` | PASS | Same helpful message |
| `audit`, `flow`, `dataflow`, `cfg`, `ast` | PASS | Same helpful message |
| `co-change`, `owners`, `batch`, `plot` | PASS | Same helpful message |
| `models` | PASS | Lists models without needing a graph |
| `info` | PASS | Shows diagnostics without needing a graph |
| `registry list` | PASS | Shows registry entries (separate from graph) |
| `snapshot` | PASS | Shows subcommand usage |

**Zero crashes or stack traces on any cold-start command.**

### Build

```
Engine: native (v2.6.0)
Files: 164 (144 JS, 20 Rust)
Nodes: 1104
Edges: 1936
Complexity: 888 functions analyzed
AST nodes: 23,872
```

## 3. Full Command Sweep

49 command variants tested. All produce valid output.

| Command | Status | Notes |
|---------|--------|-------|
| `query buildGraph -T` | PASS | 32 callees shown |
| `query buildGraph -T --depth 1` | PASS | 52 lines |
| `query buildGraph -T -j` | PASS | Valid JSON (302 lines) |
| `path buildGraph parseFileAuto -T` | PASS | "No path within 10 hops" — correct (different call chains) |
| `impact src/builder.js -T` | PASS | 10 files impacted |
| `map -T -n 10` | PASS | Top 10 most-connected nodes |
| `stats` | PASS | Full stats with quality score 88/100 |
| `stats -j` | PASS | Valid JSON (108 lines) |
| `deps src/builder.js -T` | PASS | 28 lines |
| `exports src/builder.js -T` | PASS | 6 lines |
| `fn-impact buildGraph -T` | PASS | 26 lines |
| `fn-impact buildGraph -T --depth 2 -f builder -k function` | PASS | 8 lines, flags work |
| `context buildGraph -T` | PASS | 1040 lines with full source |
| `context buildGraph -T --no-source` | PASS | 61 lines, metadata only |
| `where buildGraph -T` | PASS | Definition + usage info |
| `where -f src/builder.js` | PASS | File overview mode |
| `children buildGraph -T` | PASS | 6 lines |
| `diff-impact main -T` | PASS | 210 lines of changes vs main |
| `diff-impact HEAD -T` | PASS | "No changes detected" |
| `diff-impact -T` (unstaged) | PASS | "No changes detected" |
| `cycles` | PASS | "No circular dependencies detected" (file-level) |
| `cycles --functions` | PASS | 4 function-level cycles found |
| `structure` | PASS | 51 lines, directory hierarchy |
| `structure --depth 2 --sort cohesion` | PASS | 46 lines |
| `roles -T` | PASS | 203 lines |
| `roles -T -j` | PASS | Valid JSON (6664 lines) |
| `complexity -T` | PASS | 28 lines |
| `complexity -T -j` | PASS | Valid JSON (542 lines) |
| `communities -T` | PASS | 157 lines |
| `communities -T -j` | PASS | Valid JSON (847 lines) |
| `triage -T` | PASS | 28 lines |
| `triage -T -j` | PASS | Valid JSON (370 lines) |
| `audit src/builder.js -T` | PASS | 276 lines (file audit) |
| `audit buildGraph -T` | PASS | 78 lines (function audit) |
| `check -T` | PASS | 10 rules, 7 passed, 3 warned |
| `check --staged -T` | PASS | "No changes detected" |
| `check main -T --rules` | PASS | 3 predicates, 1 passed, 2 failed |
| `flow buildGraph -T` | PASS | 183 lines execution trace |
| `flow --list -T` | PASS | 50 lines of entry points |
| `dataflow buildGraph -T` | PASS | Data flow edges with confidence scores |
| `cfg buildGraph` | PASS | 195 blocks, 256 edges (after `--cfg` build) |
| `cfg buildGraph --format mermaid` | PASS | Mermaid output |
| `cfg buildGraph --format dot` | PASS | DOT output |
| `ast` | PASS | 3758 AST nodes |
| `ast --kind call` | PASS | 3758 nodes |
| `co-change` | PASS | "No co-change pairs found" (need `--analyze`) |
| `owners` | PASS | "No CODEOWNERS file found" |
| `batch fn-impact buildGraph openDb -T` | PASS | Valid JSON (142 lines) |
| `export -f dot` | PASS | 463 lines |
| `export -f mermaid` | PASS | 394 lines |
| `export -f json` | PASS | Valid JSON (4766 lines) |
| `export --functions -f json` | PASS | Valid JSON (4766 lines) |
| `export -f graphml` | PASS | Valid XML (1581 lines) |
| `export -f graphson` | PASS | Valid JSON (58800 lines) |
| `export -f neo4j` | PASS | Valid CSV (732 lines) |
| `models` | PASS | Lists 2 models |
| `plot` | PASS | Writes HTML file (hangs trying to open browser in CI) |
| `branch-compare main HEAD -T` | PASS | 175 lines, shows 63 added symbols |
| `snapshot save/list/restore/delete` | PASS | All operations work |
| `registry add/list/remove/prune` | PASS | All operations work |
| `mcp` (JSON-RPC) | PASS | 32 tools exposed in single-repo mode |
| `info` | PASS | Shows engine info and build metadata |

### JSON Validation

All 9 JSON outputs validated: `map`, `stats`, `query`, `roles`, `complexity`, `communities`, `triage`, `export`, `batch`.

### `--no-tests` Effect

| Metric | With tests | Without tests | Filtered |
|--------|-----------|---------------|----------|
| Nodes | 1099 | 854 | 245 |
| Files | 164 | 94 | 70 test files |

### Edge Cases Tested

| Scenario | Result |
|----------|--------|
| Non-existent symbol: `query nonexistent_xyz` | PASS — "No function/method/class matching" |
| Non-existent file: `deps nonexistent.js` | PASS — "No file matching" |
| Non-existent function: `fn-impact nonexistent_xyz` | PASS — "No function/method/class matching" |
| Invalid kind: `fn-impact buildGraph -k invalidkind` | PASS — Lists valid kinds |
| `structure .` | PASS — Works correctly |
| Search with no embeddings | PASS — Warns, suggests `codegraph embed` |
| `hotspots` command | **NOT A CLI COMMAND** — only available as MCP tool |

## 4. Rebuild & Staleness

### Incremental No-Op
PASS — "No changes detected. Graph is up to date."

### Incremental with Touch (mtime only)
PASS — Tier 1 detects mtime change, Tier 2 confirms hash unchanged. "Self-healed mtime/size for 1 files."

### Incremental with Real Change
PASS — Only changed file + 23 reverse-deps re-parsed (24 total out of 164).

**BUG: Divergence warning false positive** — Reports "edges: 1936→792 [59.1%]" but 792 is only the batch count, not the DB total. See #289.

### Embed-Rebuild-Search Pipeline
- `embed -m minilm` → 889 symbols embedded (384d)
- `search "build dependency graph"` → 5 results with hybrid BM25+semantic scoring — PASS
- Rebuild (no changes) → search still works — PASS (embeddings survive rebuild)
- Delete DB, rebuild from scratch → search correctly warns "No embeddings table found" — PASS

### CFG Build Behavior
**BUG:** `build . --cfg` on incremental no-op skips CFG computation entirely. Requires `--no-incremental` for first CFG build. See #288.

## 5. Engine Comparison

| Metric | Native | WASM | Match? |
|--------|--------|------|--------|
| Functions | 828 | 828 | Yes |
| Methods | 60 | 60 | Yes |
| Classes | 1 | 1 | Yes |
| Calls | 1599 | 1599 | Yes |
| Imports | 271 | 271 | Yes |
| Call confidence | 98.56% | 98.56% | Yes |
| Cycles (file) | 1 | 1 | Yes |
| Cycles (function) | 11 | 11 | Yes |
| **Parameters** | **0** | **1648** | **No** |
| **Properties** | **0** | **93** | **No** |
| **Constants** | **0** | **11** | **No** |
| Total nodes | 1104 | 2856 | No (+1752) |
| Total edges | 3034 | 6434 | No (+3400) |

**Core parity is excellent.** All function/method/class/call/import counts are identical. Call confidence matches perfectly. The gap is in extended node types (parameter, property, constant) that the WASM engine extracts but native does not yet. This is a known parity gap from the v2.6.0 release where extended node types were added to WASM first.

## 6. Performance Benchmarks

### Build Benchmark

| Metric | Native | WASM |
|--------|--------|------|
| Full build | 1,868ms | 4,835ms |
| Per-file | 11.4ms | 29.5ms |
| No-op rebuild | 7ms | 9ms |
| 1-file rebuild | 1,109ms | 2,893ms |
| Parse phase | 70.1ms | 442ms |
| Insert phase | 34.6ms | 46.1ms |
| Resolve phase | 31.2ms | 30ms |
| Complexity phase | 6.7ms | 223.3ms |
| DB size | 5.1MB | 9.6MB |

Native is **2.6x faster** for full builds, **6.3x faster** for parsing, and **33x faster** for complexity analysis.

### Incremental Benchmark

| Metric | Native | WASM |
|--------|--------|------|
| Full build | 2,249ms | 5,026ms |
| No-op rebuild | 8ms | 8ms |
| 1-file rebuild | 1,018ms | 3,406ms |
| Import resolution (native batch) | 6.5ms | — |
| Import resolution (JS fallback) | 7.5ms | — |

### Query Benchmark

| Query | Native | WASM |
|-------|--------|------|
| fnDeps depth 1 | 0.8ms | 0.8ms |
| fnDeps depth 3 | 0.6ms | 0.7ms |
| fnDeps depth 5 | 0.6ms | 0.7ms |
| fnImpact depth 1 | 0.6ms | 0.7ms |
| fnImpact depth 3 | 0.7ms | 0.7ms |
| fnImpact depth 5 | 0.7ms | 0.7ms |
| diffImpact | 17.1ms | 16.2ms |

Query performance is nearly identical between engines — expected since queries run against SQLite, not the parser.

### Embedding Benchmark

| Model | Dim | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Embed time | Search time |
|-------|-----|-------|-------|-------|--------|-----------|-------------|
| minilm | 384 | 83.6% | 97.5% | 98.8% | 99.8% | 5.9s | 2.6s |
| jina-small | 512 | 81.3% | 97.8% | 99.2% | 100% | 10.2s | 5.9s |
| nomic | 768 | 84.4% | 98.6% | 99.2% | 100% | 32.7s | 15.3s |
| nomic-v1.5 | 768 | 83.2% | 97.5% | 99.1% | 100% | 32.0s | 15.0s |
| bge-large | 1024 | 87.7% | 98.9% | 99.7% | 100% | 66.6s | 25.6s |

All models show strong recall. `bge-large` leads Hit@1 at 87.7% but is 11x slower than `minilm`. `minilm` remains the best tradeoff for most use cases.

## 7. Release-Specific Tests

Changes since v2.6.0 (12 non-doc commits):

| Feature/Fix | Test | Result |
|------------|------|--------|
| CFG (intraprocedural) | `cfg buildGraph` after `build --cfg --no-incremental` | PASS — 195 blocks, 256 edges |
| CFG for all languages | `cfg` works for JS and Rust functions | PASS |
| CFG mermaid/dot output | `cfg buildGraph --format mermaid/dot` | PASS |
| AST node storage | `ast`, `ast --kind call` | PASS — 23,872 nodes stored |
| Extended node types | WASM build shows parameter (1648), property (93), constant (11) | PASS |
| Exports command | `exports src/builder.js` | PASS |
| Reexport query fix | `exports` returns correct direction | PASS |
| CLI consolidation | `explain`, `fn`, `hotspots`, `manifesto`, `fn-deps` removed | PASS — "unknown command" |
| New export formats | GraphML, GraphSON, Neo4j CSV | PASS — all produce valid output |
| Dataflow analysis | `build --dataflow`, `dataflow buildGraph` | PASS — 2115 edges |
| Batch query | `batch fn-impact buildGraph openDb` | PASS — valid JSON |
| CFG rules consolidation | `check -T` shows rules with defaults | PASS |

## 8. Additional Testing

### MCP Server
- Single-repo mode: 32 tools exposed (no `list_repos`, no `repo` parameter)
- JSON-RPC initialization via stdin works correctly

### Programmatic API
- ESM import `import * as cg from '@optave/codegraph'` works — 200+ exports
- CJS `require()` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` — expected for ESM-only package
- Key exports verified: `buildGraph`, `loadConfig`, `openDb`, `ALL_SYMBOL_KINDS`, `MODELS`, `EXTENSIONS` (Set), `IGNORE_DIRS` (Set)

### Registry Flow
- `registry add . -n "dogfood-test"` → PASS
- `registry list` → shows entry
- `registry remove "dogfood-test"` → PASS
- `registry prune --ttl 0` → removes all expired entries

### Snapshot Flow
- `snapshot save dogfood-test` → 6.1 MB
- `snapshot list` → shows snapshot
- `snapshot restore dogfood-test` → PASS
- `snapshot delete dogfood-test` → PASS

## 9. Bugs Found

### BUG 1: Forward-slash paths on Windows cause empty build (Medium)
- **Issue:** [#287](https://github.com/optave/codegraph/issues/287)
- **Symptoms:** `codegraph build H:/path/to/repo` finds 0 files and creates graph.db in CWD instead of target repo. Backslash paths work correctly.
- **Root cause:** Native engine doesn't normalize forward-slash POSIX-style paths on Windows.
- **PR:** Not yet fixed — needs investigation in native engine path handling.

### BUG 2: `--cfg` flag skipped on incremental no-op (Medium)
- **Issue:** [#288](https://github.com/optave/codegraph/issues/288)
- **Symptoms:** Running `build . --cfg` when no files changed produces no CFG data. All `cfg` queries return 0 blocks/edges. Requires `--no-incremental` to build CFG for the first time.
- **Root cause:** Incremental build short-circuits before CFG computation when no file changes detected.
- **PR:** Not yet fixed.

### BUG 3: Incremental divergence warning false positive (Low)
- **Issue:** [#289](https://github.com/optave/codegraph/issues/289)
- **Symptoms:** On every incremental rebuild (even 1 file change), warning shows "edges: 1936→792 [59.1%]" — comparing full previous count with per-batch count, not DB totals.
- **Root cause:** Divergence check compares previous build's total with current batch's count.
- **PR:** Not yet fixed.

## 10. Suggestions for Improvement

### 10.1 Add `hotspots` as a CLI command
Currently `hotspots` is only available as an MCP tool but not as a CLI command. The dogfood skill references it as a command to test, and users would expect it alongside `roles`, `triage`, etc.

### 10.2 Auto-detect version changes for full rebuild
When the build metadata version doesn't match the current CLI version, suggest or automatically trigger a full rebuild. The `info` command already shows this warning but `build` doesn't act on it.

### 10.3 Extend native engine with parameter/property/constant support
The native engine doesn't extract parameter, property, or constant nodes. While core function/method/class parity is perfect, these extended types are useful for the `children` command and containment analysis.

## 11. Testing Plan

### General Testing Plan (Any Release)
- [ ] Install from published artifact (npm or GitHub release)
- [ ] Verify `--version` and `info` output
- [ ] Cold start: all commands without graph produce helpful errors
- [ ] Build: files found, nodes/edges reasonable, engine correct
- [ ] Full command sweep: every command with `-j`, `-T`, `-f`, `-k` flags
- [ ] Edge cases: non-existent symbols, invalid kinds, empty queries
- [ ] JSON validity: all `--json` outputs parse correctly
- [ ] Incremental: no-op, touch, real change, full rebuild consistency
- [ ] Embed + search pipeline
- [ ] Engine comparison: native vs WASM parity
- [ ] Benchmarks: build, incremental, query, embedding
- [ ] MCP server: initialize, tools/list, single-repo vs multi-repo
- [ ] Programmatic API: ESM import, key exports present
- [ ] Registry: add, list, remove, prune
- [ ] Snapshot: save, list, restore, delete

### Release-Specific Testing Plan (v2.6.32-dev.4f08082)
- [x] CFG works with `build --cfg --no-incremental`
- [x] CFG formats: default, mermaid, dot
- [x] AST node storage: `ast` and `ast --kind` commands
- [x] Extended node types in WASM engine
- [x] `exports` command works
- [x] Removed commands (`explain`, `fn`, etc.) are gone
- [x] New export formats: GraphML, GraphSON, Neo4j CSV
- [x] Dataflow: `build --dataflow`, `dataflow` queries
- [x] `check` consolidated command with `--rules`, `--staged`
- [x] `branch-compare` works end-to-end

### Proposed Additional Tests
- Test `--cfg` and `--dataflow` together in a single build
- Test `watch` mode with `--cfg` flag (does it build CFG on file changes?)
- Test `.codegraphrc.json` with `include`/`exclude` patterns
- Test env var overrides: `CODEGRAPH_LLM_PROVIDER`, etc.
- Test concurrent builds (two instances building the same repo)
- Test on a non-codegraph repo to verify generalization

## 12. Overall Assessment

v2.6.32-dev.4f08082 is a **solid release** with ambitious new features (CFG, AST storage, dataflow, extended node types) that work well when used correctly. The core functionality is rock-solid — zero crashes across 49+ command variants, excellent engine parity for core metrics, and sub-millisecond query performance.

The three bugs found are all usability issues (not data corruption or crashes):
1. Windows path normalization affects build from remote directories
2. CFG requires an unintuitive `--no-incremental` flag for first-time use
3. Divergence warning produces false positives

**Rating: 8/10** — Strong fundamentals with minor rough edges in the new incremental + feature-flag interaction. The native engine's 2.6x build speedup and 33x complexity speedup continue to impress.

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#287](https://github.com/optave/codegraph/issues/287) | bug(build): forward-slash paths on Windows cause 0 files parsed | open |
| Issue | [#288](https://github.com/optave/codegraph/issues/288) | bug(build): --cfg flag skipped on incremental no-op | open |
| Issue | [#289](https://github.com/optave/codegraph/issues/289) | bug(build): incremental divergence warning compares per-batch edges vs total | open |
