# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [3.1.2](https://github.com/optave/codegraph/compare/v3.1.1...v3.1.2) (2026-03-11)

**Phase 3 architectural refactoring reaches substantial completion.** This release finishes the unified AST analysis framework (Phase 3.1) — all four analyses (complexity, CFG, dataflow, AST-store) now run in a single DFS walk via pluggable visitors, with `cfg.js` shrinking from 1,242 to 518 lines and cyclomatic complexity derived directly from CFG structure. CLI command/query separation (Phase 3.2) moves ~1,059 lines of formatting code into a dedicated `src/commands/` directory. Repository pattern migration (Phase 3.3) extracts raw SQL from 14 source modules. Dynamic `import()` expressions are now tracked as `dynamic-imports` graph edges, fixing false positives in dead-export analysis and impact tracing. Prepared statement caching cuts hot-path DB overhead in the repository layer.

### Features

* **ast-analysis:** unified AST analysis framework — shared DFS walker with pluggable `enterNode`/`exitNode`/`enterFunction`/`exitFunction` hooks; complexity, CFG, AST-store, and dataflow visitors in a single coordinated pass ([#388](https://github.com/optave/codegraph/pull/388))
* **cfg:** CFG visitor rewrite — node-level DFS visitor replaces statement-level `buildFunctionCFG`, Mode A/B split eliminated; cyclomatic complexity now derived from CFG (`E - N + 2`); `cfg.js` reduced from 1,242 → 518 lines ([#392](https://github.com/optave/codegraph/pull/392))
* **commands:** extract CLI wrappers into `src/commands/` directory (Phase 3.2) — command/query separation complete across all 19 analysis modules; `src/infrastructure/` added for shared `result-formatter.js` and `test-filter.js` ([#393](https://github.com/optave/codegraph/pull/393))
* **builder:** track dynamic `import()` expressions as `dynamic-imports` graph edges — destructured names feed into call resolution, fixing false "zero consumers" in dead-export analysis ([#389](https://github.com/optave/codegraph/pull/389))

### Bug Fixes

* **hooks:** fix `check-dead-exports` hook silently no-ops on ESM codebases ([#394](https://github.com/optave/codegraph/pull/394))
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

## [3.1.1](https://github.com/optave/codegraph/compare/v3.1.0...v3.1.1) (2026-03-08)

**Reliability, architecture, and MCP cold-start fixes.** This patch breaks a circular dependency cycle, fixes MCP server first-connect reliability by deferring heavy imports, corrects flow matching to use core symbol kinds, and refactors all database access to use try/finally for reliable `db.close()`. Internal architecture improves with repository pattern for data access and command/query separation.

### Features

* **hooks:** add pre-commit hooks for cycles, dead exports, signature warnings ([#381](https://github.com/optave/codegraph/pull/381))
* **benchmark:** add 1-file rebuild phase breakdown to build benchmarks ([#370](https://github.com/optave/codegraph/pull/370))

### Bug Fixes

* **cycles:** break circular dependency cycle and remove dead `queryName` export ([#378](https://github.com/optave/codegraph/pull/378))
* **queries:** use `CORE_SYMBOL_KINDS` in flow matching ([#382](https://github.com/optave/codegraph/pull/382))
* **mcp:** defer heavy imports in MCP server for first-connect reliability ([#380](https://github.com/optave/codegraph/pull/380))

### Refactors

* wrap all db usage in try/finally for reliable `db.close()` ([#384](https://github.com/optave/codegraph/pull/384), [#383](https://github.com/optave/codegraph/pull/383))
* repository pattern for data access ([#371](https://github.com/optave/codegraph/pull/371))
* command/query separation — extract CLI wrappers, shared output helper ([#373](https://github.com/optave/codegraph/pull/373))

### Chores

* **ci:** allow `merge` type in commitlint config ([#385](https://github.com/optave/codegraph/pull/385))
* **deps-dev:** bump tree-sitter-go from 0.23.4 to 0.25.0 ([#356](https://github.com/optave/codegraph/pull/356))

## [3.1.0](https://github.com/optave/codegraph/compare/v3.0.4...v3.1.0) (2026-03-08)

**Sequence diagrams, native engine performance leap, and unused export detection.** This release adds `codegraph sequence` for Mermaid sequence diagram generation from call graph edges, delivers major native engine build optimizations (deep-clone elimination, batched SQLite inserts, call edge building in Rust, FS caching, rayon-parallel import resolution), introduces `--unused` on the exports command to detect dead exports, and fixes an ~80x native no-op rebuild regression.

### Features

* **sequence:** add `codegraph sequence <name>` command for Mermaid sequence diagram generation from call graph edges — participants are files, BFS forward from entry point, optional `--dataflow` flag for parameter/return annotations; exposed via CLI, MCP tool, and programmatic API ([#345](https://github.com/optave/codegraph/pull/345))
* **exports:** add `--unused` flag to `codegraph exports` — new `exported` column (migration v14) populated from parser export declarations, enabling detection of symbols declared as exports but with zero consumers ([#361](https://github.com/optave/codegraph/pull/361))

### Performance

* **native:** eliminate deep-clone in `normalizeNativeSymbols` — replace 125-line JS deep-clone with in-place `patchNativeResult` via `#[napi(js_name)]` annotations on Rust types ([#361](https://github.com/optave/codegraph/pull/361))
* **native:** add `include_ast_nodes` flag to `parse_file`/`parse_files` — initial parse skips AST node walking, saving ~200ms ([#361](https://github.com/optave/codegraph/pull/361))
* **native:** move call/receiver/extends edge building to Rust (`edge_builder.rs`) — narrowest-span caller resolution, confidence sorting, dedup via u64 edge keys ([#361](https://github.com/optave/codegraph/pull/361))
* **native:** add `known_files` HashSet cache to `resolve_imports_batch` — avoids redundant FS syscalls during import resolution ([#361](https://github.com/optave/codegraph/pull/361))
* **native:** parallelize `resolve_imports_batch` with rayon for concurrent import resolution ([#361](https://github.com/optave/codegraph/pull/361))
* **builder:** batch SQLite multi-value INSERTs — accumulate node/edge rows and flush with chunked INSERT statements (200 rows per chunk) instead of individual prepared statement runs ([#361](https://github.com/optave/codegraph/pull/361))

### Bug Fixes

* **native:** fix no-op rebuild regression (~80x slower than WASM) — `extToLang` map was not built when native engine provided pre-computed CFG, causing `langId` lookup to return null and triggering full re-parse on every incremental build ([#360](https://github.com/optave/codegraph/pull/360))
* **native:** pass full file list to `known_files` cache — on incremental builds only changed files were passed, causing valid import targets to be dropped ([#361](https://github.com/optave/codegraph/pull/361))
* **benchmark:** install native package explicitly in npm benchmark mode ([#351](https://github.com/optave/codegraph/pull/351))

### Documentation

* reorder README to be AI-first throughout ([#362](https://github.com/optave/codegraph/pull/362))
* add MCP tool surface optimization proposal ([#363](https://github.com/optave/codegraph/pull/363))
* update build performance, query, and incremental benchmarks for 3.0.4 ([#352](https://github.com/optave/codegraph/pull/352), [#353](https://github.com/optave/codegraph/pull/353), [#354](https://github.com/optave/codegraph/pull/354))

### Chores

* **deps:** bump graphology from 0.25.4 to 0.26.0 ([#358](https://github.com/optave/codegraph/pull/358))
* **deps-dev:** bump @biomejs/biome from 2.4.4 to 2.4.6 ([#359](https://github.com/optave/codegraph/pull/359))
* **deps-dev:** bump @commitlint/cli from 20.4.2 to 20.4.3 ([#357](https://github.com/optave/codegraph/pull/357))
* **deps-dev:** bump @commitlint/config-conventional ([#355](https://github.com/optave/codegraph/pull/355))

## [3.0.4](https://github.com/optave/codegraph/compare/v3.0.3...v3.0.4) (2026-03-05)

**Native engine goes full-stack: CFG, AST nodes, and WASM double-parse elimination.** This release completes the native engine migration — CFG computation and AST node extraction now run in Rust for 8 languages, eliminating the redundant WASM pre-parse on native builds.

### Performance

* **native:** compute CFG in Rust native engine for all 8 languages (JS/TS/TSX, Python, Go, Rust, Java, C#, Ruby, PHP) — ports `buildFunctionCFG` algorithm to Rust with per-language `CfgRules`, eliminates WASM re-parsing in CFG phase ([#342](https://github.com/optave/codegraph/pull/342))
* **native:** extract AST nodes (call, new, throw, await, string, regex) for all non-JS languages in Rust via shared `walk_ast_nodes_with_config()` — astMs drops from ~651ms to ~50ms ([#340](https://github.com/optave/codegraph/pull/340))
* **builder:** skip `ensureWasmTrees` entirely when native engine provides complete CFG + dataflow + AST data — wasmPreMs drops from ~388ms to 0 on native builds ([#344](https://github.com/optave/codegraph/pull/344))

### Bug Fixes

* **native:** fix function-scoped `const` declarations being incorrectly extracted as top-level constants ([#344](https://github.com/optave/codegraph/pull/344))
* **benchmark:** show all build phases (astMs, cfgMs, dataflowMs, wasmPreMs) in benchmark report and document v3.0.0→v3.0.3 native regression cause ([#339](https://github.com/optave/codegraph/pull/339))

## [3.0.3](https://github.com/optave/codegraph/compare/v3.0.2...v3.0.3) (2026-03-04)

> **Note:** 3.0.2 was an internal/unpublished version used during development.

### Performance

* **ast:** use single transaction for AST node insertion — astMs drops from ~3600ms to ~350ms (native) and ~547ms (WASM), reducing overall native build from 24.9 to 8.5 ms/file ([#333](https://github.com/optave/codegraph/pull/333))

## [3.0.2](https://github.com/optave/codegraph/compare/v3.0.1...v3.0.2) (2026-03-04)

**Dataflow goes multi-language, build performance recovery, and native engine parity fixes.** This patch extends dataflow analysis from JS/TS-only to all 11 supported languages, recovers build performance lost after CFG/dataflow became default-on, fixes language-aware identifier collection in dataflow, and closes a native engine scoping bug for constants.

### Features

* **dataflow:** extend dataflow analysis to all supported languages (Python, Go, Rust, Java, C#, PHP, Ruby) with per-language `DATAFLOW_RULES` and `makeDataflowRules()` factory ([#318](https://github.com/optave/codegraph/pull/318))

### Bug Fixes

* **dataflow:** use `isIdent` in `collectIdentifiers` for language-aware `referencedNames` — fixes PHP `variable_name` and other non-`identifier` node types being missed in return statements ([#324](https://github.com/optave/codegraph/pull/324))
* **native:** skip local constants inside function bodies — the native JS extractor incorrectly extracted function-scoped `const` as top-level constants ([#327](https://github.com/optave/codegraph/pull/327))
* **native:** enable extended kinds (parameters, properties, constants, receivers) in parity tests and update native binary to v3.0.1 ([#327](https://github.com/optave/codegraph/pull/327))

### Performance

* **builder:** fix v3.0.1 build performance regression (14.1 → ~5.8 ms/file) — eliminate redundant WASM parsing via `ensureWasmTrees()`, memoize `createParsers()`, filter CFG/dataflow to changed files only ([#325](https://github.com/optave/codegraph/pull/325))

### Documentation

* update build performance, query, and incremental benchmarks for 3.0.1 ([#321](https://github.com/optave/codegraph/pull/321), [#322](https://github.com/optave/codegraph/pull/322), [#323](https://github.com/optave/codegraph/pull/323))

## [3.0.1](https://github.com/optave/codegraph/compare/v3.0.0...v3.0.1) (2026-03-03)

**Post-release fixes and dataflow multi-language expansion.** This patch extends dataflow analysis (`flows_to`, `returns`, `mutates` edges) from JS/TS-only to all 11 supported languages, enables `--cfg` and `--dataflow` by default on builds, closes several native/WASM engine parity gaps, and fixes miscellaneous issues found during v3.0.0 dogfooding.

### Features

* **dataflow:** extend dataflow analysis to all supported languages (Python, Go, Rust, Java, C#, PHP, Ruby, Terraform) ([221a791](https://github.com/optave/codegraph/commit/221a791))
* **builder:** enable `--cfg` and `--dataflow` by default on builds ([#312](https://github.com/optave/codegraph/pull/312))

### Bug Fixes

* **native:** close engine parity gap between native and WASM ([#292](https://github.com/optave/codegraph/pull/292)) ([#309](https://github.com/optave/codegraph/pull/309))
* **native:** extract new/throw/await/string/regex AST nodes in native engine ([#306](https://github.com/optave/codegraph/pull/306)) ([#314](https://github.com/optave/codegraph/pull/314))
* **native:** bump native engine version to 3.0.0 ([#305](https://github.com/optave/codegraph/pull/305)) ([#310](https://github.com/optave/codegraph/pull/310))
* **queries:** include role-based entry points in `flow --list` ([#313](https://github.com/optave/codegraph/pull/313))
* **benchmark:** handle missing WASM grammars gracefully in benchmark scripts ([#311](https://github.com/optave/codegraph/pull/311))
* **ci:** prevent duplicate benchmark PRs on stable releases ([#304](https://github.com/optave/codegraph/pull/304))

### Documentation

* document dataflow multi-language support in README ([851f060](https://github.com/optave/codegraph/commit/851f060))
* mark resolved bugs and suggestions in dogfood reports ([#316](https://github.com/optave/codegraph/pull/316))
* add dogfood report for v3.0.0 ([#307](https://github.com/optave/codegraph/pull/307))
* update build performance, query, and incremental benchmarks for 3.0.0 ([#298](https://github.com/optave/codegraph/pull/298), [#299](https://github.com/optave/codegraph/pull/299), [#300](https://github.com/optave/codegraph/pull/300))

### Chores

* **ci:** include Cargo.toml in publish version bump commit ([#315](https://github.com/optave/codegraph/pull/315))
* **ci:** replace `npm ci` with `npm install` in benchmark and license workflows ([#308](https://github.com/optave/codegraph/pull/308))

## [3.0.0](https://github.com/optave/codegraph/compare/v2.6.0...v3.0.0) (2026-03-03)

**Dataflow analysis, intraprocedural CFG, AST node storage, expanded node/edge types, and a streamlined CLI surface.** This release introduces three new analysis dimensions — dataflow tracking (`flows_to`, `returns`, `mutates` edges), intraprocedural control flow graphs for all 11 supported languages, and stored queryable AST nodes (calls, `new`, string, regex, throw, await). The type system expands with `parameter`, `property`, and `constant` node kinds plus `contains`, `parameter_of`, and `receiver` edge kinds, enabling structural queries without reading source. Export gains GraphML, GraphSON, and Neo4j CSV formats plus an interactive HTML viewer (`codegraph plot`). A stable `normalizeSymbol` utility standardizes JSON output across all commands. The CLI surface is streamlined by consolidating redundant commands into fewer, more capable ones.

### ⚠ BREAKING CHANGES

* **mcp:** MCP tools `fn_deps`, `symbol_path`, and `list_entry_points` removed — use `query` with `deps`/`path` modes and `execution_flow` with `list` mode instead ([d874aa5](https://github.com/optave/codegraph/commit/d874aa5))
* **cli:** commands `fn` and `path` removed — use `query` instead; `query --path` replaced by standalone `path <from> <to>` ([d874aa5](https://github.com/optave/codegraph/commit/d874aa5))
* **cli:** commands `batch-query`, `hotspots`, `manifesto`, and `explain` removed — use `batch`, `triage --level`, `check`, and `audit --quick` respectively ([4f08082](https://github.com/optave/codegraph/commit/4f08082))

### Features

* **cli:** add dataflow analysis — `build --dataflow` extracts `flows_to`, `returns`, `mutates` edges tracking data movement through functions (JS/TS MVP), with `dataflow` command, MCP tool, and batch support ([#254](https://github.com/optave/codegraph/pull/254))
* **cli:** add intraprocedural control flow graph (CFG) — `build --cfg` constructs basic-block CFGs from tree-sitter AST, `cfg` command with text/DOT/Mermaid output ([#274](https://github.com/optave/codegraph/pull/274))
* **cli:** extend CFG to all supported languages — Python, Go, Rust, Java, C#, Ruby, PHP with per-language `CFG_RULES` and cross-language `processIf`/`processSwitch`/`processTryCatch` ([#283](https://github.com/optave/codegraph/pull/283))
* **cli:** add stored queryable AST nodes — persist calls, `new`, string, regex, throw, await nodes in `ast_nodes` table, queryable via `ast` command with SQL GLOB pattern matching ([#279](https://github.com/optave/codegraph/pull/279))
* **cli:** expand node types with `parameter`, `property`, `constant` kinds and `parent_id` column for sub-declaration queries across all 9 WASM extractors ([#270](https://github.com/optave/codegraph/pull/270))
* **cli:** add expanded edge types — `contains` (file→definition, parent→child), `parameter_of` (inverse), `receiver` (method-call dispatch) ([#279](https://github.com/optave/codegraph/pull/279))
* **cli:** add `exports <file>` command — per-symbol consumer analysis with re-export detection and counts ([#269](https://github.com/optave/codegraph/pull/269))
* **export:** add GraphML, GraphSON, Neo4j CSV formats and interactive HTML viewer (`codegraph plot`) with hierarchical/force/radial layouts, complexity overlays, and drill-down ([#268](https://github.com/optave/codegraph/pull/268))
* **cli:** add `normalizeSymbol` utility for stable 7-field JSON schema across all query and search commands ([#267](https://github.com/optave/codegraph/pull/267))
* **cli:** add batch-query multi-command mode with `splitTargets()` for comma-separated expansion and `multiBatchData()` for mixed-command orchestration ([#256](https://github.com/optave/codegraph/pull/256))
* **queries:** expose `fileHash` in `where` and `query` JSON output ([#257](https://github.com/optave/codegraph/pull/257))
* **builder:** add scoped rebuild for parallel agents ([#269](https://github.com/optave/codegraph/pull/269))

### Bug Fixes

* **queries:** correct reexport query direction and add exports integration tests ([#276](https://github.com/optave/codegraph/pull/276))
* **parser:** correct extractor line counts and duplicate section numbering ([fa7eee8](https://github.com/optave/codegraph/commit/fa7eee8))
* **triage:** map triage sort values to valid hotspot metrics ([a1583cb](https://github.com/optave/codegraph/commit/a1583cb))
* **complexity:** fix C# language ID mismatch (`c_sharp` → `csharp`) in `COMPLEXITY_RULES`, `HALSTEAD_RULES`, and `COMMENT_PREFIXES` ([#283](https://github.com/optave/codegraph/pull/283))
* **dataflow:** handle spread args, optional chaining, and reassignment in dataflow extraction ([#254](https://github.com/optave/codegraph/pull/254))

### Refactoring

* consolidate MCP tools — reduce surface from 32 to 29 by merging `fn_deps`/`symbol_path`/`list_entry_points` into `query` and `execution_flow` ([#263](https://github.com/optave/codegraph/pull/263))
* consolidate CLI — remove 5 redundant commands (`batch-query`, `hotspots`, `manifesto`, `explain`, `query --path`) in favor of unified alternatives ([#280](https://github.com/optave/codegraph/pull/280))
* consolidate MCP tools to match CLI changes from PR #280 ([cbda266](https://github.com/optave/codegraph/commit/cbda266))
* consolidate CFG rules with defaults factory and validation ([#284](https://github.com/optave/codegraph/pull/284))
* align dataflow.js with `normalizeSymbol` and `ALL_SYMBOL_KINDS` ([#285](https://github.com/optave/codegraph/pull/285))

### Documentation

* add architecture audit and roadmap for v2.7.0 ([5fe0a82](https://github.com/optave/codegraph/commit/5fe0a82))
* add competitive deep-dives for Joern and Narsil-MCP ([#260](https://github.com/optave/codegraph/pull/260), [#262](https://github.com/optave/codegraph/pull/262), [#264](https://github.com/optave/codegraph/pull/264), [#265](https://github.com/optave/codegraph/pull/265))
* add one-PR-one-concern rule to git conventions ([#281](https://github.com/optave/codegraph/pull/281))
* update references to consolidated CLI commands ([#282](https://github.com/optave/codegraph/pull/282))
* add TypeScript migration as Phase 4 in roadmap ([#255](https://github.com/optave/codegraph/pull/255))
* add Claude Code MCP registration to recommended practices ([#273](https://github.com/optave/codegraph/pull/273))

### Chores

* add CLA Assistant workflow ([#244](https://github.com/optave/codegraph/pull/244))
* add pre-commit diff-impact hook ([#271](https://github.com/optave/codegraph/pull/271))
* remove stale benchmark files from `generated/` ([#275](https://github.com/optave/codegraph/pull/275))

## [2.6.0](https://github.com/optave/codegraph/compare/v2.5.1...v2.6.0) (2026-03-02)

**CI validation, architecture boundaries, CODEOWNERS, multi-agent support, and incremental build reliability.** This release adds a `check` command for CI validation predicates (complexity, coverage, staleness gates), architecture boundary enforcement via manifesto rules with an onion-architecture preset, CODEOWNERS integration for ownership queries, `codegraph snapshot` for DB backup/restore, hybrid BM25 + semantic search via FTS5, composite `audit` and `triage` commands for risk-driven workflows, and batch querying for multi-agent dispatch. It also fixes several incremental rebuild bugs — EISDIR crashes on directory nodes, dropped barrel-file edges, orphaned complexity rows — and adds configurable drift detection to warn when incremental results diverge from full rebuilds.

### Features

* **cli:** add `check` command — CI validation predicates for complexity, coverage, staleness, and custom thresholds ([0a4c1bf](https://github.com/optave/codegraph/commit/0a4c1bf))
* **cli:** add `audit` command — composite risk audit combining explain + impact + health in one call ([6530d27](https://github.com/optave/codegraph/commit/6530d27))
* **cli:** add `triage` command — composite risk audit queue for prioritized review ([98b509f](https://github.com/optave/codegraph/commit/98b509f))
* **cli:** add `codegraph snapshot` for DB backup and restore ([8d7416b](https://github.com/optave/codegraph/commit/8d7416b))
* **cli:** add `codegraph owners` — CODEOWNERS integration for ownership queries ([36c6fdb](https://github.com/optave/codegraph/commit/36c6fdb))
* **manifesto:** add architecture boundary rules to manifesto engine ([79b9f32](https://github.com/optave/codegraph/commit/79b9f32))
* **boundaries:** add onion architecture preset to boundary rules ([c47ae76](https://github.com/optave/codegraph/commit/c47ae76))
* **embedder:** add hybrid BM25 + semantic search via FTS5 for combined keyword and vector ranking ([db3d3a3](https://github.com/optave/codegraph/commit/db3d3a3))
* **batch:** add batch querying for multi-agent dispatch ([850ef3e](https://github.com/optave/codegraph/commit/850ef3e))
* **mcp:** expose `check` as MCP tool ([3c36ef7](https://github.com/optave/codegraph/commit/3c36ef7))

### Bug Fixes

* **builder:** filter directory nodes from reverse-deps query to prevent EISDIR on incremental rebuilds ([#241](https://github.com/optave/codegraph/pull/241))
* **builder:** load unchanged barrel files into reexportMap so barrel-resolved edges aren't dropped during incremental rebuilds ([#241](https://github.com/optave/codegraph/pull/241))
* **builder:** purge `function_complexity` table on full rebuild — prevents orphaned rows accumulating across `--no-incremental` rebuilds ([#239](https://github.com/optave/codegraph/pull/239))
* **builder:** add node/edge count drift detection after incremental builds — warns when counts drift >20% and suggests `--no-incremental` ([#240](https://github.com/optave/codegraph/pull/240))
* **builder:** make drift threshold configurable via `build.driftThreshold` config (default 0.2) and include actual percentages in warning ([#240](https://github.com/optave/codegraph/pull/240))
* **complexity:** improve missing-data message — suggest `--no-incremental` rebuild instead of implying no graph exists ([#240](https://github.com/optave/codegraph/pull/240))
* **skill:** support dev build tarball installs in dogfood skill — branch Phase 0/4b pre-flight based on `-dev.` version detection ([#233](https://github.com/optave/codegraph/pull/233))
* **ci:** add `--strip` flag to `sync-native-versions.js` removing platform optionalDependencies in dev builds, fixing `npm install` failures ([#241](https://github.com/optave/codegraph/pull/241))
* **ci:** sync Cargo.toml version with package.json and automate via version script ([#241](https://github.com/optave/codegraph/pull/241))
* **owners:** add CODEOWNERS parse cache and tighten email validation ([f35c797](https://github.com/optave/codegraph/commit/f35c797))
* **bench:** add timeout and remove redundant stdio option ([978b590](https://github.com/optave/codegraph/commit/978b590))
* **ci:** save all benchmark reports and use git-based dev versioning ([267cabe](https://github.com/optave/codegraph/commit/267cabe))
* **docs:** correct ~20 inaccurate cells in feature comparison tables ([572268d](https://github.com/optave/codegraph/commit/572268d))
* **docs:** correct remaining MCP tool count in README (24/25 → 26/27) ([262874a](https://github.com/optave/codegraph/commit/262874a))

### Testing

* add barrel-project fixture and incremental-parity test for edge consistency across rebuild modes ([#241](https://github.com/optave/codegraph/pull/241))

### Refactoring

* organize `generated/` into `benchmarks/` and `dogfood/` subdirs ([35bfa3c](https://github.com/optave/codegraph/commit/35bfa3c))

### Dependencies

* bump web-tree-sitter from 0.26.5 to 0.26.6 ([70f26c0](https://github.com/optave/codegraph/commit/70f26c0))
* bump tree-sitter-cli from 0.26.5 to 0.26.6 ([161c2a0](https://github.com/optave/codegraph/commit/161c2a0))
* bump @modelcontextprotocol/sdk from 1.26.0 to 1.27.1 ([1385207](https://github.com/optave/codegraph/commit/1385207))
* consolidate Dependabot bumps (Actions + commitlint v20) ([d48be1a](https://github.com/optave/codegraph/commit/d48be1a))

## [2.5.1](https://github.com/optave/codegraph/compare/v2.5.0...v2.5.1) (2026-02-28)

**Critical fix: recover missing `branch-compare` command and broken programmatic API.** The `branch-compare` command and its implementation file were never committed in v2.5.0, causing `codegraph branch-compare` to crash and `import('@optave/codegraph')` to fail entirely due to a top-level re-export of the missing module. This patch recovers the full implementation (568 lines), adds an export guard test to prevent regressions, and introduces `--dry-run` for `registry prune`.

### Bug Fixes

* **cli:** recover `branch-compare` implementation — command was registered in cli.js and index.js but `src/branch-compare.js` was never committed, crashing both the CLI command and the entire programmatic API ([2ee10d4](https://github.com/optave/codegraph/commit/2ee10d4), [3d1224d](https://github.com/optave/codegraph/commit/3d1224d))
* **registry:** add `--dry-run` flag to `registry prune` — preview what would be removed without deleting entries ([2ee10d4](https://github.com/optave/codegraph/commit/2ee10d4))
* **bench:** remove unnecessary `shell: true` from `execFileSync` — minor security hardening ([14d03ce](https://github.com/optave/codegraph/commit/14d03ce))
* **docs:** correct dogfood benchmark data from stale v2.4.0 native binary — native complexity was reported as 2.2x slower than WASM when it's actually 47x faster ([3d1224d](https://github.com/optave/codegraph/commit/3d1224d))
* **skill:** add native binary version check to dogfood benchmark phase to prevent stale binary misreports ([3d1224d](https://github.com/optave/codegraph/commit/3d1224d))

### Testing

* add `index-exports` unit test — validates all re-exports in index.js resolve without `ERR_MODULE_NOT_FOUND` ([2ee10d4](https://github.com/optave/codegraph/commit/2ee10d4))
* add `branch-compare` integration tests (7 tests, 192 lines) ([3d1224d](https://github.com/optave/codegraph/commit/3d1224d))
* add `registry prune --dry-run` unit tests ([2ee10d4](https://github.com/optave/codegraph/commit/2ee10d4))

### Documentation

* update build performance benchmarks for 2.5.0 ([eb52074](https://github.com/optave/codegraph/commit/eb52074))
* add dogfood report for v2.5.0 ([3d1224d](https://github.com/optave/codegraph/commit/3d1224d))
* reframe Principle 5 from library-first to CLI-first identity ([3d1224d](https://github.com/optave/codegraph/commit/3d1224d))

## [2.5.0](https://github.com/optave/codegraph/compare/v2.4.0...v2.5.0) (2026-02-27)

**Complexity analysis, community detection, execution flow tracing, and manifesto rule engine.** This release adds a full code quality suite — cognitive, cyclomatic, Halstead, and Maintainability Index metrics for all 11 supported languages — with native Rust parity for maximum performance. Louvain community detection surfaces module boundaries and drift. A configurable manifesto rule engine enables CI-gated quality thresholds. Execution flow tracing lets you follow call paths through the codebase. Dev builds now publish as GitHub pre-releases instead of npm.

### Features

* **cli:** add cognitive & cyclomatic complexity metrics with per-function and file-level analysis ([35f6176](https://github.com/optave/codegraph/commit/35f6176))
* **cli:** add Halstead metrics (volume, difficulty, effort, bugs) and Maintainability Index ([452d9e9](https://github.com/optave/codegraph/commit/452d9e9))
* **cli:** add multi-language complexity analysis — extend metrics to all 11 supported languages ([b1166e0](https://github.com/optave/codegraph/commit/b1166e0))
* **cli:** add execution flow tracing — `flow` command and MCP tools for tracing call paths ([bc33f3b](https://github.com/optave/codegraph/commit/bc33f3b))
* **cli:** add `path` command for shortest-path queries between symbols ([ef0ea81](https://github.com/optave/codegraph/commit/ef0ea81))
* **communities:** add Louvain community detection for module boundary analysis and drift detection ([f3e36ad](https://github.com/optave/codegraph/commit/f3e36ad))
* **manifesto:** add configurable pass/fail rule engine with warn/fail thresholds for CI gates ([5a7d039](https://github.com/optave/codegraph/commit/5a7d039))
* **native:** add Halstead, LOC, and MI metrics to Rust native engine — full metrics parity across all 8 extractors ([44fe899](https://github.com/optave/codegraph/commit/44fe899))
* **embedder:** interactive install prompt for `@huggingface/transformers` when missing ([8e717b2](https://github.com/optave/codegraph/commit/8e717b2))
* **builder:** add build metadata tracking and `excludeTests` config shorthand ([f65b364](https://github.com/optave/codegraph/commit/f65b364))
* **structure:** add file limit to structure tool to reduce token usage ([2c565fa](https://github.com/optave/codegraph/commit/2c565fa))
* **ci:** publish dev builds as GitHub pre-releases instead of npm ([70c7627](https://github.com/optave/codegraph/commit/70c7627))
* **ci:** benchmark dev/release versioning and npm source resolution ([5d532a6](https://github.com/optave/codegraph/commit/5d532a6))

### Performance

* **native:** eliminate WASM re-parse for native complexity + build optimizations ([b8c8ca7](https://github.com/optave/codegraph/commit/b8c8ca7))
* **native:** native complexity computation for all languages with phase breakdown benchmarks ([231e941](https://github.com/optave/codegraph/commit/231e941))

### Bug Fixes

* **builder:** incremental rebuild drops edges from unchanged files ([9c3e3ba](https://github.com/optave/codegraph/commit/9c3e3ba))
* **queries:** scope-aware caller selection for nested functions ([72497dc](https://github.com/optave/codegraph/commit/72497dc))
* **complexity:** sanitize threshold values in complexity SQL queries ([c5ca1f2](https://github.com/optave/codegraph/commit/c5ca1f2))
* **builder:** upgrade build metadata failure log from debug to warn ([1c60b88](https://github.com/optave/codegraph/commit/1c60b88))
* **cli:** embed `--db` flag, DB locking, prerelease check, build logging improvements ([6a700b2](https://github.com/optave/codegraph/commit/6a700b2))
* **native:** add win32 native binary to optionalDependencies, fix embedder crashes ([f026c6a](https://github.com/optave/codegraph/commit/f026c6a))
* **hooks:** hook resilience for git ops, regex bypass, and worktree isolation ([2459cfc](https://github.com/optave/codegraph/commit/2459cfc))
* **ci:** benchmark uses stale native addon from npm ([83f2d4e](https://github.com/optave/codegraph/commit/83f2d4e))
* **ci:** preserve hand-written notes in benchmark report regeneration ([2d79f18](https://github.com/optave/codegraph/commit/2d79f18))
* **ci:** benchmark script regex + workflow branch naming ([53fc34f](https://github.com/optave/codegraph/commit/53fc34f))
* **ci:** harden benchmark workflow against transient npm failures ([1b97fb9](https://github.com/optave/codegraph/commit/1b97fb9))
* **ci:** isolate publish concurrency by event type ([529bf6f](https://github.com/optave/codegraph/commit/529bf6f))
* **ci:** use npx for license-checker to avoid intermittent 403 errors ([84e8e38](https://github.com/optave/codegraph/commit/84e8e38))
* **ci:** force-add gitignored DEPENDENCIES.json in release workflow ([fe22813](https://github.com/optave/codegraph/commit/fe22813))
* **ci:** add error handling to dev release pruning step ([fe45512](https://github.com/optave/codegraph/commit/fe45512))

### Refactoring

* simplify redundant `unwrap_or` pattern in complexity.rs ([150c3eb](https://github.com/optave/codegraph/commit/150c3eb))

### Testing

* add unit tests for interactive install prompt ([cc7c3e1](https://github.com/optave/codegraph/commit/cc7c3e1))

### Documentation

* complexity, communities, manifesto across all docs ([8f12f66](https://github.com/optave/codegraph/commit/8f12f66))
* correct engine parity section — 100% parity confirmed ([55c8ee3](https://github.com/optave/codegraph/commit/55c8ee3))
* update build performance benchmarks ([550b3b5](https://github.com/optave/codegraph/commit/550b3b5), [ea6b050](https://github.com/optave/codegraph/commit/ea6b050), [15e893c](https://github.com/optave/codegraph/commit/15e893c))

## [2.4.0](https://github.com/optave/codegraph/compare/v2.3.0...v2.4.0) (2026-02-25)

**Co-change analysis, node roles, faster parsing, and richer Mermaid output.** This release adds git co-change analysis to surface files that change together, classifies nodes by architectural role (entry/core/utility/adapter/dead/leaf), replaces the manual AST walk with tree-sitter's Query API for significantly faster JS/TS/TSX extraction, and enhances Mermaid export with subgraphs, edge labels, node shapes, and styling.

### Features

* **cli:** add git co-change analysis — surfaces files that frequently change together using Jaccard similarity on git history ([61785f7](https://github.com/optave/codegraph/commit/61785f7))
* **cli:** add node role classification — automatically labels nodes as entry, core, utility, adapter, dead, or leaf based on graph topology ([165f6ca](https://github.com/optave/codegraph/commit/165f6ca))
* **cli:** add `--json` to `search`, `--file` glob filter, `--exclude` to `prune`, exclude worktrees from vitest ([00ed205](https://github.com/optave/codegraph/commit/00ed205))
* **cli:** add update notification after commands — checks npm for newer versions and displays an upgrade hint ([eb3ccdf](https://github.com/optave/codegraph/commit/eb3ccdf))
* **export:** enhance Mermaid export with subgraphs, edge labels, node shapes, and styling ([ae301c0](https://github.com/optave/codegraph/commit/ae301c0))

### Performance

* **parser:** replace manual AST walk with tree-sitter Query API for JS/TS/TSX extraction ([fb6a139](https://github.com/optave/codegraph/commit/fb6a139))
* **builder:** avoid disk reads for line counts during incremental rebuild ([7b538bc](https://github.com/optave/codegraph/commit/7b538bc))

### Bug Fixes

* **builder:** preserve structure data during incremental builds ([7377fd9](https://github.com/optave/codegraph/commit/7377fd9))
* **embedder:** make embed command respect config `embeddings.model` ([77ffffc](https://github.com/optave/codegraph/commit/77ffffc))
* **embedder:** use `DEFAULT_MODEL` as single source of truth for embed default ([832fa49](https://github.com/optave/codegraph/commit/832fa49))
* **embedder:** add model disposal to prevent ONNX memory leak ([383e899](https://github.com/optave/codegraph/commit/383e899))
* **export:** escape quotes in Mermaid labels ([1c4ca34](https://github.com/optave/codegraph/commit/1c4ca34))
* **queries:** recompute Jaccard from total file counts during incremental co-change analysis ([e2a771b](https://github.com/optave/codegraph/commit/e2a771b))
* **queries:** collect all distinct edge kinds per pair instead of keeping only first ([4f40eee](https://github.com/optave/codegraph/commit/4f40eee))
* **queries:** skip keys without `::` separator in role lookup ([0c10e23](https://github.com/optave/codegraph/commit/0c10e23))
* **resolve:** use `indexOf` for `::` split to handle paths with colons ([b9d6ae4](https://github.com/optave/codegraph/commit/b9d6ae4))
* validate glob patterns and exclude names, clarify regex escaping ([6cf191f](https://github.com/optave/codegraph/commit/6cf191f))
* clean up regex escaping and remove unsupported brace from glob detection ([ab0d3a0](https://github.com/optave/codegraph/commit/ab0d3a0))
* **ci:** prevent benchmark updater from deleting README subsections ([bd1682a](https://github.com/optave/codegraph/commit/bd1682a))
* **ci:** add `--allow-same-version` to `npm version` in publish workflow ([9edaf15](https://github.com/optave/codegraph/commit/9edaf15))

### Refactoring

* reuse `coChangeForFiles` in `diffImpactData` ([aef1787](https://github.com/optave/codegraph/commit/aef1787))

### Testing

* add query vs walk parity tests for JS/TS/TSX extractors ([e68f6a7](https://github.com/optave/codegraph/commit/e68f6a7))

### Chores

* configure `bge-large` as default embedding model ([c21c387](https://github.com/optave/codegraph/commit/c21c387))

### Documentation

* add co-change analysis to README and mark backlog #9 done ([f977f9c](https://github.com/optave/codegraph/commit/f977f9c))
* reorganize docs — move guides to `docs/guides/`, roadmap into `docs/` ([ad423b7](https://github.com/optave/codegraph/commit/ad423b7))
* move roadmap files into `docs/roadmap/` ([693a8aa](https://github.com/optave/codegraph/commit/693a8aa))
* add Plan Mode Default working principle to CLAUDE.md ([c682f38](https://github.com/optave/codegraph/commit/c682f38))

## [2.3.0](https://github.com/optave/codegraph/compare/v2.2.1...v2.3.0) (2026-02-23)

**Smarter embeddings, richer CLI output, and robustness fixes.** This release introduces graph-enriched embedding strategies that use dependency context instead of raw source code, adds config-level test exclusion and recursive explain depth, outputs Mermaid diagrams from `diff-impact`, filters low-confidence edges from exports, and fixes numerous issues found through dogfooding.

### Features

* **embeddings:** graph-enriched embedding strategy — uses callers/callees from the dependency graph instead of raw source (~100 tokens vs ~360 avg), with context window overflow detection and `--strategy` flag ([c5dcd59](https://github.com/optave/codegraph/commit/c5dcd59))
* **cli:** add `excludeTests` config option with `--include-tests` CLI override ([56135e7](https://github.com/optave/codegraph/commit/56135e7))
* **cli:** add `--depth` option to `explain` for recursive dependency exploration ([56135e7](https://github.com/optave/codegraph/commit/56135e7))
* **cli:** add coupling score column to `map` command output ([56135e7](https://github.com/optave/codegraph/commit/56135e7))
* **cli:** add Mermaid output to `diff-impact` command for visual impact diagrams ([d2d767f](https://github.com/optave/codegraph/commit/d2d767f))
* **export:** add `--min-confidence` filter (default 0.5) to DOT/Mermaid/JSON exports ([08057f0](https://github.com/optave/codegraph/commit/08057f0))
* **skill:** add `/dogfood` skill for automated release validation — install, test, compare engines, generate report ([c713ce6](https://github.com/optave/codegraph/commit/c713ce6))
* **ci:** add query, incremental, and embedding regression benchmarks ([0fd1967](https://github.com/optave/codegraph/commit/0fd1967), [e012426](https://github.com/optave/codegraph/commit/e012426))

### Performance

* **parser:** reduce WASM boundary crossings in JS extractor for faster parsing ([d4ef6da](https://github.com/optave/codegraph/commit/d4ef6da))

### Bug Fixes

* **cli:** graceful error for `cycles`, `export`, `embed` when no `graph.db` exists ([3f56644](https://github.com/optave/codegraph/commit/3f56644))
* **embedder:** fix `splitIdentifier` lowercasing that broke camelCase search relevance ([dd71a64](https://github.com/optave/codegraph/commit/dd71a64))
* **embedder:** change default model to minilm (public, no auth required) with clear error guidance ([08057f0](https://github.com/optave/codegraph/commit/08057f0))
* **embedder:** split camelCase/snake_case identifiers in embedding text for better search relevance ([08057f0](https://github.com/optave/codegraph/commit/08057f0))
* **builder:** invalidate embeddings when nodes are deleted during incremental rebuild ([08057f0](https://github.com/optave/codegraph/commit/08057f0))
* **builder:** handle concurrent file edits and symlink loops in watcher/builder ([6735967](https://github.com/optave/codegraph/commit/6735967))
* **builder:** use busy-wait sleep instead of `Atomics.wait` for broader compatibility ([24f8ab1](https://github.com/optave/codegraph/commit/24f8ab1))
* **builder:** move engine status messages from stdout to stderr ([56135e7](https://github.com/optave/codegraph/commit/56135e7))
* **structure:** treat `.` as no filter in `structureData()` ([08057f0](https://github.com/optave/codegraph/commit/08057f0))
* **hooks:** add missing shebangs to husky hooks for Windows compatibility ([b1e012c](https://github.com/optave/codegraph/commit/b1e012c))
* **hooks:** track `mv`/`git mv`/`cp` commands in session edit log ([cfe633b](https://github.com/optave/codegraph/commit/cfe633b))
* **ci:** use PR instead of direct push for green-path version pin ([beddf94](https://github.com/optave/codegraph/commit/beddf94))
* **ci:** skip dev publish when merging release version bump PR ([ceb4c9a](https://github.com/optave/codegraph/commit/ceb4c9a))

### Refactoring

* **cli:** rename `--include-test-source` to `--with-test-source` for clarity ([242066f](https://github.com/optave/codegraph/commit/242066f))
* **builder:** lazy-load `node:os` to reduce startup overhead ([603ee55](https://github.com/optave/codegraph/commit/603ee55))

### Testing

* add `readFileSafe` and symlink loop detection tests ([5ae1cde](https://github.com/optave/codegraph/commit/5ae1cde))
* add embedding strategy benchmark and tests ([56a0517](https://github.com/optave/codegraph/commit/56a0517), [b8ce77c](https://github.com/optave/codegraph/commit/b8ce77c))

### Documentation

* add STABILITY.md with anticipated stability policy ([d3dcad5](https://github.com/optave/codegraph/commit/d3dcad5))
* add LLM integration feature planning document ([3ac5138](https://github.com/optave/codegraph/commit/3ac5138))
* add feature backlog and reorganize planning docs into `roadmap/` ([088b797](https://github.com/optave/codegraph/commit/088b797))
* reorganize README — lead with problem and value, not competition ([545aa0f](https://github.com/optave/codegraph/commit/545aa0f))
* add benchmarks section to CONTRIBUTING.md ([8395059](https://github.com/optave/codegraph/commit/8395059))

## [2.2.1](https://github.com/optave/codegraph/compare/v2.2.0...v2.2.1) (2026-02-23)

### Bug Fixes

* **embedder:** change default embedding model from jina-code to nomic-v1.5 ([f40bb91](https://github.com/optave/codegraph/commit/f40bb91))
* **config:** update config default and test to match nomic-v1.5 change ([3a88b4c](https://github.com/optave/codegraph/commit/3a88b4c))
* **ci:** run benchmark after publish to prevent workflow cancellation ([68e274e](https://github.com/optave/codegraph/commit/68e274e))

## [2.2.0](https://github.com/optave/codegraph/compare/v2.1.0...v2.2.0) (2026-02-23)

**New query commands, smarter call resolution, and full `--no-tests` coverage.** This release adds `explain`, `where`, and `context` commands for richer code exploration, introduces three-tier incremental change detection, improves call resolution accuracy, and extends the `--no-tests` flag to every query command.

### Features

* **cli:** add `codegraph explain <file|function>` command — structural summary without an LLM ([ff72655](https://github.com/optave/codegraph/commit/ff72655))
* **cli:** add `codegraph where <name>` command — fast symbol lookup for definition and usage ([7fafbaa](https://github.com/optave/codegraph/commit/7fafbaa))
* **cli:** add `codegraph context <name>` command — full function context (source, deps, callers) in one call ([3fa88b4](https://github.com/optave/codegraph/commit/3fa88b4))
* **cli:** add graph quality score to `stats` command ([130a52a](https://github.com/optave/codegraph/commit/130a52a))
* **cli:** add `--no-tests` flag to all remaining query commands for consistent test file filtering ([937b60f](https://github.com/optave/codegraph/commit/937b60f))
* **parser:** extract symbols from Commander/Express/Event callback patterns ([2ac24ef](https://github.com/optave/codegraph/commit/2ac24ef))
* **builder:** three-tier incremental change detection — skip unchanged, reparse modified, clean removed ([4b50af1](https://github.com/optave/codegraph/commit/4b50af1))
* **hooks:** add remind-codegraph hook to nudge agents before editing ([e6ddeea](https://github.com/optave/codegraph/commit/e6ddeea))
* **ci:** automated performance benchmarks per release ([f79d6f2](https://github.com/optave/codegraph/commit/f79d6f2))
* **ci:** add `workflow_dispatch` trigger for retrying failed stable releases ([8d4f0cb](https://github.com/optave/codegraph/commit/8d4f0cb))

### Bug Fixes

* **resolve:** improve call resolution accuracy with scoped fallback, dedup, and built-in skip ([3a11191](https://github.com/optave/codegraph/commit/3a11191))
* **parser:** add receiver field to call sites to eliminate false positive edges ([b08c2b2](https://github.com/optave/codegraph/commit/b08c2b2))
* **queries:** `statsData` fully filters test nodes and edges when `--no-tests` is set ([2f9730a](https://github.com/optave/codegraph/commit/2f9730a))
* **mcp:** fix file/kind parameter handling in MCP handlers ([d5af194](https://github.com/optave/codegraph/commit/d5af194))
* **mcp:** use schema objects for `setRequestHandler` instead of string literals ([fa0d358](https://github.com/optave/codegraph/commit/fa0d358))
* **security:** add path traversal guard and debug logging to file read helpers ([93a9bcf](https://github.com/optave/codegraph/commit/93a9bcf))
* **hooks:** fix Claude Code hooks for Windows and add branch name validation ([631e27a](https://github.com/optave/codegraph/commit/631e27a))
* **hooks:** add required `hookSpecificOutput` fields for context injection ([d51a3a4](https://github.com/optave/codegraph/commit/d51a3a4))
* **hooks:** guard-git hook validates branch name on `gh pr create` ([c9426fa](https://github.com/optave/codegraph/commit/c9426fa))
* **ci:** rewrite Claude Code workflow for working automated PR reviews ([1ed4121](https://github.com/optave/codegraph/commit/1ed4121))
* **ci:** move publish artifacts to `$RUNNER_TEMP` to prevent repo contamination ([d9849fa](https://github.com/optave/codegraph/commit/d9849fa))
* **ci:** make publish workflow resilient to partial failures ([5dd5b00](https://github.com/optave/codegraph/commit/5dd5b00))
* **ci:** validate version input in `workflow_dispatch` ([73a1e6b](https://github.com/optave/codegraph/commit/73a1e6b))
* fix default embedding model in README and enforce LF line endings ([c852707](https://github.com/optave/codegraph/commit/c852707))
* exclude dev dependencies from DEPENDENCIES.md ([63c6923](https://github.com/optave/codegraph/commit/63c6923))

### Documentation

* add AI Agent Guide with 6-step workflow, command reference, and MCP mapping ([5965fb4](https://github.com/optave/codegraph/commit/5965fb4))
* rewrite adding-a-language guide for LANGUAGE_REGISTRY architecture ([8504702](https://github.com/optave/codegraph/commit/8504702))
* add Codegraph vs Narsil-MCP and GitNexus comparison sections to README ([aac963c](https://github.com/optave/codegraph/commit/aac963c))
* update CLAUDE.md dogfooding section to follow recommended practices ([04dbfe6](https://github.com/optave/codegraph/commit/04dbfe6))
* update Claude Code hooks section with enrichment pattern and Windows notes ([4987de9](https://github.com/optave/codegraph/commit/4987de9))

## [2.1.0](https://github.com/optave/codegraph/compare/v2.0.0...v2.1.0) (2026-02-23)

**Parser refactor, unified publish pipeline, and quality-of-life improvements.** This release splits the monolithic parser into per-language extractor files, consolidates the dev and stable publish workflows into a single pipeline, adds the `codegraph stats` command, and hardens native engine path handling and registry management.

### Features

* **cli:** add `codegraph stats` command for graph health overview — node/edge counts, language breakdown, staleness check ([12f89fa](https://github.com/optave/codegraph/commit/12f89fa))
* **registry:** add TTL-based pruning for idle entries — stale repos auto-removed on access ([5e8c41b](https://github.com/optave/codegraph/commit/5e8c41b))
* **ci:** consolidate dev + stable publish into a single `publish.yml` workflow with automatic channel detection ([bf1a16b](https://github.com/optave/codegraph/commit/bf1a16b))
* **ci:** add embedding regression test with real ML model validation and dedicated weekly workflow ([5730a65](https://github.com/optave/codegraph/commit/5730a65))
* **ci:** add worktree workflow hooks (`guard-git.sh`, `track-edits.sh`) for parallel session safety ([e16dfeb](https://github.com/optave/codegraph/commit/e16dfeb))

### Bug Fixes

* **hooks:** replace `jq` with `node` in hooks for Windows compatibility ([ac0b198](https://github.com/optave/codegraph/commit/ac0b198))
* **native:** throw on explicit `--engine native` when addon is unavailable instead of silently falling back ([02b931d](https://github.com/optave/codegraph/commit/02b931d))
* **native:** normalize import paths to remove `.` and `..` segments in native engine ([5394078](https://github.com/optave/codegraph/commit/5394078))
* **native:** add JS-side `path.normalize()` defense-in-depth for native resolve ([e1222df](https://github.com/optave/codegraph/commit/e1222df))
* **registry:** auto-prune stale entries and skip temp dir registration ([d0f3e97](https://github.com/optave/codegraph/commit/d0f3e97))
* **tests:** isolate CLI tests from real registry via `CODEGRAPH_REGISTRY_PATH` env var ([dea0c3a](https://github.com/optave/codegraph/commit/dea0c3a))
* **ci:** prevent publish crash on pre-existing tags ([6906448](https://github.com/optave/codegraph/commit/6906448))
* **ci:** harden publish workflow version resolution ([1571f2a](https://github.com/optave/codegraph/commit/1571f2a))
* **ci:** use PR-based version bumps to avoid pushing directly to protected main branch ([3aab964](https://github.com/optave/codegraph/commit/3aab964))

### Refactoring

* **parser:** split monolithic `parser.js` extractors into per-language files under `src/extractors/` ([92b2d23](https://github.com/optave/codegraph/commit/92b2d23))
* **parser:** rename generic `walk` to language-specific names in all extractors ([6ed1f59](https://github.com/optave/codegraph/commit/6ed1f59))

### Documentation

* expand competitive analysis from 21 to 135+ tools ([0a679aa](https://github.com/optave/codegraph/commit/0a679aa))
* add competitive analysis and foundation principles ([21a6708](https://github.com/optave/codegraph/commit/21a6708))
* reposition around always-fresh graph + optional LLM enhancement ([a403acc](https://github.com/optave/codegraph/commit/a403acc))
* add parallel sessions rules to CLAUDE.md ([1435803](https://github.com/optave/codegraph/commit/1435803))

## [2.0.0](https://github.com/optave/codegraph/compare/v1.4.0...v2.0.0) (2026-02-22)

**Phase 2.5 — Multi-Repo MCP & Structural Analysis.** This release adds multi-repo support for AI agents, structural analysis with architectural metrics, and hardens security across the MCP server and SQL layers.

### ⚠ BREAKING CHANGES

* **parser:** Node kinds now use language-native types — Go structs → `struct`, Rust structs/enums/traits → `struct`/`enum`/`trait`, Java enums → `enum`, C# structs/records/enums → `struct`/`record`/`enum`, PHP traits/enums → `trait`/`enum`, Ruby modules → `module`. Rebuild required: `codegraph build --no-incremental`. ([72535fb](https://github.com/optave/codegraph/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Features

* **mcp:** add multi-repo MCP support with global registry at `~/.codegraph/registry.json` — optional `repo` param on all 11 tools, new `list_repos` tool, auto-register on build ([54ea9f6](https://github.com/optave/codegraph/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* **mcp:** default MCP server to single-repo mode for security isolation — multi-repo access requires explicit `--multi-repo` or `--repos` opt-in ([49c07ad](https://github.com/optave/codegraph/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* **registry:** harden multi-repo registry — `pruneRegistry()` removes stale entries, `--repos` allowlist for repo-level access control, auto-suffix name collisions ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **structure:** add structural analysis with directory nodes, containment edges, and metrics (symbol density, avg fan-out, cohesion scores) ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **cli:** add `codegraph structure [dir]`, `codegraph hotspots`, and `codegraph registry list|add|remove|prune` commands ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **export:** extend DOT/Mermaid export with directory clusters ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **parser:** add `SYMBOL_KINDS` constant and granular node types across both WASM and native Rust extractors ([72535fb](https://github.com/optave/codegraph/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Bug Fixes

* **security:** eliminate SQL interpolation in `hotspotsData` — replace dynamic string interpolation with static map of pre-built prepared statements ([f8790d7](https://github.com/optave/codegraph/commit/f8790d772989070903adbeeb30720789890591d9))
* **parser:** break `parser.js` ↔ `constants.js` circular dependency by inlining path normalization ([36239e9](https://github.com/optave/codegraph/commit/36239e91de43a6c6747951a84072953ea05e2321))
* **structure:** add `NULLS LAST` to hotspots `ORDER BY` clause ([a41668f](https://github.com/optave/codegraph/commit/a41668f55ff8c18acb6dde883b9e98c3113abf7d))
* **ci:** add license scan allowlist for `@img/sharp-*` dual-licensed packages ([9fbb084](https://github.com/optave/codegraph/commit/9fbb0848b4523baca71b94e7bceeb569773c8b45))

### Testing

* add 18 unit tests for registry, 4 MCP integration tests, 4 CLI integration tests for multi-repo ([54ea9f6](https://github.com/optave/codegraph/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* add 277 unit tests and 182 integration tests for structural analysis ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* add MCP single-repo / multi-repo mode tests ([49c07ad](https://github.com/optave/codegraph/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* add registry hardening tests (pruning, allowlist, name collision) ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))

### Documentation

* add dogfooding guide for self-analysis with codegraph ([36239e9](https://github.com/optave/codegraph/commit/36239e91de43a6c6747951a84072953ea05e2321))

## [1.4.0](https://github.com/optave/codegraph/compare/v1.3.0...v1.4.0) (2026-02-22)

**Phase 2 — Foundation Hardening** is complete. This release hardens the core infrastructure: a declarative parser registry, a full MCP server, significantly improved test coverage, and secure credential management.

### Features

* **mcp:** expand MCP server from 5 to 11 tools — `fn_deps`, `fn_impact`, `diff_impact`, `semantic_search`, `export_graph`, `list_functions` ([510dd74](https://github.com/optave/codegraph/commit/510dd74ed14d455e50aa3166fa28cf90d05925dd))
* **config:** add `apiKeyCommand` for secure credential resolution via external secret managers (1Password, Bitwarden, Vault, pass, macOS Keychain) ([f3ab237](https://github.com/optave/codegraph/commit/f3ab23790369df00b50c75ae7c3b6bba47fde2c6))
* **parser:** add `LANGUAGE_REGISTRY` for declarative parser dispatch — adding a new language is now a single registry entry + extractor function ([cb08bb5](https://github.com/optave/codegraph/commit/cb08bb58adac8d7aa4d5fb6ea463ce6d3dba8007))

### Testing

* add unit tests for 8 core modules, improve coverage from 62% to 75% ([62d2694](https://github.com/optave/codegraph/commit/62d2694))
* add end-to-end CLI smoke tests ([15211c0](https://github.com/optave/codegraph/commit/15211c0))
* add 11 tests for `resolveSecrets` and `apiKeyCommand` integration
* make normalizePath test cross-platform ([36fa9cf](https://github.com/optave/codegraph/commit/36fa9cf))
* skip native engine parity tests for known Rust gaps ([7d89cd9](https://github.com/optave/codegraph/commit/7d89cd9))

### Documentation

* add secure credential management guide with examples for 5 secret managers
* update ROADMAP marking Phase 2 complete
* add community health files (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY)

### CI/CD

* add license compliance workflow and CI testing pipeline ([eeeb68b](https://github.com/optave/codegraph/commit/eeeb68b))
* add OIDC trusted publishing with `--provenance` for npm packages ([bc595f7](https://github.com/optave/codegraph/commit/bc595f7))
* add automated semantic versioning and commit enforcement ([b8e5277](https://github.com/optave/codegraph/commit/b8e5277))
* add Biome linter and formatter ([a6e6bd4](https://github.com/optave/codegraph/commit/a6e6bd4))

### Bug Fixes

* handle null `baseUrl` in native alias conversion ([d0077e1](https://github.com/optave/codegraph/commit/d0077e1))
* align native platform package versions with root ([93c9c4b](https://github.com/optave/codegraph/commit/93c9c4b))
* reset lockfile before `npm version` to avoid dirty-tree error ([6f0a40a](https://github.com/optave/codegraph/commit/6f0a40a))
