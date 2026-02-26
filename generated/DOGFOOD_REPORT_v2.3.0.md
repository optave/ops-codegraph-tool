# Dogfooding Report: @optave/codegraph@2.3.0

**Date:** 2026-02-25
**Platform:** Windows 11 Pro (win32-x64), Node.js v22.18.0
**Native binary:** @optave/codegraph-win32-x64-msvc@2.3.0
**Active engine:** native (v0.1.0), auto-detected
**Target repo:** codegraph itself (99 files, 2 languages: JS 80, Rust 19)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@2.3.0` | 207 packages, 6s, 0 vulnerabilities |
| `npx codegraph --version` | `2.3.0` |
| Native binary package | `@optave/codegraph-win32-x64-msvc@2.3.0` present |
| `optionalDependencies` pinned | All 4 platform packages pinned to `2.3.0` |
| `npx codegraph info` | `engine: native (v0.1.0)` |

Installation is clean. Native binary loads correctly. All platform packages properly version-pinned.

---

## 2. Cold Start (Pre-Build)

Every command was tested against a non-existent database path before building:

| Command | Status | Message |
|---------|--------|---------|
| `query buildGraph` | PASS | "No codegraph database found... Run `codegraph build` first" |
| `stats` | PASS | Same graceful message |
| `cycles` | PASS | Same graceful message |
| `export` | PASS | Same graceful message |
| `embed` | PASS | Same graceful message (note: `--db` not supported on `embed`) |
| `search "test"` | PASS | Same graceful message |
| `map` | PASS | Same graceful message |
| `deps src/cli.js` | PASS | Same graceful message |
| `fn buildGraph` | PASS | Same graceful message |
| `fn-impact buildGraph` | PASS | Same graceful message |
| `context buildGraph` | PASS | Same graceful message |
| `explain src/cli.js` | PASS | Same graceful message |
| `where buildGraph` | PASS | Same graceful message |
| `impact src/cli.js` | PASS | Same graceful message |
| `diff-impact` | PASS | Same graceful message |
| `structure` | PASS | Same graceful message |
| `hotspots` | PASS | Same graceful message |
| `models` | PASS | Lists 7 models (no DB needed) |
| `registry list` | PASS | Lists registered repos (no DB needed) |
| `info` | PASS | Engine diagnostics (no DB needed) |

**All 20 commands pass cold-start gracefully.** No crashes, no stack traces.

---

## 3. Full Command Sweep

### Build

```
codegraph build <repo> --engine native --no-incremental --verbose
```
- 99 files parsed, 576 nodes, 787 edges (build output)
- Stats: 898 edges (includes 111 `contains` edges added by structure analysis)
- Time: sub-second

### Query Commands

| Command | Flags Tested | Status | Notes |
|---------|-------------|--------|-------|
| `query <name>` | `-T`, `-j`, `--db` | PASS | `--depth` not supported (not in help) |
| `impact <file>` | default | PASS | Shows 6 transitive dependents |
| `map` | `-n 10`, `-j` | PASS | Coupling score present in JSON |
| `stats` | `-j` | PASS | Valid JSON, 82/100 quality |
| `deps <file>` | default | PASS | Shows imports and importers |
| `fn <name>` | `--depth 2`, `-f`, `-k`, `-T`, `-j` | PASS | All flags work |
| `fn-impact <name>` | `-T`, `-j` | PASS | 5 transitive dependents |
| `context <name>` | `--depth`, `--no-source`, `--with-test-source`, `-j` | PASS | Source included by default |
| `explain <target>` | file path, function name, `--depth 2`, `-j` | PASS | Structural summary accurate |
| `where <name>` | default, `-f <file>`, `-j` | PASS | Fast lookup, file overview mode works |
| `diff-impact [ref]` | `main`, `HEAD`, `--staged`, `--format mermaid`, `-j` | PASS | Mermaid output generates flowchart |
| `cycles` | default, `--functions` | PASS | 1 file-level, 2 function-level cycles |
| `structure [dir]` | `.`, `--depth 1`, `--sort cohesion/fan-in`, `-j` | PASS | `.` filter works (v2.2.0 bug fixed) |
| `hotspots` | `--metric fan-in/fan-out/density/coupling`, `--level file/directory`, `-n`, `-j` | PASS | All metrics and levels work |

### Export Commands

| Command | Flags | Status | Notes |
|---------|-------|--------|-------|
| `export -f dot` | default, `--functions`, `--min-confidence` | PASS | Valid DOT graph |
| `export -f mermaid` | default | PASS | Valid Mermaid syntax |
| `export -f json` | `-o <file>` | PASS | 69KB JSON file written |

### Embedding & Search

| Command | Flags | Status | Notes |
|---------|-------|--------|-------|
| `models` | default | PASS | 7 models listed |
| `embed` | `-m minilm`, `--strategy structured` | PASS | 434 symbols embedded |
| `embed` | `--strategy source` | PASS | 434 symbols, 111 truncation warnings |
| `search` | `-n`, `--min-score`, `-k`, `--file`, multi-query `;` | PASS | Relevant results, buildGraph tops "build graph" query |
| `search --json` | N/A | MISSING | `-j/--json` flag not available on search |

### Infrastructure Commands

| Command | Status | Notes |
|---------|--------|-------|
| `info` | PASS | Shows version, engine, platform |
| `--version` | PASS | `2.3.0` |
| `registry list` | PASS | Lists registered repos, `-j` works |
| `registry add` | PASS | Custom name with `-n` |
| `registry remove` | PASS | Removes by name |
| `registry prune --ttl 0` | PASS | Prunes expired entries |
| `mcp` (single-repo) | PASS | 16 tools, no `list_repos`, no `repo` param |
| `mcp --multi-repo` | PASS | 17 tools, `list_repos` present, `repo` param on tools |

### Edge Cases

| Scenario | Result | Status |
|----------|--------|--------|
| Non-existent symbol: `query nonexistent` | "No results" | PASS |
| Non-existent file: `deps nonexistent.js` | "No file matching" | PASS |
| Non-existent function: `fn nonexistent` | "No function/method/class matching" | PASS |
| `--kind invalid` | "Invalid kind... Valid: function, method, ..." | PASS |
| `search` with no embeddings | "No embeddings found. Run `codegraph embed` first." | PASS |
| `--json` on all commands | Valid JSON (tested: stats, map, hotspots, fn, context, where, explain, structure, registry) | PASS |
| `--no-tests` effect | Reduces callers from 7 to 4 for buildGraph | PASS |
| Pipe output: `map --json 2>/dev/null` | Clean JSON on stdout | PASS |
| `build --no-incremental` | Force full rebuild | PASS |
| `build --verbose` | Per-file parsing details | PASS |

### JSON Output Validation

All commands that support `-j/--json` produce valid JSON:
- `stats`, `map`, `hotspots`, `fn`, `fn-impact`, `context`, `where`, `explain`, `structure`, `query`, `registry list`, `diff-impact`, `export -f json`

---

## 4. Rebuild & Staleness

### Incremental No-Op
```
Graph is up to date.
```
PASS — no files re-parsed when nothing changed.

### Three-Tier Change Detection
- **Touch only (mtime change):** "Self-healed mtime/size for 1 files" — content hash verified, no re-parse. PASS.
- **Content change:** Tier 1 detects mtime+size change → Tier 2 confirms hash change → 1 file re-parsed. PASS.

### Embed → Rebuild → Search Pipeline
1. Build embeddings (434 symbols) → search "build graph" → buildGraph ranks #1 (46.4%). PASS.
2. Touch file → rebuild → search still works (embeddings remain valid for unchanged symbols). PASS.
3. Delete DB → rebuild from scratch → "No embeddings table found" on search. PASS.

### DB Migrations
Deleting `graph.db` and rebuilding triggers migrations v1→v4. PASS.

### Incremental Build Structure Bug (FIXED)
See Bug #1 below. Incremental builds corrupted structure data by clearing ALL `contains` edges but only rebuilding for changed files. **Fixed in this session.**

---

## 5. Engine Comparison

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Nodes | 576 | 576 | 0 |
| Edges (total) | 898 | 898 | 0 |
| Calls | 647 | 647 | 0 |
| Imports | 115 | 115 | 0 |
| Contains | 111 | 111 | 0 |
| Reexports | 25 | 25 | 0 |
| Files | 99 | 99 | 0 |
| Quality Score | 82/100 | 82/100 | 0 |
| Caller Coverage | 56.6% | 56.6% | 0% |
| Call Confidence | 97.8% | 97.8% | 0% |
| Cycles (file) | 1 | 1 | 0 |
| Cycles (fn) | 2 | 2 | 0 |

**Perfect engine parity.** Both engines produce identical results across all metrics. This is a significant improvement over v2.1.0 which had parity gaps.

### Performance Benchmarks

#### Build Benchmark (`scripts/benchmark.js`)

| Metric | v2.1.0 WASM (92 files) | v2.3.0 WASM (99 files) | Per-file delta |
|--------|----------------------|----------------------|----------------|
| Build time | 609ms (6.6ms/file) | 509ms (5.1ms/file) | -22% per file |
| Query time | 1.9ms | 1.8ms | -5% |
| Nodes | 527 (5.7/file) | 575 (5.8/file) | +2% |
| Edges | 814 (8.8/file) | 897 (9.1/file) | +3% |
| DB size | 344KB (3829B/file) | 372KB (3848B/file) | +0.5% |

Build performance improved 22% per file vs v2.1.0. Node/edge counts grew slightly as the codebase grew from 92→99 files. No regressions.

#### Incremental Benchmark (`scripts/incremental-benchmark.js`)

| Metric | v2.3.0 WASM |
|--------|-------------|
| Full build | 474ms |
| No-op rebuild | 4ms |
| 1-file rebuild | 144ms |
| Import resolution (84 pairs) | 1.9ms |

No-op rebuilds complete in 4ms. Single-file incremental rebuilds take ~144ms (30% of full build for 1% of files).

#### Query Benchmark (`scripts/query-benchmark.js`)

| Metric | v2.3.0 WASM |
|--------|-------------|
| fnDeps depth 1 | 0.7ms |
| fnDeps depth 3 | 1.8ms |
| fnDeps depth 5 | 1.8ms |
| fnImpact depth 1 | 0.7ms |
| fnImpact depth 3 | 1.3ms |
| fnImpact depth 5 | 1.3ms |
| diff-impact | 13.7ms |

Sub-2ms for all function-level queries. No depth scaling issues.

#### Embedding Benchmark (`scripts/embedding-benchmark.js`)

| Model | Hit@1 | Hit@3 | Hit@5 | Misses |
|-------|-------|-------|-------|--------|
| minilm (default) | 252/329 (76.6%) | 312/329 (94.8%) | 322/329 (97.9%) | 2 |
| jina-small | 256/329 (77.8%) | 318/329 (96.7%) | 324/329 (98.5%) | 2 |
| jina-base | 248/329 (75.4%) | 311/329 (94.5%) | 320/329 (97.3%) | 3 |
| nomic | 278/329 (84.5%) | 326/329 (99.1%) | 329/329 (100%) | 0 |
| nomic-v1.5 | 274/329 (83.3%) | 323/329 (98.2%) | 329/329 (100%) | 0 |
| bge-large | FAIL (ONNX load error on Windows) | — | — | — |

nomic and nomic-v1.5 achieve perfect Hit@5 (100%) with 0 misses. minilm (default) achieves strong 97.9% Hit@5 with the smallest model size.

#### Fix Impact: Incremental Structure Rebuild (PR #91)

| Metric | Before (main) | After (fix) | Delta |
|--------|--------------|-------------|-------|
| Full build | 416ms | 439ms | +23ms (+5.5%) |
| No-op rebuild | 4ms | 4ms | 0 |
| 1-file rebuild | 125ms | 159ms | +34ms (+27%) |
| Import resolution | 2.0ms | 1.9ms | -0.1ms |

The fix adds ~34ms to 1-file incremental rebuilds (loading 98 unchanged files from DB for structure rebuild). Acceptable trade-off for correct structure data.

---

## 6. Release-Specific Tests

### v2.3.0 CHANGELOG Features

| Feature | Test | Result |
|---------|------|--------|
| Graph-enriched embedding strategy (`--strategy structured`) | `embed -m minilm --strategy structured` → 434 symbols, ~100 tokens avg | PASS |
| `--strategy source` option | `embed --strategy source` → 434 symbols, 111 truncated | PASS |
| Context overflow detection | Warning: "111 symbol(s) exceeded model context window (256 tokens)" | PASS |
| `excludeTests` config option | `{ "query": { "excludeTests": true } }` → test files hidden | PASS |
| `--include-tests` CLI override | Overrides config, shows test files | PASS |
| `--depth` on `explain` | `explain src/builder.js --depth 2` → includes recursive deps | PASS |
| Coupling score in `map` | `map -j` → `topNodes[].coupling` field present | PASS |
| Mermaid output in `diff-impact` | `diff-impact main --format mermaid` → flowchart output | PASS |
| `--min-confidence` on export | `export -f dot --min-confidence 0.5` → filters low-confidence edges | PASS |
| `/dogfood` skill | Currently running! | PASS |

### v2.3.0 Bug Fixes Verified

| Fix | Test | Result |
|-----|------|--------|
| Graceful error for `cycles`/`export`/`embed` with no DB | All tested pre-build | PASS |
| Default model changed to minilm | `embed` without `-m` uses minilm | PASS |
| `splitIdentifier` camelCase fix | Search "build graph" → `buildGraph` ranks high | PASS |
| `structure .` treated as no filter | `structure .` shows full project | PASS |
| Engine status messages to stderr | `build 2>/dev/null` produces no stdout | PASS |
| `--with-test-source` rename | `context --with-test-source` works, old `--include-test-source` gone | PASS |
| Embedding invalidation on node deletion | Orphan warning mechanism in builder.js | VERIFIED in code |

---

## 7. Additional Testing

### Programmatic API

ESM import of `@optave/codegraph` exports all expected symbols:
- Functions: `buildGraph`, `loadConfig`, `openDb`, `findDbPath`, `contextData`, `explainData`, `whereData`, `fnDepsData`, `diffImpactData`, `statsData`, `isNativeAvailable`, and 40+ more
- Constants: `ALL_SYMBOL_KINDS` (10 kinds), `EXTENSIONS` (15 extensions), `MODELS` (7 models), `IGNORE_DIRS`, `FALSE_POSITIVE_NAMES`
- CJS `require()` correctly fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` (ESM-only package)

