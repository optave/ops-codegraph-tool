# Call Graph Resolution Comparison: Codegraph vs Jelly

> Closes #1301 · Phase 8.6 follow-up · June 2026

## Summary

Codegraph outperforms Jelly on TypeScript recall (72% vs 56%) while maintaining
100% precision on both languages. On JavaScript, Jelly edges ahead on recall
(94% vs 83%), trading one false positive for better constructor-edge coverage.

| Language | Tool | Precision | Recall | TP | FP | FN |
|----------|------|:---------:|:------:|---:|---:|---:|
| JavaScript | **Codegraph** | **100%** | 83% | 15 | 0 | 3 |
| JavaScript | Jelly 0.13.0 | 94% | **94%** | 17 | 1 | 1 |
| TypeScript | **Codegraph** | **100%** | **72%** | 26 | 0 | 10 |
| TypeScript | Jelly 0.13.0 | **100%** | 56% | 20 | 0 | 16 |

Ground truth: 18 hand-annotated edges (JS) · 36 edges (TS). See
`tests/benchmarks/resolution/fixtures/{javascript,typescript}/expected-edges.json`.

---

## Methodology

### Ground truth

The hand-annotated `expected-edges.json` manifests in the resolution benchmark
fixtures serve as the ground truth corpus. They enumerate actual call edges
across `static`, `receiver-typed`, `same-file`, `constructor`,
`interface-dispatched`, `class-inheritance`, `callback`, and `re-export` modes.

Each edge is `{ source: {name, file}, target: {name, file}, mode }`.

### Codegraph metrics

The `scripts/resolution-benchmark.ts` script builds each fixture project into a
temporary SQLite graph and queries resolved `calls` edges, comparing against
the expected manifest to compute precision/recall. Run with:

```bash
npx tsx scripts/resolution-benchmark.ts
```

### Jelly metrics

