# Codegraph Architectural Audit

**Date:** 2026-03-26
**Version audited:** v3.4.0 (`@optave/codegraph@3.4.0`)
**Commit:** c8afa8f (worktree-architect-audit, based on main)
**Auditor perspective:** Principal architect, cold evaluation
**Methodology:** Codegraph self-analysis + manual source review + verified competitor research
**Previous audit:** First audit

---

## Executive Summary

Codegraph is a well-structured, pragmatically designed local code intelligence CLI that fills a genuine gap: deterministic, zero-cloud, function-level dependency analysis for AI coding agents. At 45K LOC TypeScript + 11K LOC Rust across 11 languages, it delivers real value with only 3 production dependencies. The architecture is sound for its current scale (~500 files) but faces three structural challenges: (1) a 37-file import cycle in the MCP tool barrel, (2) a monolithic 1,851-line types.ts that every module depends on, and (3) a graph quality score of 64/100 with only 29% caller coverage — meaning the tool's own analysis of itself reveals significant blind spots in call resolution. The dual-engine strategy (Rust native + WASM fallback) is architecturally justified but carries real maintenance cost with 11K LOC of Rust extractors that duplicate JS logic. The competitive position is defensible: no other open-source tool combines local-only, deterministic, function-level graphs, MCP server, and multi-language support in a single CLI.

---

## Scorecard