### MCP Server

| Mode | Tools | `list_repos` | `repo` param | Status |
|------|-------|-------------|-------------|--------|
| Single-repo (default) | 16 | absent | absent | PASS |
| `--multi-repo` | 17 | present | present | PASS |

MCP initializes via JSON-RPC, responds to `tools/list`, correct tool schemas.

### Config & Registry

- `.codegraphrc.json` with `query.excludeTests: true` → works
- `registry add/list/remove/prune` → all work
- `registry list -j` → valid JSON with timestamps

### Version Upgrade Path
- Incremental build on a graph from a previous version says "Graph is up to date" even if the engine version changed. Users should run `--no-incremental` after upgrading to ensure consistent data. (Not a bug per se, but worth documenting.)

---

## 8. Bugs Found

### BUG 1: Incremental builds corrupt structure/contains edges (Medium)
- **Issue:** [#89](https://github.com/optave/codegraph/issues/89)
- **PR:** [#91](https://github.com/optave/codegraph/pull/91)
- **Symptoms:** After any incremental build, `codegraph structure` shows most directories as "0 files, 0 symbols". Only the changed file's directory retains data. `contains` edges drop from 111 to ~15.
- **Root cause:** `buildStructure()` unconditionally clears ALL `contains` edges and directory nodes (`DELETE FROM edges WHERE kind = 'contains'`), then only rebuilds for files in `fileSymbols` — which during incremental builds only contains changed files.
- **Fix applied:** Before calling `buildStructure`, load all existing file nodes from the DB into `fileSymbols` and `lineCountMap` so the complete file set is available for structure rebuild. 37 lines added to `builder.js`. All 491 tests pass.

### Enhancement: `search` command missing `--json` flag (Low)
- **Issue:** [#90](https://github.com/optave/codegraph/issues/90)
- **PR:** N/A — enhancement, not a bug fix
- **Description:** All other query commands support `-j/--json` but `search` does not. Running `search -j` returns "unknown option '-j'".

---

## 9. Suggestions for Improvement

### 9.1 Add `--json` to `search` command
Every other query command supports JSON output. `search` is the only holdout, which breaks automation workflows.

### 9.2 Document `excludeTests` config nesting
The CHANGELOG and CLI help say "excludeTests config option" but don't mention it must be nested under `query`. A top-level `{ "excludeTests": true }` silently does nothing. Either:
- Document as `query.excludeTests` in the README/CHANGELOG
- Or accept it at both top-level and nested

### 9.3 Warn on engine mismatch during incremental builds
Store the engine used for the last full build in DB metadata. When an incremental build uses a different engine, warn the user and suggest `--no-incremental`.

### 9.4 Add `--no-incremental` recommendation after version upgrades
When `codegraph info` detects the installed version differs from the version that built the graph, suggest a full rebuild.

---

## 10. Testing Plan

### General Testing Plan (Any Release)

- [ ] Install from npm, verify version and native binary
- [ ] Cold start: all commands gracefully fail without DB
- [ ] Full build: verify node/edge counts
- [ ] Incremental no-op: "Graph is up to date"
- [ ] Incremental with change: only changed files re-parsed
- [ ] `--no-incremental` full rebuild matches clean build
- [ ] Engine comparison: native vs WASM parity
- [ ] All query commands with `-j`, `-T`, `--include-tests`
- [ ] Edge cases: non-existent symbols/files, invalid `--kind`
- [ ] Export: DOT, Mermaid, JSON formats
- [ ] Embed + search pipeline
- [ ] Registry CRUD: add, list, remove, prune
- [ ] MCP single-repo and multi-repo modes
- [ ] Programmatic API: key exports present
- [ ] Pipe output: clean JSON on stdout
- [ ] DB deletion → rebuild → migrations run
- [ ] `structure` after incremental build preserves all files

### Release-Specific Testing Plan (v2.3.0)

- [ ] `--strategy structured` vs `--strategy source` embeddings
- [ ] Context overflow detection and truncation warning
- [ ] `excludeTests` config (under `query` key)
- [ ] `--include-tests` override
- [ ] `--depth` on `explain`
- [ ] Coupling score in `map` output
- [ ] Mermaid output in `diff-impact`
- [ ] `--min-confidence` on export
- [ ] `structure .` no longer crashes
- [ ] Default model is minilm (no auth required)
- [ ] Engine status messages on stderr (not stdout)
- [ ] `--with-test-source` renamed from `--include-test-source`

### Proposed Additional Tests

- [ ] **Embed → modify → rebuild → search:** Most likely path to stale embeddings. Should be tested every release.
- [ ] **Watch mode integration:** Start watcher, modify file, verify incremental update + query correctness.
- [ ] **Multi-repo MCP workflow:** `registry add` → `mcp --repos <name>` → query via JSON-RPC.
- [ ] **Config options:** Test `.codegraphrc.json` with `include`/`exclude` patterns, `aliases`, `build.incremental: false`, `query.defaultDepth`, `search.defaultMinScore`.
- [ ] **Concurrent builds:** Two builds at once on the same DB — should one fail or queue.
- [ ] **Different repo test:** Build on a small open-source project besides codegraph itself.
- [ ] **`apiKeyCommand` credential resolution:** Test with a simple `echo` command.

---

## 11. Overall Assessment

v2.3.0 is a solid release with significant improvements in embedding quality (graph-enriched strategy), better developer experience (`excludeTests` config, `--depth` on explain, coupling scores), and excellent engine parity (0% delta on all metrics).

**The one critical bug found** — incremental builds corrupting structure data — affects all users who run `codegraph structure` or `codegraph hotspots` after any incremental build. The fix is straightforward (37 lines in builder.js) and has been submitted as PR #91. Until merged, users should run `codegraph build --no-incremental` to get correct structure data.

All 20+ CLI commands work correctly. Cold-start error handling is excellent. JSON output is valid across all commands. The three-tier change detection (journal → mtime+size → content hash) is robust. MCP server works in both single and multi-repo modes.

**Rating: 8/10**

Deductions:
- -1 for the incremental structure corruption bug (affects real-world usage)
- -0.5 for `search` missing `--json` (inconsistency with other commands)
- -0.5 for undocumented `excludeTests` nesting requirement

---

## 12. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#89](https://github.com/optave/codegraph/issues/89) | bug: mixed-engine incremental build corrupts structure/contains edges | open |
| Issue | [#90](https://github.com/optave/codegraph/issues/90) | enhancement: add --json flag to search command | open |
| PR | [#91](https://github.com/optave/codegraph/pull/91) | fix(builder): preserve structure data during incremental builds | open |
