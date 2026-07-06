# ADR-002: Dynamic Call Resolution — Taxonomy, Flagged-Edge Sink, and Static Resolution

**Date:** 2026-06-21
**Status:** Accepted
**Context:** Dynamic call sites (computed property access, eval, reflection) were silently dropped from the graph — invisible to every query, impact analysis, and dead-code detector. This ADR documents the architectural decisions for surfacing them.

---

## Decision

Dynamic call sites are **never silently dropped**. Every dynamic call in every language is either:

- **Resolved (Track A):** statically-knowable targets (`obj["foo"]()`, `const m='foo'; obj[m]()`, closed dispatch tables, literal-name reflection) are resolved into real `calls` edges at full or penalized confidence.
- **Flagged (Track B):** undecidable calls (`eval`, `new Function()`, `obj[runtimeVar]()`, dynamic reflection) are emitted as **sink edges** — visible in the graph, queryable via `codegraph roles --dynamic`, but never polluting normal precision metrics.

The boolean `Call.dynamic` is refined by a **`DynamicKind` taxonomy** that distinguishes resolvable from flag-only cases. Sink edges reuse `kind='calls'` with a new `dynamic_kind` DB column — not a new edge kind.

---

## Context

### The problem

Codegraph documented this in `README.md` as a known limitation:

> **Dynamic calls are best-effort** — complex computed property access and `eval` patterns are not resolved.

The actual behavior was worse than "best-effort" — these call sites were silently dropped by `resolveCallTargets` when it found no target. The graph was missing entire call paths through dispatch tables, computed property access, and reflection APIs in all 34 supported languages.

The limitation conflated two fundamentally different problems:

- **Track A (resolvable):** `obj["foo"]()`, `const m='foo'; obj[m]()`, `{a:fnA}[k]()`, `getattr(obj,'foo')()`, `Method.invoke(getMethod("foo"))`. A static analyzer can determine the target set.
- **Track B (undecidable):** `eval(s)`, `new Function(s)`, `obj[runtimeVar]()`, `$obj->$m()` where `$m` is not a constant. No static analyzer can resolve these in general.

The valuable improvements are distinct: **resolve Track A** targets; **detect and flag Track B** instead of dropping.

### Scope

The approved scope covers the full pipeline across all 34 supported languages: resolve knowable dynamic dispatch + flag the residue. Delivered as a foundation PR followed by per-language-family PRs. One PR per concern.

---

## Trade-offs

### Costs

1. **Data model complexity.** `DynamicKind` replaces a boolean — every `call.dynamic` site in JS, Rust, and the FFI boundary must be updated or threaded through.

2. **FFI serialization risk.** `Call` is serialized through `SerializedExtractorOutput` in `wasm-worker-{protocol,entry,pool}.ts`. Any new field not explicitly threaded is silently dropped at the Worker boundary — the primary parity divergence risk.

3. **Parity surface.** Sink-edge emission is two separate code paths (JS `buildFileCallEdges` + Rust `build_call_edges` + a back-fill pass). Both must agree byte-for-byte on synthetic name, `confidence=0.0`, and `dynamic_kind`.

4. **Scope creep risk (long tail).** 34 languages × multiple dynamic idioms per family. Mitigation: per-family PRs with a filed GitHub issue to split anything that exceeds a single concern.

5. **Resolution over-approximation (RES-2).** Dispatch-table expansion can invent false-positive edges. Kept at penalized confidence and validated against the `pts-javascript` fixture (separate from `javascript`, which has a precision-1.0 floor).

### Benefits

1. **No invisible call sites.** Every dynamic call is represented in the graph. Dead-code detection, blast-radius analysis, and impact queries no longer have blind spots at dynamic dispatch boundaries.

2. **Queryable diagnostics.** `codegraph roles --dynamic` lists all flagged calls grouped by kind — the "never silently dropped" guarantee made visible to users.

3. **Correct dead-code classification.** Functions only reachable through flagged dynamic calls are not misclassified as dead.

4. **Incremental resolution.** The Track A/B split means resolution logic lands in focused PRs without blocking the flag-only improvement, and recall floors can be raised incrementally per language family.

---

## Key Design Decisions

### DynamicKind taxonomy (not a boolean)

```ts
export type DynamicKind =
  | 'computed-literal'    // obj["foo"]()      — resolvable
  | 'computed-key'        // obj[k]()          — resolvable iff k is a const literal, else flag
  | 'reflection'          // .call/.apply/.bind, getattr, Method.invoke, $obj->$m()
  | 'eval'               // eval(), new Function() — undecidable
  | 'unresolved-dynamic' // detected dynamic call we cannot resolve
  | 'value-ref';          // bare identifier used as an object-literal property value
                          // (dispatch tables, e.g. `{ resolve: someFn }`) — resolvable
                          // against function/method-kind targets only (#1771)
```

