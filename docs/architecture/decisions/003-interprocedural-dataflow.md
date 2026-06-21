# ADR-003: Interprocedural Dataflow — Variable-Level Vertex Model

**Date:** 2026-06-21
**Status:** Accepted
**Context:** Codegraph's dataflow analysis was intraprocedural (single-function scope) and function-keyed. It could not answer "where does this user input end up?" across call boundaries. This ADR documents the architectural decisions for making it interprocedural with variable-level precision.

---

## Decision

Dataflow analysis is upgraded from **function-keyed** to **variable-level** by introducing **dataflow vertices** — addressable data locations (`param`, `local`, `return`, `receiver`) that belong to enclosing function nodes. Interprocedural stitching rides on the already-resolved `calls` edges rather than ambiguous name-based matching.

Key structural decisions:

1. **Dedicated `dataflow_vertices` table** — variable vertices are never added to `nodes`, to avoid polluting role classification, dead-code detection, fan-in/out, communities, and every graph analytic keyed off `nodes`.
2. **Function summaries** — a `dataflow_summary` table caches `param[i] →* return` intra-reachability per function, enabling interprocedural stitching without full callee inlining.
3. **Backward-compatible `dataflow_fn` view** — the existing function-level edge contract is preserved during migration; all current queries continue working unchanged.
4. **Extend to all 34 supported languages** — the 26 languages with no `DATAFLOW_RULES` today get extraction support.
5. **Decision Point DP-1 deferred to P6** — whether variable-level output becomes the default (replacing function-level) is decided at Phase 6, informed by actual P4 benchmark numbers. All P1–P5 work is additive and independently mergeable.

---

## Context

### The problem

`codegraph dataflow` answered function-scoped questions: "what does *this function* pass/return/mutate?" The graph was keyed by functions; data passing *through* a helper, middleware chain, or factory was invisible. The `README.md` documented this as a known limitation:

> **Intraprocedural (single-function scope), not interprocedural** — data flow across call boundaries is not tracked.

The existing visitor already computed the raw material for variable-level summaries (`parameters`, `returns.referencedNames`, binding indices) — but three of the five fact types were thrown away by `insertDataflowEdges`/`collectNativeEdges`. This plan consumes facts that already exist; it is not starting from scratch.

### Existing assets

- **Parameter nodes are already first-class** (`kind: 'parameter'`, linked by `parameter_of` edge and `parent_id`). Variable-level `param` vertices link back to these existing nodes — no new node kind needed.
- **Call edges are already resolved** into the `edges` table (`kind: 'calls'`), via the 6-level import-aware resolver. Interprocedural stitching rides on these proven, high-precision edges — a precision upgrade over the current name-based `flows_to` resolution (top-10 by file/line, ambiguous).

### Languages

