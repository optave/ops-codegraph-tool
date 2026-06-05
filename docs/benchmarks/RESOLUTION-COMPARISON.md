# Call Graph Resolution Comparison: Codegraph vs Jelly vs ACG

> Closes #1301 · Phase 8.6 follow-up · June 2026

## Summary

Two external call graph tools — Jelly (whole-program points-to) and ACG
(field-based approximate) — were run against the same hand-annotated fixtures
used by codegraph's resolution benchmark.

| Language | Tool | Precision | Recall | TP | FP | FN |
|----------|------|:---------:|:------:|---:|---:|---:|
| JavaScript | **Codegraph** | **100%** | 83% | 15 | 0 | 3 |
| JavaScript | Jelly 0.13.0 | 94% | **94%** | 17 | 1 | 1 |
| JavaScript | ACG 2.0.0 | 92% | 67% | 12 | 1 | 6 |
| TypeScript | **Codegraph** | **100%** | **72%** | 26 | 0 | 10 |
| TypeScript | Jelly 0.13.0 | **100%** | 56% | 20 | 0 | 16 |
| TypeScript | ACG | — | — | — | — | — |

Ground truth: 18 hand-annotated edges (JS) · 36 edges (TS). See
`tests/benchmarks/resolution/fixtures/{javascript,typescript}/expected-edges.json`.

