# Codegraph Architectural Audit

**Date:** 2026-06-19
**Version audited:** v3.13.0 (`@optave/codegraph@3.13.0`)
**Commit:** adeed351 (feat/dataflow-p4-native)
**Auditor perspective:** Principal architect, cold evaluation
**Methodology:** Codegraph self-analysis + manual source review + verified competitor research
**Previous audit:** [ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md](./ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md)

---

## Executive Summary

Three months and nine minor versions since the v3.4.0 audit. The headline improvements are real: caller coverage jumped from 29% to 41% (TypeScript-native resolution), community drift fell from 49% to 25%, and interprocedural dataflow analysis landed across multiple phases — a genuinely differentiated feature no competitor had three months ago. The language support expanded from 11 to 34 (though fixture quality varies enormously by language). These are not paper improvements.

The structural regressions are also real, and several findings from the previous audit were simply ignored. The 37-file MCP cycle was flagged in March — it persists unchanged in June. `types.ts` grew from 1,851 to 2,855 LOC (+54%) in three months. `dataflow.ts` became a 1,586-line god file that handles parsing, extraction, edge insertion, BFS traversal, and interprocedural stitching in a single module. Call confidence dropped from 81% to 73% — the new ts-native resolution is adding edges but at meaningfully lower confidence. The tool's own generated artifact (`index.js`, the NAPI-RS binding) is not excluded from analysis, ranking as the highest-risk item with a fabricated 359 cognitive complexity score. And there is still only one ADR for a codebase that just shipped interprocedural dataflow, 23 new languages, a user-level consent model, and a native orchestrator.

The competitive pressure is intensifying. GitNexus jumped from 19.9k to 42.5k stars in three months. narsil-mcp now claims 32 languages with Merkle-tree incremental. The moat codegraph holds — local + deterministic + function-level + MCP + CLI + 3 deps + MIT — is real but no longer unique in every dimension. The path forward is depth, not breadth: the 41% caller coverage ceiling is the most important number in this document.

---

## Scorecard