| Dimension | Score | Justification |
|-----------|-------|---------------|
| **Abstraction Quality** | 7/10 | Clean layer separation (shared → infrastructure → db → domain → features → presentation → cli). types.ts (1,851 LOC, 137 interfaces) is a centralized type hub — acceptable for TypeScript but creates a coupling magnet (fan-in 122). No god objects in logic layers. |
| **Coupling & Cohesion** | 6/10 | 37-file MCP barrel cycle is the worst offender. features/ cohesion is 0.04 (each feature is independent — low cohesion by metric but correct by design). Presentation layer at 0.16 cohesion. db/ exports 50+ functions as a flat surface. |
| **Scalability** | 6/10 | SQLite is single-writer. In-memory CodeGraph (adjacency list with Maps) will struggle past ~1M nodes. No streaming or pagination in graph building. Rust engine with rayon gives parsing scalability but the JS orchestration layer is the bottleneck. |
| **Correctness & Soundness** | 5/10 | Graph quality 64/100. Only 29% caller coverage (1,486/5,122 functions have >=1 caller). 81% call confidence. 3,742 dead-unresolved symbols suggest import resolution gaps. The tool is honest about this (quality score is prominent), but users may not understand that 71% of functions have zero detected callers. |
| **Type Safety** | 8/10 | Fully migrated to TypeScript (280 .ts files, 0 .js in src/). tsconfig targets es2022 with nodenext resolution. Path aliases (#shared/*, etc.) for clean imports. 70 bare `catch {}` blocks could be tightened. |
| **Error Handling** | 7/10 | Clean domain error hierarchy (CodegraphError → ParseError, DbError, ConfigError, ResolutionError, EngineError, AnalysisError, BoundaryError). 97 catch blocks, 70 bare catches. Errors are structured with code, file, and cause fields. |
| **Testing Strategy** | 7/10 | 115 test files, 32K LOC tests, 4,873 assertions. Good integration-heavy approach (31 integration tests). Parser tests for each language. No snapshot tests. Test-to-source LOC ratio: 0.71:1. Missing: property-based tests for resolution, fuzz tests for parsers. |
| **Security** | 8/10 | Only 3 prod deps (minimal attack surface). SQL queries use parameterized statements with whitelist validation on interpolated values. `execFileSync` used with array args (no shell injection). MCP server is local-only (stdio transport). |
| **API Design** | 8/10 | Curated programmatic API in index.ts — exports `*Data()` functions, not CLI formatters. Clean separation of data functions from presentation. Dual CJS/ESM output. Well-documented usage pattern. |
| **Documentation** | 7/10 | CLAUDE.md is comprehensive (serves as both human and AI documentation). ADR-001 is thorough. Missing: API reference docs, architecture diagrams, onboarding guide for contributors. |
| **Dependency Hygiene** | 9/10 | 3 prod deps (better-sqlite3, commander, web-tree-sitter). 7 optional deps (MCP SDK + platform binaries + huggingface). 20 dev deps. Minimal surface. Leiden algorithm vendored with MIT attribution. |
| **Dual Engine** | 6/10 | Justified by ADR-001 (performance + portability). 11K LOC Rust duplicates extraction logic. Parity is tested but not provably equivalent. Some analysis still falls back to WASM even in native mode. Maintenance cost is real. |

**Overall: 6.8/10** — Solid engineering for a local tool at this scale, with known weaknesses in analysis soundness and structural coupling.

---

## ADR Compliance Review

### ADR-001: Dual-Engine Architecture

**Status:** Followed, with noted gaps.

The codebase correctly implements the dual-engine architecture as described:
- Native Rust engine via napi-rs with WASM fallback ✓
- `--engine auto|native|wasm` flag ✓
- Platform-specific optional npm packages ✓
- Both engines feed the same SQLite graph ✓

**Trade-offs still accurate?** Yes. The ADR states "some analysis phases fall back to WASM even when native is selected" — this is still true. The Phase 6 (Native Analysis Acceleration) mentioned as future work has not been completed.

**Drift:** Minor. The ADR mentions "32K LOC JS" but the codebase has migrated to TypeScript (45K LOC). This is a positive evolution not reflected in the ADR text. The multi-repo integration mentioned in the trajectory is partially implemented (MCP multi-repo mode exists).

**Missing ADRs that should exist:**
1. **TypeScript migration** — A major architectural change (JS → TS) with no ADR documenting rationale, migration strategy, or build pipeline changes.
2. **Repository pattern in db/** — The shift from flat SQL functions to a Repository abstraction (SqliteRepository, InMemoryRepository) is an architectural decision without documentation.
3. **Vendored Leiden algorithm** — 1,685 LOC of vendored community detection code. Why vendor instead of depend? Why Leiden specifically?
4. **MCP tool architecture** — The barrel pattern that causes the 37-file cycle, the middleware layer, the lazy-loading strategy for SDK — all architectural choices worth documenting.

---

## Layer-by-Layer Findings

### 1. Types Layer (`src/types.ts` — 1,851 LOC)

**Abstraction Quality: 6/10**

This is the project's type hub: 137 interfaces, 28 type aliases, 1,011 symbols. Fan-in of 122 — the most imported file in the codebase. Every layer depends on it.

**The good:** Centralizing types avoids circular dependencies between modules that need to share types. TypeScript's structural typing means this file is really just a declaration file — no runtime code.

**The nuance:** The file is well-organized internally — 22 logical sections with clear `§` headers (§1-§2: symbol/edge kinds + DB rows, §3-§4: repository/extractor types, §5-§8: parser/AST/analysis, §9-§10: graph model/pipeline, §11: config, §12-§22: features/MCP/CLI). This is a deliberate integration contract, not an accidental dumping ground.

**The concern:** At 1,851 LOC, it's approaching the point where finding the right type requires scrolling through unrelated definitions. A principal architect would split this into domain-scoped type files (`types/db.ts`, `types/mcp.ts`, `types/graph.ts`, etc.) with a barrel re-export — but the current internal organization means this is a maintenance convenience issue, not a design flaw.

**Comparison:** Sourcegraph's type definitions are spread across domain packages. Semgrep uses OCaml's module system for type scoping. Joern uses Scala case classes per domain.

### 2. Database Layer (`src/db/` — 18 files, 327 symbols)

**Abstraction Quality: 7/10**

Clean Repository pattern with `SqliteRepository` and `InMemoryRepository` for testing. Query builder with SQL injection protections (whitelist validation on interpolated identifiers, parameterized queries for values). Migrations are sequential with version tracking.

**The good:**
- `query-builder.ts` validates all interpolated SQL identifiers against regex and whitelists
- `better-sqlite3` is synchronous — no async complexity, no connection pooling issues
- Repository abstraction enables in-memory testing

**The concern:**
- The `db/index.ts` barrel exports 50+ functions — the abstraction is leaking. External modules import specific low-level functions (`findCallerNames`, `findCallees`, `getCallEdges`) rather than going through a higher-level query API. The domain/analysis layer should be the only consumer of raw DB functions.
- Schema uses `db.exec()` with string literals for DDL (migrations) — acceptable since these are hardcoded strings, not user input.
- WAL mode is enabled (`pragma('journal_mode = WAL')`) with advisory locking via `.lock` files and 5000ms busy timeout — good for concurrent reads during builds.

**Scalability:** SQLite with WAL is fine for single-repo up to ~500K LOC. Beyond that, or for multi-repo with many concurrent writers, the single-writer model could become a bottleneck. For the tool's stated use case (local analysis), this is acceptable.

### 3. MCP Layer (`src/mcp/` — 40 files, 352 symbols)

**Abstraction Quality: 5/10**

The 37-file circular dependency cycle is the biggest structural flaw in the codebase.

**Root cause:** `tools/index.ts` (barrel) imports all 34 tool modules → each tool module imports `McpToolContext` type from `server.ts` → `server.ts` imports `TOOL_HANDLERS` from `tools/index.ts`. This is a type-only cycle at runtime (TypeScript's `import type` would break it), but codegraph correctly flags it because the actual imports are value imports.

**Fix:** Extract `McpToolContext` interface to a separate `types.ts` file in `mcp/`, or use `import type` consistently. This would eliminate the cycle entirely.

**The good:**
- Lazy-loading of `@modelcontextprotocol/sdk` (optional dependency)
- Clean handler registration pattern with `TOOL_HANDLERS` map
- Middleware layer for defaults and validation
- Single-repo isolation by default (security-conscious design)

**Comparison:** narsil-mcp also uses barrel exports for tools but avoids the cycle by separating types. Sourcegraph's API layer uses dependency injection to break similar cycles.

### 4. Parser Layer (`src/domain/parser.ts` — 686 LOC, fan-in 48)

**Abstraction Quality: 7/10**

`LANGUAGE_REGISTRY` is the single source of truth for all supported languages — clean registry pattern. Each language has an extractor function. The Rust engine duplicates this registry in `crates/codegraph-core/src/parser_registry.rs`.

**The concern:**
- Each Rust extractor (`extractors/javascript.rs` at 1,649 LOC, `python.rs` at 524 LOC, etc.) is a large `walk_node_depth` function — cognitive complexity 79-243. These are inherently complex (AST traversal with pattern matching), but the Rust extractors are harder to maintain than their JS counterparts because they lack the dynamic dispatch that makes JS extractors more concise.
- Adding a new language requires changes in both JS and Rust — the dual-engine cost is most visible here.

### 5. Graph Model (`src/graph/model.ts` — CodeGraph class)

**Abstraction Quality: 8/10**

Clean adjacency list implementation with `Map<string, Map<string, EdgeAttrs>>` for O(1) edge lookup. Supports directed and undirected graphs. Node IDs are strings (DB integer IDs are stringified). Auto-adds nodes on edge creation.

**The concern:**
- No edge deduplication — adding the same edge twice overwrites attributes silently.
- Memory: `Map<string, Map<string, EdgeAttrs>>` stores each edge in both `_successors` and `_predecessors` — 2x memory for directed graphs. At 10K nodes / 21K edges this is negligible, but at 1M nodes it adds up.
- No graph serialization/deserialization — the graph is always rebuilt from SQLite, never cached.

**Comparison:** Joern uses OverflowDB (disk-backed graph). Sourcegraph uses a custom index format. For codegraph's scale (local repos), in-memory is correct.

### 6. Features Layer (`src/features/` — 23 files, 8,850 LOC)

**Abstraction Quality: 7/10**

Each feature is a self-contained module exporting a `*Data()` function (pure data) and optionally a CLI formatter. Cohesion of 0.04 is misleading — features are intentionally independent. This is the right design.

**Largest files:** `dataflow.ts` (701 LOC), `structure.ts` (694 LOC), `cfg.ts` (579 LOC), `complexity.ts` (557 LOC). Only `dataflow.ts` marginally exceeds the 700 LOC threshold — overall discipline is good.

**The good:** Clear separation between data functions and presentation. Features compose domain layer functions without knowing about CLI or MCP.

### 7. Presentation Layer (`src/presentation/` — 31 files, 4,783 LOC)

**Abstraction Quality: 6/10**

`queries-cli/` has 0.00 cohesion — each file is a standalone formatter with no shared state or logic. This is correct (formatters should be independent) but the metric correctly identifies that these files don't form a coherent module.

**The concern:** `viewer.ts` (676 LOC) generates an entire HTML page with embedded JavaScript for vis-network visualization. This is a code-generation module, not a presentation layer in the traditional sense. It works but is brittle — any changes to the visualization require modifying string templates.

### 8. Infrastructure Layer (`src/infrastructure/` — 7 files, 79 symbols)

**Abstraction Quality: 8/10**

Lean and focused. `config.ts` handles multi-source configuration (file, env, secret resolution). `logger.ts` is a simple structured logger. `native.ts` handles the dual-engine loading with graceful fallback.

**The good:** `loadConfig` pipeline is clean: `mergeConfig → applyEnvOverrides → resolveSecrets`. Deep merge preserves sibling keys. `apiKeyCommand` uses `execFileSync` with array args (no shell injection).

### 9. Domain Analysis Layer (`src/domain/analysis/` — 11 files, 3,109 LOC)

**Abstraction Quality: 7/10**

Well-decomposed analysis functions: `dependencies.ts` (648 LOC), `context.ts` (546 LOC), `module-map.ts` (424 LOC), `diff-impact.ts` (356 LOC). Each is focused on one concern.

**The concern:** `diff-impact.ts` shells out to `git` via `execFileSync` — this is a hard dependency on git that isn't abstracted. If codegraph ever needs to support non-git repos (SVN, Mercurial), this would need refactoring. For now, acceptable since the tool explicitly targets git repos.

### 10. Vendored Leiden Algorithm (`src/graph/algorithms/leiden/` — 1,685 LOC)

**Abstraction Quality: 6/10**

Vendored from ngraph.leiden (MIT). Adapted to work with CodeGraph's adjacency list model via an adapter pattern. `optimiser.ts` (598 LOC) and `partition.ts` (479 LOC) are the most complex files, with cognitive complexity scores of 154 and 217 respectively.

**The concern:** These are the two highest-complexity functions in the entire JS codebase. The Leiden algorithm is mathematically complex, so high complexity is partially inherent, but `makePartition` at 217 cognitive complexity and `runLouvainUndirectedModularity` at 154 suggest the vendored code could benefit from refactoring into smaller functions.

**Build vs Buy:** The original `ngraph.leiden` package exists on npm. Vendoring was presumably done to avoid a dependency and to adapt the API to CodeGraph's model. With only 3 prod deps, this decision is consistent with the minimal-dependency philosophy. The trade-off is 1,685 LOC of complex vendored code that the team must maintain.

---

## Cross-Cutting Concerns

### 1. Type Safety

**Score: 8/10**

The TypeScript migration is complete (280 .ts files, 0 .js in src/). CLAUDE.md already reflects this correctly ("Source is TypeScript in `src/`, compiled via `tsup`").

`tsconfig.json` targets es2022 with `nodenext` module resolution. Path aliases (`#shared/*`, `#db/*`, etc.) keep imports clean. The build produces both ESM and CJS outputs.

**Concern:** 70 bare `catch {}` blocks without error typing. TypeScript's `catch` binds `unknown` by default — most catch blocks should type-narrow the error. This isn't a safety risk (errors are caught) but reduces debuggability.

### 2. Error Handling

**Score: 7/10**

Clean hierarchy: `CodegraphError` base class with domain-specific subclasses, each carrying `code`, `file`, and `cause` fields. Consistent pattern: domain code throws typed errors, CLI catches and formats.

**Concern:** 97 catch blocks total, 70 of which are bare catches. Many silently swallow errors with fallback behavior (graceful degradation), which is correct for a CLI tool but makes debugging harder. The recent commit (c8afa8f) "use safe error coercion in debug catch blocks" suggests this is actively being addressed.

### 3. Testing Strategy

**Score: 7/10**

- 115 test files, 32,538 LOC, 4,873 assertions
- Integration-heavy (31 integration tests) — correct for a tool that transforms input to database
- Parser tests for each language (20 files) — good coverage of the hot path
- Unit tests (30 files) for core logic
- Engine parity tests (4 files) — critical for dual-engine correctness
- Benchmark tests for resolution performance
- No snapshot tests, no property-based tests, no fuzz tests

**Test-to-source ratio:** 32K test LOC / 45K source LOC = 0.71:1. Decent but not exceptional.

**Missing:**
- Property-based tests for import resolution (the biggest source of false positives/negatives)
- Fuzz tests for parser extractors (tree-sitter grammars handle malformed input, but extractors may not)
- Mutation testing to validate assertion quality

### 4. Dual Engine Maintenance

**Score: 6/10**

The Rust engine (11,413 LOC) duplicates parsing, extraction, import resolution, complexity analysis, CFG generation, dataflow analysis, and cycle detection. The ADR acknowledges this cost and argues it's bounded to the hot path.

**Current state per ADR-001:** "Some analysis phases fall back to WASM even in native mode." This means `--engine native` is not purely native — it's a hybrid. The Phase 6 roadmap item to make native fully self-contained has not been completed.

**Maintenance risk:** The `walk_node_depth` function exists in 8 Rust extractors with cognitive complexity ranging from 79-243. Each language extractor is a large monolithic function. A bug in the traversal pattern must be fixed in 8+ places.

### 5. Dependency Hygiene

**Score: 9/10**

| Category | Count | Notable |
|----------|-------|---------|
| Production | 3 | better-sqlite3, commander, web-tree-sitter |
| Optional | 7 | MCP SDK, 5 platform binaries, huggingface/transformers |
| Dev | 20 | biome, vitest, napi-rs toolchain, tree-sitter grammars |

This is exceptional for a tool of this scope. Most competitors pull in dozens of production dependencies. The vendored Leiden (1,685 LOC) replaces what would be an npm dependency.

**Risk:** `better-sqlite3` requires native compilation (node-gyp) which can fail on some platforms. The `web-tree-sitter` WASM approach avoids this for the parser layer but the SQLite dependency is unavoidable.

### 6. Security Surface

**Score: 8/10**

- **SQL injection:** Mitigated via parameterized queries + whitelist validation on identifiers
- **Command injection:** `execFileSync` uses array args, not shell strings. `apiKeyCommand` config shells out but uses `execFileSync` with no shell
- **MCP server:** stdio transport only (no network exposure). Single-repo isolation by default
- **Dependencies:** 3 prod deps minimizes supply chain risk
- **File system:** Reads arbitrary files for parsing — expected behavior, but no sandboxing
- **No authentication:** MCP server has no auth — relies on the transport layer (stdio) for access control

**The one concern:** The `apiKeyCommand` config field runs an arbitrary command via `execFileSync`. If `.codegraphrc.json` is committed to a repo and an attacker modifies it, they could execute arbitrary commands when codegraph loads config. This is documented behavior (similar to `.npmrc` scripts) but worth noting.

### 7. API Design

**Score: 8/10**

The programmatic API (`index.ts`) exports 40+ functions with a clear naming convention: `*Data()` for data-returning functions, `export*` for serialization, `build*` for construction. Error classes are exported. Constants are exported. CLI formatters are explicitly excluded.

**The good:**
- Dual CJS/ESM output
- `loadConfig` exported for programmatic use
- Data functions return plain objects, not formatted strings

**The concern:** No TypeScript type exports from the package. Users importing `@optave/codegraph` get the functions but would need to import types from internal paths. The `types.ts` file should have its key interfaces re-exported from the package root.

### 8. Documentation

**Score: 7/10**

CLAUDE.md is the primary documentation — comprehensive, accurate, and serves both human developers and AI agents. ADR-001 is thorough.

**Missing:**
- API reference documentation (JSDoc exists but no generated docs)
- Architecture diagrams (the layer table in CLAUDE.md is good but a visual diagram would help)
- Contributor onboarding guide
- ~~CLAUDE.md references "JS source is plain JavaScript"~~ — already corrected; CLAUDE.md describes TypeScript source

---

## Competitive Verification

### Does Codegraph Have a Reason to Exist?

**Yes.** After verifying competitors, codegraph occupies a unique niche: **local-only, deterministic, function-level dependency graphs with MCP server support and zero cloud dependency.**

No other single tool combines all of:
1. Function-level (not just file-level) dependency resolution
2. MCP server for AI agent integration
3. Fully local — no cloud, no LLM required for core features
4. Deterministic analysis (same input → same output)
5. Multi-language support (11 languages)
6. Incremental builds
7. CLI + programmatic API + MCP in one package

### Verified Competitor Comparison

All claims verified against actual GitHub READMEs and source repositories. Items marked [UNVERIFIED] could not be confirmed from source.

| Feature | Codegraph | Sourcegraph | Joern | Semgrep | stack-graphs | narsil-mcp | CKB | GitNexus |
|---------|-----------|-------------|-------|---------|--------------|------------|-----|----------|
| **License** | MIT | **Proprietary** (no longer OSS) | Apache-2.0 | LGPL-2.1 (partial) | Apache/MIT (**archived**) | Apache-2.0 | Custom (free <$25K) | PolyForm NC |
| **MCP server** | Yes (built-in) | No | No (3rd party only) | Yes (built-in) | No | Yes (MCP-only) | Yes | Yes |
| **Standalone CLI** | Yes | Yes (src-cli) | Yes (Scala REPL) | Yes | No (library) | No | Yes | Yes |
| **Fully local** | Yes | No (server req'd) | Yes | Yes (CE) | Yes (library) | Yes | Yes | No (Docker+Memgraph) |
| **No LLM required** | Yes | Partial (Cody needs LLM) | Yes | Yes (CE) | Yes | Partial (neural search opt.) | Yes | No (RAG agent) |
| **Deterministic** | Yes | Yes (search) | Yes | Yes | Yes | Yes (core) | Yes | Partial |
| **Function-level deps** | Yes | No (search+nav) | Yes (CPG) | No (pattern match) | No (name resolution) | Partial (call graph) | Yes (SCIP-based) | Yes |
| **Incremental** | Yes (all 11 langs) | Via SCIP | No | PR-scoped | Yes (design goal) | File-level watch | **Go only** | [UNVERIFIED] |
| **Languages** | 11 | 10+ via SCIP | 6-7 core | 30+ | Framework (lang-agnostic) | 32 | 12 (tiered quality) | [UNVERIFIED] |
| **Prod deps** | 3 | Hundreds | JVM ecosystem | Python ecosystem | Rust (compiled) | Rust (compiled) | Go (compiled) | Node.js |
| **Storage** | SQLite | PostgreSQL | Custom graph DB | None (stateless) | N/A | In-memory+persist | SCIP index files | LadybugDB |
| **Stars** | — | 10.3K (archived snapshot) | 3.0K | 14.6K | 873 (archived) | 132 | 79 | 19.9K (very new) |
| **Status** | Active | Private/proprietary | Active | Active | **Archived** | Active | Active | Active (new, Feb 2026) |

### Key Competitive Insights

**Sourcegraph** is no longer open source. The main repo went private; only an archived public snapshot remains. The last Apache-licensed commit is explicitly marked. Current license is proprietary. Still the gold standard for code intelligence at scale, but no longer a viable open-source alternative. Codegraph's local-only, zero-setup approach is a genuine differentiator.

**Joern** (ShiftLeft) builds a Code Property Graph (CPG) — a superset of what codegraph builds (AST + CFG + PDG + call graph). Joern is more academically rigorous but requires JDK 21, has no incremental builds, and has no native MCP server (only 3rd-party wrappers). For security analysis, Joern is superior. For AI agent integration, codegraph wins.

**Semgrep** is pattern-based, not graph-based. It finds code patterns, not dependencies. Different tool category. Notable: Semgrep does have a built-in MCP server (`semgrep mcp`) and Claude Code plugin. Cross-file analysis is proprietary (Pro-only).

**stack-graphs** (GitHub) is **archived and abandoned**. README states: "This repository is no longer supported or updated by GitHub." Was a research-grade name resolution library using scope graph theory from TU Delft, not a user-facing tool.

**narsil-mcp** (132 stars) is MCP-native with 90 claimed tools and 32 languages. Closest competitor in the "local code intelligence for AI agents" space. Key gaps vs codegraph: no standalone CLI (MCP-only), optional LLM dependency for neural search, no SQLite persistence model. 90-tool breadth claim is ambitious for its maturity.

**CKB** (`SimplyLiz/CodeMCP`, 79 stars) is the most direct feature competitor — impact analysis, call graphs, dead code detection, MCP server, CLI. Key differences: SCIP-dependent for deep analysis (requires running language-specific indexers), incremental indexing is Go-only, custom restrictive license (free <$25K revenue, paid above).

**GitNexus** (19.9K stars, very new — trending Feb 2026) has an impressive feature set with browser-based zero-server mode and LadybugDB graph storage. However: **PolyForm Noncommercial license** blocks enterprise adoption, and the built-in "Graph RAG Agent" requires an LLM for queries.

### Competitive Moat Assessment

**Defensible differentiators:**
1. Only tool that combines MCP + CLI + programmatic API in one package
2. Only tool with deterministic, local, function-level analysis + semantic search
3. 11-language support with both native speed and universal WASM fallback
4. 3 production dependencies — smallest attack surface of any comparable tool
5. Self-dogfooding (uses itself for quality enforcement) — creates a virtuous cycle

**Not defensible:**
1. MCP server support is trivial to add — Semgrep already has `semgrep mcp`
2. Tree-sitter parsing is available to everyone — narsil-mcp uses it for 32 languages
3. Community detection and complexity metrics are well-known algorithms, not proprietary

**Threats:**
1. **GitNexus** (19.9K stars) has momentum but is noncommercial-licensed — if they relicense to MIT/Apache, it becomes the primary threat
2. **CKB** has the closest feature set but is SCIP-dependent and restrictively licensed
3. **narsil-mcp** could add a CLI and close the gap quickly (same tech stack, same tree-sitter base)
4. **JetBrains** or **Cursor** adding built-in code graph MCP tools would commoditize the AI agent integration angle

**Verdict:** The moat is the *combination* — no single feature is unique, but no competitor offers the same bundle with MIT license + zero LLM + all-language incremental + CLI + MCP + programmatic API. The licensing advantage over GitNexus and CKB is significant for enterprise adoption.

---

## Structural Census Summary

| Metric | Value |
|--------|-------|
| **Source files** | 280 (TypeScript) |
| **Source LOC** | 45,796 |
| **Rust LOC** | 11,413 |
| **Test files** | 115 |
| **Test LOC** | 32,538 |
| **Graph nodes** | 10,997 |
| **Graph edges** | 20,991 |
| **Graph quality** | 64/100 |
| **Caller coverage** | 29.0% (1,486/5,122) |
| **Call confidence** | 81.1% (3,273/4,035) |
| **File-level cycles** | 1 (37-file MCP barrel) |
| **Function-level cycles** | 8 |
| **Communities** | 107 (modularity: 0.48) |
| **Community drift** | 49% |
| **Avg cognitive complexity** | 8.5 |
| **Max cognitive complexity** | 243 (`walk_node_depth` in Rust extractor) |
| **Avg maintainability index** | 60.1 |
| **Functions above threshold** | 413 (of 1,769) |
| **Production dependencies** | 3 |
| **Dead code (total)** | 8,960 symbols (per `codegraph stats`) |
| **Dead code (callable)** | 198 functions + 3,287 methods |
| **Dead code (leaf nodes)** | 4,090 (parameters, properties, constants) |
| **Dead code (unresolved)** | 3,593 (import resolution gaps) |
| **Dead code (FFI)** | 211 (Rust napi boundary) |
| **Dead code (entry points)** | 391 (CLI commands, framework entry) |

### Dead Code Breakdown

The raw "8,960 dead" count from `codegraph stats` is misleading. The categorized breakdown below accounts for 8,285 of these; the remaining 675 are symbols that fall outside these five categories (e.g., uncategorized type aliases, re-exported symbols). Breaking down:

| Category | Count | Explanation |
|----------|-------|-------------|
| **dead-leaf** | 4,090 | Parameters, properties, constants — leaf nodes without callers. Most are struct fields, interface properties, and function parameters. Not actionable dead code. |
| **dead-unresolved** | 3,593 | Symbols whose callers couldn't be resolved. This reflects import resolution gaps, not actual dead code. Includes many TypeScript interface methods, framework callbacks, and dynamic dispatch. |
| **dead-entry** | 391 | CLI command handlers, MCP tool handlers, test helpers. These are framework entry points called by Commander/MCP, not by codegraph's own code. Correctly classified. |
| **dead-ffi** | 211 | Rust napi-rs boundary functions. Called from JS via native addon, not visible in the JS call graph. Correctly classified. |
| **Genuinely dead functions** | ~198 | After excluding leaf nodes (4,090), unresolved (3,593), entry points (391), and FFI (211), roughly 198 functions appear genuinely unreferenced. |

**By kind:** 3,328 dead parameters (expected — parameters are rarely "called"), 3,287 dead methods (mostly interface method declarations and type-only methods), 585 dead interfaces (TypeScript type declarations), 427 dead constants, 335 dead properties, 198 dead functions, 56 dead structs, 44 dead types, 21 dead classes, 3 dead enums, 1 dead trait.

**Verdict:** The actual dead callable code is ~198 functions out of 5,122 (3.9%). The 8,960 headline number includes 93% non-actionable symbols (leaf nodes, unresolved imports, entry points, FFI boundaries). Codegraph should consider reporting these categories separately by default.

### Complexity Hotspots

The top 5 most complex functions:

| Function | File | Cognitive | Cyclomatic | MI |
|----------|------|-----------|------------|-----|
| `walk_node_depth` | extractors/javascript.rs | 243 | 79 | 8.4 |
| `makePartition` | leiden/partition.ts | 217 | 97 | 5.0 |
| `runLouvainUndirectedModularity` | leiden/optimiser.ts | 154 | 46 | 29.8 |
| `build_call_edges` | edge_builder.rs | 146 | 49 | 22.1 |
| `extractGoTypeMapDepth` | extractors/go.ts | 143 | 48 | 37.6 |

The Rust extractors dominate the complexity rankings because each `walk_node_depth` is a monolithic AST traversal. The Leiden vendored code (partition + optimiser) is inherently algorithmic complexity. These are the maintenance risk areas.

---

## Strategic Verdict

### 1. Does Codegraph Have a Reason to Exist?

**Yes.** Verified against 6 competitors. No other tool offers:
- Local + deterministic + function-level + MCP + CLI + 11 languages + 3 deps

The closest competitor (narsil-mcp) is MCP-only with narrower analysis. The dominant player (Sourcegraph) requires cloud infrastructure. Joern requires JVM. stack-graphs is a library, not a tool.

Codegraph's value proposition — "give AI agents a deterministic code graph without cloud dependencies" — is real, verified, and currently unmatched.

### 2. Fundamental Design Flaws

These cannot be fixed incrementally:

1. **29% caller coverage means 71% of functions have no detected callers.** This is the tool's Achilles heel. Import resolution's 6-level fallback system is creative but fundamentally heuristic. For TypeScript projects (codegraph's primary audience), the tool should approach 80%+ caller coverage. The gap is likely caused by: dynamic imports, re-exports, barrel files, decorators, and framework-specific patterns (React hooks, Express middleware). **This is fixable** — TypeScript's type system provides information that could dramatically improve resolution. The tool should leverage `tsconfig.json` path mappings and TypeScript's module resolution algorithm rather than reimplementing a heuristic resolver.

2. **In-memory graph model has no persistence layer.** The CodeGraph adjacency list is rebuilt from SQLite on every query session. For large repos, this is wasteful. A memory-mapped or disk-backed graph (like Joern's OverflowDB) would allow graph queries without full materialization.

### 3. Missed Opportunities

1. **TypeScript-aware resolution.** The tool treats TypeScript as "JavaScript with types" for resolution purposes. A TypeScript-native resolver using `ts.createProgram` or the TypeScript Language Service would dramatically improve caller coverage for .ts/.tsx files — the tool's primary use case.

2. **LSP integration.** The tool builds its own symbol index. LSP servers (typescript-language-server, rust-analyzer) already maintain precise symbol indexes. Using LSP as a resolution backend for supported languages would improve precision with less code.

3. **Incremental graph queries.** Currently, queries hit SQLite. The tool could maintain a materialized graph in a background process (like a language server) that responds instantly to queries without DB round-trips.

4. **Call graph visualization in MCP.** The MCP server returns text results. Returning structured graph data (nodes + edges) that clients can render would be more useful for AI agents building mental models.

### 4. Kill List

Code that should be deleted, not improved:

1. **`src/vendor.d.ts` (40 LOC)** — Manual type declarations for `better-sqlite3`. The package has `@types/better-sqlite3` on DefinitelyTyped. Use the community types instead.

2. ~~**Stale CLAUDE.md references**~~ — Already resolved. CLAUDE.md correctly describes the source as TypeScript. No action needed.

### 5. Build vs Buy

| Component | Current | Recommendation |
|-----------|---------|----------------|
| Leiden community detection | Vendored (1,685 LOC) | Keep — consistent with minimal-dep philosophy, properly attributed |
| SQL query builder | Custom (200 LOC) | Keep — simple, well-validated, no ORM needed |
| CLI framework | Commander | Keep — lightweight, standard |
| Graph model | Custom CodeGraph class | Keep for now — consider `graphology` npm package if features grow |
| Config loading | Custom | Keep — clean implementation, handles secret resolution |

No changes recommended. The custom code is justified and well-maintained.

### 6. Roadmap Critique

**What's right:**
- Phase 6 (Native Analysis Acceleration) addresses the hybrid engine gap
- Multi-repo integration extends the value proposition
- VS Code extension leverages the WASM fallback

**What's missing:**
- **TypeScript-native resolution** should be the #1 priority. The 29% caller coverage is the tool's biggest weakness, and TypeScript projects are the primary audience.
- **Graph quality metrics improvement** — the tool should target 80%+ caller coverage before adding new features.
- **MCP cycle fix** — the 37-file cycle should be resolved before it grows.
- **Structured MCP responses** — returning graph data (not text) from MCP tools would better serve AI agents.

**What's wrong:**
- Adding more languages (the current 11) has diminishing returns if caller coverage for existing languages is 29%. Depth over breadth.

---

## Final Verdict

**Would I invest in this project?**

**Conditional yes.** The tool fills a real gap, has a defensible competitive position, and is well-engineered for its scale. The 3-dependency discipline is exceptional. The TypeScript migration is complete. The dual-engine architecture is justified.

**The condition:** Fix the caller coverage problem. A code intelligence tool that can only resolve callers for 29% of functions is fundamentally limited in the value it can provide. The diff-impact analysis, blast radius calculations, and dead code detection all degrade proportionally with caller coverage. If codegraph can reach 70%+ caller coverage for TypeScript/JavaScript projects (its primary audience), it becomes significantly more valuable. If it stays at 29%, it's a structural overview tool pretending to be a dependency analysis tool.

**Investment-grade improvements (prioritized):**
1. TypeScript-native import resolution → +30-40% caller coverage
2. Break the MCP 37-file cycle → demonstrates architectural discipline
3. Split types.ts into domain-scoped type files → reduces coupling
4. Report dead code categories separately by default → honest metrics
5. Add missing ADRs (TypeScript migration, Repository pattern, Leiden vendoring, MCP architecture)

**What this tool gets right that most don't:** It's honest about its limitations (quality score is prominent), it's opinionated about minimal dependencies, and it dogfoods itself aggressively. These are the hallmarks of a well-maintained open-source project. The architecture is sound — it needs deeper analysis, not a different design.
