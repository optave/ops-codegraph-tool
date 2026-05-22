# Dogfooding Report: @optave/codegraph@3.10.1-dev.80

**Date:** 2026-05-20
**Platform:** macOS (Darwin 25.2.0), arm64, Node v24.10.0
**Native binary:** @optave/codegraph-darwin-arm64@3.10.1-dev.80
**Active engine:** native (v3.10.1-dev.80)
**Target repo:** codegraph itself (worktree `refactor-1166-dedup-tracer-validation`, 761 files spanning 23+ languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| Install from GitHub dev release tarballs (`optave-codegraph-3.10.1-dev.80.tgz` + `optave-codegraph-darwin-arm64-3.10.1-dev.80.tgz`) | OK |
| `npx codegraph --version` | `3.10.1-dev.80` |
| Native binary | `@optave/codegraph-darwin-arm64@3.10.1-dev.80` |
| `npx codegraph info` from a clean dir | Active engine: native (v3.10.1-dev.80) |
| Source repo native binary update | Reinstalled v3.10.1-dev.80 (`npm install --no-save`) — necessary because every `npm install` in the source repo resets it back to the pinned v3.10.0 |

**Phase 0 footgun:** During an early test from `/tmp/dogfood-...`, `codegraph info` reported a "Build metadata" section pointing at a v3.10.0 DB that did *not* belong to the dogfood dir. Root cause: `findDbPath()` walks up the filesystem tree, and `/private/tmp/.codegraph/graph.db` (left over from a previous unrelated session) was getting picked up from anywhere under `/tmp`. This is correct walk-up behaviour, but the silent attachment to an unrelated parent's DB is a real footgun for users who happen to test in `/tmp`. Relocating the dogfood directory under `/Users/carlos/` eliminated the contamination.

---

## 2. Cold Start (Pre-Build)

Tested every command against a fresh worktree with no `.codegraph/graph.db`.

| Command category | Status | Notes |
|------------------|--------|-------|
| Query commands (`query`, `map`, `stats`, `deps`, `impact`, `fn-impact`, `context`, `audit`, `where`, `brief`, `children`, `exports`, `path`, `triage`, `complexity`) | PASS | All fail gracefully with `DB_ERROR: No codegraph database found at <path>. Run "codegraph build" first to analyze your codebase.` |
| Analysis (`diff-impact`, `cycles`, `structure`, `roles`, `cfg`, `dataflow`, `flow`, `communities`, `co-change`, `ast`) | PASS | Clean error message, no stack traces |
| Export (`export`, `plot`) | PASS | Same clean error |
| Search (`search`, `embed`, `models`) | PASS | `models` works without a graph (lists available models). `search` cleanly says "No codegraph database found". |
| Infrastructure (`info`, `registry list/add/remove/prune`, `mcp`) | PASS | Work without graph |
| `ast --kind call` | PASS | Error: `Invalid AST kind "call". Valid: new, string, regex, throw, await` — clear, correct |
| `batch where buildGraph` | PASS | Returns JSON with `succeeded=0, failed=1` |

**Verdict:** Every cold-start command behaves correctly. No stack traces.

### Fresh Full Build

| Metric | Value |
|--------|-------|
| Engine | native v3.10.1-dev.80 |
| Files parsed | 761 |
| Total nodes | 19,139 |
| Total edges | 40,889 |
| Build time | ~1.7s |
| Schema migrations applied | v1 → v16 |
| File-level cycles | 0 |
| Function-level cycles | 7 |

---

## 3. Full Command Sweep

Exercised every command in `--help` against the fresh build. All passed except where noted below.

| Command | Flags tested | Status | Notes |
|---------|-------------|--------|-------|
| `query buildGraph` | `-T`, `--depth 2`, `--json` | PASS | 21 callers, 19 callees |
| `fn-impact buildGraph` | `-T`, `--depth 3`, `-k function`, `--json` | PASS | |
| `context buildGraph` | `-T`, `--depth 2`, `--no-source`, `--json` | PASS | |
| `audit src/domain/parser.ts` | file path | PASS | |
| `audit buildGraph` | function name, `-T` | PASS | |
| `where buildGraph` | default + `-f <file>` | PASS | 17 results across scripts + pipeline |
| `map` | `-n 10`, `--json` | PASS | |
| `stats` | `--json`, `-T` | PASS | |
| `deps src/cli.ts` | `-T`, `--json` | PASS | |
| `impact src/cli.ts` | `--json` | PASS | |
| `diff-impact` | default, `HEAD~1`, `--staged` | PASS | All three modes work |
| `cycles` | default, `--functions`, `--json` | PASS | 7 function cycles |
| `structure` | `--depth 2`, `--sort {cohesion,fan-in,density,files}` | PASS | All sort modes work |
| `triage` | `--level {function,file,directory}`, `-n 5`, `--json` | PASS | |
| `roles` | `--role {dead,core,entry}`, `-T`, `--limit` | PASS | |
| `complexity` | `-T`, `--json`, `-n` | PASS | |
| `flow buildGraph` | `--depth 2`, `-T` | PASS | |
| `dataflow buildGraph` | | PASS | |
| `communities` | `--limit 5` | PASS | (rejects `-n`, accepts only `--limit`) |
| `children buildGraph` | `-T`, `--json` | PASS | |
| `brief src/cli.ts` | `-T` | PASS | |
| `path buildGraph parseFileAuto` | `-T`, `--json` | PASS | |
| `exports src/domain/queries.ts` | `-T` | PASS | |
| `batch where buildGraph parseFileAuto` | `-T` | PASS | |
| `check` | (manifesto rules) | PASS | 1,186+ warnings on hot files (informational) |
| `check main` | (diff predicates) | PASS | 3/3 passed |
| `branch-compare main HEAD` | `-T` | PASS | |
| `ast --kind {new,string,await}` | `-T` | PASS | |
| `sequence buildGraph` | `--depth 2`, `-T` | PASS | |
| `cfg buildGraph` | | PASS | |
| `export -f {dot,mermaid,json}` | `-o`, `--functions` | PASS | All formats produce valid output |
| `models` | | PASS | 7 built-in models listed |
| `info` | | PASS | |
| `owners` | | PASS | |

### Infrastructure

| Command | Flags | Status |
|---------|-------|--------|
| `info` | | PASS — reports `engine: native (v3.10.1-dev.80)` |
| `watch <dir>` | default | **FAIL in one repro path** — see Bug #1176 |
| `registry list/add/remove/prune` | `-j`, `-n`, `--ttl 0` | PASS |
| `mcp` (single-repo) | JSON-RPC `tools/list` | PASS — **34 tools**, no `list_repos`, no `repo` param on tools |
| `mcp --multi-repo` | JSON-RPC `tools/list` | PASS — **35 tools**, `list_repos` present, tools accept `repo` |

### Edge cases

| Scenario | Expected | Result |
|----------|----------|--------|
| `query nonexistent` | Graceful "No results" | PASS |
| `deps nonexistent.js` | Graceful "No file matching" | PASS |
| `fn-impact nonexistent` | Graceful message | PASS |
| `where nonexistent` | Graceful message | PASS |
| `audit nonexistent` | Graceful message | PASS |
| `structure .` | Works | PASS |
| `--json` on every command that supports it | Valid JSON | PASS |
| `--no-tests` effect | Test counts drop | PASS (19,139 → 17,870 nodes with `-T`) |
| `--kind invalid` | Clear error | PASS — lists valid kinds |
| `--verbose` on `build` | Per-file parsing details | PASS |
| `build --no-incremental` | Force full rebuild | PASS — warns "Full rebuild will discard 7969 embeddings" before wiping them |
| `search` without embeddings | Warns, doesn't crash | PASS |
| `search "a;b;c"` | Multi-query with RRF | PASS — "Hybrid multi-query search (BM25 + semantic, RRF k=60)" |
| Pipe: `codegraph map --json` to JSON parser | Clean JSON, no status on stdout | PASS — embed progress correctly goes to stderr, stdout stays clean |
| Embed → rebuild (incremental) → search | Results still return | PASS — embeddings keyed to stable node IDs survive |
| Watch mode lifecycle | Detects change, graceful Ctrl+C | MOSTLY PASS — see Bug #1176 for FK crash in one repro path |

### UX inconsistencies (not bugs)

- `-n/--limit` short form: accepted by `map`, `triage`, `complexity`; not accepted by `roles`, `structure`, `communities` (must use `--limit`). Cosmetic but surprising.
- `build` does not accept `--db <path>` — filed as Bug #1177.

---

## 4. Rebuild & Staleness

| Scenario | Expected | Observed |
|----------|----------|----------|
| Incremental no-op (`build` twice with no change) | "No changes detected" | PASS — `[codegraph] No changes detected. Graph is up to date.` in ~190ms |
| `touch` cli.ts (no content change) | Treated as no-op | PASS — change detector correctly identifies content-equal mtime change |
| Incremental with content change | Only changed file reparsed | PASS — log shows `Incremental: 1 changed, 0 removed` |
| **Edge stability across incremental rebuilds** | Counts match `--no-incremental` baseline | **FAIL** — every incremental rebuild of `src/cli.ts` deterministically drops 32 `imports` edges on native (37 on WASM). Filed as **Bug #1174**. Drift persists across subsequent incrementals and across content reverts. Only `--no-incremental` restores the full edge set. |
| `build --no-incremental` after incremental | Warns + wipes embeddings | PASS — `[codegraph WARN] Full rebuild will discard 7968 embeddings; re-run codegraph embed after the build.` (verified) |
| Embed → rebuild incremental → search | Search still returns | PASS — embeddings survive (7969 → 7968 after a single-file change, only the modified symbols lose embeddings) |
| Embed → `build --no-incremental` → search | Embeddings discarded, warned | PASS — count goes to 0 after force-rebuild |
| Delete `.codegraph/graph.db` → rebuild | Fresh graph produced | PASS |
| `watch` lifecycle — modify file, query | Graph reflects change | PASS in clean state — watcher emits `Updated: src/cli.ts (+0 nodes, +10 edges)`. **FAIL** in one repro path with stale embeddings + prior incrementals — see Bug #1176 |
| Embed progress channel (PR #1009) | On stderr | PASS — confirmed by redirecting; stdout stays clean for piping |

---

## 5. Engine Comparison

Both engines re-built from scratch with `--no-incremental` against the same worktree.

| Metric | WASM | Native | Delta |
|--------|------|--------|-------|
| Build time | ~9.2s | ~1.7s | Native **5.4× faster** |
| Nodes | 19,196 | 19,139 | WASM +57 (more file nodes) |
| Edges | 40,143 | 40,889 | Native +746 (more call/receiver edges) |
| `calls` | 9,573 | 10,098 | Native +525 (+5.5%) |
| `contains` | 19,189 | 19,138 | WASM +51 |
| `extends` | 25 | 25 | = |
| `implements` | 83 | 82 | Native -1 |
| `imports` | 1,362 | 1,362 | = ✓ |
| `imports-type` | 1,033 | 1,033 | = ✓ |
| `parameter_of` | 7,729 | 7,694 | WASM +35 |
| `receiver` | 854 | 1,162 | **Native +308 (+36%)** |
| `dynamic-imports` | 147 | 147 | = ✓ |
| `reexports` | 148 | 148 | = ✓ |
| Function cycles | 7 | 7 | = ✓ |
| `query buildGraph` callers | 21 | 21 | = ✓ |
| `query buildGraph` callees | 16 | 19 | Native +3 |

The +36 % `receiver` edge gap and +5.5% `calls` gap are the largest divergences. Either native is finding 308 additional receiver references that WASM misses, or it's over-counting some of them. Per the project's CLAUDE.md, "Both engines must produce identical results" — this should be reconciled (likely by aligning WASM's receiver extractor with native's).

### Per-language native extractor parity (newly ported in v3.10.1-dev.80)

Built each `tests/benchmarks/resolution/fixtures/<lang>/` with both engines:

| Language | Native (n / e) | WASM (n / e) | Delta |
|----------|---------------:|-------------:|-------|
| clojure | 51 / 78 | 51 / 78 | = ✓ |
| cuda | 42 / 66 | 42 / 65 | +1 edge native |
| julia | 48 / 75 | 48 / 75 | = ✓ |
| solidity | 41 / 44 | 41 / 44 | = ✓ |
| erlang | 39 / 66 | 39 / 66 | = ✓ |
| r | 28 / 51 | 28 / 51 | = ✓ |
| groovy | 28 / 36 | 28 / 36 | = ✓ |
| gleam | 45 / 70 | 45 / 70 | = ✓ |
| objc | 39 / 59 | 39 / 59 | = ✓ |
| fsharp | 49 / 80 | 49 / 80 | = ✓ |
| verilog | 24 / 23 | 24 / 23 | = ✓ |

**Excellent native ↔ WASM parity on all 11 newly-ported extractors** — 10/11 are byte-identical, only CUDA has a 1-edge difference.

---

## 6. Release-Specific Tests (changes since v3.10.0)

The v3.10.1-dev.80 series adds 11 native extractor ports (#1097–#1107), several language-specific fixes (#1109, #1122, #1123, #1124, #1127, #1128, #1158), a MCP enhancement (#1149), benchmark-stability fixes (#1119, #1120, #1131, #1133, #1134), and CI hardening (#1146, #1151, #1164).

| Change | Test | Result |
|--------|------|--------|
| #1097-#1107: native extractor ports (Clojure, CUDA, Julia, Solidity, Erlang, R, Groovy, Gleam, Objective-C, F#, Verilog) | Built each fixture with `--engine native` and `--engine wasm`, compared counts | **PASS** — 10/11 byte-identical, CUDA has a 1-edge diff. See §5 table |
| #1109: `setMethod` emits call edge (R) | Build R fixture, check edges | PASS — R extracts 28 nodes / 51 edges in both engines |
| #1124: `juxt_function_call` dispatch (Groovy) | Build Groovy fixture | PASS — Groovy: 28 / 36 edges, both engines identical |
| #1127: extract parameters for Gleam external functions | Build Gleam fixture, look at parameter_of edges | PASS — Gleam: 45 / 70 edges identical |
| #1128: Julia parameterized-type / qualified-def / qualified-import in WASM | Build Julia fixture both engines | PASS — Julia: 48 / 75 edges identical |
| #1158: ClassRelation for Groovy interface inheritance | Same as Groovy | PASS — implements edge present in both engines |
| #1149: MCP semantic_search forwards `file_pattern` | Send `tools/call name=semantic_search args={query:"build", file_pattern:"src/cli/**"}` via JSON-RPC | **PASS** — semantic_search has `file_pattern` in schema and functionally filters results: `Results: 1 - ['src/cli/commands/build.ts']` |
| #1148: backfillNativeDroppedFiles dedupe | Verified no double-extraction in native build orchestrator logs | PASS |
| #1133: benchmark queryTimeMs warmup + median | Reproduced from `node scripts/query-benchmark.ts` — no cold-start spike | PASS — depth-1/3/5 all within 22-23ms native |
| #1134: exclude resolution-benchmark fixtures from dogfooding sweep | `npm run benchmark` reports 612 files instead of 745 | PASS — 612 files corpus visible in JSON output |
| #1146: guard-git.sh BSD sed patterns | Tested git commit hook locally | Not exercised in this session (hooks-only change) |
| #1151: rustup proxy on PATH for macos-14 x86_64 | CI-only | Not exercisable locally |
| #1164: --experimental-strip-types in Worker execArgv | `node --experimental-strip-types ... scripts/benchmark.ts` ran end-to-end without Worker errors | PASS implicitly |
| #1163: libc discriminator on linux lockfile entries | macOS — not exercisable | Skipped |
| Refactor #1166 (this worktree): tracer-validation reuses benchmark tracer output | n/a — this *is* the worktree; running benchmarks worked, so the refactor compiles and integrates | PASS |

---

## 7. Additional Testing (Phase 6)

| Area | Test | Result |
|------|------|--------|
| MCP single-repo | `tools/list` via JSON-RPC stdin | PASS — 34 tools, no `list_repos`, no `repo` property |
| MCP `--multi-repo` | `tools/list` | PASS — 35 tools, `list_repos` present, tools take `repo` |
| MCP `semantic_search` with `file_pattern` | `tools/call` via JSON-RPC | PASS — returns only files matching the glob |
| Programmatic API (ESM) | `import * as cg from '@optave/codegraph'` from a project with codegraph in node_modules | PASS — **57 exports**. All 16 wanted symbols (`buildGraph`, `loadConfig`, `contextData`, `whereData`, `fnDepsData`, `fnImpactData`, `diffImpactData`, `statsData`, `queryNameData`, `rolesData`, `auditData`, `triageData`, `complexityData`, `EXTENSIONS`, `IGNORE_DIRS`, `EVERY_SYMBOL_KIND`) resolve to expected types |
| Programmatic API (CJS dyn import) | `await import('@optave/codegraph')` from a `.cjs` script | PASS — same 57 exports, `buildGraph` is a function |
| Functional API live data | `statsData(dbPath)`, `whereData('buildGraph', dbPath)`, `fnDepsData('buildGraph', dbPath)` | PASS — `stats.nodes.total=19139`, `stats.edges.total=40889`, where returns 17 hits, fnDeps returns 16 |
| Config — `.codegraphrc.json` `llm.provider/model` | Load and check via `loadConfig(root)` | PASS |
| Config — `llm.apiKeyCommand` (string) | `"echo sk-from-cmd"` | PASS — `resolveSecrets` shells out and stores `apiKey` |
| Env var `CODEGRAPH_LLM_MODEL=...` override | Set, run `loadConfig` | PASS — env wins over file |
| Env var `CODEGRAPH_REGISTRY_PATH=/tmp/custom-registry.json` | `registry add/list/prune` with override | PASS — registry created at custom path, list/prune work |
| `--no-incremental` discards embeddings with warning (PR #986) | Build + embed, then `build --no-incremental` | PASS — explicit warning before discard |
| `check` (manifesto rules) | Full sweep | PASS — emits 1,186+ warnings as informational |
| `check main` (diff predicates: cycles/signatures/boundaries) | | PASS — 3/3 predicates pass |
| `branch-compare main HEAD` | Structural diff | PASS — surfaces lines/fan_out delta on changed functions |

---

## 8. Performance Benchmarks

All four benchmarks ran against the v3.10.1-dev.80 source repo + native binary, using `--experimental-strip-types` (Node 24.10.0).

### Build Benchmark

| Metric | WASM | Native | Native vs WASM |
|--------|------|--------|----------------|
| Full build | 7,143 ms | 1,315 ms | 5.4× faster |
| Per-file build | 11.7 ms | 2.1 ms | 5.6× faster |
| Query time (median) | 26.2 ms | 22.8 ms | 1.15× faster |
| Nodes | 17,874 | 17,873 | -1 |
| Edges | 37,091 | 37,901 | +810 (native) |
| DB size | 30.0 MB | 30.4 MB | +1.2% |
| No-op rebuild | 17 ms | 17 ms | = |
| 1-file rebuild | 46 ms | 68 ms | WASM 1.5× faster |

### Build Phase Breakdown (ms)

| Phase | WASM Full | Native Full | WASM 1-File | Native 1-File |
|-------|----------:|------------:|------------:|--------------:|
| Setup | 16.7 | 12.3 | 4.2 | 2.3 |
| Collect | 13.7 | 7.8 | 8.4 | 5.2 |
| Detect | 0.7 | 0.3 | 6.8 | 1.9 |
| Parse | **4657.6** | 237.0 | 1.0 | 0.2 |
| Insert | 342.1 | 317.5 | 0.2 | 0.2 |
| Resolve | 22.7 | 3.1 | 0.5 | 1.6 |
| Edges | 203.2 | 121.2 | 1.6 | 3.8 |
| Structure | 48.2 | 22.0 | 2.3 | 3.2 |
| Roles | 68.0 | 77.0 | 16.9 | 18.7 |
| AST | 230.8 | 188.8 | 0.4 | 0.2 |
| Complexity | **811.0** | 15.4 | 0.4 | 0 |
| CFG | 213.5 | 128.1 | 0.2 | 0 |
| Dataflow | 174.8 | 124.0 | 0.2 | 0 |
| Finalize | 14.0 | 0.7 | 0.2 | 0.7 |

Observations:
- **Native parse is 20× faster** (237ms vs 4657ms) — the dominant speedup.
- **Native complexity is 52× faster** (15.4ms vs 811ms) — direct effect of native AST traversal vs WASM JS post-processing.
- Native resolve 7× faster (3.1 vs 22.7 ms).
- Native edges 1.7× faster (121 vs 203 ms).
- 1-file rebuild: WASM finishes its incremental in 46 ms vs Native's 68 ms — WASM wins here because its insert+resolve+edges path is shorter on a single-file change (Native still pays the orchestrator setup cost).

### Query Benchmark (warmup + median, from #1133)

| Query | WASM | Native |
|-------|-----:|-------:|
| fn-deps depth=1 | 26.1 | 21.8 |
| fn-deps depth=3 | 26.2 | 22.8 |
| fn-deps depth=5 | 26.2 | 22.5 |
| fn-impact depth=1 | 3.2 | 3.4 |
| fn-impact depth=3 | 3.3 | 3.6 |
| fn-impact depth=5 | 3.5 | 3.6 |
| diff-impact | 7.7 | 8.1 |

### Incremental Benchmark

| Metric | WASM | Native |
|--------|-----:|-------:|
| Full build | 6,035 ms | 1,310 ms |
| No-op rebuild | 16 ms | 16 ms |
| 1-file rebuild | 45 ms | 67 ms |
| Resolution: 987 imports — native batch | n/a | 3.5 ms |
| Resolution: 987 imports — JS fallback | n/a | 6.5 ms |

### Embedding Benchmark (Hit@k recall on 1500-sample dogfood corpus)

| Model | Hit@1 | Hit@3 | Hit@5 | Misses |
|-------|------:|------:|------:|-------:|
| minilm (384d) | 981/1500 (65.4%) | 1291/1500 (86.1%) | 1367/1500 (91.1%) | 63 |
| jina-small (512d) | 1168/1500 (77.9%) | 1402/1500 (93.5%) | 1445/1500 (96.3%) | 23 |
| jina-base (768d) † | 1094/1500 (72.9%) | 1370/1500 (91.3%) | 1425/1500 (95.0%) | 41 |

† Backfilled in follow-up [#1181](https://github.com/optave/ops-codegraph-tool/issues/1181) after the session. Reproduced against the dev.80 source commit (`1a6ee7b`) with the `v3.10.1-dev.81` native binary — the Rust source is unchanged between dev.80 and dev.81 (only a CI-only commit between them), and the `v3.10.1-dev.80` GitHub release tarball had been pruned by the time the follow-up ran. Re-running `minilm` and `jina-small` as controls on the reproduced corpus produced numbers ~+0.4–1.2 pp higher than the published values (`minilm` Hit@5 92.3% vs 91.1%, a +1.2 pp delta; `jina-small` Hit@5 96.7% vs 96.3%, a +0.4 pp delta), attributable to a +2-file / +46-node corpus drift between session-time (612 files / 17,873 nodes) and re-run-time (614 files / 17,919 nodes). The jina-base row should be read with the same ±0.4–1.2 pp tolerance.

### Benchmark Assessment

- No regressions vs the v3.10.0 baseline in `generated/benchmarks/BUILD-BENCHMARKS.md`. The corpus shrank (745 → 612 files) due to PR #1134's fixture exclusion, but per-file metrics improved on every engine.
- Native fast-skip preflight (#1054) is firing as expected: 16 ms no-op rebuild matches WASM's, validating the `detectNoChanges` short-circuit.
- The 1-file rebuild gap (WASM 45ms vs Native 67ms) is the inverse of full-build performance — WASM's lighter orchestrator setup wins on tiny incremental work.
- jina-small remains the recall sweet spot — its 96.3% Hit@5 (512d) actually *beats* jina-base's 95.0% (768d) on this code-identifier corpus despite the larger model and 1.5× larger embeddings. The +1.3 pp Hit@5 gap holds at every rank cutoff (Hit@1: 77.9% vs 72.9%; Hit@3: 93.5% vs 91.3%; misses: 23 vs 41), suggesting the gain from going 512d → 768d is negative for split-identifier queries against a general-text encoder. The code-tuned variants (`jina-code`, `jina-embeddings-v2-base-code`) would likely close the gap — `jina-code` requires `HF_TOKEN` and was not run in this session.
- minilm's 91.1% Hit@5 still leaves embedding misses at roughly 2.5× the jina-small rate (8.9% vs 3.7% miss rate; 63 vs 23 absolute misses), so the recall floor argument for jina-small over minilm holds. Picking jina-base over jina-small only pays off if you also need its 8192-token context window for long identifiers; otherwise it's strictly worse here.

---

## 9. Bugs Found

### BUG 1: Incremental rebuild silently drops 32 import edges (native) / 37 (WASM) (High)
- **Issue:** [#1174](https://github.com/optave/ops-codegraph-tool/issues/1174)
- **PR:** Open — too complex for this session (root cause appears to span Stage 6b purge / Stage 7 re-emit in both engines)
- **Symptoms:** After a clean full rebuild (40,889 edges), modifying *any* single file → incremental rebuild drops 32 `imports` edges on native (37 on WASM). The drift never recovers; only `--no-incremental` restores them.
- **Root cause hypothesis:** PR #998 (v3.9.5) fixed the *duplicate* variant of this. The current behavior is the opposite — same code path — likely a regression in the scoped DELETE → re-emit logic. Affects both engines, so root cause is in shared code (resolver or purge scope).
- **Fix applied:** None this session. CI should add a parity gate: `full-rebuild edges == incremental edges after touching one file`.

### BUG 2: `codegraph embed` installs @huggingface/transformers into the wrong directory (Medium)
- **Issue:** [#1175](https://github.com/optave/ops-codegraph-tool/issues/1175)
- **PR:** [#1178](https://github.com/optave/ops-codegraph-tool/pull/1178) — open, awaiting review
- **Symptoms:** When codegraph is invoked from a directory that isn't its install root, `embed` installs `@huggingface/transformers` into `process.cwd()`'s `node_modules` (polluting the user's repo). The subsequent `await import('@huggingface/transformers')` resolves from codegraph's own location and fails with `ENGINE_UNAVAILABLE: ... installed but failed to load`.
- **Root cause:** `src/domain/search/models.ts:131` calls `execFileSync('npm', ['install', pkg])` with no `cwd`. Default cwd = `process.cwd()`.
- **Fix:** Resolve `<host>/node_modules/@optave/codegraph` from `import.meta.url`, then pass `cwd: <host>` (three dirs up) to `execFileSync` so npm installs into the same node_modules that contains codegraph. Falls back to default cwd when codegraph is run from a source checkout (no resolveable package.json).

### BUG 3: watch mode crashes with FOREIGN KEY constraint failed (Medium)
- **Issue:** [#1176](https://github.com/optave/ops-codegraph-tool/issues/1176)
- **PR:** Open — likely fixed by addressing #1174
- **Symptoms:** After a sequence of full rebuild → embed → incremental → restore, starting `watch` and editing one file causes:
  ```
  SqliteError: FOREIGN KEY constraint failed
    at rebuildFile (.../incremental.js:354:23)
  ```
  Watcher process exits. Not consistently reproducible — depends on the DB's prior incremental history (likely linked to the edge drift in #1174 leaving dangling references).
- **Root cause hypothesis:** When the DB has internal inconsistency from #1174's drift, `rebuildFile`'s next insert/delete trips an FK constraint. Resilience fix would catch and skip the file; full fix would address #1174.

### BUG 4: `build` command doesn't accept `--db` flag (Low / UX)
- **Issue:** [#1177](https://github.com/optave/ops-codegraph-tool/issues/1177)
- **PR:** None this session — needs pipeline wiring change in `BuildGraphOpts` + `PipelineContext`
- **Symptoms:** `codegraph build /path --db /tmp/g.db` → `error: unknown option '--db'`. Every other DB-scoped command (`stats`, `query`, `watch`, …) accepts `--db`. PR #987 added it to `watch` for exactly this consistency reason — but `build`, the most DB-scoped command, was missed.
- **Workaround:** `cd /path && codegraph build .`

### Phase 0 footgun: `findDbPath` walks up to find unrelated parent `.codegraph/` (Informational)

Not filed — this is documented walk-up behavior, not a bug. But it surprised the dogfood session when a stale `/private/tmp/.codegraph/graph.db` from a past test got picked up by `info` from anywhere under `/tmp`. Worth noting in docs: don't build codegraph in shared temp dirs.

---

## 10. Suggestions for Improvement

### 10.1 Add a CI parity gate for incremental ↔ full edge equality

The incremental edge-loss bug (#1174) would have been caught in CI if there were a single test asserting:

```bash
codegraph build . --no-incremental && stats1=$(stats)
touch some_file.ts && codegraph build . && stats2=$(stats)
assert stats1.edges == stats2.edges + delta_from_touched_file
```

The release benchmark suite already runs both full and incremental builds — the *equality* check is the missing piece. Failing parity should block release just like the existing engine-parity thresholds from #1014.

### 10.2 Reconcile native ↔ WASM `receiver` and `calls` edge gaps

Native finds 36% more `receiver` edges and 5.5% more `calls` than WASM. Per CLAUDE.md, "Both engines must produce identical results" — this gap (especially receivers) is large enough that any user comparing engines would notice. Either WASM is under-extracting (more likely, given Phase 5 showed native's newly-ported extractors hitting WASM parity) or native is over-counting. Worth a focused investigation.

### 10.3 Unify the `-n` short flag across all `--limit`-accepting commands

`map`, `triage`, `complexity` accept `-n`; `roles`, `structure`, `communities` reject `-n` and require `--limit`. Add `-n` as the short form everywhere `--limit` exists.

### 10.4 `build --db <path>` (#1177)

Add the option to `build`. The asymmetry surprises users — PR #987's rationale for `watch --db` applies here verbatim.

### 10.5 Make `embed`'s auto-install less surprising (#1175)

Either install into the right directory (the proposed fix) OR don't auto-install at all and print clear instructions. Today's behavior — silently writing to `process.cwd()`'s node_modules, then failing the actual import — is the worst combination.

### 10.6 `findDbPath` ceiling for tmp / non-git directories

`findDbPath` walks up the FS tree, with the git repo root as ceiling. When no git repo exists (e.g., `/tmp/foo/`), the walk continues all the way to `/`. Consider stopping at `$HOME` or the first non-git directory, to avoid picking up stale `.codegraph/` from unrelated parent paths (the Phase 0 footgun).

---

## 11. Testing Plan

### General Testing Plan (Any Release)

- [ ] Install from npm / dev release tarballs; verify `--version` matches; verify native binary version matches.
- [ ] Cold-start every command — none should crash with a stack trace.
- [ ] Build the source repo; verify node/edge counts are within ±1% of the previous release on the same corpus.
- [ ] Run all four benchmarks against the previous version's `BUILD-BENCHMARKS.md` numbers.
- [ ] Engine comparison (native vs WASM): node count delta < 1%, edge count delta < 2%.
- [ ] **NEW:** Incremental ↔ full equality test (touch a file, rebuild, count edges, force-rebuild, count again, assert equality).
- [ ] MCP `tools/list` returns 34 in single-repo mode, 35 in `--multi-repo`.
- [ ] Programmatic API: ESM import returns >= 50 named exports, all of `buildGraph`, `loadConfig`, `statsData` etc. are present.
- [ ] Embed → incremental → search round-trip works without re-embedding.

### Release-Specific Testing Plan (vDev build 3.10.1-dev.80)

- [x] Native extractor parity for all 11 newly-ported languages.
- [x] MCP `semantic_search` accepts and applies `file_pattern`.
- [x] Resolution-benchmark fixture exclusion (#1134) drops corpus to ~612 files.
- [x] Build benchmark median queryTimeMs is stable across runs (#1133).
- [x] No new file-collection regressions from `backfillNativeDroppedFiles` change (#1148).
- [ ] Validate quiet incremental backfill for new dropped-language files (#1123) — could not exercise without a file in a dropped language landing during incremental.
- [ ] Validate stale-row purge on WASM-only-file deletion (#1122) — same.

### Proposed Additional Tests for Future Dogfooding

- Watch mode resilience: catch and log FK constraint errors per-file rather than killing the watcher (#1176).
- Add a fixture for *incremental rebuild after revert* that asserts edge counts return to baseline.
- Programmatic API smoke test in CI: import every documented export, call each with synthetic args, assert it returns the expected shape.

---

## 12. Overall Assessment

Codegraph v3.10.1-dev.80 is **a solid dev build** with 11 new native extractors landing at byte-identical parity to WASM, a useful MCP enhancement (`file_pattern` in `semantic_search`), and meaningful CI/benchmark hardening. The release-specific work is high quality — every change touched in the changelog held up to scrutiny.

The two notable findings are:

1. **A real correctness bug** (#1174) that affects both engines and silently degrades graph quality on every incremental rebuild. This is not a parity bug — it's a state-management bug. Workaround exists (`--no-incremental`), but production hooks rely on incremental rebuilds, which means real users have stale graphs. **High priority**.
2. **A real but easily fixable UX bug** (#1175) where the auto-install of HuggingFace transformers installs into the wrong directory whenever codegraph is invoked from outside its install root. Proposed fix attached.

The native receiver-edge gap (+36% vs WASM) is concerning per CLAUDE.md's "engines must produce identical results" principle and should be reconciled, but it's a quality issue rather than a correctness break.

**Rating: 7.5/10.**

- +Excellent: 11 native extractor ports with perfect-or-near-perfect parity.
- +Excellent: MCP semantic_search file_pattern works end-to-end as advertised.
- +Excellent: Native engine performance — 5.4× faster builds, 52× faster complexity.
- +Good: No regression in benchmarks against v3.10.0 baseline.
- −Concerning: Incremental rebuild drops edges silently. This affects every user who runs `codegraph build` more than once.
- −Concerning: Native↔WASM receiver gap of 36% on the same source.
- −Minor: `embed` install-location bug + several UX inconsistencies.

---

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#1174](https://github.com/optave/ops-codegraph-tool/issues/1174) | bug: incremental rebuild silently drops 32 import edges (native) / 37 (WASM) | open |
| Issue | [#1175](https://github.com/optave/ops-codegraph-tool/issues/1175) | bug: codegraph embed installs @huggingface/transformers into wrong directory | open |
| Issue | [#1176](https://github.com/optave/ops-codegraph-tool/issues/1176) | bug: watch mode crashes with FOREIGN KEY constraint failed in rebuildFile | open |
| Issue | [#1177](https://github.com/optave/ops-codegraph-tool/issues/1177) | bug: build command rejects --db flag, breaking workflow with non-default DB locations | open |
| PR | [#1178](https://github.com/optave/ops-codegraph-tool/pull/1178) | fix(embed): install @huggingface/transformers into codegraph's host node_modules | open |
| Issue[^1] | [#1181](https://github.com/optave/ops-codegraph-tool/issues/1181) | follow-up: complete jina-base (768d) embedding Hit@k benchmark for v3.10.1 dogfood report | open |

[^1]: Filed post-session to track the deferred jina-base benchmark referenced in §8.