| Dimension | Current State | State of the Art | Gap | Justification |
|-----------|--------------|-----------------|-----|---------------|
| **Abstraction Quality** | 6/10 | 9/10 | 3 | types.ts at 2,855 LOC (+54% since last audit) is worsening, not improving. dataflow.ts at 1,586 LOC is now a god file. MCP cycle (37 files) persists 3 months after being flagged. These are known debts being accumulated deliberately. |
| **Coupling & Cohesion** | 6/10 | 9/10 | 3 | types.ts fan-in grew from 122 to 185. db/index.ts fan-in is 101. Same structural issues from v3.4.0, all slightly worse. The generated index.js polluting analysis with fan-out 601 adds false signal. |
| **Scalability** | 6/10 | 9/10 | 3 | Same SQLite single-writer model. In-memory CodeGraph rebuilt on every query. Native engine with rayon covers the parsing hot path. No change since last audit — neither improved nor degraded. |
| **Correctness & Soundness** | 6/10 | 9/10 | 3 | Caller coverage improved 29%→41% (real signal). Call confidence regressed 81%→73% (new ts-native edges are lower-confidence). The tool's quality score is 65/100. Tool's own generated artifact dominates the complexity triage list. Two false-positive warnings for Rust constructors (Import.new, FileSymbols.new). |
| **Type Safety** | 8/10 | 9/10 | 1 | TypeScript throughout src/. Same baseline as v3.4.0. No meaningful change. |
| **Error Handling** | 7/10 | 8/10 | 1 | Clean domain error hierarchy. Bare catch blocks still present. Same baseline. |
| **Testing Strategy** | 7/10 | 9/10 | 2 | 349 test files, 83K LOC tests. Good integration coverage. New dataflow parser tests added for 10 languages. No property-based tests, no fuzz tests for parsers. |
| **Security** | 8/10 | 9/10 | 1 | Same minimal attack surface. `apiKeyCommand` arbitrary execution still present. User-level consent model (PR #1559) is a positive addition for multi-user scenarios. |
| **API Design** | 8/10 | 9/10 | 1 | No meaningful change since last audit. |
| **Documentation** | 5/10 | 9/10 | 4 | One ADR for a codebase that shipped 9 minor versions in 3 months. Interprocedural dataflow, user-level config, 23 new languages, native orchestrator — zero ADRs. CLAUDE.md is current and accurate. The doc deficit is widening. |
| **Dependency Hygiene** | 9/10 | 9/10 | 0 | Still 3 prod deps. No regression. |
| **Dual Engine** | 6/10 | 8/10 | 2 | Phase 4-6 native dataflow is real progress toward ADR-001's Phase 6 goal. 872 dead-FFI symbols confirmed (up from 211 in v3.4.0 — Rust crate grew). The hybrid state is narrowing but not closed. |

**Overall: 6.8/10** — Same aggregate score as v3.4.0. Caller coverage improvement and dataflow feature are neutralized by structural debt accumulation (types.ts growth, god file emergence, ignored cycle).

---

## Changes Since v3.4.0 Audit (2026-03-26 → 2026-06-19)

### Improvements

| Metric | v3.4.0 | v3.13.0 | Delta |
|--------|--------|---------|-------|
| Caller coverage | 29.0% | 41.0% | +12pp ✓ |
| Community drift | 49% | 25% | -24pp ✓ |
| Modularity | 0.48 | 0.5727 | +19% ✓ |
| Dead-unresolved | 3,593 | 2,618 | -975 ✓ |
| Graph quality | 64/100 | 65/100 | +1 ~ |
| Languages | 11 | 34 | +23 ✓ |
| Nodes (graph) | 10,997 | 24,800 | +126% ✓ |

### Regressions

| Metric | v3.4.0 | v3.13.0 | Delta |
|--------|--------|---------|-------|
| Call confidence | 81.1% | 72.7% | -8.4pp ✗ |
| types.ts LOC | 1,851 | 2,855 | +54% ✗ |
| dataflow.ts LOC | 701 | 1,586 | +126% ✗ |
| Function-level cycles | 8 | 9 | +1 ✗ |
| File-level cycles | 1 | 1 | 0 (unfixed) ✗ |
| MCP 37-file cycle | Flagged | Still present | Not fixed ✗ |

### New since last audit (not previously evaluated)

- **Interprocedural dataflow (P0–P6):** Variable-level model, arg_in/return_out edges, summaries, vertex extraction. Genuinely new capability.
- **ts-native resolution:** TypeScript-specific resolution pass added 12,776 edges (vs 380 from CHA). This is the driver of the 41% caller coverage.
- **User-level config / consent model (PR #1559):** Per-repo consent, XDG location, layered merge. New architectural layer.
- **Native orchestrator (P4–P6):** Dataflow phases ported to Rust native engine path.
- **23 additional languages:** Bash, Elixir, Lua, Dart, Zig, Haskell, OCaml, F#, HCL, Gleam, Clojure, Julia, R, Erlang, Solidity, Objective-C, CUDA, Groovy, Verilog, C, C++, Kotlin, Swift. Fixture-level support, not production-depth.

---

## ADR Compliance Review

### ADR-001: Dual-Engine Architecture

**Only one ADR exists for a codebase at v3.13.0. This is the primary documentation finding.**

**Status of ADR-001 compliance:** Mostly followed, with one significant drift.

The ADR commits to a trajectory where "`--engine native` runs the entire pipeline in Rust with zero WASM dependency" after Phase 6 (Native Analysis Acceleration). Evidence of progress:

- ✓ Native Rust engine via napi-rs with WASM fallback — compliant
- ✓ `--engine auto|native|wasm` flag — compliant
- ✓ Platform-specific optional npm packages — compliant
- ✓ Both engines feed the same SQLite graph — compliant
- ✓ Phase 4-6 native dataflow landed (P4: incremental re-stitch, P5: 18-language rules, P6: vertex extraction) — partial Phase 6 progress
- ✗ **WASM backfill still required in production:** The fresh build output shows `[codegraph WARN] Native orchestrator dropped 2 file(s) ... Backfilling via WASM`. The ADR states this is a temporary state pending Phase 6. Three months post-audit, it's still present.
- ✗ **false-positive warnings in Rust types:** `Import.new (41 callers)` and `FileSymbols.new (36 callers)` are flagged as false positives in `crates/codegraph-core/src/types.rs:154,467`. These are Rust struct constructors being detected as high-fan-in nodes. This is a parity/correctness issue the ADR's "parity convergence" trajectory should be closing.

**ADR-001 trade-offs still accurate?** Yes. The maintenance multiplier cost is real — 872 dead-FFI symbols (up from 211) as the Rust crate grew. The performance and portability justifications remain valid.

**ADR-001 trajectory:** The Phase 6 goal is being incrementally pursued (dataflow phases P4–P6 on native). The "parity convergence" trajectory is partially real — but the WASM backfill warning during the audit build shows it's not closed.

### Missing ADRs (decisions that exist in code without documentation)

These are architectural decisions made between v3.4.0 and v3.13.0 that should have ADRs:

1. **Interprocedural dataflow model** (P0–P6): A complete new analysis primitive with its own vertex schema, edge types (arg_in, return_out, def_use), and stitching algorithm. This is one of the largest feature additions in the project's history. No ADR documenting the vertex model, the stitching approach, the tradeoffs vs a purely intra-procedural model, or the decision to represent dataflow as graph edges rather than a separate analysis layer.

2. **TypeScript-native resolution technique** (ts-native): Added 12,776 edges at 73% confidence. No ADR documenting why this technique was introduced, what it does differently from the 6-level heuristic resolver, what its false-positive rate is, and whether it replaces or supplements the existing resolution.

3. **User-level config and consent model** (PR #1559): A new config layer with XDG location resolution, per-repo consent, and config-hash invalidation. No ADR documenting the security model, the trust boundary between repo-level and user-level config, or the decision to gate features on explicit consent.

4. **Language expansion from 11 to 34**: Adding 23 languages (mostly fixture-level) changed the competitive positioning. No ADR documenting the quality threshold for "supported" vs "experimental" languages, the fixture-vs-production distinction, or the decision to ship Verilog/CUDA/Erlang support without deep testing.

5. **TypeScript migration** (pre-existing, still undocumented): Still no ADR. Still a finding.

6. **MCP tool architecture** (pre-existing, still undocumented): The barrel cycle that causes the 37-file cycle, the middleware layer, and the tool registration pattern are still undocumented. Still a finding.

---

## Structural Census

| Metric | Value | vs v3.4.0 |
|--------|-------|-----------|
| **Source files (TS, src/)** | 326 | +46 |
| **Total TS LOC** | ~150K | +104K |
| **Rust LOC (crates/)** | ~41K | +30K |
| **Test files (.test.ts)** | 349 | +234 |
| **Test LOC** | ~83K | +51K |
| **Graph nodes** | 24,800 | +126% |
| **Graph edges** | 51,346 | +145% |
| **Graph quality** | 65/100 | +1 |
| **Caller coverage** | 41.0% (4,314/10,528) | +12pp |
| **Call confidence** | 72.7% (9,561/13,156) | -8.4pp |
| **ts-native edges** | 12,776 | new |
| **CHA edges** | 380 | — |
| **File-level cycles** | 1 (37-file MCP barrel) | unchanged |
| **Function-level cycles** | 9 | +1 |
| **Communities** | 403 (modularity: 0.5727) | +277% |
| **Community drift** | 25% | -24pp |
| **Avg cognitive complexity** | 4.9 | -46% |
| **Max cognitive complexity** | 359 (`requireNative` in generated index.js) | artifact |
| **Avg MI** | 62.5 | flat |
| **Functions above threshold** | 731 | +77% |
| **Production dependencies** | 3 | unchanged |

### The index.js Problem

The highest-ranked risk item in `codegraph triage -T` is `requireNative` in `index.js` with 359 cognitive complexity — a score that would be exceptional even for the most complex real code in the repository. **This is not source code.** `index.js` is the NAPI-RS auto-generated platform loader, committed to the worktree root (it appears as `?? index.js` in git status — untracked, not gitignored). The file's purpose is transparent: `// auto-generated by NAPI-RS`. It has fan-out of 601 per the coupling hotspot table, and `index.d.ts` (also untracked, 40KB) has fan-out of 601 as well.

The `.gitignore` correctly excludes `crates/codegraph-core/index.js` but not the root-level copy. The tool is eating its own tail: the build artifact it generates for itself poisons its own analysis output. The top-risk item in the triage queue is a red herring. A first-time user running `codegraph triage` on this repository would investigate `requireNative` and find they can't do anything about it.

**Fix:** Add `index.js` and `index.d.ts` to `.gitignore` (or `.codegraphignore` if that exists), or add a regex exclusion in the default `IGNORE_DIRS/IGNORE_FILES` patterns for auto-generated NAPI-RS files.

### Dead Code Breakdown

Total dead symbols: 13,780 (from `roles --role dead -T`). Breakdown:

| Category | Count | Explanation |
|----------|-------|-------------|
| **dead-leaf** | 10,127 | Parameters, properties, constants. Leaf nodes with no callers. Not actionable. |
| **dead-unresolved** | 2,618 | Symbols whose callers couldn't be resolved. Import resolution gaps. Not actionable dead code — these are resolution misses, not genuinely dead symbols. |
| **dead-ffi** | 872 | Rust napi-rs boundary. Up from 211 in v3.4.0 — Rust crate grew significantly. Correctly classified. |
| **dead-entry** | 433 | CLI commands, MCP tool handlers, framework entry points. Correctly classified. |
| **Genuinely dead callables** | ~0 in `-T` output | After excluding the four categories above, no genuinely dead functions are surfacing. Dead-entry and dead-leaf dominate. |

**Improvement:** Dead-unresolved dropped from 3,593 to 2,618 (-975) — a real improvement in resolution coverage. The ts-native technique is reducing these misses.

### Complexity Hotspots

Actual source code only (excluding the `index.js` artifact):

| Function | File | Cognitive | Cyclomatic | MI |
|----------|------|-----------|------------|-----|
| `resolve_call_targets` | build_edges.rs | 97 | 45 | 39 |
| `runContextCollectorWalk` | src/extractors/javascript.ts | 94 | 52 | 36.3 |
| `build_points_to_map` | build_edges.rs | 74 | 36 | 36.4 |
| `walk` | src/extractors/javascript.ts | 72 | 52 | 37.2 |
| `collectObjectRestParams` | src/extractors/javascript.ts | 70 | 39 | 44.3 |
| `handle_var_decl` | crates/codegraph-core/src/extractors/javascript.rs | 70 | 33 | 42.1 |
| `buildChaPostPass` | builder/stages/build-edges.ts | 61 | 24 | 49.1 |
| `buildDataflowEdges` | src/features/dataflow.ts | 53 | 19 | 40.6 |

The Rust edge builder (`resolve_call_targets` at 97) and JS extractor (`runContextCollectorWalk` at 94) dominate. Both are inherently complex because they implement resolution logic, but both exceed the 50-cognitive-complexity threshold by 2x. These are the maintenance risk areas.

---

## Layer-by-Layer Critique

### 1. `src/types.ts` — 2,855 LOC (was 1,851)

**Current State: 5/10 | State of the Art: 9/10 | Gap: 4**

The type hub grew by 1,004 LOC in three months. Fan-in went from 122 to 185 — every major module now depends on this file. The internal organization (22-section `§` headers) still works at this size, but the growth rate is the problem: at +1,000 LOC per quarter, this file hits 5,000 LOC in a year.

This is no longer a maintenance convenience issue. At 185 fan-in, any change to `types.ts` has blast radius across the entire codebase. Adding the interprocedural dataflow vertex model, the consent config types, and 23 language expansions all to a single flat type file is a design choice that makes this file a coupling magnet. The argument "TypeScript structural typing means it's just declarations" breaks down when you realize every module must be recompiled when the file changes, and every AI agent working on the codebase loads the entire 2,855-LOC type context.

**Fix:** Domain-scoped type files (`src/types/dataflow.ts`, `src/types/mcp.ts`, `src/types/graph.ts`, `src/types/db.ts`, `src/types/config.ts`) with a barrel re-export from `src/types.ts`. Mechanical to execute, meaningful for comprehensibility. **This has been flagged twice now — the previous audit recommended it in March 2026 and it remains unaddressed.**

### 2. `src/features/dataflow.ts` — 1,586 LOC (was 701)

**Current State: 5/10 | State of the Art: 9/10 | Gap: 4**

This is the project's newest god file. It now contains:
- WASM parser setup for dataflow extraction (lines 1–163)
- 14 data structure definitions (ArgFlow, Assignment, Mutation, StitchCandidate, etc.)
- `insertDataflowEdges` — raw SQL insertion (lines 251–338)
- `buildDataflowVerticesAndEdges` — vertex+edge construction (lines 339–479, 141 LOC)
- `buildInterproceduralStitch` — stitching caller-callee pairs (lines 480–725, 246 LOC)
- `collectFuncIdsForFiles`, `collectCallerStitchCandidates` — DB queries (lines 595–726)
- `collectNativeEdges` — native engine path (lines 757–817)
- `buildDataflowEdges` — orchestrator (lines 848–1025, 178 LOC, cog=53)
- `buildDataflowResult`, `buildNodeDataflowResult`, `buildNativeDataflowResult` — query layer (lines 1108–1299)
- `bfsDataflowPath`, `processDataflowNeighbor`, `reconstructDataflowPath` — BFS traversal (lines 1324–1421)
- `bfsReturnConsumers` — consumer BFS (lines 1493–1524)

This is five distinct concerns in a single file: data model, extraction, DB persistence, stitching/analysis, and query/traversal. The P0–P6 phased implementation strategy produced this accumulation — each phase added code to the same file rather than decomposing it.

**Comparison:** Joern separates CPG construction (Phase), data-flow analysis (semanticcpg), and query API (semanticcpg.dataflowengine) into distinct modules. Semgrep's inter-procedural analysis (Pro engine) has a dedicated `interproc` module with its own type system.

**Fix:** Split into `src/features/dataflow/` subdirectory with `extraction.ts` (WASM parse + visitors), `insertion.ts` (DB schema + insertion), `stitching.ts` (interprocedural stitching), `query.ts` (result builders + BFS traversal). The 1,586 LOC could become 4 files averaging 400 LOC each — still not small, but each with a single responsibility.

### 3. MCP Layer — 37-File Cycle Persists

**Current State: 4/10 | State of the Art: 8/10 | Gap: 4**

The previous audit flagged this in March 2026. It is June 2026. It is still there. Citing the v3.4.0 audit finding verbatim because nothing has changed:

> **Root cause:** `tools/index.ts` (barrel) imports all 34 tool modules → each tool module imports `McpToolContext` type from `server.ts` → `server.ts` imports `TOOL_HANDLERS` from `tools/index.ts`. This is a type-only cycle at runtime, but codegraph correctly flags it because the actual imports are value imports.
> **Fix:** Extract `McpToolContext` interface to a separate `types.ts` file in `mcp/`, or use `import type` consistently. This would eliminate the cycle entirely.

The fix is a 30-minute mechanical change. It has been documented, the root cause is understood, the fix is specified. It remains unimplemented after two audit cycles. This is not a complexity problem — it is a prioritization problem.

### 4. Graph Model (`src/graph/model.ts`)

**Current State: 7/10 | State of the Art: 8/10 | Gap: 1**

No meaningful change since v3.4.0. The CodeGraph adjacency list (`Map<string, Map<string, EdgeAttrs>>`) handles 24,800 nodes and 51,346 edges without issues. At 2.5x the previous scale, the in-memory model is holding up. Scalability concerns remain the same (1M nodes would strain this model) but are not immediately relevant.

### 5. Infrastructure Layer

**Current State: 8/10 | State of the Art: 8/10 | Gap: 0**

Addition of user-level config (PR #1559) with XDG location resolution and per-repo consent is a clean extension of the existing `loadConfig` pipeline. The layered merge (`mergeConfig → applyEnvOverrides → resolveSecrets`) now has a user-level layer between global defaults and repo-level config. The implementation is consistent with the existing pattern. No architectural regressions.

### 6. Domain Graph Builder (`src/domain/graph/`)

**Current State: 7/10 | State of the Art: 8/10 | Gap: 1**

`buildGraph` (cog=56, cyc=32) is the 12th most complex function in the codebase. `pipeline.ts` at 43 fan-in and 28 fan-out is the build orchestrator. The native orchestrator added `expandChaEdges` (cog=56) as the 13th most complex function. The native path now has dedicated orchestration through `native-orchestrator.ts` — this is appropriate decomposition.

The `build_points_to_map` in Rust (cog=74) and `resolve_call_targets` (cog=97) are the real maintenance risk in this layer. Both are monolithic resolution functions that have been growing with each resolution improvement. The JavaScript equivalent (`buildChaPostPass`, cog=61) suggests this pattern is replicated across both engines.

### 7. Parser/Extractor Layer

**Current State: 6/10 | State of the Art: 8/10 | Gap: 2**

The JavaScript extractor (`src/extractors/javascript.ts`) now has three functions above cognitive complexity 50: `runContextCollectorWalk` (94), `walk` (72), and `collectObjectRestParams` (70). The Rust extractor (`crates/codegraph-core/src/extractors/javascript.rs`) has `handle_var_decl` (70), `enclosing_func_context` (64), `collect_spread_and_array_from_bindings` (56), `collect_object_rest_params` (56), `extract_js_parameters` (51), `collect_param_bindings` (49) — six functions above the 50-threshold, all in a single Rust file.

The extraction layer has the highest concentration of complex functions in the codebase, and each language added (now 34) adds another extractor pair. At 34 languages, the extractor maintenance surface is large. The R extractor (`handleLibraryCall`, cog=67) is already complex despite R being a minority language in codegraph's target market — suggesting the pattern of monolithic `walk_node_depth` functions is being replicated unchanged for every new language.

**State-of-the-art comparison:** tree-sitter's own query language (`(function_declaration name: (identifier) @func)`) eliminates most AST traversal code. Codegraph uses tree-sitter for parsing but writes manual AST walkers rather than using tree-sitter queries. This is the right approach for extraction complexity (queries don't handle context accumulation well), but it means each language extractor is fully custom code.

### 8. Presentation Layer

**Current State: 6/10 | State of the Art: 8/10 | Gap: 2**

`viewer.ts` is now unreported in the complexity stats — likely because it generates HTML/JS as string templates and the function-level analysis of template-heavy code is unreliable. At 676 LOC (from previous audit), it remains a maintenance liability: embedded JavaScript in TypeScript string literals, vis-network configuration as inline JSON.

No meaningful changes since v3.4.0.

---

## Cross-Cutting Concerns

### 1. Call Confidence Regression (-8.4pp)

The ts-native resolution pass added 12,776 edges but dropped overall call confidence from 81% to 73%. This deserves investigation. The previous heuristic resolver (6-level priority system) produced 81% high-confidence edges. The new ts-native pass added 12,776 edges (vs 380 from CHA), which is 33x more edges from the new technique — but those 12,776 edges are pulling the confidence average down.

**Current State: 6/10 | State of the Art: 9/10 | Gap: 3**

A tool that reports 73% call confidence is telling users that roughly 1 in 4 call edges in the graph may be wrong. For blast-radius analysis and dead code detection, false edges are worse than missing edges — they create phantom dependencies and falsely mark live code as dead. The ts-native technique needs a documented confidence calibration (what does "low confidence" mean for a ts-native edge? Are these mostly correct? Are they false positives for dynamic patterns like decorators/proxies?).

### 2. Language Breadth vs. Depth

**Current State: 5/10 | State of the Art: 8/10 | Gap: 3**

Codegraph jumped from 11 to 34 languages. Looking at the fixture files per language from the stats output:
- TypeScript: 571 files (deep, well-tested)
- JavaScript: 140 files (deep)
- Rust: 84 files (deep — the codebase is 80% of this)
- CUDA: 5 files, Julia: 5, Verilog: 4, Gleam: 4, Erlang: 4, Groovy: 4...

The 23 new languages all have 4-5 fixture files. This is minimum viable support — enough to pass the benchmark fixture tests, not enough to claim production-quality analysis for CUDA or Verilog. The competitive table shows this correctly as "34 languages," but a Verilog user running `codegraph build` on a real HDL project is in unsupported territory.

**The claim without the caveat is misleading.** The previous audit recommendation was "depth over breadth" — the decision was made in the opposite direction. Whether this is correct strategically (show breadth to compete with narsil-mcp's 32 languages) is a business decision, but the technical quality tier must be documented somewhere.

### 3. Dual Engine — Phase 6 Progress

**Current State: 6/10 | State of the Art: 8/10 | Gap: 2**

ADR-001's Phase 6 (Native Analysis Acceleration) is actively being pursued. The current branch (`feat/dataflow-p4-native`) demonstrates native dataflow vertex extraction. Measured progress:

- P4 incremental re-stitch on native path ✓
- P5 dataflow rules for 18+ languages ✓  
- P6 vertex extraction on native bulk-insert path ✓

But the WASM backfill warning during this audit's build shows the native pipeline is still not fully self-contained. The `dead-ffi` count grew from 211 to 872 as the Rust crate expanded — indicating significant new Rust code was written. Progress is real, but Phase 6 is not complete.

### 4. Testing

**Current State: 7/10 | State of the Art: 9/10 | Gap: 2**

- 349 test files (up from 115 in v3.4.0 — 3x growth)
- New dataflow parser tests for 10 languages (php, rust, c, cpp, ruby, java, js, python, go, csharp — 10 files)
- New dataflow integration tests (`dataflow-incremental.test.ts`, `dataflow-vertices.test.ts`)
- Engine parity tests updated
- Resolution benchmark fixtures updated (jelly-micro baseline)

**Test-to-source ratio:** 83K test LOC / 150K source LOC = 0.55:1 — lower than v3.4.0's 0.71:1. The source grew faster than the tests. Given the 23 new languages added with 5-file fixtures, the language coverage tests are shallow. The interprocedural dataflow stitching logic (the most algorithmically complex new code) has `dataflow-incremental.test.ts` and `dataflow-vertices.test.ts` as its primary test surface — adequate for a new feature but not yet stress-tested.

**Missing (unchanged since v3.4.0):**
- Property-based tests for import resolution
- Fuzz tests for parser extractors
- Performance regression tests for the new interprocedural stitching (what's the perf cost per file of the stitch pass?)

---

## Competitive Verification

### Does Codegraph Have a Reason to Exist?

**Yes, but the moat is narrowing.**

Verified against 6 competitors as of June 2026. The findings from v3.4.0 have shifted:

| Differentiator | March 2026 | June 2026 | Status |
|----------------|-----------|-----------|--------|
| Local-only | Unique | Shared (narsil, CKB, GitNexus) | Commoditized |
| 11+ languages | Unique among MIT tools | narsil: 32, Semgrep: 30+ | No longer unique |
| MCP server | Unique among full-graph tools | GitNexus, CKB also have MCP | Commoditized |
| Function-level analysis | Differentiating | Shared (Joern, GitNexus, narsil) | Shared |
| Incremental builds (all langs) | Unique | narsil claims Merkle-tree incremental | Disputed |
| 3 prod dependencies | Unique | Still unique | **Moat** |
| MIT license | Shared | GitNexus (PolyForm NC), CKB (freemium) | **Moat** |
| CLI + MCP + API in one package | Unique | Still unique | **Moat** |
| Interprocedural dataflow | New, unmatched | Unmatched in MIT tools | **New moat** |

**The enduring moat:** 3 prod dependencies + MIT license + CLI+MCP+API bundle + interprocedural dataflow. The language breadth no longer differentiates (narsil claims 32). The local/deterministic positioning no longer differentiates (most competitors are local-first now). The unique combination that remains is: `(MIT + no LLM required + 3 deps + interprocedural dataflow + CLI+MCP+API)`.

### Verified Competitor Table

All data verified against actual GitHub READMEs and source as of 2026-06-19.

| Feature | Codegraph | narsil-mcp | Joern | Semgrep | stack-graphs | CKB (CodeMCP) | GitNexus |
|---------|-----------|------------|-------|---------|--------------|---------------|----------|
| **License** | MIT | Apache-2.0/MIT | Apache-2.0 | LGPL-2.1 | Apache/MIT | Freemium (<$25K free) | PolyForm NC |
| **MCP server** | Yes | Yes | No | Yes | No | Yes | Yes |
| **Standalone CLI** | Yes | Yes | Yes | Yes | No (library) | Yes | Yes |
| **Fully local** | Yes | Yes | Yes | Yes (CE) | Yes | Yes | Yes |
| **No LLM required** | Yes | Optional (neural search) | Yes | Yes (CE) | Yes | Yes | Optional (wiki) |
| **Deterministic** | Yes | Yes | Yes | Yes | Yes | Yes | Partial |
| **Function-level deps** | Yes | Yes | Yes (CPG) | No (CE) | Framework | Yes | Yes |
| **Interprocedural dataflow** | Yes (new) | Partial | Yes (PDG) | Pro-only | No | No | No |
| **Incremental (all langs)** | Yes | Yes (Merkle) | No | No | Yes (design) | Go-only | In progress |
| **Languages** | 34 (tiered) | 32 | 7 | 30+ | Framework | 11 | 14 |
| **Prod deps** | **3** | Many (Rust) | JVM | Python ecosystem | Rust | Go ecosystem | Node.js |
| **Storage** | SQLite | Persistent | OverflowDB | None | N/A | Custom | LadybugDB |
| **Stars** | — | 162 | 3.3K | 15.6K | Archived | 102 | **42.5K** |
| **Status** | Active | Active | Active | Active | **Archived** | Active | Active |

### Competitive Threats — Updated

**GitNexus (42.5K stars, up from 19.9K):** This is now the primary competitive threat by community momentum. Three months ago it was an interesting new entrant; at 42.5K stars it has more momentum than Joern and Semgrep combined in this time window. Its PolyForm NC license is the primary moat defense — enterprise users cannot use it commercially. If they relicense, the landscape changes immediately. Key gap vs codegraph: 14 vs 34 languages, no interprocedural dataflow, incremental "in progress."

**narsil-mcp (162 stars):** Grew from 132. Claims 32 languages and Merkle-tree incremental builds — this should be verified beyond README claims. If the Merkle-tree incremental is real for all 32 languages, the language-breadth differentiator is gone and incremental parity is contested. The CLI is now confirmed (not MCP-only as previously noted). The optional Voyage AI/OpenAI dependency for neural search is a meaningful LLM-dependency caveat.

**Semgrep (15.6K stars):** Now has a built-in MCP server (`semgrep mcp`). Cross-file analysis remains Pro-only. Not a direct competitor for graph-based analysis, but the MCP integration means AI agents using Semgrep for pattern matching may not need codegraph for that use case.

---

## Fundamental Design Flaws

### 1. Caller Coverage Ceiling at 41%

The previous audit called the 29% ceiling codegraph's "Achilles heel." It improved to 41% with ts-native resolution — this is a real improvement. The current ceiling is still fundamentally limited by the same root cause: the resolver is heuristic, not semantically grounded.

The ts-native technique added 12,776 edges at 73% confidence. This means ~3,450 of those 12,776 edges are likely wrong. The tool now has more coverage but lower precision. This is a tradeoff, but it's made implicitly rather than explicitly documented.

For TypeScript/JavaScript (the primary audience), 41% caller coverage means 59% of functions have no detected callers. The `codegraph roles --role dead -T` output shows 2,618 dead-unresolved symbols — these are functions whose callers exist but couldn't be resolved. The gap between "genuinely dead" and "unresolved" is the resolution quality problem.

A TypeScript-aware resolver using `ts.createProgram` (TypeScript Language Service) would close this gap. This recommendation was made in the March 2026 audit and is worth repeating: the tool should leverage TypeScript's own type resolution rather than reimplementing a heuristic approximation of it.

### 2. Generated Files Not Excluded from Analysis

`index.js` (auto-generated by NAPI-RS) is being analyzed as source code. The top-ranked item in `codegraph triage` is a fabricated 359-cognitive-complexity reading of a generated binding function. This is a diagnostic correctness failure — the tool presents a false result as its most important finding.

This is fixable in a single commit (add `index.js` and `index.d.ts` at the root to `.codegraphignore` or extend the default exclusion patterns). The root `.gitignore` already excludes `crates/codegraph-core/index.js` — the root copies need the same treatment.

---

## Missed Opportunities

### 1. Dataflow as a First-Class Query Surface

The interprocedural dataflow landed as a feature (`codegraph dataflow <func>`). But the MCP tools and query layer don't yet expose dataflow-aware impact analysis: "what values flow into this function?" and "what functions are transitively affected by a change to this parameter?" These questions are now answerable with the data that exists in the DB — but the query API and MCP tools haven't been updated to ask them.

### 2. Confidence Scoring Exposed to Users

Call confidence is tracked per-edge in the DB but surfaced only as an aggregate statistic. A `codegraph context --show-confidence <func>` flag that annotates callers with their confidence score would let users distinguish reliable graph data from heuristic inference. This is especially important given the confidence regression from 81% to 73%.

### 3. Language Quality Tiers

The README and help text claim "34 languages" without caveat. A tiered model (T1: JS/TS/Python/Go/Rust at production quality; T2: Java/C#/Ruby/PHP/C/C++ at tested quality; T3: remaining 23 at fixture-level) would be honest and help users set expectations. CKB documents this explicitly (Tier 1/2/3/4) — codegraph should do the same.

---

## Kill List

Code that should be deleted, not improved:

1. **Root-level `index.js` and `index.d.ts` from analysis scope:** Not source code. Add to exclusions. (See §Fundamental Design Flaws above.)

2. **`src/vendor.d.ts`** (still present from v3.4.0 finding): Manual type declarations for `better-sqlite3`. The `@types/better-sqlite3` package provides these. This is dead file territory.

---

## Build vs Buy — Unchanged Assessment

| Component | Current | Recommendation |
|-----------|---------|----------------|
| Leiden community detection | Vendored (1,685 LOC) | Keep — consistent with 3-dep philosophy |
| SQL query builder | Custom | Keep |
| CLI framework | Commander | Keep |
| Graph model | Custom CodeGraph | Keep — consider `graphology` only if features expand significantly |
| TypeScript resolver | Custom 6-level heuristic | **Buy/delegate to `ts.createProgram`** — the heuristic ceiling is 41% |
| Dataflow stitching | Custom | Keep for now — new feature, premature to replace |

---

## Strategic Verdict

### Would I invest in this project?

**Yes, with revised conditions.**

The v3.4.0 condition was "fix the caller coverage problem." Caller coverage improved from 29% to 41% — partial progress, but the ceiling remains below usefulness threshold for the primary claim (dependency analysis for TypeScript projects). The conditions for a strong yes:

**Priority 1 — Correctness over coverage:**
The call confidence regression from 81% to 73% is more concerning than the 41% ceiling. Having 13,156 edges where 27% are likely wrong degrades every downstream analysis (dead code, blast radius, impact). Before adding more coverage, stabilize the confidence floor. If the ts-native technique is producing low-confidence edges for systematic reasons (decorators, dynamic patterns, re-exports), document and filter them separately rather than pulling the aggregate down.

**Priority 2 — Structural debt, fixed this time:**
The MCP 37-file cycle was flagged in March 2026 and is still present in June 2026. The fix is 30 minutes of work. Allowing a known, documented, trivially-fixable structural flaw to persist through two audit cycles signals that the triage process is not working. Fix it before the July audit.

**Priority 3 — Split the god files:**
`types.ts` (2,855 LOC, +54% in 3 months) and `dataflow.ts` (1,586 LOC) are accumulating faster than they're being controlled. Set a hard limit (500 LOC per file outside of test fixtures) and enforce it with a pre-commit hook or manifesto rule. The infra is there — use it.

**Priority 4 — Document what was built:**
Nine minor versions shipped in three months. Interprocedural dataflow, user-level consent model, ts-native resolution, 23 new languages. Zero ADRs. The codebase is becoming harder to reason about as the undocumented decisions accumulate. An ADR doesn't need to be long — two paragraphs per decision is enough to capture why.

**What this project gets right that most don't:**
- It uses itself for quality enforcement (dogfooding) — this audit was conducted using the tool, which is the right form of discipline
- 3 production dependencies at v3.13.0 is exceptional
- The interprocedural dataflow feature has no direct equivalent in MIT-licensed local tools
- The phased implementation approach (P0 → P6) with explicit staging is the right way to ship complex analysis features

**What continues to fall short:**
- The tool recommends investigating `requireNative` as its top architectural risk — a generated file. First-time users will hit this.
- 59% of functions have no detected callers. The tool calls this "dead code" by default.
- The doc-to-feature ratio is worsening quarterly.

**Investment verdict:** Strong yes for the core proposition (local, deterministic, interprocedural, MIT, 3 deps). Conditional yes for the execution quality. The architecture is sound where it hasn't been compromised by accumulation. The specific fixes are known and bounded. The competitive position held through a wave of new entrants. What's needed is not a different direction — it's the discipline to close the known debts before opening new ones.

---

## Comparison Matrix vs. State of the Art

| Dimension | Codegraph v3.13.0 | Joern (SotA for graph) | GitNexus (SotA for AI agents) | Gap to closest SotA |
|-----------|------------------|----------------------|-------------------------------|---------------------|
| Caller coverage | 41% | ~80%+ (CPG + type-flow) | Unknown | -39pp vs Joern |
| Call confidence | 73% | High (type-safe CPG) | Unknown | -7pp |
| Language support | 34 (tiered) | 7 (deep) | 14 (medium) | Codegraph leads on breadth |
| Interprocedural DF | Yes (P0–P6) | Yes (PDG, sound) | No | Codegraph leads in MIT space |
| Incremental (all langs) | Yes | No | In progress | Codegraph leads |
| Prod dependencies | 3 | JVM ecosystem (heavy) | Node.js (heavy) | **Codegraph leads** |
| MCP integration | Yes (built-in) | No | Yes | Tied |
| License | MIT | Apache-2.0 | PolyForm NC | **Codegraph leads** |
| Graph scale limit | ~500K LOC (SQLite) | Multi-repo (OverflowDB) | Unknown | -1 order of magnitude |
| Documentation | 1 ADR, CLAUDE.md | Docs site, research papers | README | -2 ADRs minimum |
| Stars / adoption | Growing | 3.3K | 42.5K | Community trailing |
