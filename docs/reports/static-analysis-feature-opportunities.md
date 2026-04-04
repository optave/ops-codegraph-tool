# Static Analysis Feature Opportunities

**Date:** 2026-04-03
**Source:** Categorized analysis of 1,017 inline review comments across 300 PRs, cross-referenced with codegraph's existing AST, CFG, dataflow, and graph infrastructure.

---

## Executive Summary

A systematic review of 1,017 code review findings across 300 PRs reveals that **~41% of issues could be caught by deterministic static analysis** using data codegraph already collects (tree-sitter AST, CFG blocks/edges, dataflow edges, call graph, symbol roles), with an additional **~15% flaggable heuristically** (with possible false positives). Combined, ~55% of findings are addressable without an LLM. The remaining 45% requires semantic understanding of intent, prose, or domain context — outside the scope of static analysis.

This report proposes **18 new features** organized into prioritized tiers following the BACKLOG format. Seven are quick wins (low complexity, high catch rate) that leverage existing tables. The rest require moderate engineering but address high-frequency problem classes.

### Impact by Problem Class

| Problem class | Review findings | Catchable | Catch rate | Primary data source |
|--------------|----------------:|----------:|-----------:|---------------------|
| Silent failure / swallowed error | 76 | 42 | 55% | CFG + AST |
| Incorrect logic | 72 | 11 | 15% | CFG |
| Duplication & overlap | 52 | 39 | 75% | AST hash |
| Null / undefined / NaN | 48 | 19 | 40% | Dataflow + AST |
| Stale / outdated references | 52 | 27 | 52% | Graph edges |
| Dead code & unused | 32 | 29 | 91% | Graph roles (existing) |
| Engine parity divergence | 27 | 22 | 81% | Dual-engine diff |
| Unsafe casts / `any` types | 23 | 20 | 87% | AST pattern |
| Scope & encapsulation violations | 18 | 16 | 89% | Graph edges + boundaries |
| Resource leaks | 13 | 8 | 62% | CFG + AST |
| Prepared statement in loop | 11 | 10 | 91% | CFG + AST |
| SQL injection patterns | 10 | 8 | 80% | AST pattern |
| Mutable shared state | 8 | 6 | 75% | AST + dataflow |
| Weak / missing test assertions | 12 | 7 | 58% | AST pattern |
| **Total catchable (all classes)** | | **~260** | | |

---

## Proposed Features

### Tier A — Quick Wins (leverage existing tables, low complexity)