8 languages have dataflow rules today (JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C#, PHP, Ruby). The other 26 have no `DATAFLOW_RULES` — `extractDataflow` returns empty. This plan extends coverage to all 34.

---

## Trade-offs

### Costs

1. **Schema migration complexity.** Repointing `dataflow` FKs from `nodes` to `dataflow_vertices` is a potentially breaking change. Mitigated by the backward-compatible `dataflow_fn` view and by treating the DB as a derived cache (a rebuild is always acceptable — codegraph already prompts rebuild when dataflow is missing).

2. **Parity surface grows significantly.** Variable-level facts are far more numerous than function-level. Ordering and deduplication must be deterministic across engines. The parity comparator (`scripts/parity-compare.mjs`) must be extended to diff `dataflow_vertices` + new edge columns (`scope`, `call_edge_id`).

3. **Performance / DB size.** A variable graph can be 10–50× more edges than the function graph. Hard per-function vertex caps, `MAX_WALK_DEPTH`, and indexed `(func_id, kind)` lookups are mandatory before enabling by default. `bench-check` baseline required before/after each phase.

4. **26 new language extractors.** Each requires `DATAFLOW_RULES` in TS + a `DataflowRules` static + `ParamStrategy` in Rust, with fixtures and parity gate. Functional languages (Haskell, OCaml, F#, Gleam, Elixir, Erlang, Clojure) need a `TailExpression` return strategy — no `return_node` exists in these grammars. Declarative languages (HCL/Terraform, Verilog) may yield low-value output; implementation vs explicit exclusion is decided per language during that batch.

5. **Worker-protocol serialization seam.** Any new `ExtractorOutput` field (e.g. `dataflowVertices`) not added to `SerializedExtractorOutput` in `wasm-worker-{protocol,entry,pool}.ts` is silently dropped at the Worker thread boundary — the canonical parity divergence risk in this codebase.

### Benefits

1. **Cross-boundary taint tracking.** `dataflow path <src> <dst>` and `dataflow --impact` traverse a precise variable graph across function and file boundaries — the core ask for security audits and refactor impact.

2. **Precision upgrade.** Stitching on resolved `calls` edges eliminates the ambiguous name-based `flows_to` matching (top-10 by proximity). Call-resolution precision directly bounds dataflow precision.

3. **No limitation in README.** The "intraprocedural only" caveat is removed at P6, reflecting a genuinely resolved limitation.

4. **Full language coverage.** Taint analysis works for all 34 languages, not just the 8 with rules today.

---

## Target Architecture

### Variable-level vertices

| Vertex kind | Identity | Source |
|-------------|----------|--------|
| `param` | (func_id, param_index) | Reuse existing `parameter` nodes; set `node_id` link |
| `local` | (func_id, name, decl_line) | New — from `assignments`/`var_declarator` |
| `return` | (func_id) | New — one per function with a return value |
| `receiver` | (func_id) | New — `this`/`self` for mutation tracking (optional, Phase 3) |

Vertices live in `dataflow_vertices(id, func_id, kind, name, param_index, line, node_id)` — not in `nodes`.

### Edge taxonomy

| Edge kind | Scope | Meaning |
|-----------|-------|---------|
| `def_use` | `intra` | `param→local`, `local→local`, `*→return` within one function |
| `arg_in` | `inter` | Caller arg-vertex → callee `param[j]` vertex at a resolved call site |
| `return_out` | `inter` | Callee `return` vertex → caller capture-vertex |
| `mutates` | `inter` | Callee mutates arg — propagated back to caller vertex |

`call_edge_id` links each inter-edge to the `edges` row it was stitched from (precision provenance).

### Stitching algorithm

Post-pass after all per-file intra edges and summaries exist:

```
for each resolved call edge A --calls--> B:
    for each argFlow at that call site (argIndex=j, sourceVertex=x):
        emit  dataflow(x → B.param[j],  kind='arg_in',    scope='inter')
        if B.summary.param[j].flows_to_return:
            emit dataflow(B.return → v,  kind='return_out', scope='inter')
        if B.summary.param[j].is_mutated:
            emit dataflow(x → x,         kind='mutates',    scope='inter')
```

Where `v` is the caller's capture vertex for `B(...)`.

### Backward-compatible view

```sql
CREATE VIEW dataflow_fn AS
  SELECT sv.func_id AS source_id, tv.func_id AS target_id,
         d.kind, d.param_index, d.expression, d.line, d.confidence
  FROM dataflow d
  JOIN dataflow_vertices sv ON d.source_vertex = sv.id
  JOIN dataflow_vertices tv ON d.target_vertex = tv.id
  WHERE sv.func_id != tv.func_id;
```

Existing `dataflowData`/`dataflowPathData`/`dataflowImpactData` queries and MCP tool continue working during migration.

---

## Delivery Sequence

Each phase is independently shippable behind the existing `--dataflow` default.

| Phase | Deliverable | Gate |
|-------|-------------|------|
| **P0** | Schema finalization, migration, parity-comparator extension, worker-protocol fields. Prototype on a single JS fixture end-to-end. | Spike branch (throwaway) |
| **P1** | `dataflow_vertices` + intra `def_use` edges + summaries for JS/TS/TSX. Both engines. `dataflow_fn` view. | Parity (JS) + existing dataflow tests pass |
| **P2** | `arg_in`/`return_out`/`mutates` inter stitching; cross-file; `--taint`; new variable-path queries. | Taint integration tests + parity |
| **P3** | Python, Go, Rust, Java, C#, PHP, Ruby variable model + stitch. | Per-lang parity + dataflow tests |
| **P4** | Cross-file re-stitch on incremental builds; perf caps + benchmarks. | `bench-check` baseline, watcher tests |
| **P5a–P5e** | New languages — B1 (C-family), B2 (JVM/mobile), B3 (scripting), B4 (functional), B5 (systems/DSL). | Per-batch parity + resolution-benchmark |
| **P6** | CLI/MCP polish, docs, README limitation removed. **Resolve DP-1** using P4 benchmark numbers. | Docs review + DP-1 recorded |

---

## Decision Point DP-1 — Variable-Level Default vs Opt-In

Whether variable-level output replaces function-level as the default is **deferred to Phase 6**, decided by the actual P4 benchmark numbers (build time, DB size, query latency on real repos).

**Approval gate (binding):** if DP-1 resolves to replacing the default output shape (a breaking change), the implementing agent **must stop, surface the decision and rationale, and wait for explicit approval** before writing any breaking code. When approved, the breaking change goes in a dedicated, self-contained PR held until the user schedules it. All P1–P5 feature PRs must be independently mergeable and shippable without depending on the breaking PR.

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **Add variable vertices to `nodes`** | Pollutes role classification, dead-code detection, fan-in/out, communities, complexity, and every graph analytic keyed off `nodes`. A dedicated table keeps the analytical layer clean |
| **Keep function-keyed, add cross-function BFS** | Ambiguous name matching (`flows_to` uses top-10 by proximity) gives low precision at call boundaries. Riding on resolved `calls` edges is architecturally superior and reuses the work already done by the 6-level import resolver |
| **Single-level interprocedural only** | Variable-level is required for precise taint paths — knowing that `param[2]` of function A reaches `param[0]` of helper B is what makes a taint report actionable. Function-level only tells you A calls B |
| **Full type inference (TypeScript compiler, etc.)** | External heavy dependency; not in scope. The visitor's existing `parameters`/`returns`/`argFlows` facts are sufficient for the IFDS-style summary approach |
| **WASM-only first, then native** | CLAUDE.md mandates identical output from both engines. Implementing TS first and deferring the Rust mirror creates a window where the tool is in a parity-broken state; mirror module-by-module per the mirrored-engine-layout convention instead |

---

## Decision Outcome

The variable-level vertex model with a dedicated `dataflow_vertices` table, function summaries, and stitching on resolved `calls` edges is the canonical architecture for interprocedural dataflow in codegraph. The backward-compatible `dataflow_fn` view ensures a non-breaking delivery path through P5. DP-1 (default-level choice) is the single breaking-change lever, deliberately deferred to P6 where benchmark data makes it an informed decision.

All phases ship both WASM and native engine implementations, gated by `/parity`. The worker-protocol serialization seam is a required checklist item on every phase PR.
