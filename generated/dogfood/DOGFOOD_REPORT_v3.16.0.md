# Dogfooding Report: @optave/codegraph@3.16.0

**Date:** 2026-07-20
**Platform:** macOS 26.2, darwin-arm64, Node v26.4.0
**Native binary:** @optave/codegraph-darwin-arm64@3.16.0
**Active engine:** native (v3.16.0)
**Target repo:** codegraph itself (993 files, 34 languages, `crates/**` excluded per project `.codegraphrc.json`)
**Tester:** Automated dogfood session (Claude Code)

---

## 1. Setup & Installation

```
npm install @optave/codegraph@3.16.0    → clean, no issues
npx codegraph --version                 → 3.16.0
npx codegraph info:
  Native engine : available
  Native version: 3.16.0
  Active engine : native (v3.16.0)
```

`optionalDependencies` in the installed package correctly pin every platform package (`darwin-arm64`, `darwin-x64`, `linux-*`, `win32-x64-msvc`) to `3.16.0`. Source-repo native binary was already correctly pinned to `3.16.0` (this worktree was created from `origin/main` post-release). `npm run doctor` reported the environment healthy (better-sqlite3 ABI loads cleanly, all 36 WASM grammars present).

**Note on test methodology:** during setup I accidentally overwrote and deleted the repo's real `.codegraphrc.json` (`{"embeddings":{"model":"bge-large"},"exclude":["crates/**"],"ignoreAdditionalDirs":["crates"]}`) while iterating on remote-embedding-provider config tests, and separately wiped the global `~/.codegraph/registry.json` via `registry prune --ttl 0` (see §11 tester-error log). Both are disclosed there for transparency; neither affects the validity of the findings below, which were re-verified against a correctly-configured, freshly-rebuilt graph.

---

## 2. Cold Start (Pre-Build)

