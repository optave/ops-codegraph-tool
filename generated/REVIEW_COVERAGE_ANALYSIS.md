# Review Findings vs Codegraph: Coverage Analysis

> Which of the 1,017 review comments could codegraph catch with new
> static-analysis features (no LLM required)?
>
> Date: 2026-04-03

## Verdict

| Feasibility | Comments | % | Description |
|-------------|--------:|--:|-------------|
| **Already catchable** | 77 | 7.6% | Codegraph already has the data/features — needs wiring or config |
| **Feasible new feature** | 334 | 32.8% | Tree-sitter AST + graph data is sufficient; deterministic rules |
| **Partially feasible** | 152 | 14.9% | Heuristic-based; codegraph could flag suspects but with false positives |
| **Not feasible without LLM** | 454 | 44.6% | Requires semantic understanding, intent reasoning, or domain context |
| **Total** | **1,017** | | |

**Bottom line:** Codegraph could catch **~41%** (already + feasible) of what automated review finds
with deterministic static analysis, and flag another **~15%** heuristically. That's **563
comments** (55%) addressable without an LLM.

---

## Category-by-Category Breakdown

### Bug / Silent Failure & No-Op (76 comments) — 55% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 30 | **Empty catch/error-swallow detector.** Tree-sitter can find `catch {}` blocks with empty bodies or only logging. CFG analysis can detect branches that return without propagating errors. Pattern: function calls wrapped in try/catch where catch doesn't rethrow or assign. |
| Feasible | 12 | **Dead branch detector.** CFG + dataflow can identify conditions that are always true/false based on type narrowing (e.g., `typeof x !== 'undefined'` where x has a default). |
| Not feasible | 34 | Many silent failures require understanding *intent* — e.g., "this flag should error but doesn't" or "these two code paths should produce the same result." |

**Proposed features:**
1. `codegraph check --empty-catch` — find catch blocks that swallow errors
2. `codegraph check --unhandled-reject` — find async calls without `.catch()` or `await` in try
3. Manifesto rule: `no-silent-catch` (warn on `catch(e) {}` or `catch(e) { log(e) }`)

---

### Bug / Incorrect Logic (72 comments) — 15% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 8 | **Unreachable code after return.** CFG already models return/break/continue — can flag statements after unconditional early returns. |
| Partially | 3 | **Inverted condition heuristic.** When a condition's true-branch is empty and false-branch has logic, flag as suspicious. |
| Not feasible | 61 | Logic bugs like "wrong field name," "stash runs too late," "coverage reporter mismatch" require understanding program semantics. |

**Proposed features:**
1. `codegraph check --unreachable` — flag code after return/throw/break in CFG

---

### Architecture / Duplication & Overlap (52 comments) — 75% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 8 | **Duplicate symbol names.** Graph already stores all symbols — query for same-name same-kind symbols across files. |
| Feasible | 31 | **AST structural similarity.** Hash normalized AST subtrees for functions; report pairs above similarity threshold. Codegraph already has the AST — needs a comparison pass. |
| Not feasible | 13 | Semantic overlap (e.g., "A3 re-runs what Step 1 already did") requires understanding program flow across procedures. |

**Proposed features:**
1. `codegraph check --duplicates` — find structurally similar functions (AST hash)
2. `codegraph roles --role duplicate` — classify near-duplicate symbols
3. `codegraph check --duplicate-constants` — find identical constant values across files

---

### Bug / Null / Undefined / NaN / Division-by-Zero (48 comments) — 40% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 12 | **Nullable return consumer check.** Dataflow already tracks `returns` edges. If a function can return `null`/`undefined` (AST check for `return null` or missing return), flag callers that don't guard. |
| Feasible | 7 | **Division-by-zero guard.** CFG + AST can detect division where denominator is a parameter or variable with no prior `!== 0` check. |
| Not feasible | 29 | Many null issues are about API contracts (e.g., "napi-rs maps null to undefined") or runtime edge cases. |

**Proposed features:**
1. `codegraph check --nullable-return` — flag functions that return null without callers guarding
2. `codegraph check --div-zero` — flag unguarded divisions
3. Manifesto rule: `nullable-return-consumed` (warn when nullable return is used without guard)

---

