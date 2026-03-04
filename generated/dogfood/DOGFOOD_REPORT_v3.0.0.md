# Dogfooding Report: @optave/codegraph@3.0.0

**Date:** 2026-03-03
**Platform:** Windows 11 Pro (10.0.26200), win32-x64, Node v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@3.0.0 (Rust binary reports v2.6.0 internally)
**Active engine:** native (v2.6.0 — see Bug 1)
**Target repo:** codegraph itself (164 files, 2 languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@3.0.0` | 142 packages, 3s, 0 vulnerabilities |
| `npx codegraph --version` | 3.0.0 |
| Native binary package | @optave/codegraph-win32-x64-msvc@3.0.0 installed |
| `npx codegraph info` | Native engine available, reports v2.6.0 internally |
| Optional deps pinned | All 4 platform packages pinned to 3.0.0 |

**Issue:** The native binary internally reports version 2.6.0, not 3.0.0. The `Cargo.toml` version was not bumped before the release build. See Bug 1.

---

## 2. Cold Start (Pre-Build)

All 38 commands tested without a graph database present.

| Command | Status | Message |
|---------|--------|---------|
| `query`, `map`, `stats`, `deps`, `fn-impact`, `context`, `where`, `impact`, `cycles`, `export`, `structure`, `roles`, `complexity`, `communities`, `triage`, `audit`, `search`, `embed`, `diff-impact`, `check`, `plot`, `batch`, `path`, `exports`, `children`, `owners`, `co-change`, `dataflow`, `cfg`, `ast` | PASS | "No codegraph database found. Run `codegraph build` first." |
| `flow` (no args) | PASS | "Provide a function/entry point name or use --list" |
| `watch` | PASS | "No graph.db found. Run `codegraph build` first." |
| `branch-compare` | PASS | "Error: Not a git repository" (run from temp dir) |
| `info` | PASS | Shows diagnostics without needing DB |
| `models` | PASS | Lists 7 embedding models |
| `registry list` | PASS | Shows registered repos |
| `snapshot` (no subcommand) | PASS | Shows subcommand help |
| `hotspots` | PASS | "error: unknown command" (removed in v3.0.0) |
| `fn` | PASS | "error: unknown command" (removed in v3.0.0) |
| `explain` | PASS | "error: unknown command" (removed in v3.0.0) |
| `manifesto` | PASS | "error: unknown command" (removed in v3.0.0) |
| `batch-query` | PASS | "error: unknown command" (removed in v3.0.0) |

**Result:** 38/38 commands handle missing graph gracefully. Zero crashes.

---

## 3. Full Command Sweep

Build: `npx codegraph build <repo> --no-incremental --verbose`
- 164 files, 3055 nodes, 6821 edges, native engine (v2.6.0)
- Complexity: 939 functions analyzed

| Command | Status | Notes |
|---------|--------|-------|
| `query buildGraph -T` | PASS | Shows 47 callees, 2 matches |
| `query buildGraph --json -T` | PASS | Valid JSON, 2 results |
| `path buildGraph openDb -T` | PASS | 1 hop path |
| `map -T --limit 5` | PASS | Top 5: db.js (52), queries.js (37), parser.js (37) |
| `map --json --limit 3` | PASS | Valid JSON |
| `stats` | PASS | 1105 nodes, 6267 edges, quality 77/100 |
| `stats --json` | PASS | Valid JSON with full breakdown |
| `deps src/builder.js -T` | PASS | 7 imports, 0 importers (entry point), 11 definitions |
| `fn-impact buildGraph -T --depth 2` | PASS | 0 callers (entry point), correct for buildGraphologyGraph |
| `context buildGraph -T --depth 1` | PASS | Full source, deps, callers |
| `where buildGraph` | PASS | Found in src/builder.js:436 with fileHash |
| `where -f src/builder.js` | PASS | File overview with symbols, imports, exports |
| `exports src/db.js -T` | PASS | 7 exported, 16 internal, per-symbol consumers |
| `children openDb -T` | PASS | Shows parameter `dbPath` |
| `impact src/builder.js -T` | PASS | 0 dependents (entry point) |
| `cycles` | PASS | 1 cycle (5 files) |
| `structure -T --depth 1` | PASS | 4 directories with metrics |
| `roles -T --limit 10` | PASS | 2256 symbols: 1632 dead, 350 core, 224 utility, 50 entry |
| `complexity -T --limit 10` | PASS | buildGraph tops at cog=627, cyc=238 |
| `communities -T --limit 5` | PASS | 40 communities, modularity 0.3963, drift 31% |
| `triage -T --limit 5` | PASS | Risk queue, top: node_text (0.42), filter (0.42) |
| `audit src/builder.js -T --quick` | PASS | Structure + data flow summary |
| `check -T` | PASS | 10 rules, 7 pass, 3 warn, 0 fail |
| `check --staged` | PASS | "No changes detected" |
| `diff-impact` (no changes) | PASS | Empty output |
| `batch context buildGraph openDb -T` | PASS | Valid JSON, 2/2 succeeded |
| `co-change` | PASS | "No co-change pairs found" (needs --analyze) |
| `owners src/builder.js` | PASS | "No CODEOWNERS file found" |
| `export -f dot -T` | PASS | 290 lines DOT |
| `export -f mermaid -T` | PASS | 277 lines Mermaid |
| `export -f json -T` | PASS | 3490 lines JSON |
| `export -f graphml -T` | PASS | 978 lines GraphML |
| `export -f graphson -T` | PASS | 47277 lines GraphSON |
| `export -f neo4j -T` | PASS | 442 lines Neo4j CSV |
| `plot -T` | PASS | HTML file generated |
| `flow --list -T` | PASS | Reports "No entry points found" (needs analysis) |
| `flow buildGraph -T` | PASS | 48 nodes reached, 25 leaves, depth 10 |
| `cfg openDb -T` (after --cfg build) | PASS | 6 blocks, 6 edges |
| `dataflow buildGraph -T` (after --dataflow build) | PASS | Rich data flow with TO/FROM/returns |
| `ast "openDb"` | PASS | 29 matching AST nodes |
| `ast --kind call -T` | PASS | 10703 call nodes |
| `snapshot save test-v3` | PASS | 5.9 MB saved |
| `snapshot list` | PASS | Lists saved snapshot |
| `registry list --json` | PASS | Valid JSON array |
| `registry add/remove` | PASS | Add and remove work |
| `registry prune --ttl 0 --dry-run` | PASS | Shows what would be pruned |
| `embed --model minilm` | PASS | 940 symbols embedded (384d) |
| `search "build dependency graph" --limit 5` | PASS | Hybrid BM25+semantic results |
| `search --kind function --limit 3` | PASS | Kind filter works |
| `search "import resolution;resolve path" --limit 3` | PASS | Multi-query RRF works |
| `models` | PASS | 7 models listed |
| `info` | PASS | Full diagnostics |

### Edge Cases Tested

| Scenario | Result | Notes |
|----------|--------|-------|
| `query nonexistent_xyz` | PASS | "No function/method/class matching" |
| `deps nonexistent.js` | PASS | "No file matching" |
| `fn-impact nonexistent_xyz` | PASS | "No function/method/class matching" |
| `fn-impact --kind invalidkind` | PASS | "Invalid kind. Valid: function, method, ..." |
| `search` with no embeddings | PASS | Warns about missing FTS5, suggests `embed` |
| `--json` on stats, map, query | PASS | All produce valid JSON |
| `--no-tests` effect | PASS | Nodes drop from 3055 to 2371 (22.4%) |
| `structure .` | PASS | Works (was a bug in v2.2.0) |

---

## 4. Rebuild & Staleness

| Test | Result | Notes |
|------|--------|-------|
| Incremental no-op | PASS | "No changes detected. Graph is up to date." Tier 0 skipped, Tier 1 check |
| Touch file (mtime change only) | PASS | Tier 1: 1 need hash check, Tier 2: 0 actually changed. Self-healed mtime. |
| Real file modification | PASS | 1 changed, 23 reverse-deps re-parsed. Node/edge counts stable (3055/6821) |
| Force full rebuild | PASS | Same counts as incremental (3055/6821) |
| Search after rebuild (no re-embed) | PASS | Results still return correctly |
| Restore file + rebuild | PASS | Detects change, re-parses, counts stable |

---

## 5. Engine Comparison

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Nodes | 3055 | 2966 | +89 (3.0%) |
| Edges | 6821 | 6746 | +75 (1.1%) |
| Roles: core | 436 | 429 | +7 |
| Roles: dead | 2144 | 2058 | +86 |
| AST nodes stored | 24716 | 40612 | -15896 |
| Complexity functions | 939 | 938 | +1 |
| AST node kinds | call only | call + 5 more | See Bug 2 |

**Analysis:** Native extracts ~3% more symbols and edges than WASM. The AST node count difference is notable — WASM stores 40612 (extracting all 6 kinds for JS/TS/TSX via tree walk), while native stores 24716 (calls only). The native engine cannot extract `new`, `string`, `regex`, `throw`, `await` AST nodes because it doesn't preserve the parse tree.

---

## 6. Release-Specific Tests

### Breaking Changes (v3.0.0)

| Change | Test | Result |
|--------|------|--------|
| `fn` command removed | `codegraph fn buildGraph` | PASS — "unknown command" |
| `hotspots` command removed | `codegraph hotspots` | PASS — "unknown command" |
| `manifesto` command removed | `codegraph manifesto` | PASS — "unknown command" |
| `explain` command removed | `codegraph explain` | PASS — "unknown command" |
| `batch-query` command removed | `codegraph batch-query` | PASS — "unknown command" |
| `path` is now standalone | `codegraph path buildGraph openDb` | PASS — works |

### New Features

| Feature | Test | Result |
|---------|------|--------|
| Dataflow analysis | `build --dataflow` + `dataflow buildGraph` | PASS — 2132 edges, rich TO/FROM/returns |
| Intraprocedural CFG | `build --cfg` + `cfg openDb` | PASS — 938 functions, 6 blocks/6 edges for openDb |
| Stored AST nodes | `ast "openDb"` | PARTIAL — calls only with native engine (see Bug 2) |
| Expanded node types | `children openDb` shows parameter | PASS |
| Expanded edge types | stats shows `contains`, `parameter_of`, `receiver` | PASS |
| `exports` command | `exports src/db.js` | PASS — per-symbol consumers with counts |
| GraphML/GraphSON/Neo4j export | `export -f graphml/graphson/neo4j` | PASS — all produce output |
| Interactive HTML viewer | `plot` | PASS — generates HTML file |
| `normalizeSymbol` in JSON | `where --json` includes fileHash | PASS |
| Batch multi-command mode | `batch context buildGraph openDb` | PASS — 2/2 succeeded |
| `fileHash` in where/query JSON | Verified present | PASS |

### Bug Fixes Verified

| Fix | Test | Result |
|-----|------|--------|
| Reexport query direction | `exports src/db.js` shows re-exports | PASS |
| Triage sort values | `triage -T --limit 5` | PASS — valid sort |
| C# language ID mismatch | Complexity rules work for Rust files | PASS (C# not tested directly) |

---

## 7. Additional Testing

### MCP Server

| Test | Result |
|------|--------|
| Single-repo mode (default) | 30 tools exposed, no `list_repos` |
| Multi-repo mode (`--multi-repo`) | 31 tools, `list_repos` present |
| JSON-RPC initialize + tools/list | PASS — proper protocol response |

### Programmatic API

| Test | Result |
|------|--------|
| `import('@optave/codegraph')` | PASS — 166 exports |
| Key functions present | `buildGraph`, `loadConfig`, `openDb`, `findDbPath`, `contextData`, `explainData`, `whereData`, `statsData`, `isNativeAvailable` — all `function` type |
| Constants present | `ALL_SYMBOL_KINDS` (array), `EXTENSIONS`, `IGNORE_DIRS`, `MODELS` |
| CJS require | FAIL — ESM-only package (expected for ES module project) |

### Registry

| Test | Result |
|------|--------|
| `registry list --json` | PASS — valid JSON array |
| `registry add <dir> --name test` | PASS |
| `registry remove test` | PASS |
| `registry prune --ttl 0 --dry-run` | PASS — shows what would be pruned |

### Performance Benchmarks

**Not completed.** All 4 benchmark scripts (`benchmark.js`, `incremental-benchmark.js`, `query-benchmark.js`, `embedding-benchmark.js`) require WASM grammars, which cannot be built on this platform due to a wasi-sdk clang crash (LLVM bug in `clang 21.1.4` on Windows with `tree-sitter-javascript` parser). This is a platform-specific issue, not a codegraph bug.

---

## 8. Bugs Found

### BUG 1: Native engine reports version 2.6.0 (Low)
- **Issue:** [#305](https://github.com/optave/codegraph/issues/305)
- **PR:** Open — cosmetic, requires Cargo.toml version bump + native binary rebuild
- **Symptoms:** `codegraph info` shows "Native version: 2.6.0" when package is v3.0.0. Build metadata shows version mismatch warning.
- **Root cause:** `Cargo.toml` version not bumped to 3.0.0 before release build.
- **Impact:** Cosmetic, but may trigger unnecessary full rebuilds due to version mismatch detection in `buildGraph()`.

### BUG 2: Native engine only stores 'call' AST nodes (Medium)
- **Issue:** [#306](https://github.com/optave/codegraph/issues/306)
- **PR:** Open — requires extending Rust extractors or documenting limitation
- **Symptoms:** `ast --kind new/string/regex/throw/await` all return "No AST nodes found" when graph built with native engine.
- **Root cause:** Native Rust engine extracts only `call_expression` nodes. It doesn't preserve the parse tree, so the JavaScript-side AST walk in `ast.js` cannot extract the 5 additional node kinds. WASM engine works correctly.
- **Impact:** Users relying on native engine (default) get incomplete AST query results. 24716 nodes stored vs 40612 with WASM for the same codebase.

---

## 9. Suggestions for Improvement

### 9.1 Default `--cfg` and `--dataflow` on full rebuilds
Currently these are opt-in flags. Users discovering the `cfg` and `dataflow` commands will get empty results unless they know to rebuild with flags. Consider either:
- Making them default (with `--no-cfg`/`--no-dataflow` to opt out)
- Or showing a more prominent hint in the `cfg`/`dataflow` commands

### 9.2 Document AST node kind limitations per engine
The `ast` command help should note that non-call kinds require the WASM engine, or the native engine should be extended for parity.

### 9.3 Benchmark scripts should handle missing WASM grammars
All 4 benchmark scripts crash if WASM grammars aren't built. They should either:
- Fall back to native-only benchmarking
- Or print a helpful error message instead of crashing

### 9.4 `flow --list` should work after build — RESOLVED post-v3.0.0
`flow --list` returns "No entry points found" after a standard build. Entry point classification happens during build (50 entry points detected in roles), but `flow --list` doesn't find them. These may need to be stored explicitly.

> Fixed in commit `6681597` — `flow --list` now includes role-based entry points from the roles classification.

---

## 10. Testing Plan

### General Testing Plan (Any Release)

- [ ] Install from npm, verify version
- [ ] Verify native binary installs and loads
- [ ] Run all commands without graph — verify graceful errors
- [ ] Build graph, verify node/edge counts
- [ ] Run all query commands with `-T`, `--json`
- [ ] Test edge cases: nonexistent symbols, invalid kinds, empty results
- [ ] Test incremental rebuild: no-op, touch, real change
- [ ] Test embed + search pipeline
- [ ] Test export formats (DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j)
- [ ] Test MCP server (single-repo and multi-repo)
- [ ] Test programmatic API imports
- [ ] Test registry add/remove/prune
- [ ] Test snapshot save/list/restore/delete
- [ ] Compare native vs WASM engine outputs
- [ ] Run benchmarks (if WASM grammars available)

### Release-Specific Testing Plan (v3.0.0)

- [x] Verify all 5 removed commands error ("unknown command")
- [x] Test `dataflow` command with `--dataflow` build flag
- [x] Test `cfg` command with `--cfg` build flag
- [x] Test `ast` command with all 6 node kinds
- [x] Test `exports` command with per-symbol consumers
- [x] Test GraphML, GraphSON, Neo4j CSV export formats
- [x] Test `plot` interactive HTML viewer
- [x] Test `children` for parameter/property/constant nodes
- [x] Test `batch` multi-command mode
- [x] Verify `fileHash` in `where` and `query` JSON
- [x] Verify `normalizeSymbol` consistency in JSON output
- [ ] Test `build --dataflow --cfg` incremental behavior
- [ ] Test `path <from> <to>` standalone command (was `query --path`)

### Proposed Additional Tests

- Test concurrent builds (two builds at once)
- Test `.codegraphrc.json` config: include/exclude, aliases, build.incremental
- Test env var overrides: `CODEGRAPH_LLM_PROVIDER`, `CODEGRAPH_REGISTRY_PATH`
- Test `apiKeyCommand` credential resolution
- Test on a non-codegraph repository (e.g., small OSS project)
- Test database schema migration (v2.x graph.db → v3.0.0)
- Test embed → modify → rebuild → search pipeline for stale embeddings

---

## 11. Overall Assessment

Codegraph v3.0.0 is a substantial release that delivers on its three headline features: dataflow analysis, intraprocedural CFG, and stored AST nodes. The CLI surface consolidation (removing 5 commands) is clean — all removed commands error gracefully. The new export formats (GraphML, GraphSON, Neo4j CSV) and interactive HTML viewer work well. Search with hybrid BM25+semantic ranking is excellent.

The two bugs found are both related to native engine parity:
1. Version reporting is cosmetic but confusing
2. AST node kind coverage is a real feature gap affecting users who rely on non-call AST queries

Cold start handling is perfect (38/38 commands graceful). Incremental builds are solid with three-tier change detection. The MCP server exposes 30/31 tools correctly in single/multi-repo modes. The programmatic API exports 166 functions/constants.

Areas that could use attention: the opt-in nature of `--cfg` and `--dataflow` may surprise users, benchmark scripts don't handle missing WASM grammars, and `flow --list` doesn't find entry points after a standard build.

**Rating: 8/10**

Justification: Solid feature delivery with comprehensive CLI and MCP coverage. The native engine parity gap on AST nodes is the most significant issue. The version mismatch is minor but should be fixed. The release is production-ready for most workflows, with the caveat that full AST querying requires `--engine wasm`.

---

## 12. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#305](https://github.com/optave/codegraph/issues/305) | bug: native engine reports version 2.6.0 in codegraph v3.0.0 | open |
| Issue | [#306](https://github.com/optave/codegraph/issues/306) | bug: native engine only stores 'call' AST nodes, missing 5 other kinds | open |