`dynamic?: boolean` is kept to avoid churning every `call.dynamic ? 1 : 0` site.

`value-ref` is Track A (resolvable) but deliberately **not** added to the flag-only
sink-edge set: when the identifier doesn't resolve to a function/method (e.g. a
plain data reference like `{ name: SOME_CONSTANT }`), that's the common case, not
an undecidable dynamic call site — so it's silently dropped rather than flagged,
unlike `eval`/`computed-key`/`unresolved-dynamic`.

### Sink edges reuse `kind='calls'`, not a new edge kind

A new `EdgeKind` would ripple through every edge-kind switch, role classifier, exporter, MCP tool, and the viewer — high blast radius. Instead: DB migration adds `dynamic_kind TEXT` column to `edges`; sink edges use `kind='calls'`, `dynamic=1`, `dynamic_kind=<kind>`, `confidence=0.0`. Confidence below `DEFAULT_MIN_CONFIDENCE=0.5` means they never pollute normal queries or exports but remain queryable when explicitly requested.

Flagged calls use a synthetic non-matching name (`<dynamic:eval>`, `<dynamic:computed-key>`, etc.). `resolveCallTargets` short-circuits names starting with `<dynamic:` so they never spuriously match a real symbol.

### Resolution in the existing points-to solver

New constraints land in `src/domain/graph/resolver/points-to.ts` and the Rust `build_points_to_map` — **no new subsystem**. The 50-iteration Andersen solver is reused as-is. One PR per constraint type (RES-1: constant-string-key propagation; RES-2: dispatch-table expansion; RES-3: per-family literal-name reflection).

---

## Delivery Sequence

| Phase | Concern |
|-------|---------|
| **Phase 0** | Foundation: `DynamicKind` data model, `dynamic_kind` DB column (migration v18), sink-edge emission, JS extractor classification, `--dynamic` listing, fixtures |
| **Phase 1** | JS/TS/TSX: TS/TSX idioms (`Reflect.*`, decorator dispatch) + fixtures |
| **Phase 2** | JVM (Java, Kotlin, Scala, Groovy): `Method.invoke`, `getMethod`, Groovy `"$dyn"()` |
| **Phase 3** | Python: `getattr`, dispatch dicts, `eval`/`exec`, `functools.partial` |
| **Phase 4** | Scripting (Ruby, PHP): `send`, `method(:x).call`, `$obj->$m()`, `call_user_func` |
| **Phase 5** | Go + C/C++: method values, func-typed struct fields, function pointers, `dlsym` |
| **Phase 6** | Long tail (C#, Rust, Swift, ObjC, Elixir, Lua, Dart, …): per-language idioms; languages with no idiomatic dynamic dispatch noted explicitly |
| **RES-1** | Constant-string-key propagation: `const m='foo'; obj[m]()` → `obj.foo` |
| **RES-2** | Dispatch-table expansion: `{a:fnA,b:fnB}[k]()` → `{fnA,fnB}` at penalized confidence |
| **RES-3** | Literal-name reflection per family |
| **Docs** | Rewrite `README.md` limitation; update ROADMAP/BACKLOG; raise recall floors |

---

## Alternatives Considered

| Alternative | Why rejected |
|-------------|-------------|
| **Keep silently dropping** | Invisible call sites cause wrong dead-code classification and missing blast-radius paths — the tool's core value proposition is undermined |
| **New `dynamic_call` edge kind** | High blast radius through every edge-kind switch, role classifier, exporter, MCP tool, and viewer — not worth it when `kind='calls'` + `dynamic_kind` column achieves the same filtering at zero ripple cost |
| **Resolve everything with types** | Would require a type inference system (TypeScript compiler API, etc.) — dependency on an external heavy system, not in scope; the points-to solver is the right abstraction for the known cases |
| **Flag only, no resolution** | Track A cases (computed literals, dispatch tables) are statically knowable; leaving them flagged rather than resolved misses precision that real users benefit from |

---

## Decision Outcome

Dynamic call sites are never silently dropped. The `DynamicKind` taxonomy, `dynamic_kind` DB column, and sink-edge pattern are the canonical representation for this class of call. Resolution phases (RES-1/2/3) land on top of the detection foundation without changing the data model. Both WASM and native engines must produce identical sink edges, gated by `/parity` on every phase PR.

The `javascript` fixture's precision-1.0 floor is the false-positive canary; `pts-javascript` is where dispatch-table expansion is tested under relaxed precision expectations.
