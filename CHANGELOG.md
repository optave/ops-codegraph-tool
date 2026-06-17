# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.13.0](https://github.com/optave/ops-codegraph-tool/compare/v3.12.0...v3.13.0) (2026-06-16)

**User-level global config, `codegraph config` scaffolding, and an `explain` alias land.** The headline feature is a new user-level configuration layer (`~/.config/codegraph/config.json` via XDG, or `~/.codegraph/config.json` fallback) with an interactive per-repo consent model — DEFAULTS → global (if consented) → project → env → secrets. `codegraph config` now shows a human-friendly key/value/source table by default (pass `--json` for machine output), and gains `--init` (scaffold a `.codegraphrc.json` with all sections pre-populated), `--edit` (open in `$EDITOR`), `--enable-global`, `--disable-global`, and `--list-global` flags. Global `--user-config [path]` and `--no-user-config` CLI flags are also new. The `explain` command lands as a discoverable alias for `audit`. TypeScript compiler-based type resolution now auto-enables for TS projects that have a `tsconfig.json`. A supply-chain incident is resolved — a malicious `tree-sitter-erlang` npm package is replaced with a clean source build. On engine accuracy, super-dispatch cross-file false edges are eliminated, CHA confidence is aligned between WASM and native, and a sweep of parity fixes improves call-graph correctness for Go, Python, C++, CUDA, Haskell, and Zig.

### Features