These features require no new data collection — they query existing `nodes`, `edges`, `ast_nodes`, `cfg_blocks`, `cfg_edges`, and `dataflow` tables with new analysis logic.

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking | Depends on |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|------------|
| A1 | Unsafe cast detector | New `check` predicate `--no-unsafe-casts` that queries `ast_nodes` for type assertion expressions matching `as any`, `as unknown`, `<any>`, and the `Function` type. Report count and locations. Configurable threshold via `.codegraphrc.json` `check.maxUnsafeCasts` (per-file). Also surface in `diff-impact` when a PR introduces *new* unsafe casts in changed code. | CI | 87% of unsafe-cast review findings (20/23) are simple AST pattern matches — `as any` in a function body is always worth flagging. Currently invisible to all codegraph commands. Catches type safety erosion before it accumulates | ✓ | ✓ | 3 | No | — |
| A2 | Dead export enforcement in `check` | Formalize the existing dead-export detection (currently only in the pre-commit hook) as a first-class `check` predicate: `--no-dead-exports`. Query `nodes` where `kind` is function/class/method, `role` starts with `dead-`, and the symbol is exported. Include in manifesto rule engine as `no-dead-exports` with warn/fail thresholds. Also add `--no-dead-assignments` using `dataflow` table to find variables that are assigned (`flows_to` source) but never consumed (`flows_to` target count = 0). | CI | 91% of dead-code findings (29/32) are detectable with existing graph roles. The data exists — it just needs formal surfacing in `check` and `manifesto`. Dead exports are the #1 most reliably catchable issue class | ✓ | ✓ | 4 | No | — |
| A3 | Engine parity check | New `check` predicate `--parity` that builds the graph with both engines (native + WASM) on the same input and diffs the results: node counts, edge counts, role classifications, and cycle detection output. Report divergences as violations. Configurable tolerance threshold for edge counts (default: 0). Run as part of CI to prevent parity regressions. Also usable standalone: `codegraph check --parity` for manual verification. | CI | 81% of engine-parity findings (22/27) are detectable by comparing engine outputs. This is the highest-ROI investment for dual-engine quality — one check catches an entire class of bugs that currently requires manual cross-engine testing. Both engines already exist; this just automates the comparison | ✓ | ✓ | 5 | No | — |
| A4 | Stale re-export detector | New `check` predicate `--no-stale-reexports` that finds barrel-file re-exports pointing to symbols that no longer exist in the source module. Query: find `edges` of kind `reexports` where the target node has been removed (no matching node in `nodes` table) or where the re-exported name doesn't match any export in the target file. Also detect `--no-unresolved-imports` for import edges with resolution confidence below a configurable threshold (default: 0.3). | CI | 52% of stale-reference findings (27/52) involve broken re-exports, missing symbols, or unresolved imports — all directly queryable from the existing graph. Barrel files are particularly prone to staleness after refactoring | ✓ | ✓ | 4 | No | — |
| A5 | SQL injection pattern detector | New `check` predicate `--no-string-sql` that queries `ast_nodes` for call expressions to `db.prepare()`, `.execute()`, `.run()`, `.all()`, `.get()` where the argument is a template literal or string concatenation (not a plain string literal). Also detect LIKE queries without an ESCAPE clause by matching `ast_nodes` string literals containing `LIKE` followed by a non-`?` placeholder. Configurable via `check.sqlPatterns` for custom function names. | Security | 80% of SQL injection findings (8/10) are catchable with AST pattern matching — string interpolation in SQL calls is always a bug. Lightweight taint-like analysis without a dedicated security scanner. Zero false positives for the template-literal case | ✓ | ✓ | 3 | No | — |
| A6 | Empty test assertion detector | New `check` predicate `--no-empty-tests` that queries `ast_nodes` for `call` nodes matching test framework functions (`it`, `test`, `describe`) and verifies each test body contains at least one assertion call (`expect`, `assert`, `should`, `toBe`, `toEqual`, etc.). Flag test functions with zero assertion calls. Also detect assertions inside `catch` blocks (always pass if no exception is thrown) by cross-referencing `ast_nodes` assertion calls with `cfg_blocks` of kind `exception_handler`. | Testing | 58% of weak-assertion findings (7/12) are empty tests or catch-block assertions — pure AST pattern matches. Tests without assertions pass vacuously and provide zero confidence. This is the lowest-effort, highest-certainty testing check | ✓ | ✓ | 3 | No | — |
| A7 | Internal-only export detector | New `check` predicate `--no-overexposed-exports` that queries `exports` consumer data to find symbols that are exported but consumed only by files within the same directory (or a configurable scope). These are unnecessarily public APIs that widen the module's surface area. Surface in `audit` reports as "internally consumed exports" alongside existing export analysis. Configurable scope via `check.internalExportScope` (default: `directory`). | Architecture | 89% of scope/encapsulation findings (16/18) are about unnecessarily exported internals or cross-layer imports. The export consumer data already exists via `codegraph exports` — this just adds a threshold check. Reducing public API surface directly reduces blast radius | ✓ | ✓ | 4 | No | — |

### Tier B — CFG-Leveraged Checks (build on `cfg_blocks`/`cfg_edges`)