### Dead Code & Unused (32 comments) — 90% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 25 | **`codegraph roles --role dead` already exists.** Most of these (exported-but-never-imported, functions with zero callers) are exactly what the dead code detector finds. Needs better surfacing in `check` and `diff-impact`. |
| Feasible | 4 | **Dead assignment detection.** Dataflow analysis can find variables assigned but never read. Codegraph has assignments in dataflow — needs a "consumed" check. |
| Not feasible | 3 | Some "dead" items are about dead *documentation* or *config keys*, not code. |

**Proposed features:**
1. `codegraph check --dead-exports` — already exists in pre-commit hook; formalize as check rule
2. `codegraph check --dead-assignments` — variables assigned but never read (dataflow)
3. Manifesto rule: `no-dead-exports` (fail on exports with zero consumers)

---

### Architecture / Missing Validation or Guard (30 comments) — 35% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 8 | **Missing null check after nullable call.** Combine nullable-return detection with caller analysis. |
| Feasible | 3 | **Missing error check pattern.** Detect when a function that returns `Error | Result` has its return value ignored (Go-style). |
| Not feasible | 19 | "Missing UNIQUE constraint," "no iteration cap on retry loop" — these require domain understanding. |

**Proposed features:**
1. Same as nullable-return check above
2. `codegraph check --unchecked-error-return` — Go/Rust pattern: error return value not checked

---

### Stale / Outdated References (52 comments) — 52% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 15 | **Unresolved imports.** Codegraph already resolves imports — unresolved ones with `dead-unresolved` role flag stale references. |
| Feasible | 8 | **Stale re-exports.** If a barrel file re-exports a symbol that no longer exists in the source, codegraph can detect this via graph edges pointing to missing nodes. |
| Feasible | 4 | **Version string consistency.** AST can extract string literals matching semver patterns; check they all agree with `package.json` version. |
| Not feasible | 25 | "Section description still uses Leiden/Louvain" or "column header dropped WASM context" require understanding prose. |

**Proposed features:**
1. `codegraph check --stale-reexports` — re-exports pointing to removed symbols
2. `codegraph check --unresolved` — flag unresolved imports above confidence threshold

---

### Engine Parity / Native vs WASM Divergence (27 comments) — 80% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 22 | **Parity test infrastructure.** Codegraph already has both engines — `codegraph check --parity` could run both engines on the same input and diff results. This is a test harness, not analysis, but it's deterministic and codegraph-native. |
| Not feasible | 5 | Some divergences are about *when* native skips a step (feature gaps), which requires design-level reasoning. |

**Proposed features:**
1. `codegraph check --parity` — run both engines, compare node/edge counts, flag divergence
2. Add parity assertions to incremental build pipeline (already partially exists in tests)

---

### Type Safety / Unsafe Cast or `any` (23 comments) — 85% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 20 | **`as any` / `as unknown` detector.** Tree-sitter can find all type assertion expressions. Count and locate `as any` casts. This is a simple AST pattern match. |
| Not feasible | 3 | Some are about whether a cast is *justified* (e.g., "this as any is now unnecessary because the type was fixed upstream"). |

**Proposed features:**
1. `codegraph check --unsafe-casts` — find and count `as any`, `as unknown`, `<any>` casts
2. Manifesto rule: `max-unsafe-casts` (threshold per file)
3. `codegraph diff-impact` enhancement: flag *new* `as any` casts in changed code

---

### Type Safety / Type Mismatch or Regression (20 comments) — 25% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 5 | **Interface conformance check.** Codegraph has `implements` edges — verify that classes declaring `implements X` actually have all methods of interface X. |
| Not feasible | 15 | Most type mismatches require type inference that only TypeScript's type checker provides. |

**Proposed features:**
1. `codegraph check --interface-conformance` — verify implements edges are complete

---

### Architecture / Scope & Encapsulation (18 comments) — 90% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 7 | **Layer boundary violations.** `codegraph check --boundaries` already exists. "Domain importing from presentation" is exactly a boundary rule. Needs boundary presets (e.g., clean architecture layers). |
| Feasible | 9 | **Internal export detection.** If a symbol is exported but only consumed within the same directory/module, flag as unnecessarily exported. Codegraph has export consumers via `codegraph exports`. |
| Not feasible | 2 | "Misplaced import declaration" requires style judgment. |

**Proposed features:**
1. Boundary presets: `--preset onion` already exists — add `--preset layered` for src/ subdirs
2. `codegraph check --overexposed` — exports consumed only internally
3. Manifesto rule: `no-upward-imports` (domain → presentation violation)

