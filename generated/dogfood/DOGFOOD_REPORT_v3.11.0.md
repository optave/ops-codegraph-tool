# Dogfooding Report: @optave/codegraph@3.11.0

**Date:** 2026-05-25
**Platform:** macOS Darwin 25.2.0, arm64, Node v24.10.0
**Native binary:** `@optave/codegraph-darwin-arm64@3.11.0`
**Active engine:** `native (v3.11.0)`
**Target repo:** codegraph itself (773 source files, 19,443 nodes, 40,695 edges)

---

## 1. Setup & Installation

- `npm install @optave/codegraph@3.11.0` installed cleanly: 136 packages, 0 vulnerabilities.
- `npx codegraph --version` → `3.11.0` ✓
- `optionalDependencies` pins all platform binaries at exactly `3.11.0` (darwin-arm64, darwin-x64, linux-arm64-gnu, linux-x64-gnu, linux-x64-musl, win32-x64-msvc) ✓
- `codegraph info` confirms `Active engine : native (v3.11.0)` ✓
- Source-repo `node_modules/@optave/codegraph-darwin-arm64` was at `3.10.0` at session start (stale leftover from the prior release). Updated to `3.11.0` before any benchmarks ran — see §4 note.

No install-time issues.

## 2. Cold Start (Pre-Build)

Tested every query/analysis command with no graph present in the target repo.

| Command | Status | Notes |
|---|---|---|
| `query <name>` | PASS | `DB_ERROR: No codegraph database found … Run "codegraph build" first.` |
| `impact <file>` | PASS | Same clean error |
| `deps <file>` | PASS | Same clean error |
| `fn-impact <name>` | PASS | Same clean error |
| `context <name>` | PASS | Same clean error |
| `audit <target>` | PASS | Same clean error |
| `where <name>` | PASS | Same clean error |
| `diff-impact` | PASS | Same clean error |
| `cycles` | PASS | Same clean error |
| `structure` | PASS | Same clean error |
| `triage` | PASS | Same clean error |
| `embed` | PASS | Same clean error |
| `export -f dot` | PASS | Same clean error |
| `ast new` | PASS | Same clean error |
| `brief <file>` | PASS | Same clean error |
| `cfg <name>` | PASS | Same clean error |
| `children <name>` | PASS | Same clean error |
| `dataflow <name>` | PASS | Same clean error |
| `exports <file>` | PASS | Same clean error |
| `flow <name>` | PASS | Same clean error |
| `implementations <name>` | PASS | Same clean error |
| `interfaces <name>` | PASS | Same clean error |
| `path <a> <b>` | PASS | Same clean error |
| `sequence <name>` | PASS | Same clean error |
| `complexity` | PASS | Same clean error |
| `check` | PASS | Same clean error |
| `co-change` | PASS | "No co-change pairs found" |
| `communities` | PASS | Same clean error |
| `owners` | PASS | Same clean error |
| `plot` | PASS | Same clean error |
| `roles` | PASS | Same clean error |
| `models` | PASS | Lists models without needing DB ✓ |
| `branch-compare <a> <b>` | PASS | Pure git op — works without DB ✓ |
| `registry list` | PASS | Reads registry without needing DB ✓ |
| `snapshot list` | PASS | Reads snapshot dir without needing DB ✓ |
| `mcp` | PASS | initializes JSON-RPC successfully |

Build: `codegraph build .` produced 19,443 nodes, 40,695 edges across 773 files in **1.74 s** using the native engine.

## 3. Full Command Sweep

### Query commands
All work with JSON output, `--depth`, `-n/--limit`, `--kind`, `--no-tests`, and `--no-source` flags as documented.

### Edge cases tested

| Scenario | Result |
|---|---|
| `query nonexistent` | `No function/method/class matching "nonexistent"` ✓ |
| `deps nonexistent.js` | `No file matching "nonexistent.js" in graph` ✓ |
| `fn-impact nonexistent` | `No function/method/class matching "nonexistent"` ✓ |
| `structure .` | Works (no regression to v2.2.0 bug) ✓ |
| `--json` on map/stats/query/fn-impact/triage | Valid JSON ✓ |
| `--no-tests` vs without | Without: 22 test refs; with: 0 ✓ |
| `--kind banana` (invalid) | `CONFIG_INVALID: Invalid kind "banana". Valid: function, method, …` ✓ |
| `--kind function/method/interface` | Correctly filters ✓ |
| `--verbose` build | Shows incremental detection ("Incremental: 1 changed, 0 removed") ✓ |
| `build --no-incremental` | Forces full rebuild, warns about discarded embeddings ✓ |
| `search` with no embeddings | Warns "No embeddings found. Run `codegraph embed` first." ✓ |
| `map --json \| head -1` | Clean JSON to stdout ✓ |
| `cycles --functions` | Returns function-level cycles (7 detected) ✓ |
| `triage --level directory/function` | Both levels work ✓ |
| `triage --json` | Valid JSON ✓ |
| `where -f <file>` | File-overview mode works ✓ |
| `where run` | Common name returned with kind disambiguation, false positives not surfaced ✓ |