* **cli:** add `explain` as alias for `audit` — `codegraph explain <target>` is equivalent to `codegraph audit <target>`; makes the audit command easier to discover
* **config:** `codegraph config` now shows a key/value/source table when `--json` is not passed — each key displays its current value and which layer it came from (`default`, `user`, `project`, `env`)
* **config:** add `--init` and `--edit` scaffolding helpers — `codegraph config --init` scaffolds a `.codegraphrc.json` with all sections pre-populated; `codegraph config --edit` opens the project config file in `$EDITOR`
* **config:** user-level (global) config with per-repo consent — new `~/.config/codegraph/config.json` (XDG) or `~/.codegraph/config.json` fallback; interactive per-repo consent model; `codegraph config --enable-global`, `--disable-global`, `--list-global` flags; global `--user-config [path]` and `--no-user-config` CLI flags; layered merge order: DEFAULTS → global (if consented) → project → env; `config_hash` invalidation triggers a full rebuild when build-relevant config changes; `loadConfigWithProvenance` returns per-key source map ([#1559](https://github.com/optave/ops-codegraph-tool/pull/1559))

### Bug Fixes

* **config:** auto-enable TypeScript compiler resolver for TS projects — `typescriptResolver` now defaults to `true`; silently skips when `typescript` is unavailable or no `tsconfig.json` is present, so JS-only projects and environments without TypeScript are unaffected ([#1461](https://github.com/optave/ops-codegraph-tool/pull/1461))
* **config:** clarify consent prompt wording to reflect per-key inheritance semantics and improve question clarity
* **cha:** eliminate super-dispatch cross-file false edges — `super.method()` calls no longer resolve to methods outside the class hierarchy; the native engine expands super-dispatch into CHA sibling overrides ([#1506](https://github.com/optave/ops-codegraph-tool/pull/1506), [#1514](https://github.com/optave/ops-codegraph-tool/pull/1514), [#1537](https://github.com/optave/ops-codegraph-tool/pull/1537), [#1544](https://github.com/optave/ops-codegraph-tool/pull/1544))
* **native:** resolve this-dispatch in func-prop methods — `fn.method = function(){ this.other() }` now resolves `other` through the func-prop enclosing context ([#1512](https://github.com/optave/ops-codegraph-tool/pull/1512))
* **native:** seed typeMap entries for let/var object-literal methods — object literal methods defined with `let`/`var` now register their receiver types for downstream resolution
* **native:** prefer bare name over qualified in span-tie caller attribution — when two candidates share the same span, the bare-name symbol wins to avoid false qualified-name attribution
* **native:** resolve Go factory and Python constructor receiver types — `NewFoo()` in Go and `Foo()` constructors in Python now seed the typeMap for downstream method-call resolution ([#1498](https://github.com/optave/ops-codegraph-tool/pull/1498))
* **native:** align object-literal shorthand method node ordering with WASM — extraction order is now consistent between engines
* **wasm:** align TypeScript CHA dispatch confidence (0.6 → 0.8) — WASM now matches the native engine's confidence for CHA-resolved edges ([#1505](https://github.com/optave/ops-codegraph-tool/pull/1505))
* **wasm:** port missing node extractions to JS extractor (jelly-micro #1471) — several edge-type gaps in the WASM engine aligned with the native engine ([#1509](https://github.com/optave/ops-codegraph-tool/pull/1509))
* **wasm:** emit receiver edges for declaration-typed locals (C++, CUDA) — typed local declarations in C++ and CUDA now produce receiver call edges ([#1497](https://github.com/optave/ops-codegraph-tool/pull/1497))
* **parity:** port the JS points-to solver to native — WASM and native now run identical resolution logic for JavaScript/TypeScript points-to bindings; the four JS pts post-passes on the hybrid path are removed, leaving a single source of truth ([#1465](https://github.com/optave/ops-codegraph-tool/pull/1465))
* **parity:** align Java interface dispatch across WASM, native, and hybrid engines — all three engines now agree on interface method resolution confidence and edge set ([#1503](https://github.com/optave/ops-codegraph-tool/pull/1503))
* **parity:** align enclosing-caller attribution for variable bindings (Haskell, Zig) — multi-binding `let` patterns now attribute calls to the correct enclosing caller ([#1499](https://github.com/optave/ops-codegraph-tool/pull/1499))
* **extractor:** strip brackets from computed string-key method names — `obj['method']()` no longer emits `['method']` as the method name
* **receiver:** local function constructors block cross-file class receiver edges — prevents false cross-file receiver matches when a same-file function constructor is in scope
* **resolver:** class-scope field annotation typeMap keys prevent cross-class collision — `private repo: Repository` in two classes no longer shares a typeMap key ([#1495](https://github.com/optave/ops-codegraph-tool/pull/1495))
* **triage:** normalize JSON output to use `items` key at all levels — all triage JSON responses now use a consistent `items` array structure
* **cli:** accept `--json` flag in batch command as no-op — batch command no longer errors when `--json` is passed ([#1563](https://github.com/optave/ops-codegraph-tool/pull/1563))
* **parser:** downgrade WARN to debug for optional parsers with missing WASM grammar — language parse errors for optional grammars no longer pollute stderr with WARN messages
* **native:** don't warn when a natively-supported file produces 0 symbols via WASM — gitignored Rust addon artifacts no longer trigger false-positive extractor failure warnings
* **deps:** remove malicious `tree-sitter-erlang`, fix 3 moderate vulnerabilities — replaces the compromised npm package with a clean source build; also fixes 3 moderate-severity vulns ([#1478](https://github.com/optave/ops-codegraph-tool/pull/1478))
* **hooks:** track Bash file modifications to prevent false-positive commit blocks ([#1483](https://github.com/optave/ops-codegraph-tool/pull/1483))
* **perf:** scope `runPostNativeCha` to changed files on incremental builds — incremental rebuilds no longer run the full CHA post-pass on unchanged files ([#1490](https://github.com/optave/ops-codegraph-tool/pull/1490))
* **perf:** pass `symbolsOnly` through `parseFilesWasmInline` — avoids unnecessary data extraction during symbol-only parse passes ([#1489](https://github.com/optave/ops-codegraph-tool/pull/1489))
* **bench:** update Elixir, Julia, and Objective-C expected-edges to module-qualified names ([#1496](https://github.com/optave/ops-codegraph-tool/pull/1496))
* **ci:** accept v-prefixed versions in `publish` `workflow_dispatch` input ([#1443](https://github.com/optave/ops-codegraph-tool/pull/1443))

### Performance

* **native:** replace O(n²) type-map dedup with O(n) write-then-dedup — large files with many type-map entries no longer degrade quadratically during the native post-pass

### Refactors

* **native:** mirror Rust crate module layout to the TypeScript `src/` tree — `crates/codegraph-core/src/` modules now follow the snake_case equivalent of their TypeScript counterparts ([#1463](https://github.com/optave/ops-codegraph-tool/pull/1463))
* **extractors:** deduplicate C-family primitive types into a shared constant

### Chores

* **ci:** add per-PR perf canary for extractor/graph/native changes ([#1488](https://github.com/optave/ops-codegraph-tool/pull/1488))
* **ci:** add dev-dependency audit step at critical severity ([#1479](https://github.com/optave/ops-codegraph-tool/pull/1479))
* **deps-dev:** bump `@biomejs/biome` from 2.4.16 to 2.5.0 ([#1523](https://github.com/optave/ops-codegraph-tool/pull/1523))
* **deps-dev:** bump `tree-sitter-gleam` ([#1522](https://github.com/optave/ops-codegraph-tool/pull/1522))
* **deps-dev:** bump `@vitest/coverage-v8` from 4.1.7 to 4.1.8 ([#1521](https://github.com/optave/ops-codegraph-tool/pull/1521))
* **deps:** bump `anthropics/claude-code-action` from 0.0.63 to 1.0.148 ([#1520](https://github.com/optave/ops-codegraph-tool/pull/1520))

## [3.12.0](https://github.com/optave/ops-codegraph-tool/compare/v3.11.2...v3.12.0) (2026-06-10)

**Phase 8 Analysis Depth lands in full, plus a 30-technique JavaScript/TypeScript resolution sweep.** Sub-phases 8.1 through 8.6 are now complete, with 8.3 substantially complete (one stretch-goal item — full allocation-site abstraction with fixed-point iteration — deferred to a future release): TypeScript compiler API type resolution (`typescriptResolver` opt-in in `.codegraphrc.json`) upgrades confidence-0.7 heuristic edges to compiler-verified 1.0; inter-procedural return-type propagation resolves method chains and factory patterns up to 3 hops; field-based points-to analysis (Phases 8.3 through 8.3f) covers callbacks, event handlers, parameter flows, object property writes, and object destructuring rest parameters in both WASM and native engines; barrel re-export chain resolution traces symbols through `index.ts` re-exports to their actual declaration files; CHA+RTA dynamic dispatch resolves interface method calls to all instantiated concrete implementations; and Phase 8.6 adds a `byTechnique` breakdown to `codegraph stats --json` showing edges attributed to each resolver technique. Beyond the Phase 8 work, a parallel accuracy sweep adds resolution for prototype-based method calls, `Object.defineProperty` accessor this-dispatch, `super.method()` dispatch via class expressions and static blocks, `.call/.apply/.bind` receiver rebinding, `for-of`/`Set`/`Array.from` iteration callbacks, inline-array spread call edges, and constructor-assigned property types. C# call graphs improve with same-class bare static call resolution and `var`-typed local type inference. Six native engine parity issues in the incremental rebuild path are fixed. Caller coverage for real-world TypeScript projects is substantially higher after this release. Note: most resolver improvements appear under Bug Fixes below — they used `fix:` commit prefixes because they corrected missing edges in existing resolution logic rather than introducing entirely new CLI capabilities.

### Features

* **stats:** add `byTechnique` breakdown to `codegraph stats` — `codegraph stats --json` now includes `caller_coverage.byTechnique` with edge counts per resolution technique (`ts-native`, `points-to`); displayed in human-readable stats output under the caller coverage line; DB migration v17 adds `technique` column to `edges` table ([#1303](https://github.com/optave/ops-codegraph-tool/pull/1303))
* **config:** new `typescriptResolver` option in `.codegraphrc.json` — set `"build": { "typescriptResolver": true }` to enable the TypeScript compiler API enrichment pass; compiler-verified edges (confidence 1.0) replace heuristic typeMap values for factory calls, generic constructors, and other patterns tree-sitter can't resolve alone ([#1278](https://github.com/optave/ops-codegraph-tool/pull/1278))

### Bug Fixes

* **resolver:** TypeScript-native type resolution via `ts.createProgram` + type checker (Phase 8.1) — upgrades heuristic typeMap entries to compiler-verified confidence 1.0 for `.ts`/`.tsx` files; resolves `container.get<MyService>()` → `MyService.doThing()` class of edges that tree-sitter cannot see ([#1278](https://github.com/optave/ops-codegraph-tool/pull/1278))
* **resolver:** inter-procedural return-type propagation (Phase 8.2) — `const x = createUser()` propagates return type to `x` for downstream method-call resolution; chain propagation up to 3 hops with confidence decay (1.0 → 0.9 → 0.8 → 0.7); `analysis.typePropagationDepth` config knob ([#1279](https://github.com/optave/ops-codegraph-tool/pull/1279))
* **resolver:** field-based points-to analysis for higher-order calls (Phase 8.3) — tracks callback assignments, event-handler registrations, and strategy-pattern wiring; resolves `app.use(handler)` and `events.on('click', handler)` call edges ([#1289](https://github.com/optave/ops-codegraph-tool/pull/1289))
* **resolver:** cross-module points-to propagation (Phase 8.3 + 8.3b) — WASM + native parity; inter-module flows through import edges now propagate type bindings across file boundaries ([#1296](https://github.com/optave/ops-codegraph-tool/pull/1296))
* **resolver:** parameter-flow tracking in points-to analysis (Phase 8.3c) — function parameters tracked through the call graph; typed parameters seed the receiver typeMap for downstream method resolution ([#1294](https://github.com/optave/ops-codegraph-tool/pull/1294), [#1308](https://github.com/optave/ops-codegraph-tool/pull/1308))
* **resolver:** object property write tracking in points-to analysis (Phase 8.3d) — `obj.handler = fn` assignments tracked so `obj.handler()` resolves to the assigned function ([#1295](https://github.com/optave/ops-codegraph-tool/pull/1295))
* **resolver:** constructor-assigned property types for receiver-typed resolution (JS/TS) — `this.svc = new Service()` in constructors seeds the typeMap so `this.svc.call()` resolves to `Service.call` ([#1314](https://github.com/optave/ops-codegraph-tool/pull/1314))
* **resolver:** object destructuring rest parameter resolution (Phase 8.3f) — `const { a, ...rest } = obj; rest.method()` now resolves `method` via the rest binding's source type; WASM + native parity ([#1355](https://github.com/optave/ops-codegraph-tool/pull/1355))
* **resolver:** barrel re-export chain resolution — imports via `components/index.ts` barrel files now trace to the actual declaration file rather than mapping to the barrel; both WASM `buildImportedNamesMap` and `buildBarrelEdges` updated (Phase 8.4) ([#1298](https://github.com/optave/ops-codegraph-tool/pull/1298), [#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
* **resolver:** CHA + RTA enhanced dynamic dispatch (Phase 8.5) — interface method calls emit edges to all instantiated concrete implementations; `new X()` calls tracked for RTA filtering; `this.method()` resolved through the class's own method table and parent hierarchy ([#1302](https://github.com/optave/ops-codegraph-tool/pull/1302))
* **resolver:** prototype-based method calls, func-prop this-dispatch, and spread/iteration callback resolution — `Dog.prototype.bark = function()` definitions extracted; `fn.method = function(){ this.other() }` this-dispatch wired; object-rest param dispatch ([#1331](https://github.com/optave/ops-codegraph-tool/pull/1331))
* **resolver:** `Object.defineProperty` accessor this-dispatch — `this.method()` calls inside `defineProperty` getter/setter callbacks resolve through the enclosing class ([#1346](https://github.com/optave/ops-codegraph-tool/pull/1346), [#1351](https://github.com/optave/ops-codegraph-tool/pull/1351))
* **resolver:** calls through `Object.defineProperty` / `defineProperties` / `Object.create` — accessor definitions emit call edges to the object's own prototype chain ([#1328](https://github.com/optave/ops-codegraph-tool/pull/1328))
* **resolver:** generator functions extracted as definitions (JS/TS) — `function* gen()` and `async function* gen()` now emit definition nodes so callers that iterate them appear in the call graph ([#1333](https://github.com/optave/ops-codegraph-tool/pull/1333))
* **resolver:** `super.method()` dispatch via class expression, static block, and field def — `super.f()` in class bodies, `class Foo extends Bar { static { super.f() } }`, and field-level assignments now resolve to the parent class method ([#1399](https://github.com/optave/ops-codegraph-tool/pull/1399))
* **resolver:** `.call()/.apply()` this-rebinding — `fn.call(obj, ...)` and `fn.apply(obj, [...])` patterns now resolve the call to `fn` with `obj`'s type as receiver ([#1405](https://github.com/optave/ops-codegraph-tool/pull/1405))
* **resolver:** `Function.bind/call/apply` receiver-typed resolution — `bound = fn.bind(obj)` seeds the typeMap so `bound()` resolves as a method call on `obj`'s type ([#1330](https://github.com/optave/ops-codegraph-tool/pull/1330))
* **resolver:** `for-of`, `Set`, and `Array.from` iteration-callback edges — `for (const x of items) x.method()` and `new Set([...]).forEach(item => item.method())` patterns emit call edges ([#1397](https://github.com/optave/ops-codegraph-tool/pull/1397))
* **resolver:** inline-array spread call edges — `fn(...[a, b, c])` unwraps the spread array and emits call edges to each element's method ([#1394](https://github.com/optave/ops-codegraph-tool/pull/1394))
* **extractor:** inline-new expression recognized as receiver type in `extractReceiverName` — `(new Dog()).bark()` directly infers `Dog` as the receiver type without a prior assignment ([#1415](https://github.com/optave/ops-codegraph-tool/pull/1415))
* **resolver:** this.prop typeMap key scoped to enclosing class — prevents false edges in multi-class files where two classes define a property of the same name ([#1382](https://github.com/optave/ops-codegraph-tool/pull/1382))
* **parity:** C# same-class bare static calls resolved + confidence filter for static receiver fallback — `MyClass.StaticMethod()` from within the same class now resolves; heuristic static-receiver fallback gated on confidence ≥ 0.75 to reduce false positives ([#1417](https://github.com/optave/ops-codegraph-tool/pull/1417), [#1427](https://github.com/optave/ops-codegraph-tool/pull/1427))
* **parity:** C# `var`-typed local types inferred from `new`-expression initializers — `var svc = new MyService()` now seeds the typeMap with `MyService` for downstream method-call resolution ([#1424](https://github.com/optave/ops-codegraph-tool/pull/1424))
* **parity:** C# static receiver calls in WASM engine — static method resolution aligned with the native engine for same-class and qualified receiver patterns ([#1395](https://github.com/optave/ops-codegraph-tool/pull/1395))
* **native:** extract parameters for prototype method definitions — `Dog.prototype.bark = function(name) {}` now emits `name` as a parameter node in the native engine ([#1345](https://github.com/optave/ops-codegraph-tool/pull/1345))
* **native:** complexity/CFG computed for prototype method definitions — Rust engine now calculates cyclomatic complexity and control-flow graph for prototype-assigned functions ([#1347](https://github.com/optave/ops-codegraph-tool/pull/1347))
* **native:** persist this/super dispatch via hybrid WASM post-pass — when native engine cannot persist this/super typeMap entries inline, a WASM supplementary pass writes them to the DB ([#1337](https://github.com/optave/ops-codegraph-tool/pull/1337))
* **native:** return-type and call-assignment extraction in Rust engine — `returnTypeMap` and `callAssignments` now extracted by the Rust extractor, closing the parity gap with WASM for inter-procedural type propagation ([#1283](https://github.com/optave/ops-codegraph-tool/pull/1283))
* **native:** prefer local dev binary over npm package in load order — `CODEGRAPH_NATIVE_PATH` env var and local `codegraph-core.node` are now checked before falling back to the npm optional package ([#1389](https://github.com/optave/ops-codegraph-tool/pull/1389))
* **incremental:** seed callee::restName typeMap keys and pass callerName in buildCallEdges — aligns incremental call resolver with the full-build authoritative path for Phase 8.3f rest-param dispatch ([#1404](https://github.com/optave/ops-codegraph-tool/pull/1404))
* **incremental:** port same-class this.method() and defineProperty fallbacks into buildCallEdges — incremental rebuilds now match full-build resolution for `this.`-dispatch and `Object.defineProperty` accessor patterns ([#1401](https://github.com/optave/ops-codegraph-tool/pull/1401))
* **resolver:** qualified callerName mismatch in class-scoped typeMap lookup — `ClassName.method` keys now match consistently across full and incremental build paths ([#1403](https://github.com/optave/ops-codegraph-tool/pull/1403))
* **resolver:** callerName parity + func-prop cross-file edges + O(n) Phase 8.3f algorithm — fixes qualified callerName dispatch on native path and makes rest-param post-pass linear-time ([#1383](https://github.com/optave/ops-codegraph-tool/pull/1383))
* **resolver:** Phase 8.3f typeMap key scoped by callee to avoid same-name rest-param collision — two different rest parameters in the same file with the same property name no longer share the same typeMap key ([#1368](https://github.com/optave/ops-codegraph-tool/pull/1368))
* **edge_builder:** same-file this-dispatch fallback restricted to caller's own class — prevents false `this.method()` edges being emitted to methods of other classes defined in the same file ([#1343](https://github.com/optave/ops-codegraph-tool/pull/1343))
* **wasm-worker:** wire paramBindings, returnTypeMap, callAssignments through worker boundary — new `SerializedExtractorOutput` fields propagate through the WASM worker thread protocol so type-propagation data isn't silently dropped ([#1352](https://github.com/optave/ops-codegraph-tool/pull/1352))
* **extractor:** narrow `.call/.apply/.bind` skip in `extractCallbackReferenceCalls` — only skip the bound function itself, not call-sites inside its body ([#1420](https://github.com/optave/ops-codegraph-tool/pull/1420))

### Refactors

* **extractor:** align `typeMapWalk` currentClass reset with `returnTypeMapWalk` — removes a latent divergence between the two AST walkers that could cause stale class context in multi-class files ([#1408](https://github.com/optave/ops-codegraph-tool/pull/1408))

### Chores

* **deps-dev:** bump vitest from 4.1.7 to 4.1.8 ([#1367](https://github.com/optave/ops-codegraph-tool/pull/1367), [#1366](https://github.com/optave/ops-codegraph-tool/pull/1366))
* **deps-dev:** bump tree-sitter-erlang from 0.0.0 to 0.19 ([#1365](https://github.com/optave/ops-codegraph-tool/pull/1365))
* **deps-dev:** bump tree-sitter-gleam ([#1364](https://github.com/optave/ops-codegraph-tool/pull/1364))
* **deps:** bump anthropics/claude-code-action from 0.0.63 to 1.0.139 ([#1363](https://github.com/optave/ops-codegraph-tool/pull/1363))

## [3.11.2](https://github.com/optave/ops-codegraph-tool/compare/v3.11.1...v3.11.2) (2026-06-01)

**Watch mode correctness sweep.** Five independent bugs in the incremental rebuild path are fixed: the call resolver had drifted from the full-build authoritative version, causing inflated `calls` edges on any watch rebuild touching a widely-imported file; a missing dedup set let the same `(caller, target)` pair be inserted multiple times; `receiver`, `extends`, `implements`, and `dynamic-import` edges were silently absent from watch-mode rebuilds; top-level Ruby constants and program-level Python assignments were dropped by the native extractor while WASM captured them; and 10 native grammar crate versions had drifted from their WASM npm counterparts. A new shared `call-resolver.ts` module now backs both the full-build and incremental paths, closing the structural gap that let these bugs accumulate.

### Bug Fixes

* **watch:** align incremental call resolver with full build — the watcher's `resolveCallTargets`/`buildCallEdges` had drifted from the authoritative full-build resolver in `build-edges.ts`; on a comment-only rebuild of a widely-imported file, `calls` edges inflated by ~700 ([#1261](https://github.com/optave/ops-codegraph-tool/pull/1261))
* **watcher:** eliminate calls-edge inflation in incremental cascade — adds the missing `seenCallEdges` dedup set to `buildCallEdges` in the incremental path, and tightens the global name fallback in `resolveCallTargets` to match the full-build resolver ([#1264](https://github.com/optave/ops-codegraph-tool/pull/1264))
* **extract:** eliminate WASM/native node divergence — native Ruby extractor now handles top-level `assignment` nodes (program-level constants); native Python extractor extracts program-level function and class definitions that were previously dropped; eliminates the persistent full-build node count gap between engines ([#1266](https://github.com/optave/ops-codegraph-tool/pull/1266))
* **watcher:** add missing receiver/extends/implements/dynamic-import edges — `receiver` edges (method call receiver resolution), `extends`/`implements` class hierarchy edges, and `dynamic-import` edges were silently absent from watch-mode incremental rebuilds; now parity-aligned with the full build ([#1267](https://github.com/optave/ops-codegraph-tool/pull/1267))
* **engine:** align native grammar crate versions with WASM npm packages — upgrades 10 Rust tree-sitter grammar crates in `Cargo.toml` to match the npm devDependency versions, eliminating grammar-version drift identified as the structural source of native/WASM call-edge divergence ([#1268](https://github.com/optave/ops-codegraph-tool/pull/1268))

### Refactors

* **engine:** extract shared call-resolver, eliminate build/watch duplication — `findCaller`, `resolveByMethodOrGlobal`, `resolveCallTargets`, and `resolveReceiverEdge` extracted into `src/domain/graph/builder/call-resolver.ts`; both the full-build and incremental paths share a single implementation via a `CallNodeLookup` interface ([#1272](https://github.com/optave/ops-codegraph-tool/pull/1272))

### Chores

* **ci:** add grammar version parity check between npm devDeps and Cargo.toml — new `scripts/check-grammar-versions.mjs` compares grammar major versions across both package managers; wired as a lightweight CI job to catch future drift early ([#1270](https://github.com/optave/ops-codegraph-tool/pull/1270))
* **deps:** bump commander from 14.0.3 to 15.0.0 ([#1251](https://github.com/optave/ops-codegraph-tool/pull/1251)), tree-sitter-erlang to 0.18 ([#1252](https://github.com/optave/ops-codegraph-tool/pull/1252)), @biomejs/biome to 2.4.16 ([#1250](https://github.com/optave/ops-codegraph-tool/pull/1250)), @commitlint to 21.0.2 ([#1253](https://github.com/optave/ops-codegraph-tool/pull/1253), [#1254](https://github.com/optave/ops-codegraph-tool/pull/1254))

## [3.11.1](https://github.com/optave/ops-codegraph-tool/compare/v3.11.0...v3.11.1) (2026-05-29)

**Four new embedding models, sticky model resolution, and a large internal refactor.** `codegraph embed` adds `mxbai-large`, `mxbai-xsmall`, `bge-m3`, and `modernbert` to the model registry — all publicly accessible without an HF token, covering multilingual, high-quality large, tiny-with-long-context, and ModernBERT-architecture use cases. Sticky model resolution ensures that subsequent `codegraph embed` runs on an existing graph reuse the model it was originally built with rather than the global default; the default for fresh graphs shifts from `nomic-v1.5` to `nomic` (same dimensions and context window, but the public Xenova mirror instead of the occasionally-gated nomic-ai org). Watch mode delta reporting is corrected — the rebuild log now shows the net edge change instead of an inflated gross re-insertion count. Under the hood, a 10-PR refactor (Titan Grind) decomposed the largest modules — `ast-analysis`, `domain`, `graph`, `presentation`, `extractors`, and `core-rs` — into focused, independently-testable units with no user-visible behavioral changes.

### Features

* **embed:** add `mxbai-large`, `mxbai-xsmall`, `bge-m3`, and `modernbert` embedding models — all Apache-2.0/MIT licensed, no `HF_TOKEN` required; `bge-m3` is multilingual (100+ languages, 8192 ctx), `mxbai-large` tops the MTEB BERT-large leaderboard, `mxbai-xsmall` is tiny with 4096-token context, `modernbert` uses the ModernBERT architecture ([#1229](https://github.com/optave/ops-codegraph-tool/pull/1229))
* **embed:** sticky model resolution — `codegraph embed` on an existing graph now reuses the model stored in `embedding_meta` rather than falling back to the global default; the default for fresh graphs changes from `nomic-v1.5` to `nomic` (same dim/context, public Xenova mirror avoids occasional HF gating) ([#1228](https://github.com/optave/ops-codegraph-tool/pull/1228))

### Bug Fixes

* **watch:** report net edge delta in rebuild log — previously the count was inflated by re-inserted edges that cancel out; now shows only the true net change ([#1245](https://github.com/optave/ops-codegraph-tool/pull/1245), [#1220](https://github.com/optave/ops-codegraph-tool/pull/1220))

### Refactors

* **ast-analysis:** decompose engine and visitors, break visitor-utils cycle ([#1231](https://github.com/optave/ops-codegraph-tool/pull/1231))
* **extractors:** shared helpers across language extractors (TS+Rust); adopt shared child-iteration helpers ([#1230](https://github.com/optave/ops-codegraph-tool/pull/1230), [#1238](https://github.com/optave/ops-codegraph-tool/pull/1238))
* **core-rs:** decompose pipeline, read_queries, edge_builders; collapse walker recursion ([#1232](https://github.com/optave/ops-codegraph-tool/pull/1232))
* **graph:** decompose Leiden optimiser and roles classifier ([#1233](https://github.com/optave/ops-codegraph-tool/pull/1233))
* **presentation:** extract shared rendering helpers in cfg and flow ([#1234](https://github.com/optave/ops-codegraph-tool/pull/1234))
* **domain:** decompose parser, analysis, and search modules ([#1236](https://github.com/optave/ops-codegraph-tool/pull/1236))
* **features:** decompose complexity/structure/owners; reduce cfg/cochange/feature-warnings complexity ([#1237](https://github.com/optave/ops-codegraph-tool/pull/1237))
* **parity:** render orchestrator-drop summary as a per-extension table ([#1225](https://github.com/optave/ops-codegraph-tool/pull/1225), [#1240](https://github.com/optave/ops-codegraph-tool/pull/1240))

## [3.11.0](https://github.com/optave/ops-codegraph-tool/compare/v3.10.0...v3.11.0) (2026-05-25)

**Native engine reaches feature parity with WASM, plus an engine-parity sweep across 14 languages.** The final 11 extractors (Clojure, CUDA, Julia, Solidity, Erlang, R, Groovy, Gleam, Objective-C, F#, Verilog) are now ported to Rust, so every supported language extracts symbols natively when the prebuilt binary is available — no more silent fallback to WASM for these. In parallel, a multi-PR parity sweep aligned the `contains`/parameter/inheritance edges that the two engines disagreed on across Java/Kotlin/CUDA/Ruby/Objective-C/HCL/Dart/Scala/Elixir/Haskell/Python/C#/Groovy/C++, so the native engine no longer drops parameters, function-pointer fields, default-value arguments, or interface inheritance edges that WASM was already emitting. F# `.fsi` signature files now route through a dedicated grammar instead of being parsed as `.fs` source. On the CLI, `-n` is now the short form of `--limit` on every limit-accepting command (previously only on five), `build` accepts `-d/--db`, and MCP `semantic_search` accepts `file_pattern` to scope hybrid/semantic/keyword searches to a subtree. Watch mode no longer crashes on rebuild when embeddings exist for the file, and barrel-chain re-parse discovery iterates until stable so chained re-exports stop dropping edges.

### Features

* **cli:** unify `-n` short flag across all `--limit`-accepting commands — `roles`, `structure`, `communities`, `audit`, `check`, `children`, `diff-impact`, `ast`, `brief`, `cfg`, `context`, `dataflow`, `deps`, `exports`, `flow`, `fn-impact`, `impact`, `implementations`, `interfaces`, `query`, `sequence`, and `where` now all accept `-n` in addition to `--limit` ([#1184](https://github.com/optave/ops-codegraph-tool/pull/1184))
* **cli:** accept `-d/--db` on `build` to match every other DB-scoped command — pre-built graphs can now be re-targeted at build time without `cd`-ing into the project root ([#1183](https://github.com/optave/ops-codegraph-tool/pull/1183))
* **mcp:** forward `file_pattern` (string or string[]) in `semantic_search` to scope hybrid/semantic/keyword results — closes a silent-drop where MCP callers passing `file_pattern` got unscoped global hits back with no error ([#1149](https://github.com/optave/ops-codegraph-tool/pull/1149))
* **fsharp:** route `.fsi` files through a dedicated signature grammar — new `fsharp-signature` language id with a `val foo : type` handler that distinguishes signature declarations from `let foo = ...` source bindings ([#1162](https://github.com/optave/ops-codegraph-tool/pull/1162))

### Performance

* **native:** port Clojure extractor to Rust ([#1097](https://github.com/optave/ops-codegraph-tool/pull/1097))
* **native:** port CUDA extractor to Rust ([#1099](https://github.com/optave/ops-codegraph-tool/pull/1099))
* **native:** port Julia extractor to Rust ([#1098](https://github.com/optave/ops-codegraph-tool/pull/1098))
* **native:** port Solidity extractor to Rust ([#1100](https://github.com/optave/ops-codegraph-tool/pull/1100))
* **native:** port Erlang extractor to Rust ([#1103](https://github.com/optave/ops-codegraph-tool/pull/1103))
* **native:** port R extractor to Rust ([#1102](https://github.com/optave/ops-codegraph-tool/pull/1102))
* **native:** port Groovy extractor to Rust ([#1101](https://github.com/optave/ops-codegraph-tool/pull/1101))
* **native:** port Gleam extractor to Rust ([#1105](https://github.com/optave/ops-codegraph-tool/pull/1105))
* **native:** port Objective-C extractor to Rust ([#1106](https://github.com/optave/ops-codegraph-tool/pull/1106))
* **native:** port F# extractor to Rust ([#1104](https://github.com/optave/ops-codegraph-tool/pull/1104))
* **native:** port Verilog extractor to Rust ([#1107](https://github.com/optave/ops-codegraph-tool/pull/1107))
* **native:** skip backfill on incrementals when orchestrator preserved files — avoids redundant WASM-side backfill work on clean incremental rebuilds ([#1082](https://github.com/optave/ops-codegraph-tool/pull/1082))
* **native:** skip backfill on clean incrementals + bench guard tuning — removes the residual cost when nothing actually changed ([#1085](https://github.com/optave/ops-codegraph-tool/pull/1085))
* **bench:** exclude resolution-benchmark fixtures from dogfooding and incremental-benchmark sweeps so per-file timings reflect real source code, not pinned-precision fixture corpora ([#1131](https://github.com/optave/ops-codegraph-tool/pull/1131), [#1134](https://github.com/optave/ops-codegraph-tool/pull/1134))

### Bug Fixes

* **extractors:** drill through `function_declarator` for parameter names — restores parameter extraction for C-family pointer-to-function declarations across all engines ([#1213](https://github.com/optave/ops-codegraph-tool/pull/1213))
* **extractors:** recursively walk Haskell pattern parameters so destructured arguments emit edges ([#1203](https://github.com/optave/ops-codegraph-tool/pull/1203))
* **extractors/cuda:** keep function-pointer class fields that were previously dropped at parity-align time ([#1207](https://github.com/optave/ops-codegraph-tool/pull/1207))
* **native/kotlin:** strip `navigation_suffix` wrapper from call name so qualified calls resolve to the correct callee instead of the suffix node ([#1205](https://github.com/optave/ops-codegraph-tool/pull/1205))
* **extractors/elixir:** extract default-value and pattern-match parameters that were silently dropped on multi-clause functions ([#1202](https://github.com/optave/ops-codegraph-tool/pull/1202))
* **extractors:** align Ruby/Objective-C `contains` parity across engines ([#1201](https://github.com/optave/ops-codegraph-tool/pull/1201))
* **extractors:** align Java/Kotlin/CUDA `contains` parity across engines ([#1199](https://github.com/optave/ops-codegraph-tool/pull/1199))
* **extractors:** align HCL/Dart/Scala `contains` parity across engines ([#1196](https://github.com/optave/ops-codegraph-tool/pull/1196))
* **extractors:** align Elixir/Haskell/Python `contains` parity across engines ([#1195](https://github.com/optave/ops-codegraph-tool/pull/1195))
* **native/csharp:** align extractor with WASM on three engine-parity divergences ([#1194](https://github.com/optave/ops-codegraph-tool/pull/1194))
* **db:** stop `findDbPath` walk at cwd when there is no git ceiling, so `codegraph` invoked outside a repo no longer climbs to the filesystem root ([#1193](https://github.com/optave/ops-codegraph-tool/pull/1193))
* **native/cpp:** strip reference modifier from parameter names so `T& foo` extracts `foo`, not `& foo` ([#1192](https://github.com/optave/ops-codegraph-tool/pull/1192))
* **native:** apply WASM callback-callee gating in JS extractor so `member_expression` callback args no longer create false-positive edges ([#1191](https://github.com/optave/ops-codegraph-tool/pull/1191))
* **watch:** purge embeddings before nodes to stop FK crash in `rebuildFile` — incremental rebuilds on watched files with embeddings no longer crash with a foreign-key constraint violation ([#1182](https://github.com/optave/ops-codegraph-tool/pull/1182))
* **builder:** iterate barrel re-parse discovery to stop dropping chained-barrel edges — the WASM builder now loops until the dirty-barrel set is stable, so `a → b → c → d` chained re-exports no longer leave edges on the floor ([#1179](https://github.com/optave/ops-codegraph-tool/pull/1179))
* **embed:** install `@huggingface/transformers` into codegraph's host node_modules — `codegraph embed` no longer fails when invoked from a project that hasn't installed transformers itself ([#1178](https://github.com/optave/ops-codegraph-tool/pull/1178))
* **hooks:** use POSIX `[[:space:]]` in `guard-git.sh` grep patterns so the hook works under BSD grep on macOS ([#1170](https://github.com/optave/ops-codegraph-tool/pull/1170))
* **hooks:** `guard-git.sh` sed patterns work on macOS BSD sed — closes a silent no-op where the hook ran but matched nothing under BSD ([#1146](https://github.com/optave/ops-codegraph-tool/pull/1146))
* **groovy:** emit `ClassRelation` for interface inheritance in both engines so `implements` edges no longer go missing on Groovy classes ([#1158](https://github.com/optave/ops-codegraph-tool/pull/1158))
* **builder:** remove duplicate early-return in `backfillNativeDroppedFiles` ([#1148](https://github.com/optave/ops-codegraph-tool/pull/1148))
* **julia:** port parameterized-type / qualified-def / qualified-import fixes to WASM so Julia parity matches between engines ([#1128](https://github.com/optave/ops-codegraph-tool/pull/1128))
* **gleam:** extract parameters for external functions so cross-module Gleam calls resolve ([#1127](https://github.com/optave/ops-codegraph-tool/pull/1127))
* **native:** purge stale rows when WASM-only files are deleted ([#1122](https://github.com/optave/ops-codegraph-tool/pull/1122))
* **native:** backfill new dropped-language files on quiet incrementals so newly-added Solidity/Erlang/Verilog files appear on the next rebuild even when the file system signal looks quiet ([#1123](https://github.com/optave/ops-codegraph-tool/pull/1123))
* **r:** `setMethod` emits a call edge, not a duplicate definition ([#1125](https://github.com/optave/ops-codegraph-tool/pull/1125))
* **groovy:** dispatch `juxt_function_call` in both engines so Groovy DSL-style calls (`task { ... }`) emit edges ([#1124](https://github.com/optave/ops-codegraph-tool/pull/1124))
* **bench:** warmup + median for `queryTimeMs` to remove cold-start noise from the publish gate ([#1133](https://github.com/optave/ops-codegraph-tool/pull/1133))
* **scripts:** trend annotations fall back to nearest non-null prior release so a missing run no longer breaks the trend chart ([#1120](https://github.com/optave/ops-codegraph-tool/pull/1120))
* **scripts:** preserve manual NOTES block in incremental report generator ([#1119](https://github.com/optave/ops-codegraph-tool/pull/1119))

### Refactors

* **objc:** use `if let Some` in for-loop instead of `?` to fail-soft on extractor errors ([#1156](https://github.com/optave/ops-codegraph-tool/pull/1156))
* **verilog:** use `if let Some` in for-loops instead of `?` ([#1155](https://github.com/optave/ops-codegraph-tool/pull/1155))
* **ci:** let tracer-validation gate reuse benchmark artifact ([#1171](https://github.com/optave/ops-codegraph-tool/pull/1171))
* **ci:** let resolution gate reuse benchmark artifact ([#1167](https://github.com/optave/ops-codegraph-tool/pull/1167))

### CI

* run pre-publish benchmark gate on every PR — regressions surface at PR time instead of at publish ([#1072](https://github.com/optave/ops-codegraph-tool/pull/1072))
* isolate `dropped-language-gap.test.ts` as a regression canary so the engine-parity gap test no longer hides under broader suites ([#1169](https://github.com/optave/ops-codegraph-tool/pull/1169))
* force rustup proxy on PATH for macos-14 x86_64 builds so the prebuilt binary keeps building on the deprecated runner ([#1151](https://github.com/optave/ops-codegraph-tool/pull/1151))
* **test:** use `--experimental-strip-types` in Worker `execArgv` so vitest stays green on Node 24+ ([#1164](https://github.com/optave/ops-codegraph-tool/pull/1164))
* **test/julia:** cover macro signature guard branch ([#1150](https://github.com/optave/ops-codegraph-tool/pull/1150))
* **test/parsers:** gate `LANGUAGE_REGISTRY ↔ NATIVE_SUPPORTED_EXTENSIONS` parity to catch silent drift between the two registries ([#1154](https://github.com/optave/ops-codegraph-tool/pull/1154))

### Build

* derive libc verifier scope from `optionalDependencies` so the verifier no longer hard-codes the platform list ([#1172](https://github.com/optave/ops-codegraph-tool/pull/1172))
* restore libc discriminator on linux lockfile entries — re-adds `libc: ["glibc"]` / `libc: ["musl"]` that npm v11 had silently stripped ([#1163](https://github.com/optave/ops-codegraph-tool/pull/1163))

### Docs

* dogfood report for v3.10.1-dev.80 ([#1180](https://github.com/optave/ops-codegraph-tool/pull/1180))
* backfill jina-base Hit@k for v3.10.1-dev.80 ([#1186](https://github.com/optave/ops-codegraph-tool/pull/1186))

### Chores

* **deps:** bump web-tree-sitter from 0.26.8 to 0.26.9 ([#1210](https://github.com/optave/ops-codegraph-tool/pull/1210))
* **deps:** bump better-sqlite3 from 12.9.0 to 12.10.0 ([#1141](https://github.com/optave/ops-codegraph-tool/pull/1141))
* **deps-dev:** bump tree-sitter-cli from 0.26.8 to 0.26.9 ([#1212](https://github.com/optave/ops-codegraph-tool/pull/1212))
* **deps-dev:** bump tree-sitter-erlang from 0.0.0 to 0.17 ([#1138](https://github.com/optave/ops-codegraph-tool/pull/1138))
* **deps-dev:** bump tree-sitter-gleam from `1627dc5` to `4e4643c` ([#1089](https://github.com/optave/ops-codegraph-tool/pull/1089))
* **deps-dev:** bump @vitest/coverage-v8 from 4.1.5 to 4.1.7 ([#1211](https://github.com/optave/ops-codegraph-tool/pull/1211))
* **deps-dev:** bump vitest from 4.1.6 to 4.1.7 ([#1208](https://github.com/optave/ops-codegraph-tool/pull/1208))
* **deps-dev:** bump vitest from 4.1.5 to 4.1.6 ([#1139](https://github.com/optave/ops-codegraph-tool/pull/1139))
* **deps-dev:** bump vitest from 4.1.4 to 4.1.5 ([#1087](https://github.com/optave/ops-codegraph-tool/pull/1087))
* **deps-dev:** bump commit-and-tag-version from 12.7.1 to 12.7.3 ([#1209](https://github.com/optave/ops-codegraph-tool/pull/1209))
* **deps-dev:** bump @commitlint/cli from 21.0.0 to 21.0.1 ([#1142](https://github.com/optave/ops-codegraph-tool/pull/1142))
* **deps-dev:** bump @commitlint/cli from 20.5.3 to 21.0.0 ([#1086](https://github.com/optave/ops-codegraph-tool/pull/1086))
* **deps-dev:** bump @commitlint/config-conventional ([#1088](https://github.com/optave/ops-codegraph-tool/pull/1088), [#1140](https://github.com/optave/ops-codegraph-tool/pull/1140))
* **deps-dev:** bump @biomejs/biome from 2.4.13 to 2.4.15 ([#1090](https://github.com/optave/ops-codegraph-tool/pull/1090))

## [3.10.0](https://github.com/optave/ops-codegraph-tool/compare/v3.9.6...v3.10.0) (2026-05-01)

**Selective MCP tool filtering, WASM build-speed regression fix, and Haskell parity restoration.** A new `mcp.disabledTools` config field lets you remove specific MCP tools from the schema entirely — useful for smaller-context models that don't need all 33 tools competing for the initial prompt budget. The 3.9.6 expansion of `AST_TYPE_MAPS` to 23 languages had a side effect of making WASM full builds re-parse every WASM-parseable file in the corpus; the per-file `needsFn` filter now scopes the re-parse correctly, dropping the 744-file dogfooding build from 14.0s back to 7.8s (matching the 3.9.5 baseline). A second parity fix gates `astTypeMap` lookups with `Object.hasOwn` so Haskell's `constructor` node type no longer walks the prototype chain to `Object.prototype.constructor` — restoring the Haskell resolver from 0%/0% precision/recall in 3.9.6 to 100%/33% (matching the 3.9.4 baseline). The release benchmark workflow has also been restructured: regression guards now run inside `publish.yml` *before* npm publishes, instead of after the docs PR lands, so a regression can no longer ship to npm and then fire on unrelated dev commits.

### Features

* **mcp:** add `mcp.disabledTools` config to remove specific tools from the MCP schema — drops disabled tools entirely from the schema (not just rejected at runtime) so smaller-context models save initial-prompt tokens; tool names are normalized for matching ([#1035](https://github.com/optave/ops-codegraph-tool/pull/1035))

### Bug Fixes

* **parity:** gate `astTypeMap` lookup with `Object.hasOwn` — Haskell `constructor` nodes (`Left`, `Right`, `Just`, …) no longer fall through to `Object.prototype.constructor`, which was dropping the non-cloneable `Object()` function into `astNodes.kind` and crashing the worker boundary with `function Object() { [native code] } could not be cloned`; Haskell resolver returns to v3.9.4 baseline (precision=1.0, recall=0.333) ([#1041](https://github.com/optave/ops-codegraph-tool/pull/1041))

### Performance

* **wasm:** scope `ensureWasmTrees` re-parse to files that actually need it — `wasm-worker-entry.ts` now serializes empty `astNodes` arrays (empty ≠ undefined) and `ensureWasmTrees` accepts an optional `needsFn` filter so only files genuinely lacking data are re-parsed; WASM full build on the 744-file dogfooding corpus drops from 14.0s back to 7.8s, restoring the 3.9.5 baseline ([#1038](https://github.com/optave/ops-codegraph-tool/pull/1038))

### CI

* **release:** gate npm publish on benchmark regressions — moves the regression guard into a `pre-publish-benchmark` job in `publish.yml` so a regression fails the publish workflow before npm sees the new version, instead of firing on unrelated dev commits after the post-publish benchmark PR lands ([#1040](https://github.com/optave/ops-codegraph-tool/pull/1040))
* **bench:** rename auto-generated benchmark branch prefix from `benchmark/` to `chore/` — aligns with the local `guard-git.sh` allow-list so post-publish benchmark PRs no longer require hook bypass when pushed from a Claude Code session ([#1044](https://github.com/optave/ops-codegraph-tool/pull/1044))

## [3.9.6](https://github.com/optave/ops-codegraph-tool/compare/v3.9.5...v3.9.6) (2026-04-29)

**Native engine parity and incremental-build performance.** Native single-file incremental rebuilds drop from 876ms to 43ms (95% faster, 0.78× WASM) by adopting the WASM save-and-reconnect strategy so reverse-dep files no longer get re-parsed when they didn't change. Native full-build edge construction now beats WASM (119ms vs 184ms) by replacing per-row `query_row` lookups with one-shot HashMap pre-loads and chunked multi-row inserts. AST-node extraction is now within 0.12% parity between engines after fixing three independent divergences (missing language coverage in WASM, `await_expression` recursion, UTF-8 byte-length gating). The release-triggered benchmark workflow that silently hung at 600s on v3.9.5 is fixed — workers now dispose the WASM parser pool and embedding progress writes to stderr instead of corrupting stdout JSON. A new CI parity gate runs after every release benchmark and fails loudly when any of five engine-parity thresholds regress, so silent drift can no longer ship.

### Bug Fixes

* **parity:** align WASM and native `ast_nodes` extraction — registered 19 missing languages in WASM's `AST_TYPE_MAPS`, removed `await_expression` `skipChildren` quirk, and fixed UTF-8 byte-length gating in native; total AST-node parity now within 0.12% across self-build (was ~7,200 row delta) ([#1016](https://github.com/optave/ops-codegraph-tool/pull/1016))
* **parity:** log per-file reasons for native orchestrator drops — bucket dropped files by `unsupported-by-native` (info) vs `native-extractor-failure` (warn) with sample paths so legitimate parser limits no longer mask real Rust extractor bugs ([#1024](https://github.com/optave/ops-codegraph-tool/pull/1024))
* **bench:** dispose WASM worker pool and keep progress off stdout — release-triggered benchmark workflow no longer hangs at 600s; embedding progress writes to stderr so JSON-consuming workers stop parsing `Unexpected token 'E'` ([#1009](https://github.com/optave/ops-codegraph-tool/pull/1009))

### Performance

* **native:** scope incremental rebuild to truly-changed files — 1-file incremental drops from 876ms to 43ms (95% faster, 0.78× WASM) by saving reverse-dep edges before purge and reconnecting them post-rebuild instead of re-parsing the full reverse-dep cone ([#1027](https://github.com/optave/ops-codegraph-tool/pull/1027))
* **native:** batch-load file/symbol IDs in edges phase — replaces per-import `query_row` lookups with one-shot HashMap pre-loads and chunks import-edge inserts into 199-row `VALUES` batches; full-build `edges` phase now 119ms vs WASM's 184ms (0.65×) ([#1028](https://github.com/optave/ops-codegraph-tool/pull/1028))

### CI

* **bench:** gate release benchmark on engine parity thresholds — five thresholds (file-set gap, DB size ratio, edges/roles ratios, 1-file incremental ratio) fail the release benchmark workflow when engine parity regresses, with a markdown summary linking each breach to its tracking issue ([#1014](https://github.com/optave/ops-codegraph-tool/pull/1014))

### Chores

* **deps-dev:** bump @vitest/coverage-v8 from 4.1.4 to 4.1.5 ([#1021](https://github.com/optave/ops-codegraph-tool/pull/1021))
* **deps-dev:** bump @biomejs/biome from 2.4.11 to 2.4.13 ([#1019](https://github.com/optave/ops-codegraph-tool/pull/1019))
* **deps-dev:** bump @commitlint/cli from 20.5.0 to 20.5.2 ([#1018](https://github.com/optave/ops-codegraph-tool/pull/1018))
* **deps-dev:** bump tree-sitter-erlang from 0.0.0 to 0.16 ([#1017](https://github.com/optave/ops-codegraph-tool/pull/1017))
* **deps-dev:** bump tree-sitter-gleam from `0153f8b` to `1627dc5` ([#1020](https://github.com/optave/ops-codegraph-tool/pull/1020))

## [3.9.5](https://github.com/optave/ops-codegraph-tool/compare/v3.9.4...v3.9.5) (2026-04-23)

**Incremental build correctness and concurrency safety.** This release hardens the incremental build path end-to-end. Duplicate edges that silently accumulated on every incremental rebuild of hybrid barrel files are eliminated — edge counts are now stable across consecutive rebuilds. `config.include` and `config.exclude` globs were declared in `DEFAULTS` but never consumed by either engine; both the Rust and WASM collectors now compile and apply them identically during initial walks and fast-path rebuilds. Concurrent journal appends from watch sessions and manual builds are serialized via lockfile, and watcher writes now advance the header timestamp so the first build after every watch session no longer falls through to an expensive full rescan. `snapshot save --force` and `snapshot restore` use per-pid temp files + atomic rename to close TOCTOU races. WASM parsing is isolated in a worker thread so a V8 fatal error skips one file instead of aborting the whole build, and extractor exceptions are now per-file rather than pipeline-fatal. The `watch` command gains `-d/--db` for consistency with every other DB-scoped command, `--no-incremental` warns before discarding embeddings, and `build:wasm` shows a one-line remediation banner instead of 700 lines of ENOENT noise when `tree-sitter-cli` is missing.

### Features

* **build:** report `collectMs` and `detectMs` as separate phases in `BuildResult.phases` so incremental-build perf investigations can see file-walk and change-detection work separately ([#993](https://github.com/optave/ops-codegraph-tool/pull/993))

### Bug Fixes

* **incremental:** prevent duplicate edges on rebuild — Stage 6b's scoped `DELETE` only purged `imports`/`reexports` before Stage 7 re-emitted 8 edge kinds, leaking ~250 duplicate `calls`/`receiver`/`extends`/`implements`/`imports-type`/`dynamic-imports` edges per incremental rebuild of hybrid barrel files ([#998](https://github.com/optave/ops-codegraph-tool/pull/998))
* **config:** honor `include`/`exclude` globs in file collection — both the native Rust engine and the WASM/JS engine now compile the globs once and filter collected paths identically during initial walks and incremental fast-path rebuilds ([#994](https://github.com/optave/ops-codegraph-tool/pull/994))
* **journal:** serialize concurrent appends via lockfile — prevents interleaved writes from watch sessions + manual builds that corrupted the journal header and caused silent fall-through to hash-scan rebuilds ([#1002](https://github.com/optave/ops-codegraph-tool/pull/1002))
* **journal:** stamp header timestamp on watcher appends — the first build after every watch session no longer falls through to expensive mtime+size + SHA256 rescans ([#1001](https://github.com/optave/ops-codegraph-tool/pull/1001))
* **snapshot:** close TOCTOU race on save/restore/delete — `snapshot save --force` and `snapshot restore` write to per-pid temp files and atomically rename so concurrent saves can no longer produce truncated/interleaved destinations ([#1003](https://github.com/optave/ops-codegraph-tool/pull/1003))
* **wasm:** isolate tree-sitter parsing in worker thread — V8 fatal errors skip a single file with a warn and respawn the worker instead of killing the whole build ([#975](https://github.com/optave/ops-codegraph-tool/pull/975))
* **extractors:** guard empty-text identifiers and isolate extractor crashes — a single misbehaving file no longer kills the whole WASM build ([#972](https://github.com/optave/ops-codegraph-tool/pull/972))
* **extractor:** gate `member_expression` callback args on callee allowlist — restores TS resolution precision from 93.8% back to 100% by eliminating `store.set(user.id, user)` false positives ([#974](https://github.com/optave/ops-codegraph-tool/pull/974))
* **native:** backfill silently-dropped files via WASM for engine parity — closes a native-vs-WASM file-node gap (668 vs 728 on this repo) when the installed native addon lacks an extractor for a language ([#970](https://github.com/optave/ops-codegraph-tool/pull/970))
* **native:** restore `cargo test --lib` green — downgrade tree-sitter-scala/swift to ABI-14-compatible releases and fix `BuildSettings::default` disagreeing with serde field defaults (176 passed / 0 failed) ([#978](https://github.com/optave/ops-codegraph-tool/pull/978))
* **watch:** accept `-d/--db` to point at a graph.db outside cwd — restores consistency with every other DB-scoped command (`build`, `stats`, `query`, `fn-impact`, …) ([#987](https://github.com/optave/ops-codegraph-tool/pull/987))
* **build:** warn before `--no-incremental` wipes embeddings — single-line warning at the shared pipeline entry fires whenever a full rebuild is about to discard non-empty embeddings ([#986](https://github.com/optave/ops-codegraph-tool/pull/986))
* **build:wasm:** add preflight check with clear remediation — missing `tree-sitter-cli` binary now shows one banner with concrete fixes instead of 35 × 20-line ENOENT stack dumps ([#990](https://github.com/optave/ops-codegraph-tool/pull/990))
* **embed:** resolve source files from DB root, not cwd — `codegraph embed --db <abs-path>` no longer silently stores 0 embeddings when run from an unrelated cwd; falls back to the DB's parent for pre-existing DBs ([#992](https://github.com/optave/ops-codegraph-tool/pull/992))
* **config:** reject non-string `apiKeyCommand` with `ConfigError` — the previous silent fallthrough left `apiKey` null with no diagnostic; error message names the received type and shows the expected format ([#991](https://github.com/optave/ops-codegraph-tool/pull/991))
* **louvain:** demote native-path parity warning to debug — the Leiden-specific-options warning was firing unconditionally because `DEFAULTS.community` always populated the guarded fields ([#989](https://github.com/optave/ops-codegraph-tool/pull/989))
* **hooks:** recognize `git -C <path>` in `guard-git.sh` — closes a hook bypass where `git -C <worktree> push` skipped branch-name validation and the destructive-command blocklist ([#1004](https://github.com/optave/ops-codegraph-tool/pull/1004))
* **scripts:** use `--experimental-strip-types` on every Node version — Node 24 removed the `--strip-types` alias, breaking `build:wasm`, `deps:tree`, and `version` scripts on Node 24.10.0 ([#985](https://github.com/optave/ops-codegraph-tool/pull/985))
* **benchmark:** spawn npm via shell on Windows — fixes benchmark suite invocation on Windows ([#973](https://github.com/optave/ops-codegraph-tool/pull/973))
* **publish:** build native addon from source in preflight ([#954](https://github.com/optave/ops-codegraph-tool/pull/954))
* **release:** require user-observable surface for minor bumps in the release skill ([#953](https://github.com/optave/ops-codegraph-tool/pull/953))

### Performance

* **globs:** memoize compiled include/exclude globs per build — long-running processes (watch mode, MCP server) no longer recompile identical pattern lists on every `buildGraph` call; FIFO cache capped at 32 entries in both TS and Rust paths ([#1005](https://github.com/optave/ops-codegraph-tool/pull/1005))
* **native:** scope node loading in call-edge builder for incremental builds — loads only files being processed + their resolved import targets instead of every node in the graph; full builds and very large incrementals (>200 files) unchanged ([#976](https://github.com/optave/ops-codegraph-tool/pull/976))

### Chores

* **deps:** bump better-sqlite3 from 12.8.0 to 12.9.0 ([#962](https://github.com/optave/ops-codegraph-tool/pull/962))
* **deps-dev:** bump tree-sitter-erlang from 0.0.0 to 0.15 ([#961](https://github.com/optave/ops-codegraph-tool/pull/961))
* **deps-dev:** bump tree-sitter-c-sharp from 0.23.1 to 0.23.5 ([#959](https://github.com/optave/ops-codegraph-tool/pull/959))

## [3.9.4](https://github.com/optave/ops-codegraph-tool/compare/v3.9.3...v3.9.4) (2026-04-17)

**Resolution accuracy and incremental-build reliability.** The JS/TS extractor now resolves named function references passed as callback arguments — Express middleware, event handlers, `Array.map`/`.filter`/`.then` callbacks, and destructured handler bindings are tracked as real call edges instead of appearing as dead code. On a 1 895-file TypeScript monorepo this surfaced 21 previously-invisible callers of a single auth middleware. A version-mismatch bug that silently forced every native incremental build into a full 5.8s rebuild is fixed — no-op rebuilds now exit in ~200ms. Three WASM incremental-build bugs are also fixed: edge loss during reverse-dep purges, unnecessary reparses, and a V8 crash during GC of orphaned WASM trees. Fan-in/out and import counts are now consistent between full and incremental build paths.

### Bug Fixes

* **js-extractor:** resolve named function references passed as arguments — middleware, callback, and handler references emit dynamic call edges; destructured bindings from factory calls emit function definitions, eliminating false "dead-unresolved" results for functions passed by reference ([#947](https://github.com/optave/ops-codegraph-tool/pull/947))
* **wasm:** resolve incremental edge loss, unnecessary reparses, and V8 crash — save-and-reconnect approach preserves edges without reparsing reverse-dep files; error-path tree cleanup prevents GC crashes ([#938](https://github.com/optave/ops-codegraph-tool/pull/938))
* **native:** resolve version-mismatch that broke incremental builds — no-op rebuild dropped from 5.8s to 214ms ([#928](https://github.com/optave/ops-codegraph-tool/pull/928), [#930](https://github.com/optave/ops-codegraph-tool/pull/930))
* **structure:** reconcile `import_count` semantics between fast path and full path — both paths now consistently count distinct imported files ([#942](https://github.com/optave/ops-codegraph-tool/pull/942))
* include `imports-type` in fast-path `fan_in`/`fan_out` queries — aligns incremental metrics with full-build behavior for files with type-only imports ([#948](https://github.com/optave/ops-codegraph-tool/pull/948))
* **rust:** fix test compilation errors in extractor tests — renamed `Import.path` → `Import.source` and missing `build_import_edges` arguments ([#950](https://github.com/optave/ops-codegraph-tool/pull/950))
* **ci:** add resilience to Claude Code workflow for fork branch races — concurrency groups and pre-flight branch verification with 3 retries ([#949](https://github.com/optave/ops-codegraph-tool/pull/949))

### Performance

* **native:** port full-build structure computation to Rust — eliminates JS DB round-trip through `reconstructFileSymbolsFromDb()` on full builds ([#937](https://github.com/optave/ops-codegraph-tool/pull/937))
* **native:** defer `NativeDatabase.openReadWrite` until after change detection — saves ~60ms on every incremental build invocation, no-op builds exit before opening native connection ([#939](https://github.com/optave/ops-codegraph-tool/pull/939))
* **native:** raise native edge-building threshold to `smallFilesThreshold` — small incrementals (≤5 files) use JS edge path to avoid napi-rs marshaling overhead ([#940](https://github.com/optave/ops-codegraph-tool/pull/940))

### Chores

* disable adaptive thinking via `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING` env var ([#943](https://github.com/optave/ops-codegraph-tool/pull/943))

## [3.9.3](https://github.com/optave/ops-codegraph-tool/compare/v3.9.2...v3.9.3) (2026-04-12)

**Native engine parity and build performance.** The Rust engine now produces identical role classifications as the JS fallback — reexport chains, type-only imports, and constant classification all match. Build performance improves across the board: the entire analysis pipeline (complexity, CFG, dataflow, AST) now runs inside the Rust orchestrator on a single rusqlite connection, batched WAL checkpoints cut incremental rebuild overhead by 49%, and a full-build regression from v3.9.2 is fixed. A new CI parity job catches engine divergences before they ship. The incremental rebuild guide documents what data requires a full rebuild and adds automatic 24h staleness detection to Claude Code hooks.

### Bug Fixes

* **native:** align Rust role classification with JS — reexport chains, type-only imports, constant classification ([#918](https://github.com/optave/ops-codegraph-tool/pull/918))
* **native:** strip pre-release suffix in semverCompare — dev builds were silently falling back to JS pipeline ([#898](https://github.com/optave/ops-codegraph-tool/pull/898))
* **test:** restore strict parity assertions and add dedicated CI parity job ([#916](https://github.com/optave/ops-codegraph-tool/pull/916))
* **release:** decouple version bumps from release PRs to fix CI failures ([#893](https://github.com/optave/ops-codegraph-tool/pull/893))

### Performance

* **native:** move analysis persistence (AST, complexity, CFG, dataflow) into Rust orchestrator — eliminates JS WASM re-parse ([#907](https://github.com/optave/ops-codegraph-tool/pull/907))
* **native:** use single rusqlite connection for entire build pipeline — 12% faster full builds, 30% faster incremental, 14% smaller DB ([#897](https://github.com/optave/ops-codegraph-tool/pull/897))
* **native:** fix full-build regression from NativeDbProxy overhead ([#906](https://github.com/optave/ops-codegraph-tool/pull/906))
* **incremental:** batch WAL checkpoints and fix native CFG bulk insert — 49% faster incremental rebuilds ([#917](https://github.com/optave/ops-codegraph-tool/pull/917))
* **query:** fix diffImpact latency regression from redundant config loading ([#905](https://github.com/optave/ops-codegraph-tool/pull/905))

### Refactors

* adopt dead helpers across codebase — 28 files, -30 net lines ([#895](https://github.com/optave/ops-codegraph-tool/pull/895))

### Docs

* incremental vs full rebuild guide with automatic 24h staleness check ([#919](https://github.com/optave/ops-codegraph-tool/pull/919))
* update build, query, and incremental benchmarks for 3.9.2 ([#900](https://github.com/optave/ops-codegraph-tool/pull/900), [#901](https://github.com/optave/ops-codegraph-tool/pull/901), [#902](https://github.com/optave/ops-codegraph-tool/pull/902))

### Chores

* **deps:** bump web-tree-sitter from 0.26.7 to 0.26.8 ([#913](https://github.com/optave/ops-codegraph-tool/pull/913))
* **deps:** bump actions/setup-go from 5 to 6, actions/github-script from 8 to 9, actions/setup-python from 5 to 6 ([#910](https://github.com/optave/ops-codegraph-tool/pull/910), [#909](https://github.com/optave/ops-codegraph-tool/pull/909), [#908](https://github.com/optave/ops-codegraph-tool/pull/908))
* **deps-dev:** bump vitest from 4.1.2 to 4.1.4, @vitest/coverage-v8 from 4.1.2 to 4.1.4 ([#915](https://github.com/optave/ops-codegraph-tool/pull/915), [#912](https://github.com/optave/ops-codegraph-tool/pull/912))
* **deps-dev:** bump tree-sitter-cli from 0.26.7 to 0.26.8, @biomejs/biome from 2.4.10 to 2.4.11 ([#911](https://github.com/optave/ops-codegraph-tool/pull/911), [#914](https://github.com/optave/ops-codegraph-tool/pull/914))

## [3.9.2](https://github.com/optave/ops-codegraph-tool/compare/v3.9.1...v3.9.2) (2026-04-06)

**Engine parity fix and build performance improvements.** This patch fixes a native engine deduplication bug that caused divergent results when multiple type map entries existed for the same symbol, improving engine parity. Build performance improves with deferred native database initialization (skipping the native DB entirely on no-op rebuilds) and a fix for an incremental rebuild regression introduced in v3.9.1. The resolution benchmark suite is significantly expanded with dynamic call tracing across all language fixtures, and the release workflow now gates on precision/recall thresholds.

### Bug Fixes

* **native:** confidence-aware dedup in type map for engine parity ([#885](https://github.com/optave/ops-codegraph-tool/pull/885))

### Performance

* defer NativeDatabase init to after no-op early exit ([#884](https://github.com/optave/ops-codegraph-tool/pull/884))
* **native:** fix incremental rebuild regression ([#882](https://github.com/optave/ops-codegraph-tool/pull/882), [#888](https://github.com/optave/ops-codegraph-tool/pull/888))

### Chores

* **ci:** gate release workflow on resolution precision/recall thresholds ([#886](https://github.com/optave/ops-codegraph-tool/pull/886))
* **bench:** resolution benchmark v2 — dynamic tracing, 14 languages, per-mode categories ([#878](https://github.com/optave/ops-codegraph-tool/pull/878))
* **bench:** extend dynamic call tracing to all language fixtures ([#883](https://github.com/optave/ops-codegraph-tool/pull/883))

## [3.9.1](https://github.com/optave/ops-codegraph-tool/compare/v3.9.0...v3.9.1) (2026-04-05)

**Dead code accuracy, native query performance, and supply-chain hardening.** This release significantly improves dead code detection — class instantiations via `new`, type-only imports, barrel re-exports, and same-file constants are now correctly tracked as consumption. The native Rust engine gains a composite `fnDeps` query that runs dependency resolution in a single cross-language call, and a critical 1238% incremental rebuild regression from v3.9.0 is fixed. WASM grammar validation and npm audit harden the build pipeline. CLI reliability improves with a fix for hangs in git worktree environments.

### Bug Fixes

* track class instantiation (`new`) as consumption for dead code detection ([#861](https://github.com/optave/ops-codegraph-tool/pull/861))
* resolve type-only imports for dead code analysis ([#862](https://github.com/optave/ops-codegraph-tool/pull/862))
* trace barrel re-exports in role classification ([#860](https://github.com/optave/ops-codegraph-tool/pull/860))
* recognize same-file constant consumption in dead code detector ([#859](https://github.com/optave/ops-codegraph-tool/pull/859))
* resolve codegraph CLI hangs in git worktrees ([#863](https://github.com/optave/ops-codegraph-tool/pull/863))
* use shared `shouldIgnore`/`isSupportedFile` in watcher ([#864](https://github.com/optave/ops-codegraph-tool/pull/864))
* resolve barrel resolution quality and cycle regression ([#848](https://github.com/optave/ops-codegraph-tool/pull/848))
* show both engines side-by-side in README benchmark table ([#826](https://github.com/optave/ops-codegraph-tool/pull/826))
* release config script validation and broken postbump ([#825](https://github.com/optave/ops-codegraph-tool/pull/825))
* **native:** lower version gate for native orchestrator ([#867](https://github.com/optave/ops-codegraph-tool/pull/867))
* **native:** correct incremental purge, scoped deletion, and barrel resolution ([#865](https://github.com/optave/ops-codegraph-tool/pull/865))
* **ci:** retry npm publish on transient registry errors ([#833](https://github.com/optave/ops-codegraph-tool/pull/833))
* **ci:** upgrade publish job to Node 24 for OIDC trusted publishing ([#850](https://github.com/optave/ops-codegraph-tool/pull/850))
* **ci:** add npm auth debug step and fix publish retry logic ([#835](https://github.com/optave/ops-codegraph-tool/pull/835))
* **perf:** wire engine selection through openRepo to fix query benchmarks ([#869](https://github.com/optave/ops-codegraph-tool/pull/869))
* **bench:** attribute unified walk time to per-phase timers ([#858](https://github.com/optave/ops-codegraph-tool/pull/858))

### Performance

* native Rust fnDeps composite query ([#870](https://github.com/optave/ops-codegraph-tool/pull/870))
* **native:** fix 1238% incremental rebuild regression ([#856](https://github.com/optave/ops-codegraph-tool/pull/856))

### Refactors

* **native:** decompose core Rust algorithms and pipeline ([#845](https://github.com/optave/ops-codegraph-tool/pull/845))
* **native:** extract constants and shared barrel resolution ([#842](https://github.com/optave/ops-codegraph-tool/pull/842))
* **native:** flatten and decompose extractor match arms ([#844](https://github.com/optave/ops-codegraph-tool/pull/844))
* DRY shared abstractions in TS features ([#843](https://github.com/optave/ops-codegraph-tool/pull/843))
* decompose TS complexity and build pipeline ([#846](https://github.com/optave/ops-codegraph-tool/pull/846))
* improve TS code quality across modules ([#847](https://github.com/optave/ops-codegraph-tool/pull/847))

### Chores

* **security:** WASM grammar validation and npm audit CI ([#834](https://github.com/optave/ops-codegraph-tool/pull/834))
* **deps:** bump @modelcontextprotocol/sdk from 1.28.0 to 1.29.0 ([#829](https://github.com/optave/ops-codegraph-tool/pull/829))
* **deps-dev:** bump @huggingface/transformers from 3.8.1 to 4.0.1 ([#831](https://github.com/optave/ops-codegraph-tool/pull/831))
* **deps-dev:** bump @biomejs/biome from 2.4.9 to 2.4.10 ([#828](https://github.com/optave/ops-codegraph-tool/pull/828))
* **deps-dev:** bump tree-sitter-gleam ([#830](https://github.com/optave/ops-codegraph-tool/pull/830))
* **deps-dev:** bump tree-sitter-erlang from 0.0.0 to 0.15 ([#827](https://github.com/optave/ops-codegraph-tool/pull/827))

## [3.9.0](https://github.com/optave/ops-codegraph-tool/compare/v3.8.1...v3.9.0) (2026-04-04)

**Engine parity hardening and cross-database queries.** This release closes the remaining native/WASM divergences — node counts, edge counts, complexity metrics, and import resolution now match across engines. A new `--db` flag on `branch-compare` and `info` lets you point at any `.codegraph/graph.db`, enabling cross-repo comparisons without rebuilding. WASM grammar loading is now lazy during incremental rebuilds, cutting rebuild times for large codebases. Windows users get a fix for `ENOENT` failures during auto-install.

### Features

* **cli:** add `--db` flag to `branch-compare` and `info` commands for cross-database queries ([#820](https://github.com/optave/ops-codegraph-tool/pull/820))
* add resolution precision/recall metrics and version stamp to README benchmarks ([#796](https://github.com/optave/ops-codegraph-tool/pull/796))

### Bug Fixes

* respect `--engine wasm` in pipeline guard ([#819](https://github.com/optave/ops-codegraph-tool/pull/819))
* resolve npm ENOENT on Windows for auto-install ([#818](https://github.com/optave/ops-codegraph-tool/pull/818))
* resolve native/WASM engine divergence in node and edge counts ([#810](https://github.com/optave/ops-codegraph-tool/pull/810))
* **native:** resolve importedNames priority and type map scope collisions ([#811](https://github.com/optave/ops-codegraph-tool/pull/811))
* **native:** resolve import path mismatch and add post-native structure phase ([#807](https://github.com/optave/ops-codegraph-tool/pull/807))
* **native:** extract export name for destructured dynamic imports ([#813](https://github.com/optave/ops-codegraph-tool/pull/813))
* **native:** fix incremental barrel edges, median parity, and analysis data loss ([#806](https://github.com/optave/ops-codegraph-tool/pull/806))
* **parity:** align native vs WASM complexity metrics ([#809](https://github.com/optave/ops-codegraph-tool/pull/809))
* v3.8.1 regression fixes (fnDeps, WASM lazy-load, edge parity, CI guard) ([#815](https://github.com/optave/ops-codegraph-tool/pull/815))
* **ci:** remove npm self-upgrade that breaks publish workflow ([#790](https://github.com/optave/ops-codegraph-tool/pull/790))

### Performance

* lazy-load WASM grammars for incremental rebuilds ([#808](https://github.com/optave/ops-codegraph-tool/pull/808))

## [3.8.1](https://github.com/optave/ops-codegraph-tool/compare/v3.8.0...v3.8.1) (2026-04-03)

**Windows stability, native engine fixes, and large-codebase performance.** This patch hardens the v3.8.0 release with critical Windows fixes (polling watcher to avoid ReFS BSOD, Windows-scoped import-edge handling), several native engine corrections (dataflow parameter indexing, embedding path resolution, build orchestrator sequencing), and performance improvements for large codebases — cycle detection and stats queries are faster, and query-time analysis now routes through the native Rust engine.

### Bug Fixes

* **native:** resolve dataflow null paramIndex and import edge key mismatch ([#788](https://github.com/optave/ops-codegraph-tool/pull/788))
* **native:** keep nativeDb open through finalize for correct build_meta ([#784](https://github.com/optave/ops-codegraph-tool/pull/784))
* **embed:** handle absolute file paths from native engine ([#780](https://github.com/optave/ops-codegraph-tool/pull/780), [#783](https://github.com/optave/ops-codegraph-tool/pull/783))
* default watcher to polling on Windows to avoid ReFS BSOD ([#778](https://github.com/optave/ops-codegraph-tool/pull/778))
* scope native import-edge skip to Windows only ([#777](https://github.com/optave/ops-codegraph-tool/pull/777))
* run analysis phases after native Rust build orchestrator ([#757](https://github.com/optave/ops-codegraph-tool/pull/757))
* skip native build orchestrator for addon ≤3.8.0 and fix path bug ([#758](https://github.com/optave/ops-codegraph-tool/pull/758))
* auto-install @huggingface/transformers in non-TTY environments ([#779](https://github.com/optave/ops-codegraph-tool/pull/779))
* remove duplicate function definitions in leiden optimiser ([#786](https://github.com/optave/ops-codegraph-tool/pull/786))
* replace empty catch blocks with structured error handling ([#764](https://github.com/optave/ops-codegraph-tool/pull/764))
* replace console.log with structured logging in non-CLI-output code ([#765](https://github.com/optave/ops-codegraph-tool/pull/765))
* **ci:** add concurrency group to codegraph-impact workflow ([#785](https://github.com/optave/ops-codegraph-tool/pull/785))
* **bench:** resolve query benchmark CI failure and increase embedding timeout ([#749](https://github.com/optave/ops-codegraph-tool/pull/749))

### Performance

* route query analysis through native Rust engine ([#745](https://github.com/optave/ops-codegraph-tool/pull/745))
* optimize cycles and stats for large codebases ([#781](https://github.com/optave/ops-codegraph-tool/pull/781))
* filter reverse-dep files from native build analysis scope ([#782](https://github.com/optave/ops-codegraph-tool/pull/782))
* forward langId hint to native standalone analysis functions ([#743](https://github.com/optave/ops-codegraph-tool/pull/743))

### Refactors

* decompose ast-analysis visitor framework ([#771](https://github.com/optave/ops-codegraph-tool/pull/771))
* Titan v3.8.0 — decompose god-functions, structured logging, error handling ([#775](https://github.com/optave/ops-codegraph-tool/pull/775))
* extract class declaration handlers in language extractors ([#769](https://github.com/optave/ops-codegraph-tool/pull/769))
* split hybridSearchData into keyword, vector, and merge steps ([#768](https://github.com/optave/ops-codegraph-tool/pull/768))
* decompose makePartition into focused graph operations ([#766](https://github.com/optave/ops-codegraph-tool/pull/766))
* extract rendering sub-functions from inspect and diff-impact-mermaid ([#767](https://github.com/optave/ops-codegraph-tool/pull/767))
* address quality warnings in shared modules ([#770](https://github.com/optave/ops-codegraph-tool/pull/770))

## [3.8.0](https://github.com/optave/ops-codegraph-tool/compare/v3.7.0...v3.8.0) (2026-04-01)

**34 languages and a fully native build pipeline.** This release completes Phase 7 (Expanded Language Support) by shipping the final 11 languages — F#, Gleam, Clojure, Julia, R, Erlang, Solidity, Objective-C, CUDA, Groovy, and Verilog — bringing codegraph from 23 to 34 supported languages. On the performance side, the entire build pipeline now runs natively in Rust: graph algorithms (BFS, shortest path, Louvain, centrality), import edge building with barrel resolution, and build-glue queries all migrate from JS to napi-rs. A new Rust build orchestration layer coordinates the full native pipeline end-to-end.

### Features

* add F#, Gleam, Clojure, Julia, R, Erlang language support ([#722](https://github.com/optave/ops-codegraph-tool/pull/722))
* add Solidity, Objective-C, CUDA, Groovy, Verilog language support ([#729](https://github.com/optave/ops-codegraph-tool/pull/729))
* full Rust build orchestration ([#740](https://github.com/optave/ops-codegraph-tool/pull/740))

### Bug Fixes

* **native:** enable bulkInsertNodes native path ([#736](https://github.com/optave/ops-codegraph-tool/pull/736))
* **native:** enable bulkInsertNodes native path — null-visibility serialisation ([#737](https://github.com/optave/ops-codegraph-tool/pull/737))
* **native:** prevent SQLITE_CORRUPT in incremental pipeline ([#728](https://github.com/optave/ops-codegraph-tool/pull/728))
* **ocaml:** use LANGUAGE_OCAML_INTERFACE grammar for .mli files ([#730](https://github.com/optave/ops-codegraph-tool/pull/730))
* address unresolved review feedback from batch4 language extractors ([#731](https://github.com/optave/ops-codegraph-tool/pull/731))
* **bench:** report partial native results when incremental rebuild fails ([#741](https://github.com/optave/ops-codegraph-tool/pull/741))

### Performance

* migrate graph algorithms (BFS, shortest path, Louvain, centrality) to Rust ([#732](https://github.com/optave/ops-codegraph-tool/pull/732))
* migrate import edge building + barrel resolution to Rust ([#738](https://github.com/optave/ops-codegraph-tool/pull/738))
* **native:** expose standalone complexity/CFG/dataflow analysis via napi-rs ([#733](https://github.com/optave/ops-codegraph-tool/pull/733))
* native Rust build-glue queries (detect-changes, finalize, incremental) ([#735](https://github.com/optave/ops-codegraph-tool/pull/735))

### Refactors

* **native:** remove call kind from AST node extraction ([#734](https://github.com/optave/ops-codegraph-tool/pull/734))

## [3.7.0](https://github.com/optave/ops-codegraph-tool/compare/v3.6.0...v3.7.0) (2026-03-30)

**Six more languages and a CFG stability fix.** Codegraph now supports Elixir, Lua, Dart, Zig, Haskell, and OCaml — bringing the total to 23 languages with dual-engine extractors. A WAL conflict in the native CFG bulk-insert path is also fixed, preventing database corruption when JS and native connections overlap during control-flow graph writes.

### Features

* add Elixir, Lua, Dart, Zig, Haskell, OCaml language support ([#718](https://github.com/optave/ops-codegraph-tool/pull/718))

### Bug Fixes

* **cfg:** avoid dual-connection WAL conflict in native bulkInsertCfg ([#719](https://github.com/optave/ops-codegraph-tool/pull/719))

## [3.6.0](https://github.com/optave/ops-codegraph-tool/compare/v3.5.0...v3.6.0) (2026-03-30)

**Six new languages: Elixir, Lua, Dart, Zig, Haskell, OCaml.** This release adds first-class support for Elixir, Lua, Dart, Zig, Haskell, and OCaml — bringing the total supported languages to 23. Each language ships with dual-engine extractors (WASM TypeScript + native Rust), AST configs, and parser tests. The native Rust engine gains batched query methods for the read path, WAL corruption is fixed when native and JS connections overlap, and WASM call-AST extraction is restored for full engine parity.

### Features

* add C, C++, Kotlin, Swift, Scala, Bash language support ([#708](https://github.com/optave/ops-codegraph-tool/pull/708))

### Bug Fixes

* **parity:** restore call AST node extraction in WASM engine ([#705](https://github.com/optave/ops-codegraph-tool/pull/705))
* **native:** suspend JS connection around native writes to prevent WAL corruption ([#704](https://github.com/optave/ops-codegraph-tool/pull/704))
* native visibility crash and dual-SQLite WAL corruption in benchmarks ([#689](https://github.com/optave/ops-codegraph-tool/pull/689))
* **ci:** resolve visibility null crash and sequence dataflow annotation ([#693](https://github.com/optave/ops-codegraph-tool/pull/693))
* **publish:** update repository URLs for npm provenance ([#682](https://github.com/optave/ops-codegraph-tool/pull/682))

### Performance

* **queries:** batched native Rust query methods for read path ([#698](https://github.com/optave/ops-codegraph-tool/pull/698))

### Refactors

* **extractors:** parser abstraction layer (Phase 7.1) ([#700](https://github.com/optave/ops-codegraph-tool/pull/700))
* **native:** extract generic walk_tree to eliminate walk_node_depth duplication ([#703](https://github.com/optave/ops-codegraph-tool/pull/703))
* remove dead WASM call-AST extraction and pre-3.2 edge shim ([#686](https://github.com/optave/ops-codegraph-tool/pull/686))
* Titan audit — decompose, reduce complexity, remove dead code ([#699](https://github.com/optave/ops-codegraph-tool/pull/699))

## [3.5.0](https://github.com/optave/ops-codegraph-tool/compare/v3.4.1...v3.5.0) (2026-03-29)

**Full rusqlite database migration and sub-100ms incremental rebuilds.** This release completes the migration of all SQLite operations from better-sqlite3 to native Rust/rusqlite via napi-rs, delivering major performance gains across the entire build pipeline. Incremental rebuilds drop from 466ms to 67–80ms, and bulk inserts for nodes, edges, roles, AST nodes, CFG, and dataflow all run through the native engine. better-sqlite3 is now lazy-loaded only as a fallback. Path aliases are restored with TS 6.x-compatible subpath imports, and several WASM/native parity bugs are fixed.

### Features

* **config:** restore path aliases with TS 6.x-compatible subpath imports ([#672](https://github.com/optave/ops-codegraph-tool/pull/672))

### Bug Fixes

* **db:** fold reverse-dep edge deletion into NativeDatabase.purgeFilesData ([#670](https://github.com/optave/ops-codegraph-tool/pull/670), [#679](https://github.com/optave/ops-codegraph-tool/pull/679))
* **wasm:** extract call-site AST nodes in ast-store-visitor ([#678](https://github.com/optave/ops-codegraph-tool/pull/678))
* **parser:** close WASM–native engine parity gap ([#649](https://github.com/optave/ops-codegraph-tool/pull/649), [#657](https://github.com/optave/ops-codegraph-tool/pull/657))
* **test:** remove constant-kind exclusion from parity test ([#676](https://github.com/optave/ops-codegraph-tool/pull/676), [#680](https://github.com/optave/ops-codegraph-tool/pull/680))

### Performance

* **db:** NativeDatabase napi-rs class for rusqlite connection lifecycle (6.13) ([#666](https://github.com/optave/ops-codegraph-tool/pull/666))
* **db:** migrate Repository read queries to NativeDatabase rusqlite (6.14) ([#671](https://github.com/optave/ops-codegraph-tool/pull/671))
* **db:** migrate build pipeline writes to NativeDatabase (6.15) ([#669](https://github.com/optave/ops-codegraph-tool/pull/669))
* **db:** generic query execution on NativeDatabase (6.16) ([#677](https://github.com/optave/ops-codegraph-tool/pull/677))
* **db:** bulk CFG and dataflow DB writes via rusqlite ([#653](https://github.com/optave/ops-codegraph-tool/pull/653))
* **build:** native Rust/rusqlite for roles & edge insertion (6.12) ([#658](https://github.com/optave/ops-codegraph-tool/pull/658))
* **insert-nodes:** native Rust/rusqlite pipeline for node insertion ([#654](https://github.com/optave/ops-codegraph-tool/pull/654))
* **ast:** bulk-insert AST nodes via native Rust/rusqlite ([#651](https://github.com/optave/ops-codegraph-tool/pull/651))
* sub-100ms incremental rebuilds (466ms → 67–80ms) ([#644](https://github.com/optave/ops-codegraph-tool/pull/644))
* **hooks:** narrow Bash hook matchers to git commands only ([#655](https://github.com/optave/ops-codegraph-tool/pull/655))

### Refactors

* **db:** lazy-load better-sqlite3 and remove standalone napi functions (6.17) ([#673](https://github.com/optave/ops-codegraph-tool/pull/673))

### Chores

* **deps:** upgrade TypeScript from 5.9 to 6.0 ([#667](https://github.com/optave/ops-codegraph-tool/pull/667))
* **deps:** bump @modelcontextprotocol/sdk from 1.27.1 to 1.28.0 ([#664](https://github.com/optave/ops-codegraph-tool/pull/664))
* **deps-dev:** bump @vitest/coverage-v8 from 4.1.1 to 4.1.2 ([#662](https://github.com/optave/ops-codegraph-tool/pull/662))
* **deps-dev:** bump @biomejs/biome from 2.4.8 to 2.4.9 ([#661](https://github.com/optave/ops-codegraph-tool/pull/661))

## [3.4.1](https://github.com/optave/ops-codegraph-tool/compare/v3.4.0...v3.4.1) (2026-03-26)

**Post-migration stabilization and native engine accuracy.** This release fixes a Rust `findCaller` bug that misattributed 68 call edges, adds compound database indexes to restore query performance after the TypeScript migration, and delivers a 96% speedup to incremental role classification (255ms → 9ms). WASM builds are more resilient, incremental rebuilds handle JSONC and version changes correctly, and error handling is safer across the board.

### Bug Fixes

* **native:** remove spurious else-if in Rust `findCaller` that misattributed 68 call edges ([#637](https://github.com/optave/ops-codegraph-tool/pull/637))
* **native:** recurse into `await_expression` children in `walk_ast_nodes` ([#618](https://github.com/optave/ops-codegraph-tool/pull/618))
* **build:** JSONC parse and version-aware incremental rebuilds ([#631](https://github.com/optave/ops-codegraph-tool/pull/631))
* WASM build resilience and lint cleanup from TypeScript migration ([#629](https://github.com/optave/ops-codegraph-tool/pull/629))
* dogfood fixes 9.1–9.4 — version warning, barrel exports, quieter tsconfig, Set compatibility ([#634](https://github.com/optave/ops-codegraph-tool/pull/634))
* use safe error coercion in debug catch blocks ([#630](https://github.com/optave/ops-codegraph-tool/pull/630))
* add debug logging to empty catch blocks across infrastructure and domain layers ([#616](https://github.com/optave/ops-codegraph-tool/pull/616))
* **bench:** use `dist/` for npm benchmark installs to avoid Node type-stripping error ([#624](https://github.com/optave/ops-codegraph-tool/pull/624))
* **bench:** repair benchmark workflow broken by TypeScript migration ([#612](https://github.com/optave/ops-codegraph-tool/pull/612))
* **skills:** prevent `/review` from spamming `@greptileai` when already approved ([#628](https://github.com/optave/ops-codegraph-tool/pull/628))

### Performance

* **db:** add compound indexes to fix query regression from TypeScript migration ([#632](https://github.com/optave/ops-codegraph-tool/pull/632))
* **build:** incremental rebuild optimizations — roles 255ms → 9ms ([#622](https://github.com/optave/ops-codegraph-tool/pull/622))

### Refactors

* **errors:** extract shared `toErrorMessage` helper ([#633](https://github.com/optave/ops-codegraph-tool/pull/633))
* extract `MAX_WALK_DEPTH` constant to extractors helpers ([#620](https://github.com/optave/ops-codegraph-tool/pull/620))
* address SLOC warnings in domain and features layers ([#621](https://github.com/optave/ops-codegraph-tool/pull/621))
* split `cfg-visitor.ts` by control-flow construct ([#619](https://github.com/optave/ops-codegraph-tool/pull/619))

### Chores

* **titan:** first full Titan Paradigm pipeline run — audit report generation and skill improvements ([#623](https://github.com/optave/ops-codegraph-tool/pull/623))

## [3.4.0](https://github.com/optave/ops-codegraph-tool/compare/v3.3.1...v3.4.0) (2026-03-25)

**TypeScript migration complete, Leiden community detection, and native engine hardening.** The entire codebase — all 271 source files — is now TypeScript with zero `.js` files remaining. Community detection upgrades from Louvain to a vendored Leiden algorithm with true probabilistic refinement, removing the `graphology` dependency. Go gains structural interface matching and C# gets proper `implements` disambiguation. The native Rust engine now extracts call-site AST nodes and bypasses the JS CFG visitor entirely on native builds. MCP server shutdown is graceful, and several edge-attribution and WASM fallback bugs are fixed.

### Features

* **types:** complete TypeScript migration — all 271 source files migrated from JavaScript, zero `.js` files remaining. Covers leaf modules, core domain, graph algorithms, builder stages, search, CLI layer (48 command handlers), AST analysis, features, presentation, MCP tools, and test suite ([#553](https://github.com/optave/ops-codegraph-tool/pull/553), [#554](https://github.com/optave/ops-codegraph-tool/pull/554), [#555](https://github.com/optave/ops-codegraph-tool/pull/555), [#558](https://github.com/optave/ops-codegraph-tool/pull/558), [#566](https://github.com/optave/ops-codegraph-tool/pull/566), [#570](https://github.com/optave/ops-codegraph-tool/pull/570), [#579](https://github.com/optave/ops-codegraph-tool/pull/579), [#580](https://github.com/optave/ops-codegraph-tool/pull/580), [#581](https://github.com/optave/ops-codegraph-tool/pull/581), [#588](https://github.com/optave/ops-codegraph-tool/pull/588))
* **communities:** vendor Leiden community detection algorithm, replacing `graphology-communities-louvain` — full control over resolution, quality functions, and probabilistic refinement ([#545](https://github.com/optave/ops-codegraph-tool/pull/545), [#552](https://github.com/optave/ops-codegraph-tool/pull/552), [#556](https://github.com/optave/ops-codegraph-tool/pull/556))
* **resolution:** Go structural interface matching — post-extraction pass matches struct method sets against interface method sets; C# `implements` disambiguation via post-walk reclassification of `extends` entries targeting known interfaces ([#522](https://github.com/optave/ops-codegraph-tool/pull/522))
* **native:** extract call-site AST nodes in Rust during native parse, fixing WASM fallback path for incomplete extraction ([#591](https://github.com/optave/ops-codegraph-tool/pull/591))
* **native:** extract `base_list` for C# classes in the Rust engine ([#577](https://github.com/optave/ops-codegraph-tool/pull/577))
* **cfg:** bypass JS CFG visitor entirely on native builds; fix Go `for-range` CFG parity between engines ([#595](https://github.com/optave/ops-codegraph-tool/pull/595))

### Bug Fixes

* **edges:** remove `findCaller` fallback that misattributed file-scope calls to unrelated functions ([#607](https://github.com/optave/ops-codegraph-tool/pull/607))
* **mcp:** add graceful shutdown to prevent "MCP Failed" errors on session clear ([#598](https://github.com/optave/ops-codegraph-tool/pull/598))
* **resolver:** apply JS-side `.js` → `.ts` extension remap after native resolution ([#594](https://github.com/optave/ops-codegraph-tool/pull/594))
* **resolver:** normalize paths in native resolver for `.js` → `.ts` remap ([#600](https://github.com/optave/ops-codegraph-tool/pull/600))
* **deps:** patch 5 high-severity transitive vulnerabilities ([#583](https://github.com/optave/ops-codegraph-tool/pull/583))
* **types:** narrow parser return types, `cachedStmt` in `buildTestFileIds`, WASM parser path, and triage query results ([#569](https://github.com/optave/ops-codegraph-tool/pull/569), [#576](https://github.com/optave/ops-codegraph-tool/pull/576), [#578](https://github.com/optave/ops-codegraph-tool/pull/578))
* **scripts:** use version-aware `strip-types` flag in `package.json` scripts ([#599](https://github.com/optave/ops-codegraph-tool/pull/599))
* **tests:** use `fs.cpSync` for fixture copy to handle subdirectories ([#584](https://github.com/optave/ops-codegraph-tool/pull/584))

### Performance

* **native:** fix WASM fallback bypass so native builds skip redundant JS analysis passes; batch SQL inserts for node/edge operations ([#606](https://github.com/optave/ops-codegraph-tool/pull/606))
* **queries:** apply `cachedStmt` to `buildTestFileIds` static SQL for faster test filtering ([#575](https://github.com/optave/ops-codegraph-tool/pull/575))

### Tests

* strengthen weak assertions and add presentation layer coverage ([#586](https://github.com/optave/ops-codegraph-tool/pull/586))

### Chores

* add `npm run bench` script and stale embeddings warning ([#604](https://github.com/optave/ops-codegraph-tool/pull/604))
* bump `commit-and-tag-version`, `tree-sitter-cli`, `web-tree-sitter`, `@commitlint/cli`, `@commitlint/config-conventional` ([#560](https://github.com/optave/ops-codegraph-tool/pull/560), [#561](https://github.com/optave/ops-codegraph-tool/pull/561), [#562](https://github.com/optave/ops-codegraph-tool/pull/562), [#563](https://github.com/optave/ops-codegraph-tool/pull/563), [#564](https://github.com/optave/ops-codegraph-tool/pull/564))

### Notes

* **constants:** `EXTENSIONS` and `IGNORE_DIRS` in the programmatic API are now `Set<string>` (changed during TypeScript migration). Both expose a `.toArray()` convenience method for consumers that need array semantics.

## [3.3.1](https://github.com/optave/ops-codegraph-tool/compare/v3.3.0...v3.3.1) (2026-03-20)

**Incremental rebuild accuracy and post-3.3.0 stabilization.** This patch fixes a critical edge gap in the file watcher's single-file rebuild path where call edges were silently dropped during incremental rebuilds, aligns the native Rust engine's edge builder kind filters with the JS engine for parity, plugs a WASM tree memory leak in native engine typeMap backfill, and restores query performance to pre-3.1.4 levels. Several post-reorganization import path issues are also corrected.

### Bug Fixes

* **watcher:** close edge gap in single-file rebuild — incremental rebuilds now correctly preserve call edges by coercing native typeMap arrays to Maps and rebuilding edges for reverse-dependency files ([#533](https://github.com/optave/ops-codegraph-tool/pull/533), [#542](https://github.com/optave/ops-codegraph-tool/pull/542))
* **native:** align edge builder kind filters with JS engine parity — ensures native and WASM engines produce identical edge sets ([#541](https://github.com/optave/ops-codegraph-tool/pull/541))
* **native:** free leaked WASM trees in native engine typeMap backfill ([#534](https://github.com/optave/ops-codegraph-tool/pull/534))
* **cli:** correct `ast` command import path after src/ reorganization ([#532](https://github.com/optave/ops-codegraph-tool/pull/532))
* **benchmarks:** stabilize benchmark targets across engines and preserve README links ([#527](https://github.com/optave/ops-codegraph-tool/pull/527))
* **benchmarks:** update benchmark script import paths after src/ restructure ([#521](https://github.com/optave/ops-codegraph-tool/pull/521))
* **ci:** sync Cargo.toml version before native binary build ([#538](https://github.com/optave/ops-codegraph-tool/pull/538))

### Performance

* **queries:** reduce query latency regression from 3.1.4 to 3.3.0 — cached prepared statements for `findReverseDeps` and `deleteOutgoingEdges` ([#528](https://github.com/optave/ops-codegraph-tool/pull/528))

### Tests

* **watcher:** incremental edge parity CI check — ensures watcher rebuilds produce identical edge sets to full builds ([#539](https://github.com/optave/ops-codegraph-tool/pull/539))

### Chores

* **ci:** add dynamic import verification to catch stale paths ([#540](https://github.com/optave/ops-codegraph-tool/pull/540))

## [3.3.0](https://github.com/optave/ops-codegraph-tool/compare/v3.2.0...v3.3.0) (2026-03-19)

**Resolution accuracy reaches a new level.** This release delivers Phase 4 resolution improvements — type inference across all typed languages, receiver type tracking with graded confidence, `package.json` exports field resolution, and monorepo workspace resolution. Method calls like `repo.findCallers()` now resolve through receiver types instead of matching any `findCallers` in scope. Barrel files correctly show re-exported symbols. A precision/recall benchmark suite tracks call resolution accuracy across versions. On the infrastructure side, all hardcoded behavioral constants are centralized into `DEFAULTS` with recursive deep merge, and the TypeScript migration begins with project setup and core type definitions.

### Features

* **resolution:** type inference for all typed languages (TS, Java, Go, Rust, C#, PHP, Python) — `obj.method()` resolves through declared types in both WASM and native engines ([#501](https://github.com/optave/ops-codegraph-tool/pull/501))
* **resolution:** receiver type tracking with graded confidence — constructors (`new Foo()`) at 1.0, annotations at 0.9, factory methods at 0.7; highest-confidence assignment wins per variable ([#505](https://github.com/optave/ops-codegraph-tool/pull/505))
* **resolution:** `package.json` `exports` field and monorepo workspace resolution — conditional exports, subpath patterns, npm/pnpm/Yarn workspaces resolved with high confidence instead of brute-force filesystem probing ([#509](https://github.com/optave/ops-codegraph-tool/pull/509))
* **exports:** show re-exported symbols for barrel files — `codegraph exports` now traces through re-exports to show the actual consumers of each symbol ([#515](https://github.com/optave/ops-codegraph-tool/pull/515))
* **roles:** dead role sub-categories — `dead-leaf`, `dead-entry`, `dead-ffi`, `dead-unresolved` replace the coarse `dead` role for more precise dead code classification ([#504](https://github.com/optave/ops-codegraph-tool/pull/504))
* **config:** centralize all hardcoded behavioral constants into `DEFAULTS` with recursive deep merge — partial `.codegraphrc.json` overrides now preserve sibling keys ([#506](https://github.com/optave/ops-codegraph-tool/pull/506))
* **benchmarks:** call resolution precision/recall benchmark suite — hand-annotated fixtures per language with expected-edges manifests, CI gate on accuracy regression ([#507](https://github.com/optave/ops-codegraph-tool/pull/507))
* **benchmarks:** child-process isolation for benchmarks — benchmark runner spawns builds in separate processes to prevent state leaks ([#512](https://github.com/optave/ops-codegraph-tool/pull/512))
* **typescript:** project setup for incremental migration — `tsconfig.json`, build pipeline, `dist/` output with source maps ([#508](https://github.com/optave/ops-codegraph-tool/pull/508))
* **typescript:** core type definitions (`src/types.ts`) — comprehensive types for symbols, edges, nodes, config, queries, and all domain model interfaces ([#516](https://github.com/optave/ops-codegraph-tool/pull/516))
* **languages:** add `.pyi`, `.phtml`, `.rake`, `.gemspec` extensions to Python, PHP, and Ruby parsers ([#502](https://github.com/optave/ops-codegraph-tool/pull/502))

### Bug Fixes

* **cli:** reword misleading 'stale' warning in `codegraph info` — no longer implies the graph is broken when it's simply older than some files ([#510](https://github.com/optave/ops-codegraph-tool/pull/510))
* **skills:** update dogfood and release skill templates to match current CLI surface ([#511](https://github.com/optave/ops-codegraph-tool/pull/511))

## [3.2.0](https://github.com/optave/ops-codegraph-tool/compare/v3.1.5...v3.2.0) (2026-03-17)

**Post-Phase 3 decomposition and dead code accuracy.** This release completes a thorough decomposition of the remaining monolithic modules — language extractors, AST analysis visitors, domain analysis functions, and feature modules are all broken into focused, single-responsibility helpers. Dead code detection now correctly classifies symbols that are only referenced by tests as "test-only" instead of "dead", and constants are properly included in edge building so they no longer appear as false-positive dead exports. A new `brief` command provides token-efficient file summaries designed for AI hook context injection. The native engine gains a MAX_WALK_DEPTH guard to prevent stack overflows on deeply nested ASTs.

### Features

* **cli:** `codegraph brief <file>` command — token-efficient file summary with symbols, roles, caller counts, and risk tiers; designed for hook-based context injection ([#480](https://github.com/optave/ops-codegraph-tool/pull/480))

### Bug Fixes

* **roles:** classify test-only-called symbols as "test-only" instead of "dead" — reduces false positives in dead code detection ([#497](https://github.com/optave/ops-codegraph-tool/pull/497))
* **builder:** include constant nodes in edge building — constants no longer appear as false-positive dead exports ([#495](https://github.com/optave/ops-codegraph-tool/pull/495))
* **native:** add MAX_WALK_DEPTH guard to native engine AST walkers — prevents stack overflows on deeply nested files ([#484](https://github.com/optave/ops-codegraph-tool/pull/484))
* **cli:** support repeated `--file` flag for multi-file scoping across all commands ([#498](https://github.com/optave/ops-codegraph-tool/pull/498))
* **versioning:** use semver-compliant dev version numbering (`-dev.0` suffix instead of non-standard format) ([#479](https://github.com/optave/ops-codegraph-tool/pull/479))

### Refactors

* **extractors:** decompose monolithic language extractors (JS/TS, Python, Java) into per-category handlers ([#490](https://github.com/optave/ops-codegraph-tool/pull/490))
* **ast-analysis:** decompose AST analysis visitors and domain builder stages into focused helpers ([#491](https://github.com/optave/ops-codegraph-tool/pull/491))
* **domain:** decompose domain analysis and feature modules into single-responsibility functions ([#492](https://github.com/optave/ops-codegraph-tool/pull/492))
* **presentation:** split data fetching from formatting and extract CLI/MCP subcommand dispatch ([#493](https://github.com/optave/ops-codegraph-tool/pull/493))
* **cleanup:** dead code removal, shared abstractions, and empty catch block replacement across all layers ([#489](https://github.com/optave/ops-codegraph-tool/pull/489))

## [3.1.5](https://github.com/optave/ops-codegraph-tool/compare/v3.1.4...v3.1.5) (2026-03-16)

**Phase 3 architectural refactoring completes.** This release finishes the remaining two Phase 3 roadmap tasks — domain directory grouping (3.15) and CLI composability (3.16) — bringing Phase 3 to 14 of 14 tasks complete. The `src/` directory is now reorganized into `domain/`, `features/`, and `presentation/` layers. A new `openGraph()` helper eliminates DB-open/close boilerplate across CLI commands, and a universal output formatter adds `--table` and `--csv` output to all commands. Several post-reorganization bugs are fixed: complexity/CFG/dataflow analysis restored after the move, MCP server imports corrected, worktree boundary escapes prevented, CJS `require()` support added, and LIKE wildcard injection in queries patched.

### Features

* **cli:** `openGraph()` helper and universal output formatter with `--table` and `--csv` output formats — eliminates per-command DB boilerplate and format-switching logic ([#461](https://github.com/optave/ops-codegraph-tool/pull/461))

### Bug Fixes

* **builder:** restore complexity/CFG/dataflow analysis that silently stopped running after src/ reorganization ([#469](https://github.com/optave/ops-codegraph-tool/pull/469))
* **db:** prevent `findDbPath` from escaping git worktree boundary — stops codegraph from accidentally using a parent repo's database ([#457](https://github.com/optave/ops-codegraph-tool/pull/457))
* **mcp:** update MCP server import path after src/ reorganization ([#466](https://github.com/optave/ops-codegraph-tool/pull/466))
* **api:** add CJS `require()` support to package exports — fixes `ERR_REQUIRE_ESM` for CommonJS consumers ([#472](https://github.com/optave/ops-codegraph-tool/pull/472))
* **db:** escape LIKE wildcards in `NodeQuery.fileFilter` and `nameLike` — prevents filenames containing `%` or `_` from matching unrelated rows ([#446](https://github.com/optave/ops-codegraph-tool/pull/446))

### Refactors

* **architecture:** reorganize `src/` into `domain/`, `features/`, `presentation/` layers — completes Phase 3.15 domain directory grouping ([#456](https://github.com/optave/ops-codegraph-tool/pull/456))
* **architecture:** move remaining flat `src/` files into subdirectories ([#458](https://github.com/optave/ops-codegraph-tool/pull/458))
* **architecture:** resolve three post-reorganization issues (circular imports, barrel exports, path corrections) ([#459](https://github.com/optave/ops-codegraph-tool/pull/459))
* **queries:** deduplicate BFS impact traversal and centralize config loading ([#463](https://github.com/optave/ops-codegraph-tool/pull/463))
* **tests:** migrate integration tests to InMemoryRepository for faster execution ([#462](https://github.com/optave/ops-codegraph-tool/pull/462))

### Tests

* **db:** add `findRepoRoot` and `findDbPath` ceiling boundary tests ([#475](https://github.com/optave/ops-codegraph-tool/pull/475))

## [3.1.4](https://github.com/optave/ops-codegraph-tool/compare/v3.1.3...v3.1.4) (2026-03-16)

**Phase 3 architectural refactoring reaches near-completion.** This release delivers 11 of 14 roadmap tasks in Phase 3 (Vertical Slice Architecture), restructuring the codebase from a flat collection of large files into a modular subsystem layout. The 3,395-line `queries.js` is decomposed into `src/analysis/` and `src/shared/` modules. The MCP tool registry becomes composable. CLI commands are self-contained modules under `src/commands/`. A domain error hierarchy replaces ad-hoc throws. The build pipeline is decomposed into named stages. The embedder is extracted into `src/embeddings/` with pluggable stores and search strategies. A unified graph model (`src/graph/`) consolidates four parallel graph representations. Nodes gain qualified names, hierarchical scoping, and visibility metadata. An `InMemoryRepository` enables fast unit testing without SQLite. The presentation layer (`src/presentation/`) separates all output formatting from domain logic. `better-sqlite3` is bumped to 12.8.0.

### Features

* **graph-model:** unified in-memory `CodeGraph` model with 3 builders, 6 algorithms, and 2 classifiers — consolidates four parallel graph representations into `src/graph/` ([#435](https://github.com/optave/ops-codegraph-tool/pull/435), [#436](https://github.com/optave/ops-codegraph-tool/pull/436))
* **qualified-names:** `qualified_name`, `scope`, and `visibility` columns on nodes (migration v15) — enables direct lookups like "all methods of class X" without edge traversal ([#437](https://github.com/optave/ops-codegraph-tool/pull/437))
* **testing:** `InMemoryRepository` for unit tests without SQLite — repository pattern now supports in-memory and persistent backends ([#444](https://github.com/optave/ops-codegraph-tool/pull/444))

### Refactors

* **queries:** decompose `queries.js` (3,395 lines) into `src/analysis/` and `src/shared/` modules ([#425](https://github.com/optave/ops-codegraph-tool/pull/425))
* **mcp:** composable MCP tool registry — tools defined alongside their implementations ([#426](https://github.com/optave/ops-codegraph-tool/pull/426))
* **cli:** split `cli.js` into self-contained command modules under `src/commands/` ([#427](https://github.com/optave/ops-codegraph-tool/pull/427))
* **api:** curate public API surface — explicit exports, remove internal leaks ([#430](https://github.com/optave/ops-codegraph-tool/pull/430))
* **errors:** domain error hierarchy — typed errors replace ad-hoc throws ([#431](https://github.com/optave/ops-codegraph-tool/pull/431))
* **embeddings:** extract embedder into `src/embeddings/` subsystem with pluggable stores and search strategies ([#433](https://github.com/optave/ops-codegraph-tool/pull/433))
* **builder:** decompose `buildGraph()` into named pipeline stages ([#434](https://github.com/optave/ops-codegraph-tool/pull/434))
* **presentation:** extract all output formatting into `src/presentation/` — viewer, export, table, sequence renderer, result formatter ([#443](https://github.com/optave/ops-codegraph-tool/pull/443))

### Chores

* **ci:** add backlog compliance phase to automated PR review ([#432](https://github.com/optave/ops-codegraph-tool/pull/432))
* **deps:** bump better-sqlite3 from 12.6.2 to 12.8.0 ([#442](https://github.com/optave/ops-codegraph-tool/pull/442))
* **deps-dev:** bump @biomejs/biome from 2.4.6 to 2.4.7 ([#441](https://github.com/optave/ops-codegraph-tool/pull/441))
* **deps-dev:** bump @commitlint/cli from 20.4.3 to 20.4.4 ([#440](https://github.com/optave/ops-codegraph-tool/pull/440))
* **deps-dev:** bump @commitlint/config-conventional from 20.4.3 to 20.4.4 ([#439](https://github.com/optave/ops-codegraph-tool/pull/439))
* **deps-dev:** bump @vitest/coverage-v8 from 4.0.18 to 4.1.0 ([#438](https://github.com/optave/ops-codegraph-tool/pull/438))

## [3.1.3](https://github.com/optave/ops-codegraph-tool/compare/v3.1.2...v3.1.3) (2026-03-11)

**Bug fixes and build instrumentation.** This patch fixes WASM builds silently producing zero complexity rows, resolves four dogfood-reported issues (benchmark crash resilience, WASM parser memory cleanup, native dynamic import tracking, stale native version reporting), and adds missing build phase timers so `setupMs` and `finalizeMs` now account for the previously untracked ~45% of total build time. Prepared statement caching is extracted into a reusable `cachedStmt` utility.

### Features

* **builder:** add `setupMs` and `finalizeMs` phase timers to `buildGraph` — closes the ~45% gap in phase breakdown accounting ([#415](https://github.com/optave/ops-codegraph-tool/pull/415))

### Bug Fixes

* **complexity:** fix WASM builds producing zero `function_complexity` rows — incorrect import alias caused `findFunctionNode` to be undefined in WASM-only path ([#414](https://github.com/optave/ops-codegraph-tool/pull/414))
* **native:** track `import()` expressions in Rust extractor — adds `dynamicImport` field to `Import` struct, matching WASM behavior for dead-export analysis ([#418](https://github.com/optave/ops-codegraph-tool/pull/418))
* **native:** report correct native package version in `codegraph info` — reads from platform npm package.json instead of binary-embedded version ([#418](https://github.com/optave/ops-codegraph-tool/pull/418))
* **benchmark:** wrap engine calls in try/catch so one engine failure doesn't prevent the other from running; fix embedding benchmark `disposeModel` leak ([#418](https://github.com/optave/ops-codegraph-tool/pull/418))
* **parser:** add `disposeParsers()` to release cached WASM parsers/queries; call `tree.delete()` after AST analysis to prevent segfaults on repeated builds ([#418](https://github.com/optave/ops-codegraph-tool/pull/418))
* **queries:** hoist prepared statement out of BFS loop in `getClassHierarchy` ([#403](https://github.com/optave/ops-codegraph-tool/pull/403))
* **ci:** only trigger Claude automated review on PR open, not every push ([#419](https://github.com/optave/ops-codegraph-tool/pull/419))

### Performance

* **db:** extract `cachedStmt` utility into `src/db/repository/cached-stmt.js` — reusable prepared statement caching for hot-path repository functions ([#417](https://github.com/optave/ops-codegraph-tool/pull/417), [#402](https://github.com/optave/ops-codegraph-tool/pull/402))

## [3.1.2](https://github.com/optave/ops-codegraph-tool/compare/v3.1.1...v3.1.2) (2026-03-11)

**Phase 3 architectural refactoring reaches substantial completion.** This release finishes the unified AST analysis framework (Phase 3.1) — all four analyses (complexity, CFG, dataflow, AST-store) now run in a single DFS walk via pluggable visitors, with `cfg.js` shrinking from 1,242 to 518 lines and cyclomatic complexity derived directly from CFG structure. CLI command/query separation (Phase 3.2) moves ~1,059 lines of formatting code into a dedicated `src/commands/` directory. Repository pattern migration (Phase 3.3) extracts raw SQL from 14 source modules. Dynamic `import()` expressions are now tracked as `dynamic-imports` graph edges, fixing false positives in dead-export analysis and impact tracing. Prepared statement caching cuts hot-path DB overhead in the repository layer.

### Features

* **ast-analysis:** unified AST analysis framework — shared DFS walker with pluggable `enterNode`/`exitNode`/`enterFunction`/`exitFunction` hooks; complexity, CFG, AST-store, and dataflow visitors in a single coordinated pass ([#388](https://github.com/optave/ops-codegraph-tool/pull/388))
* **cfg:** CFG visitor rewrite — node-level DFS visitor replaces statement-level `buildFunctionCFG`, Mode A/B split eliminated; cyclomatic complexity now derived from CFG (`E - N + 2`); `cfg.js` reduced from 1,242 → 518 lines ([#392](https://github.com/optave/ops-codegraph-tool/pull/392))
* **commands:** extract CLI wrappers into `src/commands/` directory (Phase 3.2) — command/query separation complete across all 19 analysis modules; `src/infrastructure/` added for shared `result-formatter.js` and `test-filter.js` ([#393](https://github.com/optave/ops-codegraph-tool/pull/393))
* **builder:** track dynamic `import()` expressions as `dynamic-imports` graph edges — destructured names feed into call resolution, fixing false "zero consumers" in dead-export analysis ([#389](https://github.com/optave/ops-codegraph-tool/pull/389))

### Bug Fixes

* **hooks:** fix `check-dead-exports` hook silently no-ops on ESM codebases ([#394](https://github.com/optave/ops-codegraph-tool/pull/394))
* **hooks:** guard pre-push hook against `sh -e` failure when `diff-impact` is unavailable
* **complexity:** remove function nodes from `nestingNodeTypes` and eliminate O(n²) lookup
* **complexity:** remove function nesting inflation in `computeAllMetrics` and pass `langId` to LOC
* **ast-analysis:** guard `runAnalyses` call, fix nested function nesting, rename `_engineOpts`
* **ast-analysis:** fix Halstead skip depth counter, debug logging, perf import

### Performance

* **db:** cache prepared statements in hot-path repository functions — avoids repeated statement compilation on incremental builds

### Refactors

* migrate raw SQL from 14 source modules into repository pattern (Phase 3.3) — `src/db/repository/` split into 10 domain files (nodes, edges, build-stmts, complexity, cfg, dataflow, cochange, embeddings, graph-read, barrel)
* address Greptile review — deduplicate `relatedTests`, hoist prepared stmts, fix `.raw()` no-op

## [3.1.1](https://github.com/optave/ops-codegraph-tool/compare/v3.1.0...v3.1.1) (2026-03-08)

**Reliability, architecture, and MCP cold-start fixes.** This patch breaks a circular dependency cycle, fixes MCP server first-connect reliability by deferring heavy imports, corrects flow matching to use core symbol kinds, and refactors all database access to use try/finally for reliable `db.close()`. Internal architecture improves with repository pattern for data access and command/query separation.

### Features

* **hooks:** add pre-commit hooks for cycles, dead exports, signature warnings ([#381](https://github.com/optave/ops-codegraph-tool/pull/381))
* **benchmark:** add 1-file rebuild phase breakdown to build benchmarks ([#370](https://github.com/optave/ops-codegraph-tool/pull/370))

### Bug Fixes

* **cycles:** break circular dependency cycle and remove dead `queryName` export ([#378](https://github.com/optave/ops-codegraph-tool/pull/378))
* **queries:** use `CORE_SYMBOL_KINDS` in flow matching ([#382](https://github.com/optave/ops-codegraph-tool/pull/382))
* **mcp:** defer heavy imports in MCP server for first-connect reliability ([#380](https://github.com/optave/ops-codegraph-tool/pull/380))

### Refactors

* wrap all db usage in try/finally for reliable `db.close()` ([#384](https://github.com/optave/ops-codegraph-tool/pull/384), [#383](https://github.com/optave/ops-codegraph-tool/pull/383))
* repository pattern for data access ([#371](https://github.com/optave/ops-codegraph-tool/pull/371))
* command/query separation — extract CLI wrappers, shared output helper ([#373](https://github.com/optave/ops-codegraph-tool/pull/373))

### Chores

* **ci:** allow `merge` type in commitlint config ([#385](https://github.com/optave/ops-codegraph-tool/pull/385))
* **deps-dev:** bump tree-sitter-go from 0.23.4 to 0.25.0 ([#356](https://github.com/optave/ops-codegraph-tool/pull/356))

## [3.1.0](https://github.com/optave/ops-codegraph-tool/compare/v3.0.4...v3.1.0) (2026-03-08)

**Sequence diagrams, native engine performance leap, and unused export detection.** This release adds `codegraph sequence` for Mermaid sequence diagram generation from call graph edges, delivers major native engine build optimizations (deep-clone elimination, batched SQLite inserts, call edge building in Rust, FS caching, rayon-parallel import resolution), introduces `--unused` on the exports command to detect dead exports, and fixes an ~80x native no-op rebuild regression.

### Features

* **sequence:** add `codegraph sequence <name>` command for Mermaid sequence diagram generation from call graph edges — participants are files, BFS forward from entry point, optional `--dataflow` flag for parameter/return annotations; exposed via CLI, MCP tool, and programmatic API ([#345](https://github.com/optave/ops-codegraph-tool/pull/345))
* **exports:** add `--unused` flag to `codegraph exports` — new `exported` column (migration v14) populated from parser export declarations, enabling detection of symbols declared as exports but with zero consumers ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))

### Performance

* **native:** eliminate deep-clone in `normalizeNativeSymbols` — replace 125-line JS deep-clone with in-place `patchNativeResult` via `#[napi(js_name)]` annotations on Rust types ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **native:** add `include_ast_nodes` flag to `parse_file`/`parse_files` — initial parse skips AST node walking, saving ~200ms ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **native:** move call/receiver/extends edge building to Rust (`edge_builder.rs`) — narrowest-span caller resolution, confidence sorting, dedup via u64 edge keys ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **native:** add `known_files` HashSet cache to `resolve_imports_batch` — avoids redundant FS syscalls during import resolution ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **native:** parallelize `resolve_imports_batch` with rayon for concurrent import resolution ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **builder:** batch SQLite multi-value INSERTs — accumulate node/edge rows and flush with chunked INSERT statements (200 rows per chunk) instead of individual prepared statement runs ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))

### Bug Fixes

* **native:** fix no-op rebuild regression (~80x slower than WASM) — `extToLang` map was not built when native engine provided pre-computed CFG, causing `langId` lookup to return null and triggering full re-parse on every incremental build ([#360](https://github.com/optave/ops-codegraph-tool/pull/360))
* **native:** pass full file list to `known_files` cache — on incremental builds only changed files were passed, causing valid import targets to be dropped ([#361](https://github.com/optave/ops-codegraph-tool/pull/361))
* **benchmark:** install native package explicitly in npm benchmark mode ([#351](https://github.com/optave/ops-codegraph-tool/pull/351))

### Documentation

* reorder README to be AI-first throughout ([#362](https://github.com/optave/ops-codegraph-tool/pull/362))
* add MCP tool surface optimization proposal ([#363](https://github.com/optave/ops-codegraph-tool/pull/363))
* update build performance, query, and incremental benchmarks for 3.0.4 ([#352](https://github.com/optave/ops-codegraph-tool/pull/352), [#353](https://github.com/optave/ops-codegraph-tool/pull/353), [#354](https://github.com/optave/ops-codegraph-tool/pull/354))

### Chores

* **deps:** bump graphology from 0.25.4 to 0.26.0 ([#358](https://github.com/optave/ops-codegraph-tool/pull/358))
* **deps-dev:** bump @biomejs/biome from 2.4.4 to 2.4.6 ([#359](https://github.com/optave/ops-codegraph-tool/pull/359))
* **deps-dev:** bump @commitlint/cli from 20.4.2 to 20.4.3 ([#357](https://github.com/optave/ops-codegraph-tool/pull/357))
* **deps-dev:** bump @commitlint/config-conventional ([#355](https://github.com/optave/ops-codegraph-tool/pull/355))

## [3.0.4](https://github.com/optave/ops-codegraph-tool/compare/v3.0.3...v3.0.4) (2026-03-05)

**Native engine goes full-stack: CFG, AST nodes, and WASM double-parse elimination.** This release completes the native engine migration — CFG computation and AST node extraction now run in Rust for 8 languages, eliminating the redundant WASM pre-parse on native builds.

### Performance

* **native:** compute CFG in Rust native engine for all 8 languages (JS/TS/TSX, Python, Go, Rust, Java, C#, Ruby, PHP) — ports `buildFunctionCFG` algorithm to Rust with per-language `CfgRules`, eliminates WASM re-parsing in CFG phase ([#342](https://github.com/optave/ops-codegraph-tool/pull/342))
* **native:** extract AST nodes (call, new, throw, await, string, regex) for all non-JS languages in Rust via shared `walk_ast_nodes_with_config()` — astMs drops from ~651ms to ~50ms ([#340](https://github.com/optave/ops-codegraph-tool/pull/340))
* **builder:** skip `ensureWasmTrees` entirely when native engine provides complete CFG + dataflow + AST data — wasmPreMs drops from ~388ms to 0 on native builds ([#344](https://github.com/optave/ops-codegraph-tool/pull/344))

### Bug Fixes

* **native:** fix function-scoped `const` declarations being incorrectly extracted as top-level constants ([#344](https://github.com/optave/ops-codegraph-tool/pull/344))
* **benchmark:** show all build phases (astMs, cfgMs, dataflowMs, wasmPreMs) in benchmark report and document v3.0.0→v3.0.3 native regression cause ([#339](https://github.com/optave/ops-codegraph-tool/pull/339))

## [3.0.3](https://github.com/optave/ops-codegraph-tool/compare/v3.0.2...v3.0.3) (2026-03-04)

> **Note:** 3.0.2 was an internal/unpublished version used during development.

### Performance

* **ast:** use single transaction for AST node insertion — astMs drops from ~3600ms to ~350ms (native) and ~547ms (WASM), reducing overall native build from 24.9 to 8.5 ms/file ([#333](https://github.com/optave/ops-codegraph-tool/pull/333))

## [3.0.2](https://github.com/optave/ops-codegraph-tool/compare/v3.0.1...v3.0.2) (2026-03-04)

**Dataflow goes multi-language, build performance recovery, and native engine parity fixes.** This patch extends dataflow analysis from JS/TS-only to all 11 supported languages, recovers build performance lost after CFG/dataflow became default-on, fixes language-aware identifier collection in dataflow, and closes a native engine scoping bug for constants.

### Features

* **dataflow:** extend dataflow analysis to all supported languages (Python, Go, Rust, Java, C#, PHP, Ruby) with per-language `DATAFLOW_RULES` and `makeDataflowRules()` factory ([#318](https://github.com/optave/ops-codegraph-tool/pull/318))

### Bug Fixes

* **dataflow:** use `isIdent` in `collectIdentifiers` for language-aware `referencedNames` — fixes PHP `variable_name` and other non-`identifier` node types being missed in return statements ([#324](https://github.com/optave/ops-codegraph-tool/pull/324))
* **native:** skip local constants inside function bodies — the native JS extractor incorrectly extracted function-scoped `const` as top-level constants ([#327](https://github.com/optave/ops-codegraph-tool/pull/327))
* **native:** enable extended kinds (parameters, properties, constants, receivers) in parity tests and update native binary to v3.0.1 ([#327](https://github.com/optave/ops-codegraph-tool/pull/327))

### Performance

* **builder:** fix v3.0.1 build performance regression (14.1 → ~5.8 ms/file) — eliminate redundant WASM parsing via `ensureWasmTrees()`, memoize `createParsers()`, filter CFG/dataflow to changed files only ([#325](https://github.com/optave/ops-codegraph-tool/pull/325))

### Documentation

* update build performance, query, and incremental benchmarks for 3.0.1 ([#321](https://github.com/optave/ops-codegraph-tool/pull/321), [#322](https://github.com/optave/ops-codegraph-tool/pull/322), [#323](https://github.com/optave/ops-codegraph-tool/pull/323))

## [3.0.1](https://github.com/optave/ops-codegraph-tool/compare/v3.0.0...v3.0.1) (2026-03-03)

**Post-release fixes and dataflow multi-language expansion.** This patch extends dataflow analysis (`flows_to`, `returns`, `mutates` edges) from JS/TS-only to all 11 supported languages, enables `--cfg` and `--dataflow` by default on builds, closes several native/WASM engine parity gaps, and fixes miscellaneous issues found during v3.0.0 dogfooding.

### Features

* **dataflow:** extend dataflow analysis to all supported languages (Python, Go, Rust, Java, C#, PHP, Ruby, Terraform) ([221a791](https://github.com/optave/ops-codegraph-tool/commit/221a791))
* **builder:** enable `--cfg` and `--dataflow` by default on builds ([#312](https://github.com/optave/ops-codegraph-tool/pull/312))

### Bug Fixes

* **native:** close engine parity gap between native and WASM ([#292](https://github.com/optave/ops-codegraph-tool/pull/292)) ([#309](https://github.com/optave/ops-codegraph-tool/pull/309))
* **native:** extract new/throw/await/string/regex AST nodes in native engine ([#306](https://github.com/optave/ops-codegraph-tool/pull/306)) ([#314](https://github.com/optave/ops-codegraph-tool/pull/314))
* **native:** bump native engine version to 3.0.0 ([#305](https://github.com/optave/ops-codegraph-tool/pull/305)) ([#310](https://github.com/optave/ops-codegraph-tool/pull/310))
* **queries:** include role-based entry points in `flow --list` ([#313](https://github.com/optave/ops-codegraph-tool/pull/313))
* **benchmark:** handle missing WASM grammars gracefully in benchmark scripts ([#311](https://github.com/optave/ops-codegraph-tool/pull/311))
* **ci:** prevent duplicate benchmark PRs on stable releases ([#304](https://github.com/optave/ops-codegraph-tool/pull/304))

### Documentation

* document dataflow multi-language support in README ([851f060](https://github.com/optave/ops-codegraph-tool/commit/851f060))
* mark resolved bugs and suggestions in dogfood reports ([#316](https://github.com/optave/ops-codegraph-tool/pull/316))
* add dogfood report for v3.0.0 ([#307](https://github.com/optave/ops-codegraph-tool/pull/307))
* update build performance, query, and incremental benchmarks for 3.0.0 ([#298](https://github.com/optave/ops-codegraph-tool/pull/298), [#299](https://github.com/optave/ops-codegraph-tool/pull/299), [#300](https://github.com/optave/ops-codegraph-tool/pull/300))

### Chores

* **ci:** include Cargo.toml in publish version bump commit ([#315](https://github.com/optave/ops-codegraph-tool/pull/315))
* **ci:** replace `npm ci` with `npm install` in benchmark and license workflows ([#308](https://github.com/optave/ops-codegraph-tool/pull/308))

## [3.0.0](https://github.com/optave/ops-codegraph-tool/compare/v2.6.0...v3.0.0) (2026-03-03)

**Dataflow analysis, intraprocedural CFG, AST node storage, expanded node/edge types, and a streamlined CLI surface.** This release introduces three new analysis dimensions — dataflow tracking (`flows_to`, `returns`, `mutates` edges), intraprocedural control flow graphs for all 11 supported languages, and stored queryable AST nodes (calls, `new`, string, regex, throw, await). The type system expands with `parameter`, `property`, and `constant` node kinds plus `contains`, `parameter_of`, and `receiver` edge kinds, enabling structural queries without reading source. Export gains GraphML, GraphSON, and Neo4j CSV formats plus an interactive HTML viewer (`codegraph plot`). A stable `normalizeSymbol` utility standardizes JSON output across all commands. The CLI surface is streamlined by consolidating redundant commands into fewer, more capable ones.

### ⚠ BREAKING CHANGES

* **mcp:** MCP tools `fn_deps`, `symbol_path`, and `list_entry_points` removed — use `query` with `deps`/`path` modes and `execution_flow` with `list` mode instead ([d874aa5](https://github.com/optave/ops-codegraph-tool/commit/d874aa5))
* **cli:** commands `fn` and `path` removed — use `query` instead; `query --path` replaced by standalone `path <from> <to>` ([d874aa5](https://github.com/optave/ops-codegraph-tool/commit/d874aa5))
* **cli:** commands `batch-query`, `hotspots`, `manifesto`, and `explain` removed — use `batch`, `triage --level`, `check`, and `audit --quick` respectively ([4f08082](https://github.com/optave/ops-codegraph-tool/commit/4f08082))

### Features

* **cli:** add dataflow analysis — `build --dataflow` extracts `flows_to`, `returns`, `mutates` edges tracking data movement through functions (JS/TS MVP), with `dataflow` command, MCP tool, and batch support ([#254](https://github.com/optave/ops-codegraph-tool/pull/254))
* **cli:** add intraprocedural control flow graph (CFG) — `build --cfg` constructs basic-block CFGs from tree-sitter AST, `cfg` command with text/DOT/Mermaid output ([#274](https://github.com/optave/ops-codegraph-tool/pull/274))
* **cli:** extend CFG to all supported languages — Python, Go, Rust, Java, C#, Ruby, PHP with per-language `CFG_RULES` and cross-language `processIf`/`processSwitch`/`processTryCatch` ([#283](https://github.com/optave/ops-codegraph-tool/pull/283))
* **cli:** add stored queryable AST nodes — persist calls, `new`, string, regex, throw, await nodes in `ast_nodes` table, queryable via `ast` command with SQL GLOB pattern matching ([#279](https://github.com/optave/ops-codegraph-tool/pull/279))
* **cli:** expand node types with `parameter`, `property`, `constant` kinds and `parent_id` column for sub-declaration queries across all 9 WASM extractors ([#270](https://github.com/optave/ops-codegraph-tool/pull/270))
* **cli:** add expanded edge types — `contains` (file→definition, parent→child), `parameter_of` (inverse), `receiver` (method-call dispatch) ([#279](https://github.com/optave/ops-codegraph-tool/pull/279))
* **cli:** add `exports <file>` command — per-symbol consumer analysis with re-export detection and counts ([#269](https://github.com/optave/ops-codegraph-tool/pull/269))
* **export:** add GraphML, GraphSON, Neo4j CSV formats and interactive HTML viewer (`codegraph plot`) with hierarchical/force/radial layouts, complexity overlays, and drill-down ([#268](https://github.com/optave/ops-codegraph-tool/pull/268))
* **cli:** add `normalizeSymbol` utility for stable 7-field JSON schema across all query and search commands ([#267](https://github.com/optave/ops-codegraph-tool/pull/267))
* **cli:** add batch-query multi-command mode with `splitTargets()` for comma-separated expansion and `multiBatchData()` for mixed-command orchestration ([#256](https://github.com/optave/ops-codegraph-tool/pull/256))
* **queries:** expose `fileHash` in `where` and `query` JSON output ([#257](https://github.com/optave/ops-codegraph-tool/pull/257))
* **builder:** add scoped rebuild for parallel agents ([#269](https://github.com/optave/ops-codegraph-tool/pull/269))

### Bug Fixes

* **queries:** correct reexport query direction and add exports integration tests ([#276](https://github.com/optave/ops-codegraph-tool/pull/276))
* **parser:** correct extractor line counts and duplicate section numbering ([fa7eee8](https://github.com/optave/ops-codegraph-tool/commit/fa7eee8))
* **triage:** map triage sort values to valid hotspot metrics ([a1583cb](https://github.com/optave/ops-codegraph-tool/commit/a1583cb))
* **complexity:** fix C# language ID mismatch (`c_sharp` → `csharp`) in `COMPLEXITY_RULES`, `HALSTEAD_RULES`, and `COMMENT_PREFIXES` ([#283](https://github.com/optave/ops-codegraph-tool/pull/283))
* **dataflow:** handle spread args, optional chaining, and reassignment in dataflow extraction ([#254](https://github.com/optave/ops-codegraph-tool/pull/254))

### Refactoring

* consolidate MCP tools — reduce surface from 32 to 29 by merging `fn_deps`/`symbol_path`/`list_entry_points` into `query` and `execution_flow` ([#263](https://github.com/optave/ops-codegraph-tool/pull/263))
* consolidate CLI — remove 5 redundant commands (`batch-query`, `hotspots`, `manifesto`, `explain`, `query --path`) in favor of unified alternatives ([#280](https://github.com/optave/ops-codegraph-tool/pull/280))
* consolidate MCP tools to match CLI changes from PR #280 ([cbda266](https://github.com/optave/ops-codegraph-tool/commit/cbda266))
* consolidate CFG rules with defaults factory and validation ([#284](https://github.com/optave/ops-codegraph-tool/pull/284))
* align dataflow.js with `normalizeSymbol` and `ALL_SYMBOL_KINDS` ([#285](https://github.com/optave/ops-codegraph-tool/pull/285))

### Documentation

* add architecture audit and roadmap for v2.7.0 ([5fe0a82](https://github.com/optave/ops-codegraph-tool/commit/5fe0a82))
* add competitive deep-dives for Joern and Narsil-MCP ([#260](https://github.com/optave/ops-codegraph-tool/pull/260), [#262](https://github.com/optave/ops-codegraph-tool/pull/262), [#264](https://github.com/optave/ops-codegraph-tool/pull/264), [#265](https://github.com/optave/ops-codegraph-tool/pull/265))
* add one-PR-one-concern rule to git conventions ([#281](https://github.com/optave/ops-codegraph-tool/pull/281))
* update references to consolidated CLI commands ([#282](https://github.com/optave/ops-codegraph-tool/pull/282))
* add TypeScript migration as Phase 4 in roadmap ([#255](https://github.com/optave/ops-codegraph-tool/pull/255))
* add Claude Code MCP registration to recommended practices ([#273](https://github.com/optave/ops-codegraph-tool/pull/273))

### Chores

* add CLA Assistant workflow ([#244](https://github.com/optave/ops-codegraph-tool/pull/244))
* add pre-commit diff-impact hook ([#271](https://github.com/optave/ops-codegraph-tool/pull/271))
* remove stale benchmark files from `generated/` ([#275](https://github.com/optave/ops-codegraph-tool/pull/275))

## [2.6.0](https://github.com/optave/ops-codegraph-tool/compare/v2.5.1...v2.6.0) (2026-03-02)

**CI validation, architecture boundaries, CODEOWNERS, multi-agent support, and incremental build reliability.** This release adds a `check` command for CI validation predicates (complexity, coverage, staleness gates), architecture boundary enforcement via manifesto rules with an onion-architecture preset, CODEOWNERS integration for ownership queries, `codegraph snapshot` for DB backup/restore, hybrid BM25 + semantic search via FTS5, composite `audit` and `triage` commands for risk-driven workflows, and batch querying for multi-agent dispatch. It also fixes several incremental rebuild bugs — EISDIR crashes on directory nodes, dropped barrel-file edges, orphaned complexity rows — and adds configurable drift detection to warn when incremental results diverge from full rebuilds.

### Features

* **cli:** add `check` command — CI validation predicates for complexity, coverage, staleness, and custom thresholds ([0a4c1bf](https://github.com/optave/ops-codegraph-tool/commit/0a4c1bf))
* **cli:** add `audit` command — composite risk audit combining explain + impact + health in one call ([6530d27](https://github.com/optave/ops-codegraph-tool/commit/6530d27))
* **cli:** add `triage` command — composite risk audit queue for prioritized review ([98b509f](https://github.com/optave/ops-codegraph-tool/commit/98b509f))
* **cli:** add `codegraph snapshot` for DB backup and restore ([8d7416b](https://github.com/optave/ops-codegraph-tool/commit/8d7416b))
* **cli:** add `codegraph owners` — CODEOWNERS integration for ownership queries ([36c6fdb](https://github.com/optave/ops-codegraph-tool/commit/36c6fdb))
* **manifesto:** add architecture boundary rules to manifesto engine ([79b9f32](https://github.com/optave/ops-codegraph-tool/commit/79b9f32))
* **boundaries:** add onion architecture preset to boundary rules ([c47ae76](https://github.com/optave/ops-codegraph-tool/commit/c47ae76))
* **embedder:** add hybrid BM25 + semantic search via FTS5 for combined keyword and vector ranking ([db3d3a3](https://github.com/optave/ops-codegraph-tool/commit/db3d3a3))
* **batch:** add batch querying for multi-agent dispatch ([850ef3e](https://github.com/optave/ops-codegraph-tool/commit/850ef3e))
* **mcp:** expose `check` as MCP tool ([3c36ef7](https://github.com/optave/ops-codegraph-tool/commit/3c36ef7))

### Bug Fixes

* **builder:** filter directory nodes from reverse-deps query to prevent EISDIR on incremental rebuilds ([#241](https://github.com/optave/ops-codegraph-tool/pull/241))
* **builder:** load unchanged barrel files into reexportMap so barrel-resolved edges aren't dropped during incremental rebuilds ([#241](https://github.com/optave/ops-codegraph-tool/pull/241))
* **builder:** purge `function_complexity` table on full rebuild — prevents orphaned rows accumulating across `--no-incremental` rebuilds ([#239](https://github.com/optave/ops-codegraph-tool/pull/239))
* **builder:** add node/edge count drift detection after incremental builds — warns when counts drift >20% and suggests `--no-incremental` ([#240](https://github.com/optave/ops-codegraph-tool/pull/240))
* **builder:** make drift threshold configurable via `build.driftThreshold` config (default 0.2) and include actual percentages in warning ([#240](https://github.com/optave/ops-codegraph-tool/pull/240))
* **complexity:** improve missing-data message — suggest `--no-incremental` rebuild instead of implying no graph exists ([#240](https://github.com/optave/ops-codegraph-tool/pull/240))
* **skill:** support dev build tarball installs in dogfood skill — branch Phase 0/4b pre-flight based on `-dev.` version detection ([#233](https://github.com/optave/ops-codegraph-tool/pull/233))
* **ci:** add `--strip` flag to `sync-native-versions.js` removing platform optionalDependencies in dev builds, fixing `npm install` failures ([#241](https://github.com/optave/ops-codegraph-tool/pull/241))
* **ci:** sync Cargo.toml version with package.json and automate via version script ([#241](https://github.com/optave/ops-codegraph-tool/pull/241))
* **owners:** add CODEOWNERS parse cache and tighten email validation ([f35c797](https://github.com/optave/ops-codegraph-tool/commit/f35c797))
* **bench:** add timeout and remove redundant stdio option ([978b590](https://github.com/optave/ops-codegraph-tool/commit/978b590))
* **ci:** save all benchmark reports and use git-based dev versioning ([267cabe](https://github.com/optave/ops-codegraph-tool/commit/267cabe))
* **docs:** correct ~20 inaccurate cells in feature comparison tables ([572268d](https://github.com/optave/ops-codegraph-tool/commit/572268d))
* **docs:** correct remaining MCP tool count in README (24/25 → 26/27) ([262874a](https://github.com/optave/ops-codegraph-tool/commit/262874a))

### Testing

* add barrel-project fixture and incremental-parity test for edge consistency across rebuild modes ([#241](https://github.com/optave/ops-codegraph-tool/pull/241))

### Refactoring

* organize `generated/` into `benchmarks/` and `dogfood/` subdirs ([35bfa3c](https://github.com/optave/ops-codegraph-tool/commit/35bfa3c))

### Dependencies

* bump web-tree-sitter from 0.26.5 to 0.26.6 ([70f26c0](https://github.com/optave/ops-codegraph-tool/commit/70f26c0))
* bump tree-sitter-cli from 0.26.5 to 0.26.6 ([161c2a0](https://github.com/optave/ops-codegraph-tool/commit/161c2a0))
* bump @modelcontextprotocol/sdk from 1.26.0 to 1.27.1 ([1385207](https://github.com/optave/ops-codegraph-tool/commit/1385207))
* consolidate Dependabot bumps (Actions + commitlint v20) ([d48be1a](https://github.com/optave/ops-codegraph-tool/commit/d48be1a))

## [2.5.1](https://github.com/optave/ops-codegraph-tool/compare/v2.5.0...v2.5.1) (2026-02-28)

**Critical fix: recover missing `branch-compare` command and broken programmatic API.** The `branch-compare` command and its implementation file were never committed in v2.5.0, causing `codegraph branch-compare` to crash and `import('@optave/codegraph')` to fail entirely due to a top-level re-export of the missing module. This patch recovers the full implementation (568 lines), adds an export guard test to prevent regressions, and introduces `--dry-run` for `registry prune`.

### Bug Fixes

* **cli:** recover `branch-compare` implementation — command was registered in cli.js and index.js but `src/branch-compare.js` was never committed, crashing both the CLI command and the entire programmatic API ([2ee10d4](https://github.com/optave/ops-codegraph-tool/commit/2ee10d4), [3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))
* **registry:** add `--dry-run` flag to `registry prune` — preview what would be removed without deleting entries ([2ee10d4](https://github.com/optave/ops-codegraph-tool/commit/2ee10d4))
* **bench:** remove unnecessary `shell: true` from `execFileSync` — minor security hardening ([14d03ce](https://github.com/optave/ops-codegraph-tool/commit/14d03ce))
* **docs:** correct dogfood benchmark data from stale v2.4.0 native binary — native complexity was reported as 2.2x slower than WASM when it's actually 47x faster ([3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))
* **skill:** add native binary version check to dogfood benchmark phase to prevent stale binary misreports ([3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))

### Testing

* add `index-exports` unit test — validates all re-exports in index.js resolve without `ERR_MODULE_NOT_FOUND` ([2ee10d4](https://github.com/optave/ops-codegraph-tool/commit/2ee10d4))
* add `branch-compare` integration tests (7 tests, 192 lines) ([3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))
* add `registry prune --dry-run` unit tests ([2ee10d4](https://github.com/optave/ops-codegraph-tool/commit/2ee10d4))

### Documentation

* update build performance benchmarks for 2.5.0 ([eb52074](https://github.com/optave/ops-codegraph-tool/commit/eb52074))
* add dogfood report for v2.5.0 ([3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))
* reframe Principle 5 from library-first to CLI-first identity ([3d1224d](https://github.com/optave/ops-codegraph-tool/commit/3d1224d))

## [2.5.0](https://github.com/optave/ops-codegraph-tool/compare/v2.4.0...v2.5.0) (2026-02-27)

**Complexity analysis, community detection, execution flow tracing, and manifesto rule engine.** This release adds a full code quality suite — cognitive, cyclomatic, Halstead, and Maintainability Index metrics for all 11 supported languages — with native Rust parity for maximum performance. Louvain community detection surfaces module boundaries and drift. A configurable manifesto rule engine enables CI-gated quality thresholds. Execution flow tracing lets you follow call paths through the codebase. Dev builds now publish as GitHub pre-releases instead of npm.

### Features

* **cli:** add cognitive & cyclomatic complexity metrics with per-function and file-level analysis ([35f6176](https://github.com/optave/ops-codegraph-tool/commit/35f6176))
* **cli:** add Halstead metrics (volume, difficulty, effort, bugs) and Maintainability Index ([452d9e9](https://github.com/optave/ops-codegraph-tool/commit/452d9e9))
* **cli:** add multi-language complexity analysis — extend metrics to all 11 supported languages ([b1166e0](https://github.com/optave/ops-codegraph-tool/commit/b1166e0))
* **cli:** add execution flow tracing — `flow` command and MCP tools for tracing call paths ([bc33f3b](https://github.com/optave/ops-codegraph-tool/commit/bc33f3b))
* **cli:** add `path` command for shortest-path queries between symbols ([ef0ea81](https://github.com/optave/ops-codegraph-tool/commit/ef0ea81))
* **communities:** add Louvain community detection for module boundary analysis and drift detection ([f3e36ad](https://github.com/optave/ops-codegraph-tool/commit/f3e36ad))
* **manifesto:** add configurable pass/fail rule engine with warn/fail thresholds for CI gates ([5a7d039](https://github.com/optave/ops-codegraph-tool/commit/5a7d039))
* **native:** add Halstead, LOC, and MI metrics to Rust native engine — full metrics parity across all 8 extractors ([44fe899](https://github.com/optave/ops-codegraph-tool/commit/44fe899))
* **embedder:** interactive install prompt for `@huggingface/transformers` when missing ([8e717b2](https://github.com/optave/ops-codegraph-tool/commit/8e717b2))
* **builder:** add build metadata tracking and `excludeTests` config shorthand ([f65b364](https://github.com/optave/ops-codegraph-tool/commit/f65b364))
* **structure:** add file limit to structure tool to reduce token usage ([2c565fa](https://github.com/optave/ops-codegraph-tool/commit/2c565fa))
* **ci:** publish dev builds as GitHub pre-releases instead of npm ([70c7627](https://github.com/optave/ops-codegraph-tool/commit/70c7627))
* **ci:** benchmark dev/release versioning and npm source resolution ([5d532a6](https://github.com/optave/ops-codegraph-tool/commit/5d532a6))

### Performance

* **native:** eliminate WASM re-parse for native complexity + build optimizations ([b8c8ca7](https://github.com/optave/ops-codegraph-tool/commit/b8c8ca7))
* **native:** native complexity computation for all languages with phase breakdown benchmarks ([231e941](https://github.com/optave/ops-codegraph-tool/commit/231e941))

### Bug Fixes

* **builder:** incremental rebuild drops edges from unchanged files ([9c3e3ba](https://github.com/optave/ops-codegraph-tool/commit/9c3e3ba))
* **queries:** scope-aware caller selection for nested functions ([72497dc](https://github.com/optave/ops-codegraph-tool/commit/72497dc))
* **complexity:** sanitize threshold values in complexity SQL queries ([c5ca1f2](https://github.com/optave/ops-codegraph-tool/commit/c5ca1f2))
* **builder:** upgrade build metadata failure log from debug to warn ([1c60b88](https://github.com/optave/ops-codegraph-tool/commit/1c60b88))
* **cli:** embed `--db` flag, DB locking, prerelease check, build logging improvements ([6a700b2](https://github.com/optave/ops-codegraph-tool/commit/6a700b2))
* **native:** add win32 native binary to optionalDependencies, fix embedder crashes ([f026c6a](https://github.com/optave/ops-codegraph-tool/commit/f026c6a))
* **hooks:** hook resilience for git ops, regex bypass, and worktree isolation ([2459cfc](https://github.com/optave/ops-codegraph-tool/commit/2459cfc))
* **ci:** benchmark uses stale native addon from npm ([83f2d4e](https://github.com/optave/ops-codegraph-tool/commit/83f2d4e))
* **ci:** preserve hand-written notes in benchmark report regeneration ([2d79f18](https://github.com/optave/ops-codegraph-tool/commit/2d79f18))
* **ci:** benchmark script regex + workflow branch naming ([53fc34f](https://github.com/optave/ops-codegraph-tool/commit/53fc34f))
* **ci:** harden benchmark workflow against transient npm failures ([1b97fb9](https://github.com/optave/ops-codegraph-tool/commit/1b97fb9))
* **ci:** isolate publish concurrency by event type ([529bf6f](https://github.com/optave/ops-codegraph-tool/commit/529bf6f))
* **ci:** use npx for license-checker to avoid intermittent 403 errors ([84e8e38](https://github.com/optave/ops-codegraph-tool/commit/84e8e38))
* **ci:** force-add gitignored DEPENDENCIES.json in release workflow ([fe22813](https://github.com/optave/ops-codegraph-tool/commit/fe22813))
* **ci:** add error handling to dev release pruning step ([fe45512](https://github.com/optave/ops-codegraph-tool/commit/fe45512))

### Refactoring

* simplify redundant `unwrap_or` pattern in complexity.rs ([150c3eb](https://github.com/optave/ops-codegraph-tool/commit/150c3eb))

### Testing

* add unit tests for interactive install prompt ([cc7c3e1](https://github.com/optave/ops-codegraph-tool/commit/cc7c3e1))

### Documentation

* complexity, communities, manifesto across all docs ([8f12f66](https://github.com/optave/ops-codegraph-tool/commit/8f12f66))
* correct engine parity section — 100% parity confirmed ([55c8ee3](https://github.com/optave/ops-codegraph-tool/commit/55c8ee3))
* update build performance benchmarks ([550b3b5](https://github.com/optave/ops-codegraph-tool/commit/550b3b5), [ea6b050](https://github.com/optave/ops-codegraph-tool/commit/ea6b050), [15e893c](https://github.com/optave/ops-codegraph-tool/commit/15e893c))

## [2.4.0](https://github.com/optave/ops-codegraph-tool/compare/v2.3.0...v2.4.0) (2026-02-25)

**Co-change analysis, node roles, faster parsing, and richer Mermaid output.** This release adds git co-change analysis to surface files that change together, classifies nodes by architectural role (entry/core/utility/adapter/dead/leaf), replaces the manual AST walk with tree-sitter's Query API for significantly faster JS/TS/TSX extraction, and enhances Mermaid export with subgraphs, edge labels, node shapes, and styling.

### Features

* **cli:** add git co-change analysis — surfaces files that frequently change together using Jaccard similarity on git history ([61785f7](https://github.com/optave/ops-codegraph-tool/commit/61785f7))
* **cli:** add node role classification — automatically labels nodes as entry, core, utility, adapter, dead, or leaf based on graph topology ([165f6ca](https://github.com/optave/ops-codegraph-tool/commit/165f6ca))
* **cli:** add `--json` to `search`, `--file` glob filter, `--exclude` to `prune`, exclude worktrees from vitest ([00ed205](https://github.com/optave/ops-codegraph-tool/commit/00ed205))
* **cli:** add update notification after commands — checks npm for newer versions and displays an upgrade hint ([eb3ccdf](https://github.com/optave/ops-codegraph-tool/commit/eb3ccdf))
* **export:** enhance Mermaid export with subgraphs, edge labels, node shapes, and styling ([ae301c0](https://github.com/optave/ops-codegraph-tool/commit/ae301c0))

### Performance

* **parser:** replace manual AST walk with tree-sitter Query API for JS/TS/TSX extraction ([fb6a139](https://github.com/optave/ops-codegraph-tool/commit/fb6a139))
* **builder:** avoid disk reads for line counts during incremental rebuild ([7b538bc](https://github.com/optave/ops-codegraph-tool/commit/7b538bc))

### Bug Fixes

* **builder:** preserve structure data during incremental builds ([7377fd9](https://github.com/optave/ops-codegraph-tool/commit/7377fd9))
* **embedder:** make embed command respect config `embeddings.model` ([77ffffc](https://github.com/optave/ops-codegraph-tool/commit/77ffffc))
* **embedder:** use `DEFAULT_MODEL` as single source of truth for embed default ([832fa49](https://github.com/optave/ops-codegraph-tool/commit/832fa49))
* **embedder:** add model disposal to prevent ONNX memory leak ([383e899](https://github.com/optave/ops-codegraph-tool/commit/383e899))
* **export:** escape quotes in Mermaid labels ([1c4ca34](https://github.com/optave/ops-codegraph-tool/commit/1c4ca34))
* **queries:** recompute Jaccard from total file counts during incremental co-change analysis ([e2a771b](https://github.com/optave/ops-codegraph-tool/commit/e2a771b))
* **queries:** collect all distinct edge kinds per pair instead of keeping only first ([4f40eee](https://github.com/optave/ops-codegraph-tool/commit/4f40eee))
* **queries:** skip keys without `::` separator in role lookup ([0c10e23](https://github.com/optave/ops-codegraph-tool/commit/0c10e23))
* **resolve:** use `indexOf` for `::` split to handle paths with colons ([b9d6ae4](https://github.com/optave/ops-codegraph-tool/commit/b9d6ae4))
* validate glob patterns and exclude names, clarify regex escaping ([6cf191f](https://github.com/optave/ops-codegraph-tool/commit/6cf191f))
* clean up regex escaping and remove unsupported brace from glob detection ([ab0d3a0](https://github.com/optave/ops-codegraph-tool/commit/ab0d3a0))
* **ci:** prevent benchmark updater from deleting README subsections ([bd1682a](https://github.com/optave/ops-codegraph-tool/commit/bd1682a))
* **ci:** add `--allow-same-version` to `npm version` in publish workflow ([9edaf15](https://github.com/optave/ops-codegraph-tool/commit/9edaf15))

### Refactoring

* reuse `coChangeForFiles` in `diffImpactData` ([aef1787](https://github.com/optave/ops-codegraph-tool/commit/aef1787))

### Testing

* add query vs walk parity tests for JS/TS/TSX extractors ([e68f6a7](https://github.com/optave/ops-codegraph-tool/commit/e68f6a7))

### Chores

* configure `bge-large` as default embedding model ([c21c387](https://github.com/optave/ops-codegraph-tool/commit/c21c387))

### Documentation

* add co-change analysis to README and mark backlog #9 done ([f977f9c](https://github.com/optave/ops-codegraph-tool/commit/f977f9c))
* reorganize docs — move guides to `docs/guides/`, roadmap into `docs/` ([ad423b7](https://github.com/optave/ops-codegraph-tool/commit/ad423b7))
* move roadmap files into `docs/roadmap/` ([693a8aa](https://github.com/optave/ops-codegraph-tool/commit/693a8aa))
* add Plan Mode Default working principle to CLAUDE.md ([c682f38](https://github.com/optave/ops-codegraph-tool/commit/c682f38))

## [2.3.0](https://github.com/optave/ops-codegraph-tool/compare/v2.2.1...v2.3.0) (2026-02-23)

**Smarter embeddings, richer CLI output, and robustness fixes.** This release introduces graph-enriched embedding strategies that use dependency context instead of raw source code, adds config-level test exclusion and recursive explain depth, outputs Mermaid diagrams from `diff-impact`, filters low-confidence edges from exports, and fixes numerous issues found through dogfooding.

### Features

* **embeddings:** graph-enriched embedding strategy — uses callers/callees from the dependency graph instead of raw source (~100 tokens vs ~360 avg), with context window overflow detection and `--strategy` flag ([c5dcd59](https://github.com/optave/ops-codegraph-tool/commit/c5dcd59))
* **cli:** add `excludeTests` config option with `--include-tests` CLI override ([56135e7](https://github.com/optave/ops-codegraph-tool/commit/56135e7))
* **cli:** add `--depth` option to `explain` for recursive dependency exploration ([56135e7](https://github.com/optave/ops-codegraph-tool/commit/56135e7))
* **cli:** add coupling score column to `map` command output ([56135e7](https://github.com/optave/ops-codegraph-tool/commit/56135e7))
* **cli:** add Mermaid output to `diff-impact` command for visual impact diagrams ([d2d767f](https://github.com/optave/ops-codegraph-tool/commit/d2d767f))
* **export:** add `--min-confidence` filter (default 0.5) to DOT/Mermaid/JSON exports ([08057f0](https://github.com/optave/ops-codegraph-tool/commit/08057f0))
* **skill:** add `/dogfood` skill for automated release validation — install, test, compare engines, generate report ([c713ce6](https://github.com/optave/ops-codegraph-tool/commit/c713ce6))
* **ci:** add query, incremental, and embedding regression benchmarks ([0fd1967](https://github.com/optave/ops-codegraph-tool/commit/0fd1967), [e012426](https://github.com/optave/ops-codegraph-tool/commit/e012426))

### Performance

* **parser:** reduce WASM boundary crossings in JS extractor for faster parsing ([d4ef6da](https://github.com/optave/ops-codegraph-tool/commit/d4ef6da))

### Bug Fixes

* **cli:** graceful error for `cycles`, `export`, `embed` when no `graph.db` exists ([3f56644](https://github.com/optave/ops-codegraph-tool/commit/3f56644))
* **embedder:** fix `splitIdentifier` lowercasing that broke camelCase search relevance ([dd71a64](https://github.com/optave/ops-codegraph-tool/commit/dd71a64))
* **embedder:** change default model to minilm (public, no auth required) with clear error guidance ([08057f0](https://github.com/optave/ops-codegraph-tool/commit/08057f0))
* **embedder:** split camelCase/snake_case identifiers in embedding text for better search relevance ([08057f0](https://github.com/optave/ops-codegraph-tool/commit/08057f0))
* **builder:** invalidate embeddings when nodes are deleted during incremental rebuild ([08057f0](https://github.com/optave/ops-codegraph-tool/commit/08057f0))
* **builder:** handle concurrent file edits and symlink loops in watcher/builder ([6735967](https://github.com/optave/ops-codegraph-tool/commit/6735967))
* **builder:** use busy-wait sleep instead of `Atomics.wait` for broader compatibility ([24f8ab1](https://github.com/optave/ops-codegraph-tool/commit/24f8ab1))
* **builder:** move engine status messages from stdout to stderr ([56135e7](https://github.com/optave/ops-codegraph-tool/commit/56135e7))
* **structure:** treat `.` as no filter in `structureData()` ([08057f0](https://github.com/optave/ops-codegraph-tool/commit/08057f0))
* **hooks:** add missing shebangs to husky hooks for Windows compatibility ([b1e012c](https://github.com/optave/ops-codegraph-tool/commit/b1e012c))
* **hooks:** track `mv`/`git mv`/`cp` commands in session edit log ([cfe633b](https://github.com/optave/ops-codegraph-tool/commit/cfe633b))
* **ci:** use PR instead of direct push for green-path version pin ([beddf94](https://github.com/optave/ops-codegraph-tool/commit/beddf94))
* **ci:** skip dev publish when merging release version bump PR ([ceb4c9a](https://github.com/optave/ops-codegraph-tool/commit/ceb4c9a))

### Refactoring

* **cli:** rename `--include-test-source` to `--with-test-source` for clarity ([242066f](https://github.com/optave/ops-codegraph-tool/commit/242066f))
* **builder:** lazy-load `node:os` to reduce startup overhead ([603ee55](https://github.com/optave/ops-codegraph-tool/commit/603ee55))

### Testing

* add `readFileSafe` and symlink loop detection tests ([5ae1cde](https://github.com/optave/ops-codegraph-tool/commit/5ae1cde))
* add embedding strategy benchmark and tests ([56a0517](https://github.com/optave/ops-codegraph-tool/commit/56a0517), [b8ce77c](https://github.com/optave/ops-codegraph-tool/commit/b8ce77c))

### Documentation

* add STABILITY.md with anticipated stability policy ([d3dcad5](https://github.com/optave/ops-codegraph-tool/commit/d3dcad5))
* add LLM integration feature planning document ([3ac5138](https://github.com/optave/ops-codegraph-tool/commit/3ac5138))
* add feature backlog and reorganize planning docs into `roadmap/` ([088b797](https://github.com/optave/ops-codegraph-tool/commit/088b797))
* reorganize README — lead with problem and value, not competition ([545aa0f](https://github.com/optave/ops-codegraph-tool/commit/545aa0f))
* add benchmarks section to CONTRIBUTING.md ([8395059](https://github.com/optave/ops-codegraph-tool/commit/8395059))

## [2.2.1](https://github.com/optave/ops-codegraph-tool/compare/v2.2.0...v2.2.1) (2026-02-23)

### Bug Fixes

* **embedder:** change default embedding model from jina-code to nomic-v1.5 ([f40bb91](https://github.com/optave/ops-codegraph-tool/commit/f40bb91))
* **config:** update config default and test to match nomic-v1.5 change ([3a88b4c](https://github.com/optave/ops-codegraph-tool/commit/3a88b4c))
* **ci:** run benchmark after publish to prevent workflow cancellation ([68e274e](https://github.com/optave/ops-codegraph-tool/commit/68e274e))

## [2.2.0](https://github.com/optave/ops-codegraph-tool/compare/v2.1.0...v2.2.0) (2026-02-23)

**New query commands, smarter call resolution, and full `--no-tests` coverage.** This release adds `explain`, `where`, and `context` commands for richer code exploration, introduces three-tier incremental change detection, improves call resolution accuracy, and extends the `--no-tests` flag to every query command.

### Features

* **cli:** add `codegraph explain <file|function>` command — structural summary without an LLM ([ff72655](https://github.com/optave/ops-codegraph-tool/commit/ff72655))
* **cli:** add `codegraph where <name>` command — fast symbol lookup for definition and usage ([7fafbaa](https://github.com/optave/ops-codegraph-tool/commit/7fafbaa))
* **cli:** add `codegraph context <name>` command — full function context (source, deps, callers) in one call ([3fa88b4](https://github.com/optave/ops-codegraph-tool/commit/3fa88b4))
* **cli:** add graph quality score to `stats` command ([130a52a](https://github.com/optave/ops-codegraph-tool/commit/130a52a))
* **cli:** add `--no-tests` flag to all remaining query commands for consistent test file filtering ([937b60f](https://github.com/optave/ops-codegraph-tool/commit/937b60f))
* **parser:** extract symbols from Commander/Express/Event callback patterns ([2ac24ef](https://github.com/optave/ops-codegraph-tool/commit/2ac24ef))
* **builder:** three-tier incremental change detection — skip unchanged, reparse modified, clean removed ([4b50af1](https://github.com/optave/ops-codegraph-tool/commit/4b50af1))
* **hooks:** add remind-codegraph hook to nudge agents before editing ([e6ddeea](https://github.com/optave/ops-codegraph-tool/commit/e6ddeea))
* **ci:** automated performance benchmarks per release ([f79d6f2](https://github.com/optave/ops-codegraph-tool/commit/f79d6f2))
* **ci:** add `workflow_dispatch` trigger for retrying failed stable releases ([8d4f0cb](https://github.com/optave/ops-codegraph-tool/commit/8d4f0cb))

### Bug Fixes

* **resolve:** improve call resolution accuracy with scoped fallback, dedup, and built-in skip ([3a11191](https://github.com/optave/ops-codegraph-tool/commit/3a11191))
* **parser:** add receiver field to call sites to eliminate false positive edges ([b08c2b2](https://github.com/optave/ops-codegraph-tool/commit/b08c2b2))
* **queries:** `statsData` fully filters test nodes and edges when `--no-tests` is set ([2f9730a](https://github.com/optave/ops-codegraph-tool/commit/2f9730a))
* **mcp:** fix file/kind parameter handling in MCP handlers ([d5af194](https://github.com/optave/ops-codegraph-tool/commit/d5af194))
* **mcp:** use schema objects for `setRequestHandler` instead of string literals ([fa0d358](https://github.com/optave/ops-codegraph-tool/commit/fa0d358))
* **security:** add path traversal guard and debug logging to file read helpers ([93a9bcf](https://github.com/optave/ops-codegraph-tool/commit/93a9bcf))
* **hooks:** fix Claude Code hooks for Windows and add branch name validation ([631e27a](https://github.com/optave/ops-codegraph-tool/commit/631e27a))
* **hooks:** add required `hookSpecificOutput` fields for context injection ([d51a3a4](https://github.com/optave/ops-codegraph-tool/commit/d51a3a4))
* **hooks:** guard-git hook validates branch name on `gh pr create` ([c9426fa](https://github.com/optave/ops-codegraph-tool/commit/c9426fa))
* **ci:** rewrite Claude Code workflow for working automated PR reviews ([1ed4121](https://github.com/optave/ops-codegraph-tool/commit/1ed4121))
* **ci:** move publish artifacts to `$RUNNER_TEMP` to prevent repo contamination ([d9849fa](https://github.com/optave/ops-codegraph-tool/commit/d9849fa))
* **ci:** make publish workflow resilient to partial failures ([5dd5b00](https://github.com/optave/ops-codegraph-tool/commit/5dd5b00))
* **ci:** validate version input in `workflow_dispatch` ([73a1e6b](https://github.com/optave/ops-codegraph-tool/commit/73a1e6b))
* fix default embedding model in README and enforce LF line endings ([c852707](https://github.com/optave/ops-codegraph-tool/commit/c852707))
* exclude dev dependencies from DEPENDENCIES.md ([63c6923](https://github.com/optave/ops-codegraph-tool/commit/63c6923))

### Documentation

* add AI Agent Guide with 6-step workflow, command reference, and MCP mapping ([5965fb4](https://github.com/optave/ops-codegraph-tool/commit/5965fb4))
* rewrite adding-a-language guide for LANGUAGE_REGISTRY architecture ([8504702](https://github.com/optave/ops-codegraph-tool/commit/8504702))
* add Codegraph vs Narsil-MCP and GitNexus comparison sections to README ([aac963c](https://github.com/optave/ops-codegraph-tool/commit/aac963c))
* update CLAUDE.md dogfooding section to follow recommended practices ([04dbfe6](https://github.com/optave/ops-codegraph-tool/commit/04dbfe6))
* update Claude Code hooks section with enrichment pattern and Windows notes ([4987de9](https://github.com/optave/ops-codegraph-tool/commit/4987de9))

## [2.1.0](https://github.com/optave/ops-codegraph-tool/compare/v2.0.0...v2.1.0) (2026-02-23)

**Parser refactor, unified publish pipeline, and quality-of-life improvements.** This release splits the monolithic parser into per-language extractor files, consolidates the dev and stable publish workflows into a single pipeline, adds the `codegraph stats` command, and hardens native engine path handling and registry management.

### Features

* **cli:** add `codegraph stats` command for graph health overview — node/edge counts, language breakdown, staleness check ([12f89fa](https://github.com/optave/ops-codegraph-tool/commit/12f89fa))
* **registry:** add TTL-based pruning for idle entries — stale repos auto-removed on access ([5e8c41b](https://github.com/optave/ops-codegraph-tool/commit/5e8c41b))
* **ci:** consolidate dev + stable publish into a single `publish.yml` workflow with automatic channel detection ([bf1a16b](https://github.com/optave/ops-codegraph-tool/commit/bf1a16b))
* **ci:** add embedding regression test with real ML model validation and dedicated weekly workflow ([5730a65](https://github.com/optave/ops-codegraph-tool/commit/5730a65))
* **ci:** add worktree workflow hooks (`guard-git.sh`, `track-edits.sh`) for parallel session safety ([e16dfeb](https://github.com/optave/ops-codegraph-tool/commit/e16dfeb))

### Bug Fixes

* **hooks:** replace `jq` with `node` in hooks for Windows compatibility ([ac0b198](https://github.com/optave/ops-codegraph-tool/commit/ac0b198))
* **native:** throw on explicit `--engine native` when addon is unavailable instead of silently falling back ([02b931d](https://github.com/optave/ops-codegraph-tool/commit/02b931d))
* **native:** normalize import paths to remove `.` and `..` segments in native engine ([5394078](https://github.com/optave/ops-codegraph-tool/commit/5394078))
* **native:** add JS-side `path.normalize()` defense-in-depth for native resolve ([e1222df](https://github.com/optave/ops-codegraph-tool/commit/e1222df))
* **registry:** auto-prune stale entries and skip temp dir registration ([d0f3e97](https://github.com/optave/ops-codegraph-tool/commit/d0f3e97))
* **tests:** isolate CLI tests from real registry via `CODEGRAPH_REGISTRY_PATH` env var ([dea0c3a](https://github.com/optave/ops-codegraph-tool/commit/dea0c3a))
* **ci:** prevent publish crash on pre-existing tags ([6906448](https://github.com/optave/ops-codegraph-tool/commit/6906448))
* **ci:** harden publish workflow version resolution ([1571f2a](https://github.com/optave/ops-codegraph-tool/commit/1571f2a))
* **ci:** use PR-based version bumps to avoid pushing directly to protected main branch ([3aab964](https://github.com/optave/ops-codegraph-tool/commit/3aab964))

### Refactoring

* **parser:** split monolithic `parser.js` extractors into per-language files under `src/extractors/` ([92b2d23](https://github.com/optave/ops-codegraph-tool/commit/92b2d23))
* **parser:** rename generic `walk` to language-specific names in all extractors ([6ed1f59](https://github.com/optave/ops-codegraph-tool/commit/6ed1f59))

### Documentation

* expand competitive analysis from 21 to 135+ tools ([0a679aa](https://github.com/optave/ops-codegraph-tool/commit/0a679aa))
* add competitive analysis and foundation principles ([21a6708](https://github.com/optave/ops-codegraph-tool/commit/21a6708))
* reposition around always-fresh graph + optional LLM enhancement ([a403acc](https://github.com/optave/ops-codegraph-tool/commit/a403acc))
* add parallel sessions rules to CLAUDE.md ([1435803](https://github.com/optave/ops-codegraph-tool/commit/1435803))

## [2.0.0](https://github.com/optave/ops-codegraph-tool/compare/v1.4.0...v2.0.0) (2026-02-22)

**Phase 2.5 — Multi-Repo MCP & Structural Analysis.** This release adds multi-repo support for AI agents, structural analysis with architectural metrics, and hardens security across the MCP server and SQL layers.

### ⚠ BREAKING CHANGES

* **parser:** Node kinds now use language-native types — Go structs → `struct`, Rust structs/enums/traits → `struct`/`enum`/`trait`, Java enums → `enum`, C# structs/records/enums → `struct`/`record`/`enum`, PHP traits/enums → `trait`/`enum`, Ruby modules → `module`. Rebuild required: `codegraph build --no-incremental`. ([72535fb](https://github.com/optave/ops-codegraph-tool/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Features

* **mcp:** add multi-repo MCP support with global registry at `~/.codegraph/registry.json` — optional `repo` param on all 11 tools, new `list_repos` tool, auto-register on build ([54ea9f6](https://github.com/optave/ops-codegraph-tool/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* **mcp:** default MCP server to single-repo mode for security isolation — multi-repo access requires explicit `--multi-repo` or `--repos` opt-in ([49c07ad](https://github.com/optave/ops-codegraph-tool/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* **registry:** harden multi-repo registry — `pruneRegistry()` removes stale entries, `--repos` allowlist for repo-level access control, auto-suffix name collisions ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **structure:** add structural analysis with directory nodes, containment edges, and metrics (symbol density, avg fan-out, cohesion scores) ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **cli:** add `codegraph structure [dir]`, `codegraph hotspots`, and `codegraph registry list|add|remove|prune` commands ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **export:** extend DOT/Mermaid export with directory clusters ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **parser:** add `SYMBOL_KINDS` constant and granular node types across both WASM and native Rust extractors ([72535fb](https://github.com/optave/ops-codegraph-tool/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Bug Fixes

* **security:** eliminate SQL interpolation in `hotspotsData` — replace dynamic string interpolation with static map of pre-built prepared statements ([f8790d7](https://github.com/optave/ops-codegraph-tool/commit/f8790d772989070903adbeeb30720789890591d9))
* **parser:** break `parser.js` ↔ `constants.js` circular dependency by inlining path normalization ([36239e9](https://github.com/optave/ops-codegraph-tool/commit/36239e91de43a6c6747951a84072953ea05e2321))
* **structure:** add `NULLS LAST` to hotspots `ORDER BY` clause ([a41668f](https://github.com/optave/ops-codegraph-tool/commit/a41668f55ff8c18acb6dde883b9e98c3113abf7d))
* **ci:** add license scan allowlist for `@img/sharp-*` dual-licensed packages ([9fbb084](https://github.com/optave/ops-codegraph-tool/commit/9fbb0848b4523baca71b94e7bceeb569773c8b45))

### Testing

* add 18 unit tests for registry, 4 MCP integration tests, 4 CLI integration tests for multi-repo ([54ea9f6](https://github.com/optave/ops-codegraph-tool/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* add 277 unit tests and 182 integration tests for structural analysis ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* add MCP single-repo / multi-repo mode tests ([49c07ad](https://github.com/optave/ops-codegraph-tool/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* add registry hardening tests (pruning, allowlist, name collision) ([a413ea7](https://github.com/optave/ops-codegraph-tool/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))

### Documentation

* add dogfooding guide for self-analysis with codegraph ([36239e9](https://github.com/optave/ops-codegraph-tool/commit/36239e91de43a6c6747951a84072953ea05e2321))

## [1.4.0](https://github.com/optave/ops-codegraph-tool/compare/v1.3.0...v1.4.0) (2026-02-22)

**Phase 2 — Foundation Hardening** is complete. This release hardens the core infrastructure: a declarative parser registry, a full MCP server, significantly improved test coverage, and secure credential management.

### Features

* **mcp:** expand MCP server from 5 to 11 tools — `fn_deps`, `fn_impact`, `diff_impact`, `semantic_search`, `export_graph`, `list_functions` ([510dd74](https://github.com/optave/ops-codegraph-tool/commit/510dd74ed14d455e50aa3166fa28cf90d05925dd))
* **config:** add `apiKeyCommand` for secure credential resolution via external secret managers (1Password, Bitwarden, Vault, pass, macOS Keychain) ([f3ab237](https://github.com/optave/ops-codegraph-tool/commit/f3ab23790369df00b50c75ae7c3b6bba47fde2c6))
* **parser:** add `LANGUAGE_REGISTRY` for declarative parser dispatch — adding a new language is now a single registry entry + extractor function ([cb08bb5](https://github.com/optave/ops-codegraph-tool/commit/cb08bb58adac8d7aa4d5fb6ea463ce6d3dba8007))

### Testing

* add unit tests for 8 core modules, improve coverage from 62% to 75% ([62d2694](https://github.com/optave/ops-codegraph-tool/commit/62d2694))
* add end-to-end CLI smoke tests ([15211c0](https://github.com/optave/ops-codegraph-tool/commit/15211c0))
* add 11 tests for `resolveSecrets` and `apiKeyCommand` integration
* make normalizePath test cross-platform ([36fa9cf](https://github.com/optave/ops-codegraph-tool/commit/36fa9cf))
* skip native engine parity tests for known Rust gaps ([7d89cd9](https://github.com/optave/ops-codegraph-tool/commit/7d89cd9))

### Documentation

* add secure credential management guide with examples for 5 secret managers
* update ROADMAP marking Phase 2 complete
* add community health files (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY)

### CI/CD

* add license compliance workflow and CI testing pipeline ([eeeb68b](https://github.com/optave/ops-codegraph-tool/commit/eeeb68b))
* add OIDC trusted publishing with `--provenance` for npm packages ([bc595f7](https://github.com/optave/ops-codegraph-tool/commit/bc595f7))
* add automated semantic versioning and commit enforcement ([b8e5277](https://github.com/optave/ops-codegraph-tool/commit/b8e5277))
* add Biome linter and formatter ([a6e6bd4](https://github.com/optave/ops-codegraph-tool/commit/a6e6bd4))

### Bug Fixes

* handle null `baseUrl` in native alias conversion ([d0077e1](https://github.com/optave/ops-codegraph-tool/commit/d0077e1))
* align native platform package versions with root ([93c9c4b](https://github.com/optave/ops-codegraph-tool/commit/93c9c4b))
* reset lockfile before `npm version` to avoid dirty-tree error ([6f0a40a](https://github.com/optave/ops-codegraph-tool/commit/6f0a40a))