---

### Architecture / Inconsistent Behavior (21 comments) — 30% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 6 | **API surface consistency.** Detect functions with same name in different modules but different signatures (parameter count/names). |
| Not feasible | 15 | "Inconsistent scoping condition" or "inconsistent denominator" require understanding the intended behavior. |

**Proposed features:**
1. `codegraph check --signature-consistency` — same-name exports with different parameter shapes

---

### Bug / Resource Leak (13 comments) — 60% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 8 | **Open-without-close detector.** Dataflow + CFG can track: if `db = openDb()` or `conn = new Connection()` appears in a function, verify `db.close()` or equivalent appears on all CFG exit paths. |
| Not feasible | 5 | Some leaks are about event listeners accumulating or cleanup callbacks not being wired — harder to detect structurally. |

**Proposed features:**
1. `codegraph check --resource-leak` — open/close pair verification on CFG paths
2. Pattern config: `{ "open": "openDb", "close": ".close()" }` per resource type

---

### Performance / Prepared Statement in Loop (11 comments) — 91% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 10 | **Hot-path allocation detector.** CFG knows which blocks are inside loops. AST can find `db.prepare()` calls. Combine: `db.prepare()` inside a loop body = finding. Generalizable to any "expensive call in loop" pattern. |
| Not feasible | 1 | One item is about a statement not using a cache pattern — requires understanding the caching API. |

**Proposed features:**
1. `codegraph check --expensive-in-loop` — configurable list of expensive calls (`db.prepare`, `fs.readFileSync`, `new RegExp`) flagged when inside CFG loop blocks
2. Manifesto rule: `no-prepare-in-loop`

---

### Performance / Unnecessary Recomputation (10 comments) — 50% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 5 | **Redundant call detection.** If the same function is called with identical arguments twice in the same scope (no mutations between), flag it. Dataflow has enough to detect this. |
| Not feasible | 5 | "All DB nodes re-analyzed on every incremental build" requires understanding the build pipeline design. |

**Proposed features:**
1. `codegraph check --redundant-calls` — same call, same args, same scope, no intervening mutation

---

### Security / SQL & Injection (10 comments) — 80% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 8 | **Unparameterized query detector.** AST can find string concatenation/template literals passed to `db.prepare()`, `.execute()`, `.run()`. Flag SQL strings built with variables instead of `?` parameters. Also detect LIKE without ESCAPE clause. |
| Not feasible | 2 | "pragma() accepts write PRAGMAs" requires understanding SQL semantics. |

**Proposed features:**
1. `codegraph check --sql-injection` — flag string-interpolated SQL in prepare/execute calls
2. `codegraph check --like-escape` — flag LIKE queries without ESCAPE clause
3. Manifesto rule: `no-string-sql`

---

### Architecture / Mutable Shared State (8 comments) — 75% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 6 | **Module-level mutable export detector.** AST can find `export let` or `export const obj = {}` where the exported binding is a mutable object. Combined with dataflow mutation tracking, flag exports that are mutated by importers. |
| Not feasible | 2 | Cache correctness requires understanding intended caching behavior. |

**Proposed features:**
1. `codegraph check --mutable-exports` — flag exported mutable state (let, mutable objects)
2. `codegraph check --mutated-params` — flag functions that mutate their input parameters

---

### Bug / Race Condition & Concurrency (6 comments) — 35% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 2 | **Non-transactional multi-write detector.** AST can find multiple `db.run()`/`db.exec()` calls in a function without a surrounding `db.transaction()`. |
| Not feasible | 4 | True race conditions require understanding concurrent execution contexts. |

**Proposed features:**
1. `codegraph check --non-transactional` — multiple DB writes without transaction wrapper

---

### Testing / Weak or Missing Assertion (12 comments) — 60% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Feasible | 7 | **Empty test / no-assert detector.** AST can find test functions (`it()`, `test()`, `describe()`) and check whether they contain assertion calls (`expect`, `assert`, `should`). Flag tests with zero assertions. |
| Not feasible | 5 | "Test doesn't compare both engines" requires understanding test intent. |

**Proposed features:**
1. `codegraph check --empty-tests` — test blocks with no assertion calls
2. `codegraph check --catch-assert` — assertions inside catch blocks (always pass if no throw)
3. Manifesto rule: `min-assertions-per-test`

---

### Testing / Incomplete Coverage (14 comments) — 40% feasible