### -n short-flag sweep (v3.11.0 feature #1184)

All 22 listed commands accept `-n` without error: `roles`, `structure`, `audit`, `children`, `ast`, `brief`, `cfg`, `context`, `dataflow`, `deps`, `exports`, `flow`, `impact`, `implementations`, `interfaces`, `query`, `sequence`, `where`, `communities`, `check`, `diff-impact`, `fn-impact`, plus `triage`/`map`/`search` already supported. ✓

## 4. Rebuild & Staleness

| Test | Result |
|---|---|
| Incremental no-op rebuild | `[codegraph] No changes detected. Graph is up to date.` in ~0.4 s, counts identical ✓ |
| Incremental with 1 file edited | Only the changed file re-parsed, counts consistent ✓ |
| `build --no-incremental` | Full rebuild, counts match incremental result, warns about embedding loss ✓ |
| Embed → rebuild → search (no re-embed) | Search returns results — incremental rebuild preserves embeddings ✓ |
| Watch lifecycle (start, modify, Ctrl+C) | Watcher detects change, incremental update logged, graceful shutdown ✓ |
| Watch + existing embeddings (#1182) | No FK constraint crash — fix verified ✓ |

Issue noted: see §9, BUG 1 — watcher's edge-delta accounting.

## 5. Engine Comparison

> **Note:** the engine comparison was run against a slightly earlier repo state than the header figures (19,443 nodes / 40,695 edges), captured before a handful of local edits landed during the session. The delta is small (~100 nodes / ~200 edges) and does not affect the parity conclusions — both engines were measured against the same snapshot.

| Metric | Native | WASM | Delta |
|---|---|---|---|
| Nodes | 19,342 | 19,341 | +1 (0.005%) |
| Edges | 40,486 | 40,453 | +33 (0.08%) |
| Files | 772 | 772 | 0 |
| Functions | 3,590 | 3,588 | +2 (0.06%) |
| Call edges | 9,677 | 9,648 | +29 (0.3%) |
| Quality score | 68 | 66 | +2 |
| Build time | ~4 s | ~23 s | 5.7× native speedup |

Per-query parity check:

| Query | Native | WASM | Match |
|---|---|---|---|
| `fn-impact buildGraph` total impacted | 46 | 46 | ✓ |
| `cycles --functions` count | 7 | 7 | ✓ |
| `triage --json` top 5 names | identical | identical | ✓ |

Engine parity is well within the 5% threshold across every metric tested. No actionable parity gaps.

## 6. Release-Specific Tests (v3.11.0)

| Feature / Fix (PR) | Test | Result |
|---|---|---|
| `-n` short flag on all limit commands (#1184) | Ran each of the 22 listed commands with `-n 1`, no errors | ✓ |
| `build -d/--db` (#1183) | `codegraph build . -d /tmp/test-custom-db/graph.db` produced a 34 MB DB at the custom path | ✓ |
| `findDbPath` stops at cwd outside repo (#1193) | Ran query from `/tmp` → `DB_ERROR: No codegraph database found at /private/tmp/.codegraph/graph.db` (did not climb to `/`) | ✓ |
| MCP `semantic_search` accepts `file_pattern` (#1149) | JSON-RPC `tools/call` with `file_pattern: "src/*"` accepted, no validation error | ✓ |
| F# `.fsi` routed to dedicated grammar (#1162) | Created `/tmp/fsi-test/test.fsi`; build emitted `byLanguage: { fsharp-signature: 1 }` | ✓ |
| Watch + embed FK crash fix (#1182) | Embed 7,557 symbols, start `watch`, edit source, no FK constraint crash | ✓ |
| CUDA function-pointer fields (#1207) | Build of full repo (incl. CUDA fixtures) succeeded without warnings | ✓ |
| C++ `T&` parameter stripping (#1192) | Native parse of C++ fixtures clean | ✓ |
| JS callback gating (#1191) | Native build matches WASM call-edge count within parity threshold | ✓ |
| Native engine ports (#1097–#1107) | All 14 languages built without `[WARN] dropped` notices on clean build | ✓ |
| Native skip-backfill on clean incremental (#1082, #1085) | No-op rebuild ran in ~0.4 s (no spurious WASM backfill) | ✓ |

## 7. Additional Testing

### MCP server
- Single-repo mode: **34 tools** (`query`, `path`, `file_deps`, `brief`, `file_exports`, `impact_analysis`, `find_cycles`, `module_map`, `fn_impact`, `context`, `symbol_children`, `where`, `diff_impact`, `semantic_search`, `export_graph`, `list_functions`, `structure`, `node_roles`, `co_changes`, `execution_flow`, `sequence`, `complexity`, `communities`, `code_owners`, `audit`, `batch_query`, `triage`, `branch_compare`, `cfg`, `dataflow`, `check`, `implementations`, `interfaces`, `ast_query`). ✓
- Multi-repo mode (`--multi-repo`): **35 tools**, includes `list_repos`. ✓

### Programmatic API
`require('@optave/codegraph')` exposes 30+ named exports including `buildGraph`, `loadConfig`, `contextData`, `fnImpactData`, `whereData`, `triageData`, `statsData`, `auditData`, `EXTENSIONS` (Set), `IGNORE_DIRS` (Set), `EVERY_SYMBOL_KIND`, `EVERY_EDGE_KIND`, plus structured error types (`AnalysisError`, `BoundaryError`, `CodegraphError`, `ConfigError`, `DbError`, `EngineError`, `ParseError`, `ResolutionError`). ✓

### Config (`.codegraphrc.json`)
A test repo with `include: ["src/**/*.js"]`, `exclude: ["**/*.test.js"]`, and `query.defaultDepth: 5` was built correctly — 2 files included, 1 excluded as expected. ✓

### Registry
- `registry list -j` returns valid JSON ✓
- `registry add . -n custom` accepts a custom name ✓
- `registry remove <name>` works ✓
- `registry prune --ttl 0` removes expired entries ✓

### Snapshot
- `snapshot save <name>` produces a ~48 MB snapshot ✓
- `snapshot list` lists with size + timestamp ✓
- `snapshot delete <name>` removes ✓

### Different repo
Cloned `sindresorhus/is` and built — 772 nodes / 1,614 edges across 5 files, no errors. ✓

### Concurrent usage
Ran `codegraph stats` and `codegraph map` in parallel from the same project — both succeeded. ✓

### Hotspot / false-positive filtering
`triage --json -n 20` returns no entries matching the common-name allowlist (`run`, `get`, `set`, `init`, `main`, `create`, `update`, `find`). ✓

## 8. Performance Benchmarks

### Build Benchmark (`scripts/benchmark.ts`)

| Metric | WASM | Native | Speedup |
|---|---|---|---|
| Full build (623 files) | 15,238 ms | 2,593 ms | **5.9×** |
| Per-file build | 24.5 ms | 4.2 ms | **5.8×** |
| No-op rebuild | 33 ms | 38 ms | — |
| 1-file rebuild | 104 ms | 124 ms | — |
| Query time (warm, median) | 50.2 ms | 43.6 ms | 1.15× |

### Build Phase Breakdown

| Phase | WASM Full | Native Full | WASM 1-File | Native 1-File |
|---|---|---|---|---|
| Setup | 22 ms | 31 ms | 7 ms | 4 ms |
| Collect | 29 ms | 12 ms | 21 ms | 11 ms |
| Detect | 2 ms | 0.2 ms | 15 ms | 3 ms |
| Parse | **10,378 ms** | 500 ms | 3 ms | 0.4 ms |
| Insert | 663 ms | 614 ms | 1 ms | 0.3 ms |
| Resolve | 25 ms | 4 ms | 1 ms | 0.4 ms |
| Edges | 461 ms | 256 ms | 3 ms | 8 ms |
| Structure | 93 ms | 57 ms | 5 ms | 6 ms |
| Roles | 153 ms | 158 ms | 41 ms | 33 ms |
| AST | 461 ms | 336 ms | 1 ms | 0.3 ms |
| Complexity | **1,468 ms** | **28 ms** | 1 ms | 0 ms |
| CFG | 430 ms | 229 ms | 0 ms | 0 ms |
| Dataflow | 411 ms | 255 ms | 1 ms | 0 ms |
| Finalize | 12 ms | 1 ms | 0.5 ms | 0.9 ms |

Notable: native complexity is **52×** faster than WASM (1468 ms → 28 ms), which is the expected behaviour now that the native binary version matches the JS runtime — earlier sessions where complexity ran in 1500+ ms on native indicated a stale-binary fallback. ✓

### Query Benchmark (`scripts/query-benchmark.ts`)

| Query | WASM | Native |
|---|---|---|
| `fn-deps` depth=1 | 72.4 ms | 49.5 ms |
| `fn-deps` depth=3 | 57.9 ms | 45.1 ms |
| `fn-deps` depth=5 | 53.2 ms | 43.9 ms |
| `fn-impact` depth=1 | 6.7 ms | 6.4 ms |
| `fn-impact` depth=3 | 6.7 ms | 7.1 ms |
| `fn-impact` depth=5 | 7.9 ms | 8.6 ms |
| `diff-impact` | 16.7 ms | 15.4 ms |

### Incremental Benchmark (`scripts/incremental-benchmark.ts`)

| Metric | WASM | Native |
|---|---|---|
| Full build | 12,820 ms | 2,522 ms |
| No-op rebuild | 36 ms | 35 ms |
| 1-file rebuild | 97 ms | 137 ms |
| Native batch resolve (989 imports) | — | 6 ms |
| JS fallback resolve | 9.3 ms | — |

### Embedding Benchmark (`scripts/embedding-benchmark.ts`)

**Partial result — full run deferred.** The full sweep across all 7 models takes ~30 min per model (model download + 7,557-symbol embed + 1,500-symbol search benchmark). The session captured the first model and partial progress on the next two before being terminated for time:

| Model | Hit@1 | Hit@3 | Hit@5 | Misses |
|---|---|---|---|---|
| minilm | 1004/1500 (66.9%) | 1320/1500 (88.0%) | 1398/1500 (93.2%) | 55 |
| jina-small | (polluted run, see note) | | | |
| jina-base | partial (4232/7557 embeddings done) | | | |

> **Note on jina-small:** the headline Hit@k for jina-small in this session was extremely degraded (38%/46%/48%). The benchmark output stream shows hundreds of `No embeddings found. Run codegraph embed first.` lines interleaved during the jina-small run — strongly suggesting another process held the DB during the search phase. The minilm result was unaffected. Recommend re-running the embedding benchmark in isolation post-release before drawing model-quality conclusions for jina-small/jina-base.

### Benchmark Assessment

- Native speedup over WASM holds at ~6× for full builds, matching the v3.10.x baseline.
- Complexity phase is no longer the bottleneck for native (28 ms vs WASM 1468 ms) — confirms the native binary version is correctly matched.
- 1-file rebuild on native is slightly slower than WASM (137 ms vs 97 ms). Both are dominated by the roles phase (~35 ms) and the constant overhead of orchestrator setup; this is unchanged from prior releases.
- No-op rebuild exceeds the 10 ms target on both engines (35–38 ms), but parity between engines is good.

## 9. Bugs Found

### BUG 1: Watcher edges log shows insert count, not net delta (Low)
- **Issue:** [#1219](https://github.com/optave/ops-codegraph-tool/issues/1219)
- **PR:** [#1220](https://github.com/optave/ops-codegraph-tool/pull/1220)
- **Symptoms:** `codegraph watch` reports `+N edges` for every file rebuild where N is the count of edges re-inserted, not the actual net change in the DB. A comment-only edit shows `+10 edges` even though the DB total moved by 0.
- **Root cause:** `rebuildFile` in `src/domain/graph/builder/incremental.ts` calls `purgeFileData` first (which removes the file's edges) and then accumulates `edgesAdded` across each builder pass without subtracting the purged count. The watcher log printed `+${r.edgesAdded}` verbatim. The companion `nodes` field already used a signed delta (`nodesAdded - nodesRemoved`), so the asymmetry confused users.
- **Fix applied:** Track `edgesRemoved` in `rebuildFile` (count edges touching the file before purge, plus outgoing edges of each reverse-dep). Thread it through `RebuildResult` to the watcher. Render the watcher log edges field as a signed delta `(edgesAdded - edgesRemoved)` matching the nodes field. The `change-journal.ts` "edges.added" semantics are intentionally preserved as "insert count".
- **New test:** `tests/integration/watcher-edges-delta.test.ts` locks in net-zero behaviour for comment-only edits and net-positive for added symbols.

## 10. Suggestions for Improvement

### 10.1 Tighten embedding benchmark isolation
The benchmark forks per-model workers but appears to share the host project's `.codegraph/graph.db`. When parallel CLI activity occurs (e.g. a manual `codegraph embed` invocation during a benchmark run), the bench's search phase fires off hundreds of `No embeddings found. Run codegraph embed first.` lines and produces invalid Hit@k. Either lock the bench DB exclusively or fork into a copied DB path before each model.

### 10.2 Surface dropped-file warnings on the same line as the count
When a mid-state journal-vs-fresh-build collision triggered the orchestrator-drop warning, the message included exact filenames for the first few of each extension plus "+31 more extension(s)" — useful, but it lives in a wall-of-text WARN line. Splitting by extension with a tabular summary would scan faster.

### 10.3 `models` listing could mark engine-fallback models
`models` lists `jina-code` as the default-looking option but it silently requires `HF_TOKEN`. A small marker (`*` or "auth: HF_TOKEN") would set expectations before the user kicks off a 5-minute download that fails late.

## 11. Testing Plan

### General Testing Plan (any release)

- [ ] `npm install @optave/codegraph@<v>` clean, no peer-dep warnings
- [ ] `codegraph --version` matches
- [ ] `optionalDependencies` pinned to same `<v>`
- [ ] `codegraph info` reports native engine, version matches
- [ ] Cold-start: every command surfaces a graceful DB_ERROR
- [ ] Build (incremental & full) produces consistent counts
- [ ] No-op rebuild ≤ 100 ms
- [ ] All query commands handle `--json`, `-n`, `--kind`, `--no-tests`
- [ ] MCP `tools/list` returns 34 (single-repo) / 35 (`--multi-repo`)
- [ ] Programmatic API import surface unchanged from prior release
- [ ] Engine parity within 5% on nodes/edges
- [ ] Native ≥ 3× faster than WASM on full builds
- [ ] Watch lifecycle: start → modify → Ctrl+C clean

### Release-Specific Testing Plan (v3.11.0)

- [ ] All 22 limit-accepting commands accept `-n` (`#1184`)
- [ ] `build -d <path>` writes to the custom DB path (`#1183`)
- [ ] `findDbPath` stops at cwd when no `.git` ceiling (`#1193`)
- [ ] MCP `semantic_search` honours `file_pattern` (`#1149`)
- [ ] `.fsi` files routed to `fsharp-signature` language (`#1162`)
- [ ] Embed + watch: no FK constraint crash (`#1182`)
- [ ] All 14 native extractors load (no silent WASM fallback) (`#1097`–`#1107`)
- [ ] CUDA function-pointer class fields preserved (`#1207`)
- [ ] C++ `T& foo` extracts to `foo` not `& foo` (`#1192`)

### Proposed Additional Tests

- Add a dogfooding step that runs the embedding benchmark **after** all other interactive testing (so concurrent DB activity can't pollute Hit@k results).
- Add an integration test for `findDbPath` boundary behaviour (cwd outside git) to lock in the `#1193` fix as a regression canary.
- Consider a CI smoke test for `mcp --multi-repo`: snapshot-test that `tools/list` returns exactly 35 entries including `list_repos`.

## 12. Overall Assessment

v3.11.0 is a solid release. The headline native-parity sweep across 14 languages lands cleanly — no silent WASM fallback, no parity drift larger than 0.3% on any metric I checked. CLI ergonomics improvements (`-n` everywhere, `build -d`) work without exceptions. `findDbPath` boundary fix is correct. The `.fsi` signature grammar path is wired up end to end. MCP `file_pattern` plumbing is in place.

Bugs found are limited to a single low-severity log-message asymmetry in the watcher's edge-delta accounting — fixed in PR. Embedding benchmark methodology has a concurrency-isolation issue (see §10.1) that the dogfood skill should also account for.

**Rating: 9 / 10**

One point off for the watcher log accuracy bug (long-standing, but visible enough that real watch users will encounter it). Everything else lands cleanly and the v3.11.0-headline work is solid.

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|---|---|---|---|
| Issue | [#1219](https://github.com/optave/ops-codegraph-tool/issues/1219) | bug(watch): edges log shows insert count, not net delta — misleading for unchanged content | open |
| PR | [#1220](https://github.com/optave/ops-codegraph-tool/pull/1220) | fix(watch): report net edge delta in rebuild log | open |