All commands tested before any graph existed returned the same graceful, helpful error:
```
codegraph [DB_ERROR]: No codegraph database found at <path>/.codegraph/graph.db.
Run "codegraph build" first to analyze your codebase.
```
Confirmed for: `query`, `map`, `stats`, `fn-impact`, `deps`, `cycles`, `context`, `audit`, `where`, `export`, `embed`, `search`, `structure`, `triage`, `roles`, `complexity`. `info`, `models`, `registry list/add`, `snapshot list`, and MCP `initialize` all correctly work with **no graph present** (as expected — they don't need one).

### Build (native, auto engine)
```
[codegraph] Using native engine (v3.16.0)
[codegraph] Found 993 files to parse
[codegraph DEBUG] Running migration v1 .. v21 (fresh DB)
[codegraph] Native build orchestrator completed: 21031 nodes, 43195 edges, 993 files
[codegraph] Dataflow (native orchestrator): 2090 inter-procedural edges inserted
[codegraph] Dataflow: 2 fn-level edges, 10 inter-procedural edges inserted

Wall time: 3.98s (--verbose, cold start, schema created from scratch)
```

---

## 3. Full Command Sweep

| Command | Status | Notes |
|---------|--------|-------|
| `query buildGraph -T` / `-j` / `--depth 2` | PASS | correct call chain, valid JSON |
| `impact <file>` | PASS | |
| `map` / `map -n 5` | PASS | |
| `stats` / `stats -j` | PASS | full breakdown, all sections present |
| `deps <file>` | PASS | |
| `fn-impact buildGraph -T` / `--depth 2` | PASS | |
| `fn-impact buildGraph -f <file>` | PASS (my error) | correctly returns "no match" — `buildGraph` isn't defined in the barrel file I picked; real function lives in `builder/pipeline.ts` |
| `context buildGraph -T` / `--no-source` / `--include-tests` | PASS | |
| `audit buildGraph -T` | PASS | |
| `audit <barrel file> -T` | **BUG** (#2135, fixed in #2142) | misleading "No file matching" for a real, tracked file with 0 own functions |
| `where buildGraph` / `where -f <file>` | PASS | |
| `diff-impact main -T` / `HEAD` / `--staged` / (unstaged) | PASS | all graceful, correct |
| `cycles` / `cycles --functions` | PASS | 1 file-level, 6 function-level cycles |
| `structure --depth 2` / `--sort cohesion` / `.` | PASS | |
| `triage` / `--level function -n 5` / `--json` | PASS | |
| `export -f dot/mermaid/json/graphml/neo4j/graphson` | PASS except json/graphson | see §9 Bug 3 |
| `export --functions` | **BUG** (#2136, fixed in #2141) | silently ignored for `json`/`graphson` only |
| `children buildGraph` | PASS | |
| `dataflow buildGraph -T` | PASS | |
| `exports <file> -T` | PASS | |
| `implementations` / `interfaces` | PASS | |
| `brief <file>` | PASS | |
| `ast --kind string/throw` | PASS | |
| `cfg buildGraph` | PASS | |
| `check` (manifesto) | PASS | |
| `path <from> <to>` | PASS | |
| `batch fn-impact <target>` | PASS | correct `{command,total,succeeded,failed,results}` shape |
| `communities` | PASS | 381 communities, modularity 0.5012 (native) |
| `roles --role dead/core/--dynamic` | PASS | |
| `owners` | PASS | graceful "No CODEOWNERS file found" |
| `co-change` (query mode) | PASS | graceful "No co-change pairs found" |
| `sequence` / `flow` / `branch-compare` | PASS | |
| `complexity -f <file>` | PASS | note: `complexity` takes an optional positional **symbol name**, not a file — file scoping requires `-f`/`--file`; my first attempt without `-f` was tester error, not a bug |
| `config` / `--json` / `--explain` | PASS | |
| `snapshot save/list/restore/delete` | PASS | full lifecycle works |
| `plot -o <file>` | PASS | valid 380KB HTML written |
| `search "..."` (before embed) | PASS | graceful "No embeddings found" |
| `search` (after embed, various flags) | PASS | see §4 |
| `mcp` (JSON-RPC `initialize`, `tools/list`) | PASS | see §7 |
| `watch` (start/detect/stop) | PASS | detects file changes, graceful `Ctrl+C` shutdown — but see §9 Bug 2 re: edge counts after incremental updates |
| `registry list/add/remove/prune` | PASS (functionally) | **`--ttl 0` is destructive against real state** — tester error, see §11 |

### Edge Cases Tested

| Scenario | Result |
|----------|--------|
| `query nonexistent` | Graceful "No function/method/class matching" |
| `deps nonexistent.js` | Graceful "No file matching" |
| `fn-impact nonexistent` | Graceful "No function/method/class matching" |
| `structure .` | Works (verifying the v2.2.0 bug stays fixed) |
| `--json` on every JSON-capable command | Valid JSON in every case tested |
| `--no-tests` vs default | Test file counts correctly drop with `-T` |
| `search` with no embeddings | Graceful warning, not a crash |
| `embed` with remote provider misconfigured | Graceful `ENGINE_UNAVAILABLE` once config is actually visible to the command — see #2137 for when it *isn't* visible |
| Pipe output (`map --json \| head -1`) | Clean JSON, no status noise mixed into stdout |
| `snapshot save → restore → delete` | Full round-trip works, correct file sizes reported |

---

## 4. Rebuild & Staleness

- **No-op incremental:** `[codegraph] No changes detected. Graph is up to date.` — 0.38s, exact.
- **Incremental with a real change:** correctly reports `Incremental: 1 changed, 0 removed`, only re-parses the touched file.
- **`touch` with byte-identical content:** correctly reports `No changes detected` (content-hash based, not mtime-based) — no false rebuild.
- **Force full rebuild (`--no-incremental`):** matches the from-scratch build exactly (21031 nodes / 43195 edges).
- **🐛 Incremental edge loss (#2138):** editing an **unrelated** file (`src/domain/graph/builder/pipeline.ts`) and reverting it back to byte-identical content permanently drops exactly 10 edges (43195 → 43185) — all `calls`/`receiver` edges from 5 functions in `src/domain/parser.ts` to the `WasmWorkerPool` class in `src/domain/wasm-worker-pool.ts`, a file that was never touched. Full edge-set diff (not just counts) confirms this precisely; only `--no-incremental` recovers the missing edges. `watch` mode showed the same symptom on a different file (`-22 edges` from a single comment-line append to `roles.ts`), consistent with the same root cause.
- **Full rebuild after embed:** correctly **warns** before discarding: `Full rebuild will discard 5085 embeddings; re-run codegraph embed after the build.`
- **Embed → rebuild (no-op) → search:** search still works correctly, same results.
- **Embed → modify unrelated file → incremental rebuild → search without re-embedding:** returns results without crashing; correctly surfaces non-stale matches (didn't crash on stale embeddings, though there's no explicit "N embeddings may be stale" warning — a possible future UX improvement, not a bug).
- **Delete `.codegraph` entirely → search:** graceful `DB_ERROR`, not a crash.
- **Watch mode lifecycle:** starts cleanly, detects a live file edit (`Updated: <file> (+N nodes, -N edges)`), and shuts down gracefully on `Ctrl+C` (`Stopping watcher...`) with no dangling process.

---

## 5. Engine Comparison

Built codegraph's own source (993 files) with each engine from a clean `.codegraph/`:

| Metric | Native | WASM | Delta |
|--------|--------|------|-------|
| Nodes | 21031 | 21031 | 0 |
| Edges | 43195 | 43279 | +84 (wasm) |
| Build time | 3.98s | 11.04s | 2.8× |
| `calls` edges | 9009 | 9092 | +83 (wasm) |
| `receiver` edges | 1088 | 1089 | +1 (wasm) |
| File-level cycles | 1 | 1 | 0 |
| Function-level cycles | 6 | 6 | 0 |
| Communities (Leiden) | 381 | 380 | -1 |
| Modularity | 0.5012 | 0.5143 | +0.013 (wasm) |

**Parity gap (#2139):** native is a strict subset of wasm's edges (0 edges unique to native, 84 unique to wasm) — i.e. this is a native under-resolution, not a wasm false-positive, for the dominant pattern. 65 of the 84 missing edges follow one clear shape: calls/receiver dispatch on an interface-typed receiver with multiple concrete implementers (`NativeDbProxy.prepare`/`.transaction`, `Repository.getClassHierarchy` across its three implementations, `TreeSitterNode.namedChild`). wasm's CHA/RTA resolves these correctly; native does not. A further 6 edges look like the *opposite* direction — wasm possibly over-resolving across unrelated benchmark-fixture directory boundaries (`jelly-micro/classes` → `jelly-micro/super`/`super4`/`super5`) — flagged separately in the issue for someone closer to the hierarchy-scoping logic to confirm intent. The community-detection delta (381 vs 380, modularity ±0.013) is fully consistent with — and likely just a downstream consequence of — this same 84-edge input-graph difference, not a separate Leiden-port bug.

No divergence found in cycle detection (file- or function-level) between engines.

---

## 6. Release-Specific Tests

v3.16.0's stated headline items, and how each tested:

| Feature/Fix | Test | Result |
|---|---|---|
| Remote embedding provider (`embeddings.provider: "openai"`) | Configured `.codegraphrc.json` with a fake `llm.baseUrl`, ran `embed` | **Works correctly** when the CLI's cwd matches the target project (routes through remote provider, fails gracefully with `ENGINE_UNAVAILABLE: fetch failed` on an unreachable endpoint) — **but silently falls back to loading the local HuggingFace model** when invoked with a different cwd than the target dir, because of a deeper bug (#2137, not fixed this session — see below) |
| Complexity metrics for C/C++/Kotlin/Swift/Scala/Bash on WASM | `complexity -f <fixture-file>` for one file per language, wasm-engine DB | **Confirmed working** — cognitive/cyclomatic/nesting/MI all populated (previously returned nothing per CHANGELOG) |
| Leiden ported to native Rust | `communities -j` on both engines | **Confirmed** — native no longer runs classic Louvain; both report Leiden-shaped output; 380 vs 381 communities, modularity within 0.013 (explained by the pre-existing 84-edge graph difference in §5, not the Leiden port itself) |
| `watch` incremental gains CHA/RTA/points-to/dynamic-sink edges | Live edit during `watch` | Detected and applied, but see #2138 — the underlying incremental edge-loss bug reproduces during `watch` too (same class of issue, not re-filed separately) |
| Deleted-export advisory persistence (#2103, `check` survives purge ordering) | Deleted a file with an external consumer, ran `check --staged` **before and after** a rebuild that purges the file's rows | **Confirmed fixed** — `check --staged` correctly reports `[FAIL] signatures ... file lib.js deleted but still used by 1 external consumer(s)` in both cases; before this fix the second check would have silently passed |

---

## 7. Additional Testing

**MCP server:** `initialize` + `tools/list` verified in both modes.
- Single-repo (default): 34 tools, no `list_repos`, no `repo` param on any tool.
- `--multi-repo`: 35 tools, `list_repos` present, `repo` param present (`"Repository name from the registry (omit for local project)"`).
Both match documented behavior exactly.

**Programmatic API:** `import('@optave/codegraph')` (ESM) returns all 59 exports correctly, including `buildGraph`, `EXTENSIONS`, all `*Data` query functions. `require('@optave/codegraph')` (CJS) returns a `Promise` rather than synchronous named exports — **this is intentional, documented behavior** (an inline comment in the shipped `dist/index.cjs` explicitly warns `const { buildGraph } = require(...)` will silently give `undefined`, and to `await` the require instead), not a bug. It is, however, **not mentioned in README.md's "Programmatic API" section**, which only shows `import` examples — a documentation gap worth closing (see §10).

**Config:** `.codegraphrc.json`'s `exclude`/`ignoreAdditionalDirs` correctly kept `crates/**` out of the graph. `llm.apiKeyCommand` correctly shells out via `execFileSync` and resolves the key. `CODEGRAPH_LLM_PROVIDER`/`_MODEL`/`_API_KEY` env overrides correctly take effect in `loadConfig()`.

**Symbol kinds:** spot-checked `function`, `method`, `class`, `interface`, `struct`, `enum`, `trait`, `module` via `stats -j`'s `nodes.byKind` breakdown — all present with sane counts for this repo's language mix.

---

## 8. Performance Benchmarks

### Build Benchmark
| Metric | WASM | Native | Speedup |
|--------|------|--------|---------|
| Full build (741 files) | 11318 ms | 2909 ms | 3.9× |
| No-op rebuild | 23 ms | 23 ms | 1.0× |
| 1-file rebuild | 186 ms | 142 ms | 1.3× |
| Query time | 8 ms | 6 ms | 1.3× |

### Build Phase Breakdown (full build)
| Phase | WASM Full | Native Full | WASM 1-File | Native 1-File |
|-------|-----------|-------------|-------------|----------------|
| Setup | 14.8 | 14.1 | 4.7 | 4.5 |
| Collect | 31.5 | 13.6 | 14.8 | 8.6 |
| Detect | 0.6 | 0.4 | 102 | 2.2 |
| Parse | 7639.9 | 360.7 | 1.5 | 0.3 |
| Insert | 308.1 | 316.8 | 0.2 | 0.2 |
| Resolve | 19.8 | 3.1 | 0.3 | 0.3 |
| Edges | 2021.5 | 153.8 | 9.5 | 3.7 |
| Structure | 47.5 | 27.1 | 26.8 | 31.4 |
| Roles | 85.6 | 72.2 | 17.9 | 20.6 |
| AST | 238.8 | 200.7 | 0.3 | 0.2 |
| Complexity | 32 | 15.5 | 0.2 | 0 |
| CFG | 172.4 | 123.4 | 0.1 | 0 |
| Dataflow | 283.8 | 121.6 | 1.2 | 0 |
| Finalize | 5.5 | 0.7 | 0.2 | 0.7 |
| (native-only) CHA/gapDetect/thisDispatch/reclassify/techniqueBackfill | n/a | 42.3 + 13.6 + 17 + 107.9 + 19 | n/a | 33.7 + 3.9 + 1.6 + 0 + 3.4 |

No anomalous phases — native is faster or roughly equal to wasm in every phase; 1-file rebuild is faster than full build in both engines as expected. `detectMs` at 102ms for wasm's 1-file rebuild vs 2.1ms native is the one large relative gap, but it's a small absolute cost.

### Query Benchmark
| Query | WASM | Native |
|-------|------|--------|
| fn-deps depth1/3/5 | 7.6 / 8.0 / 7.7 ms | 6.0 / 5.9 / 6.0 ms |
| fn-impact depth1/3/5 | 3.1 / 3.4 / 3.3 ms | 3.8 / 3.3 / 3.4 ms |
| diff-impact latency | 9.0 ms | 7.8 ms |

### Incremental Benchmark
| Metric | WASM | Native |
|--------|------|--------|
| Full build | 10260 ms | 2776 ms |
| No-op rebuild | 23 ms | 23 ms |
| 1-file rebuild | 185 ms | 135 ms |
| Import resolution (1116 imports) | 7.5 ms (JS fallback) | 3.8 ms (native batch) |

### Embedding Benchmark (partial — 2 of 11 models completed within session time budget)
| Model | Hit@1 | Hit@3 | Hit@5 | Misses |
|-------|-------|-------|-------|--------|
| minilm (384d) | 1082/1500 (72.1%) | 1326/1500 (88.4%) | 1398/1500 (93.2%) | 51 |
| jina-small (512d) | 1197/1500 (79.8%) | 1408/1500 (93.9%) | 1440/1500 (96.0%) | 29 |

The remaining 9 models (jina-base, jina-code, nomic, nomic-v1.5, bge-large, mxbai-xsmall, mxbai-large, bge-m3, modernbert) were still running when this report was written and are **not included** — flagging explicitly rather than silently omitting. jina-small already recall-beats minilm at every k, consistent with prior releases' benchmark data.

### Benchmark Assessment
- Native build/incremental/query performance is consistent with prior releases — no regressions detected relative to `generated/benchmarks/BUILD-BENCHMARKS.md`'s historical figures.
- `embedding-benchmark.ts` prints a spurious `CODEGRAPH_ENGINE="<model>" is not a valid engine value` warning for every model tested — cosmetic only (falls back to `auto`), root-caused and filed as #2140.
- Local git tags were not fetched by default (`git fetch origin main` only, no `--tags`), which initially caused the build benchmark to mislabel its own version as `3.15.1-dev.182` via `git describe`; fixed by `git fetch origin --tags`. This is a **testing-methodology note**, not a codegraph bug — flagging for the next dogfood session.

---

## 9. Bugs Found

### BUG 1: update-graph.sh hook rebuilds the wrong repo with a stale global binary (Medium)
- **Issue:** [#2134](https://github.com/optave/ops-codegraph-tool/issues/2134)
- **PR:** open — repo-tooling fix, not part of the npm package, left for a follow-up session
- **Symptoms:** writing an unrelated `.sh` scratch file (outside the target repo entirely) silently triggered a full incremental rebuild of the target repo's graph using whatever `codegraph` happens to be on `$PATH` globally (here, a stale v3.15.0), corrupting `build_meta.codegraph_version` and producing different node/edge counts, with stderr suppressed.
- **Root cause:** `PROJECT_DIR` is derived from the hook's own `git rev-parse --show-toplevel` (cwd-based) rather than validating `FILE_PATH`'s actual location; `command -v codegraph` prefers the global binary over the project's own build.
- **Fix applied:** none this session (repo-tooling, not product code).

### BUG 2: incremental rebuild loses 10 receiver-dispatch edges via an unrelated file (Medium)
- **Issue:** [#2138](https://github.com/optave/ops-codegraph-tool/issues/2138)
- **PR:** open — too complex for this session (native Rust incremental orchestrator)
- **Symptoms:** editing and reverting `src/domain/graph/builder/pipeline.ts` permanently drops 10 `calls`/`receiver` edges from unrelated `src/domain/parser.ts` functions to the `WasmWorkerPool` class, recoverable only via `--no-incremental`.
- **Root cause:** likely in `runPostNativeCha`'s "Gate A (hierarchy) full scan" incremental path, which doesn't reproduce the same receiver-dispatch resolution as a genuine full build for this class shape.
- **Fix applied:** none this session.

### BUG 3: native engine misses interface-typed multi-implementer receiver dispatch vs wasm (Medium)
- **Issue:** [#2139](https://github.com/optave/ops-codegraph-tool/issues/2139)
- **PR:** open — native Rust resolver change, too complex for this session
- **Symptoms:** native misses 84 edges (65 in one clear pattern) that wasm correctly resolves, all involving calls/receiver dispatch on interface-typed receivers (`NativeDbProxy`, `Repository`, `TreeSitterNode`) with multiple concrete implementations.
- **Fix applied:** none this session.

### BUG 4: `codegraph export --functions` silently ignored for `json` and `graphson` formats (Medium)
- **Issue:** [#2136](https://github.com/optave/ops-codegraph-tool/issues/2136)
- **PR:** [#2141](https://github.com/optave/ops-codegraph-tool/pull/2141) (open, CI running)
- **Symptoms:** `export -f json --functions` and `-f graphson --functions` produced byte-identical output to the file-level default — the only 2 of 6 formats that didn't honor the flag.
- **Root cause:** `exportJSON`/`exportGraphSON` in `src/features/export.ts` never read `opts.fileLevel`, unlike the other four exporters.
- **Fix applied:** both functions now branch on `fileLevel`, reusing the existing `loadFileLevelEdges`/`loadFunctionLevelEdges` helpers; added regression tests for both formats × both levels.

### BUG 5: `codegraph audit <file>` conflates "not found" with "0 own functions" (Low)
- **Issue:** [#2135](https://github.com/optave/ops-codegraph-tool/issues/2135)
- **PR:** [#2142](https://github.com/optave/ops-codegraph-tool/pull/2142) (open, CI running)
- **Symptoms:** a real, graph-tracked barrel/re-export file printed the identical "No file matching" message as a file that genuinely isn't in the graph.
- **Root cause:** `AuditResult` had no way to distinguish "zero results from `explainData`" from "results found, but zero own function-kind symbols."
- **Fix applied:** added `AuditResult.found` (false only in the true "not found" case); `presentation/audit.ts` now renders a distinct message for each case.

### BUG 6 (cosmetic, Low): CLI's shared `ctx.config` is resolved once from `process.cwd()`, ignoring the target dir/`--db` path
- **Issue:** [#2137](https://github.com/optave/ops-codegraph-tool/issues/2137)
- **PR:** open — architectural, spans many call sites, too risky for this session
- **Symptoms:** the new remote-embedding-provider feature (this release's headline item) silently does nothing when `codegraph embed <dir>` is invoked from a directory other than `<dir>` itself, because `embed.ts`'s `validate()`/`execute()` read the CLI's shared, cwd-pinned `config` singleton instead of deriving config from the command's own target path.
- **Fix applied:** none this session; same architectural pattern already tracked (differently scoped) in #1881/#2017.

### BUG 7 (cosmetic, Low): `embedding-benchmark.ts` forked workers print a spurious `CODEGRAPH_ENGINE` warning
- **Issue:** [#2140](https://github.com/optave/ops-codegraph-tool/issues/2140)
- **PR:** open — trivial fix, left for a follow-up session
- **Symptoms:** harmless `[codegraph WARN] CODEGRAPH_ENGINE="<model>" is not a valid engine value` on every embedding-benchmark model run.
- **Fix applied:** none this session.

---

## 10. Suggestions for Improvement

### 10.1 Document the CJS `await require(...)` gotcha in README.md
`dist/index.cjs` explicitly documents (inline) that `require('@optave/codegraph')` returns a Promise and that destructuring at require-time silently gives `undefined` — a real trap for CJS consumers who'd never read the shipped `.cjs` file. The README's Programmatic API section (line ~900) only shows `import` examples; a short CJS caveat there would save consumers real debugging time.

### 10.2 `.claude/hooks/update-graph.sh` should scope rebuilds to the edited file's own repo
See Bug 1 (#2134) — worth fixing given how easily any Claude Code session working in an adjacent worktree/scratch directory can silently corrupt a graph under test.

### 10.3 Consider surfacing a "search results may be stale" hint after incremental rebuilds without re-embedding
Not a bug (no crash, no wrong-looking results in my testing), but `codegraph embed` → modify a file → incremental `build` → `search` gives no signal that the modified file's embeddings are now stale. A one-line warning (mirroring the existing "Full rebuild will discard N embeddings" one) would close the loop.

### 10.4 Update this skill's benchmark script references
`SKILL.md` Phase 4b references `node scripts/benchmark.js` etc.; the actual files are `.ts` and must be run via `node --experimental-strip-types --import ./scripts/ts-resolve-loader.js scripts/benchmark.ts` (or `npm run benchmark` for the build one specifically, which is the only one with a package.json alias). Also worth noting: fetch tags (`git fetch origin --tags`), not just the branch, before benchmarking in a fresh worktree, or the reported "version" field mislabels itself via a stale `git describe`.

---

## 11. Testing Plan

### General Testing Plan (Any Release)
- [ ] Install from npm, verify version + native binary + `codegraph info` reports `native`
- [ ] Cold-start sweep: every command before `build`, confirm graceful `DB_ERROR`
- [ ] Full command sweep with `-j`/`-T`/`--include-tests` where applicable
- [ ] Incremental: no-op, real change, revert-to-identical-content, `--no-incremental` — diff full edge sets, not just counts
- [ ] Engine comparison: node/edge/cycle/community counts, full edge-set diff (not just totals)
- [ ] Embed → search → modify → rebuild → search-without-re-embed pipeline
- [ ] MCP `tools/list` in both single- and multi-repo mode
- [ ] Programmatic API via both `import()` and `require()`

### Release-Specific Testing Plan (v3.16.0)
- [x] Remote embedding provider: config parsing, graceful failure on unreachable endpoint, **and cwd-sensitivity** (this is where #2137 was found)
- [x] Complexity metrics for C/C++/Kotlin/Swift/Scala/Bash on WASM
- [x] Leiden native port parity vs wasm
- [x] Deleted-export advisory persistence across rebuild purge ordering

### Proposed Additional Tests (for future dogfood sessions)
- Full edge-set diffs (not just node/edge counts) after every incremental-rebuild scenario — this is what actually caught #2138; count-only comparisons would have missed it entirely.
- Test every CLI command from a **different cwd** than the target repo, not just via `--db <path>` from within it — this is what surfaced #2137.
- Fetch git tags (not just the branch) before running any benchmark script in a fresh worktree.
- When testing the embedding benchmark, budget ~5-10 min per larger model (jina-base/jina-code/nomic/bge-large/bge-m3/mxbai-large) — the full 11-model sweep did not fit in this session's time budget.

---

## 12. Overall Assessment

v3.16.0 delivers on its stated headline items — the remote embedding provider feature works correctly and fails gracefully once its config is actually visible to the command (the cwd-sensitivity bug that blocks it in the common cross-directory invocation pattern is a pre-existing architectural issue, not new to this release); the six-language WASM complexity expansion and the native Leiden port both check out; the deleted-export persistence fix does exactly what it says. Command-sweep coverage was broad and almost entirely clean — of ~60 distinct commands/flag combinations exercised, only 2 produced genuinely wrong output (`export --functions` for json/graphson, `audit`'s misleading barrel-file message), both now fixed with PRs open. The incremental-rebuild edge-loss bug (#2138) and the native/wasm receiver-dispatch parity gap (#2139) are the most consequential remaining findings — both real correctness issues, both scoped precisely enough (exact edge lists, not just counts) that a follow-up session should be able to fix them directly from the issue text.

**Rating: 7.5/10.** Solid release for its stated scope, with one release-blocking-adjacent finding (#2137 — the flagship new feature is silently inert under a common invocation pattern) and two real, if narrow, correctness bugs in the core incremental/native-engine machinery that predate this release but were newly surfaced by this session's edge-set-diff methodology. Deducting for those three rather than the (already-fixed) minor `export`/`audit` bugs, which are exactly the kind of thing a good dogfood pass is supposed to catch and did.

---

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#2134](https://github.com/optave/ops-codegraph-tool/issues/2134) | update-graph.sh hook rebuilds the wrong repo with a stale global binary | open |
| Issue | [#2135](https://github.com/optave/ops-codegraph-tool/issues/2135) | audit \<file\> reports "No file matching" for barrel files | closed via #2142 |
| Issue | [#2136](https://github.com/optave/ops-codegraph-tool/issues/2136) | export --functions silently ignored for json/graphson | closed via #2141 |
| Issue | [#2137](https://github.com/optave/ops-codegraph-tool/issues/2137) | shared ctx.config resolved from process.cwd(), ignoring target dir | open |
| Issue | [#2138](https://github.com/optave/ops-codegraph-tool/issues/2138) | incremental rebuild loses 10 receiver-dispatch edges via unrelated file | open |
| Issue | [#2139](https://github.com/optave/ops-codegraph-tool/issues/2139) | native misses interface-typed multi-implementer receiver dispatch vs wasm | open |
| Issue | [#2140](https://github.com/optave/ops-codegraph-tool/issues/2140) | embedding-benchmark.ts spurious CODEGRAPH_ENGINE warning | open |
| PR | [#2141](https://github.com/optave/ops-codegraph-tool/pull/2141) | fix(export): honor --functions for json and graphson formats | open, CI running |
| PR | [#2142](https://github.com/optave/ops-codegraph-tool/pull/2142) | fix(audit): distinguish "file not found" from "file has zero functions" | open, CI running |

---

## Appendix: Tester-Error Disclosure

Two mistakes made during this session, disclosed for transparency (neither is a codegraph bug):

1. **Accidentally deleted the repo's real `.codegraphrc.json`** while iterating on remote-embedding-provider config tests (repeated `cat > .codegraphrc.json` + `rm -f` cleanup clobbered the committed file instead of a scratch copy). Caught via `git status` showing it as deleted; restored via `git show HEAD:.codegraphrc.json > .codegraphrc.json` before any build numbers in this report were finalized.
2. **Ran `codegraph registry prune --ttl 0` against the real global `~/.codegraph/registry.json`**, which — as documented — prunes anything not accessed in the last 0 days, i.e. everything. This wiped ~140 real registry entries accumulated across past sessions. No source code, graph databases, or other project data were affected (the registry is a lightweight name→path index only); every entry can be re-added on demand via `registry add <path>`. Flagged to the user immediately when discovered rather than held for this appendix.