These features use the CFG data that is already computed on every build but currently only consumed by the `cfg` display command.

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking | Depends on |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|------------|
| B1 | Empty catch / swallowed error detector | New `check` predicate `--no-swallowed-errors` that combines CFG and AST analysis to find error-handling anti-patterns: **(a)** `catch` blocks with empty bodies or only logging calls (no rethrow, no return, no assignment); **(b)** `catch` blocks that return a falsy value without propagating the error; **(c)** async function calls without `.catch()` or surrounding `try/catch` (requires cross-referencing `ast_nodes` `await` expressions with `cfg_blocks` to check if they're inside an exception handler block). Configurable allowed patterns via `check.allowedCatchPatterns` (e.g., `["log.error", "logger.warn"]` to exempt logging-then-rethrow patterns). | CI | Silent failures are the **#1 review finding** (76 comments, 7.5% of all findings). 55% (42/76) are catchable — empty catch blocks, swallowed errors, and unhandled rejections are deterministic AST+CFG patterns. This single feature addresses more findings than any other proposal | ✓ | ✓ | 4 | No | — |
| B2 | Unreachable code detector | New `check` predicate `--no-unreachable` that queries `cfg_blocks` for blocks with zero incoming edges (excluding entry blocks) to detect dead branches. Also detect statements after unconditional `return`/`throw`/`break`/`continue` by finding `cfg_blocks` of kind `sequence` that follow a block ending with a return/throw edge and have no other incoming edges. Surface in `audit` reports as "unreachable blocks" count. | CI | Catches dead code that the symbol-level dead code detection misses — unreachable branches *inside* functions, not just unused functions. CFG already has this data; it just needs a query. Addresses 8 findings from the incorrect-logic category | ✓ | ✓ | 3 | No | Backlog #46 |
| B3 | Resource leak detector | New `check` predicate `--no-resource-leaks` that tracks open/close pairs through CFG paths. Configuration: `check.resourcePatterns` mapping open calls to their required close calls (e.g., `{ "openDb": ".close()", "createConnection": ".end()", "fs.open": "fs.close" }`). For each function, find `ast_nodes` call expressions matching an "open" pattern, then verify that all CFG exit paths pass through a block containing the corresponding "close" call. Flag functions where at least one exit path (including exception paths) misses the close. | CI | 62% of resource-leak findings (8/13) follow the open-without-close-on-all-paths pattern. Database connections, file handles, and server instances left open are a recurring bug class. This is the first check that combines CFG path analysis with AST pattern matching for a practical correctness guarantee | ✓ | ✓ | 4 | No | — |

### Tier C — AST + Dataflow Analysis (build on `ast_nodes` + `dataflow`)

These features combine AST node queries with dataflow edge analysis for deeper checks.

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking | Depends on |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|------------|
| C1 | Nullable return consumer check | New `check` predicate `--no-unchecked-nullable` that identifies functions whose CFG contains a `return null`, `return undefined`, or `return` (bare) statement, then traces `returns` dataflow edges to find callers that use the return value without a null guard. A "null guard" is any `cfg_block` of kind `condition` that tests the return-value variable for nullish before the consumption point. High-confidence: only flag when the return-null path is reachable (not behind an always-true guard). | CI | 40% of null/undefined findings (19/48) involve nullable returns consumed without guards. Combining CFG (return paths), dataflow (`returns` edges), and AST (condition checks) catches the most impactful null bugs — the ones that crash at runtime, not just type-level issues | ✓ | ✓ | 4 | No | Backlog #49 |
| C2 | Mutable export detector | New `check` predicate `--no-mutable-exports` that finds: **(a)** `export let` declarations (AST pattern on export statements with `let` keyword); **(b)** exported `const` bindings whose value is a mutable object literal (`{}`, `[]`, `new Map()`, `new Set()`) and has `mutates` dataflow edges from importer functions; **(c)** functions that receive a parameter via `flows_to` dataflow and mutate it (parameter mutation side effect). Surface (c) as `--no-param-mutation` separately. | Architecture | 75% of mutable-state findings (6/8) are module-level mutable exports or functions that mutate their inputs. Both are deterministic patterns: `export let` is a pure AST match, and parameter mutation is tracked by existing `mutates` dataflow edges. Mutable shared state is a common source of hard-to-debug coupling | ✓ | ✓ | 3 | No | — |
| C3 | Duplicate function detector | New `codegraph similar --structural` command (and `check` predicate `--no-duplicates`) that computes normalized AST hashes for function bodies. Normalization: strip variable names, replace literals with type placeholders, hash the resulting tree structure. Functions with identical or near-identical hashes (configurable Jaccard threshold on AST node sequences, default 0.90) are flagged as duplicates. Report pairs with file locations and similarity score. Distinct from the embeddings-based `similar` (Backlog #56) — this is purely structural, no embeddings required. | Analysis | 75% of duplication findings (39/52) are structurally similar code — same logic with different variable names. AST hashing is deterministic and fast (single-pass over existing parse trees). This catches copy-paste code that even embedding similarity might miss if naming conventions differ | ✓ | ✓ | 3 | No | — |

### Tier D — Compound Checks (combine multiple data sources)

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking | Depends on |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|------------|
| D1 | Signature consistency checker | New `check` predicate `--signature-consistency` that finds exported functions with the same name across different modules and compares their parameter counts and names. Flag pairs where same-name exports have different arities or parameter names (suggesting an inconsistent API). Cross-reference with `implements` edges: if a class implements an interface, verify all interface methods are present with matching signatures. | Architecture | 30% of inconsistency findings (6/21) are same-name functions with different signatures. This also addresses 25% of type-mismatch findings (5/20) where classes don't fully implement their declared interfaces. Signature consistency is a strong proxy for API contract correctness | ✓ | ✓ | 4 | No | — |
| D2 | Non-transactional multi-write detector | New `check` predicate `--no-non-transactional-writes` that finds functions containing multiple `db.run()`, `db.exec()`, or `db.prepare().run()` calls (via `ast_nodes`) that are not wrapped in a `db.transaction()` call (check if the function body or an enclosing scope contains a transaction wrapper). Configurable function names via `check.dbWritePatterns` and `check.transactionPatterns`. | Security | Catches data corruption risks from non-atomic multi-statement operations. 35% of race-condition findings (2/6) are non-transactional writes. While rare in review volume, these are among the highest-severity bugs — each one is a potential data corruption vector | ✓ | ✓ | 3 | No | — |

---

## Relationship to Existing Backlog

Several proposed features overlap with or extend existing backlog items. This section maps the relationship:

| Proposed | Existing Backlog | Relationship |
|----------|-----------------|-------------|
| A2 (dead export check) | #1, #4 (dead code, node classification) | **Extends** — formalizes existing `roles --role dead` as a `check` predicate with manifesto integration |
| A7 (overexposed exports) | #36 (exports analysis) | **Extends** — adds a threshold check on top of existing export consumer data |
| B1 (empty catch) | #41 (AST-based lint predicates) | **Instance of** — empty-catch is the highest-value predicate for the generic AST lint framework |
| B2 (unreachable code) | #46 (unreachable block detection) | **Same item** — this report validates the priority of backlog #46 with quantitative data |
| B3 (resource leak) | #51 (dataflow predicates in check) | **Instance of** — resource leak detection is the highest-value dataflow predicate |
| C1 (nullable return) | #49 (data-dependent impact) | **Extends** — nullable-return check is enabled by dataflow traversal across function boundaries |
| C3 (duplicate detector) | #56 (find similar functions) | **Complements** — structural hashing (AST) vs semantic similarity (embeddings); both are useful |
| D2 (non-transactional) | #51 (dataflow predicates) | **Instance of** — specific pattern within the generic dataflow check framework |
| — | #85 (hot-path detection) | **Already in backlog** — expensive-in-loop detection is backlog #85; this report confirms its priority |

### Items already in backlog that this analysis validates as high-priority

These existing backlog items are confirmed as high-value by the review finding data:

| Backlog ID | Title | Findings addressed | Validated priority |
|-----------|-------|-------------------:|-------------------|
| #85 | Hot-path expensive-initialization detection | 10 (prepared stmt in loop) | **High** — 91% catch rate, already well-scoped |
| #46 | Unreachable block detection in `check` | 8 (incorrect logic) | **High** — pure CFG query, zero false positives |
| #41 | AST-based lint predicates in `check` | 30+ (across silent failure, security, testing) | **Critical** — this is the generic framework that enables A5, A6, B1 |
| #51 | Dataflow predicates in `check` | 8+ (resource leaks, race conditions) | **Medium** — high severity but lower volume |
| #49 | Data-dependent impact analysis | 19 (null/undefined) | **High** — enables C1 and broader nullable analysis |
| #7 | OWASP/CWE pattern detection | 10 (SQL injection) | **Medium** — A5 is the lightweight version; #7 is the full implementation |

---

## Implementation Roadmap

### Phase 1 — Quick wins (Tier A, ~2 weeks)

Implement A1–A7 as new `check` predicates. All query existing tables. Ship as a single PR adding `--no-unsafe-casts`, `--no-dead-exports`, `--parity`, `--no-stale-reexports`, `--no-string-sql`, `--no-empty-tests`, `--no-overexposed-exports` flags.

**Expected catch rate after Phase 1:** ~130 of the 260 addressable findings (50%).

### Phase 2 — CFG-leveraged checks (Tier B, ~3 weeks)

Implement B1–B3. These require CFG path traversal logic (new analysis code, not just SQL queries). B1 (empty catch) is the highest single-feature impact.

**Expected catch rate after Phase 2:** ~190 of the 260 addressable findings (73%).

### Phase 3 — Dataflow + structural analysis (Tiers C–D, ~4 weeks)

Implement C1–C3 and D1–D2. These combine multiple data sources and require the most engineering. C3 (duplicate detector) has the broadest impact. C1 (nullable return) depends on backlog #49.

**Expected catch rate after Phase 3:** ~260 of the 260 addressable findings (100%).

---

## What Static Analysis Cannot Catch

The remaining 45% of findings (454 comments) require capabilities beyond deterministic static analysis:

| Category | Count | Why not automatable |
|----------|------:|---------------------|
| Procedure & workflow gaps (Titan, shell scripts) | 103 | Multi-step procedures described in prose; correctness requires understanding intended behavior |
| Documentation accuracy | 111 | Comparing prose claims against code behavior; judging clarity and completeness |
| Incorrect logic (semantic) | 61 | "Wrong field name," "stash runs too late" — requires understanding program intent |
| Algorithm correctness | 15 | Understanding mathematical invariants and data structure contracts |
| Missing features | 21 | Knowing what the feature *should* do vs what it does |
| Process violations | 38 | Matching code against written procedures and conventions |

These are the domain of LLM-powered code review — semantic understanding that complements the structural analysis codegraph provides.