Jelly ([@cs-au-dk/jelly](https://github.com/cs-au-dk/jelly), v0.13.0) is a
whole-program, flow-insensitive points-to analyzer for JavaScript/TypeScript.
It outputs a JSON call graph with `fun2fun` edges indexed by
`fileIndex:startLine:startCol:endLine:endCol`.

The `scripts/compare-jelly.mjs` script:
1. Copies each fixture to a temp directory with a minimal `package.json`
2. Runs Jelly with the fixture entry point
3. Resolves Jelly's line-number function IDs to `ClassName.method` names using
   source-line regex matching
4. Computes precision/recall against the same expected-edge manifests

```bash
JELLY_PATH=$(which jelly) node scripts/compare-jelly.mjs --all
```

**Mapping caveat:** Jelly identifies functions by source position; mapping to
codegraph-style names uses heuristic regex. Correctness was verified manually
for both fixtures.

---

## Per-Language Analysis

### JavaScript

| Mode | Codegraph | Jelly |
|------|-----------|-------|
| `static` (4 edges) | 4/4 (100%) | 4/4 (100%) |
| `receiver-typed` (5 edges) | 2/5 (40%) | 5/5 (100%) |
| `same-file` (5 edges) | 5/5 (100%) | 4/5 (80%) |
| `constructor` (4 edges) | 4/4 (100%) | 3/4 (75%) |

**Key differences:**

- **Receiver-typed recall** — Codegraph misses the three `this.logger.*` calls
  (`Logger.error`, `Logger.info`, `Logger.warn`) because it does not propagate
  types through constructor-assigned object properties (`this.logger = new
  Logger()` → `Logger` type on `this.logger`). Jelly's whole-program
  points-to analysis tracks all property writes and reads, resolving these
  correctly. Codegraph does resolve `main → UserService.createUser` and `main →
  UserService.deleteUser` via interprocedural return-type tracking
  (`buildService()` returns `UserService`).

- **Constructor edge representation** — Jelly emits `UserService → Logger` (the
  class as the caller), while the ground truth expects
  `UserService.constructor → Logger` (the method as the caller). This produces
  one FP + one FN for Jelly; codegraph uses the constructor method name and
  matches the ground truth.

### TypeScript

| Mode | Codegraph | Jelly |
|------|-----------|-------|
| `static` (3 edges) | 3/3 (100%) | 3/3 (100%) |
| `same-file` (5 edges) | 5/5 (100%) | 2/5 (40%) |
| `receiver-typed` (10 edges) | 7/10 (70%) | 6/10 (60%) |
| `callback` (3 edges) | 3/3 (100%) | 0/3 (0%) |
| `re-export` (2 edges) | 2/2 (100%) | 0/2 (0%) |
| `interface-dispatched` (5 edges) | 0/5 (0%) | **5/5 (100%)** |
| `class-inheritance` (2 edges) | 0/2 (0%) | 0/2 (0%) |
| `constructor` (6 edges) | 6/6 (100%) | 4/6 (67%) |

**Key differences:**

- **Interface dispatch** — Jelly resolves all 5 interface-dispatched edges
  (`UserService.getUser → UserRepository.findById`, etc.) because its
  whole-program analysis sees that `InMemoryUserRepository` is the only
  concrete type ever passed to `UserService`, making the polymorphic targets
  unambiguous. Codegraph's TypeScript CHA post-pass is not yet implemented;
  it resolves interface dispatch in Java/C#/Kotlin but not TypeScript. This is
  the most significant qualitative difference between the two tools.

- **Callbacks / higher-order functions** — Codegraph tracks callback argument
  bindings (e.g. `processEach(arr, logUser)`), resolving the callee from the
  argument expression. Jelly's flow-insensitive model does not propagate
  function values through call-argument positions, missing all 3 callback
  edges.

- **Barrel re-exports** — Codegraph follows re-export chains (`barrel.ts` →
  `index.ts` → consumer) to resolve calls that cross barrel boundaries. Jelly
  misses both `re-export` edges because `initFromBarrel` imports symbols
  through an intermediate barrel and Jelly does not model the alias chain.

- **Same-file edges** — Jelly misses `Shape.describe → Shape.area` and both
  `runCallbackDemo → processEach/filterThen` (labeled `same-file` in the
  ground truth), likely because `Shape.area` is a method call resolved via
  `this` and Jelly's same-file heuristic treats `this.area()` differently
  from a direct function call.

- **Class hierarchy** — Neither tool resolves `class-inheritance` edges on
  this fixture (`Shape.describe` calling overriding methods). These require
  type-narrowing from concrete subtypes at call sites.

---

## Java (ACG)

### Tool selection

The issue referenced `github.com/maccioni/acg`, but that is an adaptive call
graph library for **JavaScript** (the "ACG" from Feldthaus et al., ICSE 2013,
which Jelly also cites as prior work). No tool named "ACG" targets Java.

Established Java static call graph tools are:

| Tool | Approach | Notes |
|------|----------|-------|
| [WALA](https://github.com/wala/WALA) | CHA / 0-CFA / k-CFA | Heavy, requires JVM analysis harness |
| [Soot](https://github.com/soot-oss/soot) | CHA / RTA / VTA / Spark | Requires compiled `.class` files |
| [javacg-static](https://github.com/gousiosg/java-callgraph) | CHA | Lightweight, reads JARs |

All three require compiled bytecode. The fixture project contains raw `.java`
source files without a build system, so running these tools would require
either compiling the fixture (adding a `javac` / `mvn` step) or switching to a
source-level analyzer.

**Current codegraph Java metrics** (from `scripts/resolution-benchmark.ts`):

| Mode | Codegraph |
|------|-----------|
| `interface-dispatched` (3 edges) | 3/3 (100%) |
| `receiver-typed` (4 edges) | 3/4 (75%) |
| `same-file` (2 edges) | 0/2 (0%) |
| `static` (2 edges) | 0/2 (0%) |
| `class-inheritance` (3 edges) | 0/3 (0%) |
| `constructor` (3 edges) | 3/3 (100%) |
| **Total** | **9/17 (53%)** precision=100% |

Open items filed:
- Java same-file and static recall: tracked in the main benchmark threshold
  (`java: { precision: 0.7, recall: 0.3 }`, currently exceeded)
- Java class-hierarchy dispatch: same gap as TS — CHA post-pass not yet wired
  for Java in the WASM engine

---

## Conclusions

**Where codegraph leads:**
- Zero false positives on both JS and TS — its conservative precision is a
  design goal; it only resolves an edge when the analysis is confident
- TypeScript recall (72%) exceeds Jelly's (56%) because codegraph tracks
  callbacks, higher-order bindings, and barrel re-export chains
- Constructor edges are attributed to the method (`Foo.constructor`), matching
  software engineering conventions

**Where Jelly leads:**
- **TypeScript interface dispatch**: Jelly resolves 5/5 `interface-dispatched`
  edges; codegraph resolves 0/5. Jelly's whole-program analysis determines
  that `InMemoryUserRepository` is the only concrete implementor, making
  virtual calls unambiguous. This is the single biggest gap versus an external
  tool.
- **JavaScript receiver-typed via property assignments**: Jelly correctly
  resolves `this.logger.error/info/warn` by tracking the
  `this.logger = new Logger()` write; codegraph does not yet propagate types
  through constructor-assigned instance properties.
- Jelly is a mature whole-program points-to analysis — on static and
  flow-insensitive patterns it approaches ground truth.

**Shared gaps:**
- TypeScript `class-inheritance` edges (2 edges): both miss these — requires
  type-narrowing to concrete subtypes at virtual call sites.
- Neither tool covers 100% of `receiver-typed` edges; both miss 3–4 edges in
  the TypeScript fixture where type information flows through multiple
  intermediate assignments.

**Recommended next steps (prioritized by impact):**

1. **TypeScript CHA post-pass** — Wire codegraph's CHA pass to TypeScript
   class hierarchies and interface implementors (mirrors the Java/C# path).
   This would recover the 5 `interface-dispatched` and 2 `class-inheritance`
   edges, adding +7 recall on the TS fixture.
2. **Property-assignment type tracking** — Track `this.prop = new Foo()`
   writes and use the inferred type when resolving `this.prop.method()` calls.
   Recovers 3 FN on the JS fixture.
3. **Java comparison** — Add a `javac` compilation step to the Java fixture so
   `javacg-static` (JAR-based, lightweight) can analyze compiled classes.
   Current Java recall (53%) has known gaps in same-file and static edges
   that a bytecode-level tool would cover.

---

## Reproducing Results

```bash
# Codegraph baseline (all languages)
npx tsx scripts/resolution-benchmark.ts | jq '{javascript, typescript, java}'

# Jelly comparison (JS + TS)
npm install @cs-au-dk/jelly          # or: JELLY_PATH=$(which jelly)
JELLY_PATH=node_modules/.bin/jelly \
  node scripts/compare-jelly.mjs --all

# Full resolution test suite
npx vitest run tests/benchmarks/resolution/resolution-benchmark.test.ts
```

Jelly version used: **0.13.0** (June 2026). Results may differ across versions
as Jelly's analysis precision improves.