| Feasibility | Count | Approach |
|-------------|------:|----------|
| Already catchable | 6 | **Export without test consumer.** Codegraph tracks which test files call which symbols. An exported function with zero test-file callers = untested public API. `codegraph roles` with test-file awareness can already flag this. |
| Not feasible | 8 | "Test only covers source strategy not structured" requires understanding test intent and coverage depth. |

**Proposed features:**
1. `codegraph check --untested-exports` — public exports with no test-file callers
2. Manifesto rule: `min-test-coverage-by-callers` (% of exports with at least one test caller)

---

## Categories NOT Feasible Without LLM

These categories fundamentally require understanding *intent*, *prose*, or *domain semantics*:

| Category | Count | Why not feasible |
|----------|------:|-----------------|
| Titan Pipeline / Procedure Gap | 55 | Requires understanding multi-step procedures described in prose |
| Shell Script / Check Logic Bug | 48 | Regex/bash logic correctness requires understanding intended behavior |
| Documentation / Inaccurate Claim | 39 | Comparing prose claims against code behavior |
| Documentation / Numbering & Scoring Errors | 29 | Verifying arithmetic in markdown tables |
| Documentation / Missing or Incomplete | 21 | Judging what documentation should exist |
| Bug / Missing Feature or Incomplete | 21 | Knowing what the feature *should* do |
| Process / Procedure & Skill Violations | 15 | Matching code against written procedures |
| Bug / Algorithm & Data Structure | 15 | Understanding algorithmic correctness |
| Bug / Data Loss & Corruption | 12 | Understanding data lifecycle and recovery semantics |
| Documentation / Ambiguous or Confusing | 10 | Judging clarity of prose |
| Display / Output & Formatting | 9 | Understanding output expectations |

---

## Summary: Proposed New Features by ROI

Ranked by (comments catchable) x (implementation feasibility):

| # | Feature | Comments caught | Complexity | Category |
|--:|---------|---------------:|:----------:|----------|
| 1 | `--parity` engine comparison | 22 | Low | Engine Parity |
| 2 | `--duplicates` AST similarity | 31 | Medium | Duplication |
| 3 | `--dead-exports` as check rule | 25 | Low | Dead Code |
| 4 | `--empty-catch` error swallowing | 30 | Medium | Silent Failure |
| 5 | `--unsafe-casts` as-any detector | 20 | Low | Type Safety |
| 6 | `--sql-injection` string SQL | 8 | Low | Security |
| 7 | `--expensive-in-loop` hot-path | 10 | Medium | Performance |
| 8 | `--resource-leak` open/close | 8 | High | Resource Leak |
| 9 | `--nullable-return` null check | 12 | High | Null/Undefined |
| 10 | `--empty-tests` no-assert tests | 7 | Low | Testing |
| 11 | `--overexposed` internal exports | 9 | Low | Encapsulation |
| 12 | `--untested-exports` coverage | 6 | Low | Testing |
| 13 | `--stale-reexports` dead barrels | 8 | Low | Stale References |
| 14 | `--mutable-exports` shared state | 6 | Medium | Mutable State |
| 15 | `--unreachable` dead CFG blocks | 8 | Medium | Incorrect Logic |
| 16 | `--mutated-params` side effects | 6 | Medium | Mutable State |
| 17 | `--non-transactional` DB writes | 2 | Medium | Race Condition |
| 18 | `--signature-consistency` API | 6 | Medium | Inconsistency |
| | **Total by proposed features** | **~244** | | |

> **Note:** The per-problem-class analysis identifies ~260 total catchable findings. The ~244 figure here reflects the subset directly addressed by the 18 proposed features — some catchable findings in each category require additional feature work beyond these 18.

### Quick wins (Low complexity, high impact):
1. **`--dead-exports`** — already have the data, just wire to `check`
2. **`--unsafe-casts`** — simple AST pattern match on `as any`
3. **`--parity`** — run both engines, diff results
4. **`--sql-injection`** — string concat in SQL calls
5. **`--empty-tests`** — test blocks without assertion calls
6. **`--overexposed`** — exports with only local consumers
7. **`--stale-reexports`** — re-exports pointing to removed symbols

### Medium effort, high impact:
8. **`--empty-catch`** — catch blocks that swallow errors
9. **`--duplicates`** — AST structural similarity hashing
10. **`--expensive-in-loop`** — configurable hot-path patterns