ACG uses [esprima](https://esprima.org/) and does not parse TypeScript or modern
ES syntax (spread `...`), so TS comparison is Jelly-only, and the JS numbers
reflect partial coverage.

---

## Methodology

### Ground truth

The hand-annotated `expected-edges.json` manifests serve as ground truth. They
enumerate actual call edges across `static`, `receiver-typed`, `same-file`,
`constructor`, `interface-dispatched`, `class-inheritance`, `callback`, and
`re-export` modes. Each edge is `{ source: {name, file}, target: {name, file}, mode }`.

### Codegraph metrics

`scripts/resolution-benchmark.ts` builds each fixture into a temporary SQLite
graph and queries resolved `calls` edges, comparing against the manifest.

```bash
npx tsx scripts/resolution-benchmark.ts | jq '{javascript, typescript, java}'
```

### Jelly

[@cs-au-dk/jelly](https://github.com/cs-au-dk/jelly) v0.13.0 — whole-program,
flow-insensitive points-to analyzer for JS/TS. Outputs a JSON call graph with
`fun2fun` edges indexed by `fileIndex:startLine:startCol:endLine:endCol`.

### ACG

[@persper/js-callgraph](https://www.npmjs.com/package/@persper/js-callgraph)
v2.0.0 — implements the Feldthaus et al. ICSE 2013 field-based algorithm
("efficient construction of approximate call graphs for JavaScript IDE services").
Jelly's design is partly based on this work. ACG uses esprima for parsing:
only CommonJS / pre-ES2018 JavaScript, no TypeScript.

**Note on issue #1301:** The issue referenced `github.com/maccioni/acg` as "ACG
(targeting Java)". That repository is unavailable; "ACG" in the JS community
refers to the Feldthaus et al. algorithm, which targets JavaScript (not Java).
For Java call graph comparison, see the [Java section](#java) below.

### Comparison script

`scripts/compare-tools.mjs` runs both Jelly and ACG on a fixture directory,
maps tool-specific function IDs and names to `ClassName.method` notation, and
computes precision/recall against the expected-edge manifests.

```bash
npm install @cs-au-dk/jelly @persper/js-callgraph
node scripts/compare-tools.mjs --all
# or with explicit paths:
JELLY_PATH=node_modules/.bin/jelly \
ACG_PATH=node_modules/.bin/js-callgraph \
  node scripts/compare-tools.mjs --all
```

**Name mapping:** Jelly uses source positions (line:col); ACG provides unqualified
function names. Both are mapped to `ClassName.method` form via regex over source
lines. Correctness was verified manually for both JS and TS fixtures.

---

## Per-Language Analysis

### JavaScript

| Mode | Codegraph | Jelly | ACG |
|------|:---------:|:-----:|:---:|
| `static` (4 edges) | 4/4 (100%) | 4/4 (100%) | 0/4 (0%)† |
| `receiver-typed` (5 edges) | 2/5 (40%) | 5/5 (100%) | 4/5 (80%)† |
| `same-file` (5 edges) | 5/5 (100%) | 4/5 (80%) | 4/5 (80%)† |
| `constructor` (4 edges) | 4/4 (100%) | 3/4 (75%) | 3/4 (75%) |

† ACG could not parse `validators.js` (spread syntax unsupported by esprima),
so all calls to/from `validate`, `normalize`, `checkLength`, and `trimWhitespace`
are missing. Excluding those 5 edges, ACG's effective recall on the parseable
subset is 12/13 ≈ 92%.

**Key differences:**

- **Receiver-typed recall** — Codegraph misses the three `this.logger.*` calls
  (`Logger.error`, `Logger.info`, `Logger.warn`) because it does not propagate
  types through constructor-assigned object properties (`this.logger = new
  Logger()`). Jelly's whole-program points-to analysis tracks all property
  writes, resolving these correctly. ACG also resolves them (field-based
  analysis tracks object property flow). Codegraph does resolve
  `main → UserService.createUser` and `main → UserService.deleteUser` via
  interprocedural return-type tracking (`buildService()` returns `UserService`).

- **Constructor edge representation** — Both Jelly and ACG emit
  `UserService → Logger` (the class as the caller), while the ground truth
  expects `UserService.constructor → Logger` (the method). This produces one FP
  + one FN for each tool; codegraph matches the ground truth by naming the
  constructor method explicitly.

- **ACG parse limitation** — ACG's esprima parser rejects modern JS syntax
  (shorthand property spread `{ ...obj }` in validators.js). This is a tooling
  limitation, not an algorithmic one. A tool using acorn or swc would not have
  this issue.

### TypeScript

ACG does not support TypeScript. Comparison is Jelly-only.

| Mode | Codegraph | Jelly |
|------|:---------:|:-----:|
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
  whole-program analysis determines that `InMemoryUserRepository` is the only
  concrete type ever passed to `UserService`. Codegraph's CHA post-pass handles
  Java/C#/Kotlin but is not yet wired for TypeScript. This is the most
  significant qualitative gap vs an external tool.

- **Callbacks / higher-order functions** — Codegraph tracks callback argument
  bindings (e.g. `processEach(arr, logUser)`), resolving the callee from the
  argument expression. Jelly's flow-insensitive model does not propagate
  function values through call-argument positions, missing all 3 callback edges.

- **Barrel re-exports** — Codegraph follows re-export chains (`barrel.ts` →
  `index.ts` → consumer). Jelly misses both `re-export` edges because the
  import alias chain through the barrel is not modeled.

- **Same-file edges** — Jelly misses `Shape.describe → Shape.area` and
  `runCallbackDemo → processEach/filterThen` (labeled `same-file`); the
  `this.area()` call form and callback-via-argument pattern are not captured
  by its same-file heuristic.

- **Class hierarchy** — Neither tool resolves `class-inheritance` edges;
  these require type-narrowing to concrete subtypes at virtual call sites.

---

## Java {#java}

### Tool selection

Established Java static call graph tools all require compiled bytecode:

| Tool | Approach | Notes |
|------|----------|-------|
| [WALA](https://github.com/wala/WALA) | CHA / 0-CFA / k-CFA | Heavy, requires JVM harness |
| [Soot](https://github.com/soot-oss/soot) | CHA / RTA / VTA / Spark | Needs compiled `.class` files |
| [javacg-static](https://github.com/gousiosg/java-callgraph) | CHA | Lightweight, reads JARs |

The fixture contains raw `.java` source with no build system. Running these
tools requires a `javac` compilation step (tracked in #1307).

**Current codegraph Java metrics** (`scripts/resolution-benchmark.ts`):

| Mode | Codegraph |
|------|:---------:|
| `interface-dispatched` (3 edges) | 3/3 (100%) |
| `constructor` (3 edges) | 3/3 (100%) |
| `receiver-typed` (4 edges) | 3/4 (75%) |
| `same-file` (2 edges) | 0/2 (0%) |
| `static` (2 edges) | 0/2 (0%) |
| `class-inheritance` (3 edges) | 0/3 (0%) |
| **Total** | **9/17 (53%)** · precision=100% |

---

## Conclusions

**Where codegraph leads:**
- Zero false positives on JS and TS — conservative precision is a design goal
- TypeScript recall (72%) exceeds Jelly's (56%) via callback tracking and
  barrel re-export chain resolution
- Constructor edges attributed to the method (`Foo.constructor`), matching
  software engineering conventions; both Jelly and ACG emit the class instead

**Where Jelly leads:**
- **TypeScript interface dispatch**: Jelly resolves 5/5 `interface-dispatched`
  edges; codegraph resolves 0/5. The single biggest gap vs an external tool.
- **JavaScript receiver-typed via property writes**: Jelly resolves
  `this.logger.error/info/warn`; codegraph does not yet track types through
  constructor-assigned instance properties (`this.prop = new Foo()`).

**Where ACG stands:**
- Faster than Jelly (field-based, not whole-program) but constrained by esprima
  (no TypeScript, no modern JS syntax). On the parseable JS subset, ACG matches
  Jelly in precision (92% vs 94%) but trails in recall (67% vs 94%) — the gap
  is entirely explained by the validators.js parse failure, not by the algorithm.
- ACG and Jelly share the same constructor-naming FP (`ClassName → TargetClass`
  instead of `ClassName.constructor → TargetClass`), confirming this is a
  representational convention in the academic call-graph community, not a bug
  in either tool.

**Shared gaps:**
- TypeScript `class-inheritance` (2 edges): 0% recall for all tools — requires
  type-narrowing to concrete subtypes at virtual call sites.

**Recommended next steps (filed as issues):**

1. **TypeScript CHA post-pass** (#1305) — Wire codegraph's CHA pass to TS class
   hierarchies and interface implementors. Recovers 5 `interface-dispatched` +
   2 `class-inheritance` edges (+7 recall on TS fixture).
2. **Property-assignment type tracking** (#1306) — Track `this.prop = new Foo()`
   writes. Recovers 3 JS `receiver-typed` FN.
3. **Java comparison with javacg-static** (#1307) — Add `javac` compilation to
   the Java fixture so a bytecode-level tool can validate Java recall claims.

---

## Reproducing Results

```bash
# Codegraph baseline (all languages)
npx tsx scripts/resolution-benchmark.ts | jq '{javascript, typescript, java}'

# Jelly + ACG comparison (JS only for ACG, JS+TS for Jelly)
npm install @cs-au-dk/jelly @persper/js-callgraph
node scripts/compare-tools.mjs --all

# Full resolution test suite
npx vitest run tests/benchmarks/resolution/resolution-benchmark.test.ts
```

Tool versions used: Jelly **0.13.0**, @persper/js-callgraph **2.0.0** (June 2026).
Results may change as tool precision improves.
