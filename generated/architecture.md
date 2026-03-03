# Codegraph Architectural Audit — Revised Analysis

> **Scope:** Unconstrained redesign proposals. No consideration for migration effort or backwards compatibility. What would the ideal architecture look like?
>
> **Revision context:** The original audit (Feb 22, 2026) analyzed v1.4.0 with ~12 source modules totaling ~5K lines. The first revision (Mar 2, 2026) covered v2.6.0 with 35 modules totaling 17,830 lines. Since then, a rapid expansion added 6 new modules (cfg, ast, dataflow, viewer, extractors refactor, CLI consolidation), 4 new DB tables, 3 new node kinds, 3 new edge kinds, and 9 new MCP tools — all in a single day. The codebase now stands at 50 source modules totaling 26,277 lines. This revision re-evaluates every recommendation against the actual codebase as it stands today.

---

## What Changed Since the Last Revision (Mar 2 → Mar 3, 2026)

| Metric | Mar 2 (v2.6.0) | Mar 3 (post-PRs) | Delta |
|--------|----------------|-------------------|-------|
| Source modules | 35 | 50 (37 core + 11 extractors + 2 new) | +15 |
| Total source lines | 17,830 | 26,277 | +47% |
| `queries.js` | 3,110 lines | 3,395 lines | +285 |
| `mcp.js` | 1,212 lines | 1,370 lines | +158 |
| `cli.js` | 1,285 lines | 1,557 lines | +272 |
| `builder.js` | 1,173 lines | 1,355 lines | +182 |
| `cfg.js` | -- | 1,451 lines | New |
| `dataflow.js` | -- | 1,187 lines | New |
| `viewer.js` | -- | 948 lines | New |
| `ast.js` | -- | 392 lines | New |
| `db.js` | 317 lines | 392 lines | +75 |
| `export.js` | 681 lines | 681 lines | unchanged |
| DB tables | 9 | 13 | +4 |
| DB migrations | v9 | v13 | +4 |
| MCP tools | 25 | 34 | +9 |
| CLI commands | 45 | 47 | +2 (net: +7 added, -5 consolidated) |
| `index.js` exports | 120+ | 140+ (32 export lines) | +20 |
| Test files | 59 | 70 | +11 |
| Node kinds | 10 | 13 | +3 (parameter, property, constant) |
| Edge kinds | 6 | 9 | +3 (contains, parameter_of, receiver) |
| Extractor modules | 0 (inline in parser.js) | 11 files, 2,299 lines | New directory |

**Key patterns observed in this burst:**

1. **The dual-function anti-pattern was replicated 4 more times** (cfg.js, ast.js, dataflow.js, viewer.js) — each with its own `*Data()` / `*()` pair, DB opening, SQL, formatting. The pattern count went from 15 to 19 modules.

2. **CFG introduced a third analysis engine pattern** alongside complexity and dataflow: language-specific rule maps keyed by AST node type, applied during a tree walk. Three modules now independently implement "per-language AST rules + engine walker" with no shared framework.

3. **The extractors refactoring (PR #270) is the first genuine structural decomposition** — parser.js extractors split into `src/extractors/` with one file per language. This is the pattern the rest of the codebase should follow.

4. **Scope and parent hierarchy finally arrived** — `parent_id` column on `nodes`, `contains`/`parameter_of` edges, `children` query. This partially addresses the qualified names gap (item #11 in the previous revision).

5. **CLI consolidation (PR #280) removed 5 commands** — the first time the project actively reduced surface area. `hotspots` merged into `triage`, `manifesto` into `check`, `explain` into `audit --quick`, `batch-query` into `batch where`, `query --path` into standalone `path`.

---

## 1. The Dual-Function Anti-Pattern — Now 19 Modules Deep

**Previous state:** 15 modules with `*Data()` / `*()` pairs.

**Current state:** 19 modules. Four new additions:

```
cfg.js          -> cfgData() / cfg()
ast.js          -> astQueryData() / astQuery()
dataflow.js     -> dataflowData() / dataflow(), dataflowPathData(), dataflowImpactData()
viewer.js       -> prepareGraphData() / generatePlotHTML()
```

Plus queries.js grew two more pairs: `childrenData()` / `children()`, `exportsData()` / `fileExports()`.

**Reinforced assessment:** Each new module independently handles DB opening, SQL execution, result shaping, pagination, CLI formatting, JSON output, and `--no-tests` filtering. The `cfg.js` module at 1,451 lines is the most extreme example — it contains CFG construction rules for 9 languages, a build phase, a query function, DOT/Mermaid formatters, and a CLI printer all in one file.

**The ideal architecture is unchanged** — Command + Query separation with shared `CommandRunner` lifecycle. But the urgency increased: at the current rate of ~4 new dual-function modules per development sprint, the pattern will reach 25+ modules before any refactoring can happen.

---

## 2. The Database Layer — 13 Tables Across 25+ Modules

**Previous state:** 9 tables, SQL scattered across 20+ modules.

**Current state:** 13 tables, SQL scattered across **25+ modules**. New tables:

| Table | Migration | Module | Purpose |
|-------|-----------|--------|---------|
| `dataflow` | v10 | `dataflow.js` | flows_to, returns, mutates edges with confidence |
| `nodes.parent_id` | v11 | `builder.js` | Parent-child node hierarchy |
| `cfg_blocks` | v12 | `cfg.js` | Basic blocks per function |
| `cfg_edges` | v12 | `cfg.js` | Control flow edges between blocks |
| `ast_nodes` | v13 | `ast.js` | Stored queryable AST nodes (call, new, string, regex, throw, await) |

Each new module follows the same pattern: import `openDb()`, write raw SQL with inline string construction, create its own prepared statements. `cfg.js` alone has ~20 SQL statements.

**The repository pattern is now even more critical.** With 13 tables, the migration system in `db.js` is getting complex (392 lines, up from 317). The ideal decomposition into `db/connection.js`, `db/migrations.js`, `db/repository.js` is unchanged but higher urgency.

---

## 3. queries.js at 3,395 Lines — Still Growing

**Previous state:** 3,110 lines.

**Current state:** 3,395 lines — gained 285 lines. New additions:
- `childrenData()` — query child symbols (parameters, properties, constants)
- `exportsData()` — per-symbol consumer analysis for file exports
- `CORE_SYMBOL_KINDS` (10) / `EXTENDED_SYMBOL_KINDS` (3) / `EVERY_SYMBOL_KIND` (13) — tiered kind constants
- `CORE_EDGE_KINDS` (6) / `STRUCTURAL_EDGE_KINDS` (3) / `EVERY_EDGE_KIND` (9) — tiered edge constants
- `normalizeSymbol()` — stable 7-field JSON shape for all queries

**Positive development:** The constant hierarchy (`CORE_` / `EXTENDED_` / `EVERY_`) is well-designed and provides clean backward compatibility (`ALL_SYMBOL_KINDS = CORE_SYMBOL_KINDS`). The `normalizeSymbol()` utility enforces consistent output. These are **the right abstractions** — they just need to live in dedicated files (`shared/constants.js`, `shared/normalize.js`) rather than accumulating in the megafile.

**The decomposition plan from the previous revision still applies.** Add `shared/constants.js` for the kind/edge/role constants and `shared/normalize.js` for `normalizeSymbol` + `isTestFile` + `kindIcon`.

---

## 4. MCP at 1,370 Lines with 34 Tools

**Previous state:** 1,212 lines, 25 tools.

**Current state:** 1,370 lines, 34 tools. Nine new tools added:

| Tool | Source module |
|------|-------------|
| `cfg` | cfg.js |
| `ast_query` | ast.js |
| `dataflow` | dataflow.js |
| `dataflow_path` | dataflow.js |
| `dataflow_impact` | dataflow.js |
| `file_exports` | queries.js |
| `symbol_children` | queries.js |
| `fn_impact` (extended kinds enum) | queries.js |
| Various updated enums | (edge_kinds, symbol kinds) |

**Positive development:** The MCP tools were **not** consolidated alongside the CLI (PR #280 removed 5 CLI commands but kept all MCP tools for backward compatibility). This is the right call for an MCP API — clients may depend on specific tool names.

**The composable tool registry pattern is now more urgent.** At 34 tools in a single file, each addition requires coordinating the tool definition, the dispatch handler, and the import — three touch points. The one-file-per-tool registry pattern proposed in the previous revision would make each of the 34 tools independently maintainable.

---

## 5. CLI at 1,557 Lines with 47 Commands — Consolidation Started

**Previous state:** 1,285 lines, 45 commands.

**Current state:** 1,557 lines, 47 commands. Net change: +7 new commands (cfg, ast, dataflow, dataflow-path, dataflow-impact, children, path), -5 consolidated commands (hotspots, manifesto, explain, batch-query, query --path).

**Positive development:** PR #280 is the first CLI surface area reduction — 5 commands consolidated into existing ones. This is the right direction. `check` now subsumes `manifesto`, `triage` subsumes `hotspots`, `audit --quick` subsumes `explain`, `batch where` subsumes `batch-query`.

**But the file still grew** because 7 new commands were added in parallel. The inline Commander.js pattern means each new command adds 20-40 lines of `.command().description().option().action()` boilerplate. The command object pattern from the previous revision would keep the entry point lean regardless of command count.

---

## 6. cfg.js at 1,451 Lines — A New Monolith

**Not in previous revision** — this module didn't exist.

**Current state:** 1,451 lines containing:
- `makeCfgRules(overrides)` — factory for language-specific CFG construction rules
- `CFG_RULES` Map — rules for all 9 supported languages (JS/TS, Python, Go, Rust, Java, C#, PHP, Ruby)
- `buildFunctionCFG(functionNode, langId)` — CFG construction from AST (basic blocks + control flow edges)
- `buildCFGData(db, fileSymbols, rootDir)` — build-phase integration (write cfg_blocks/cfg_edges to DB)
- `cfgData(name, customDbPath, opts)` — query function
- `cfgToDOT()` / `cfgToMermaid()` — graph export formatters
- `cfg(name, customDbPath, opts)` — CLI printer

**Problem:** This is a miniature version of the `complexity.js` monolith. It has the same structure: per-language rules map + engine walker + DB integration + query + formatting. The two modules share the same fundamental pattern but implement it independently.

**Connection to complexity.js:** `cfg.js` imports `findFunctionNode()` from `complexity.js` — confirming that these two AST-analysis modules have shared concerns but no shared framework.

**Ideal architecture — unified AST analysis framework:**

```
src/
  ast-analysis/
    engine.js                  # Shared AST walk with visitor pattern
    rules/
      complexity/              # Cognitive/cyclomatic/Halstead rules per language
        javascript.js
        python.js
        ...
      cfg/                     # Basic-block construction rules per language
        javascript.js
        python.js
        ...
    metrics.js                 # Halstead, MI computation (from complexity.js)
    cfg-builder.js             # Basic-block + edge construction (from cfg.js)
```

Both complexity and CFG analysis walk the same AST trees with language-specific rules. A shared visitor-pattern engine would eliminate the parallel rule-map implementations and allow future AST analyses (e.g., dead code detection, mutation analysis) to plug in without creating yet another 1K+ line module.

---

## 7. dataflow.js at 1,187 Lines — JS/TS Only, Language Hardcoding

**Not in previous revision** — this module was just introduced (#254).

**Current state:** 1,187 lines implementing define-use chain extraction with three edge types:
- `flows_to` — parameter/variable flow between functions
- `returns` — call return value assignment tracking
- `mutates` — parameter-derived mutation detection

**Design qualities:**
- Confidence scoring (1.0 param, 0.9 call return, 0.8 destructured) — good, but undocumented
- Transaction-based DB writes — correct pattern
- Lazy parser initialization — efficient

**Architectural concerns:**
1. **Language hardcoding** — Lines 517-524 and 573-580 hardcode `javascript`/`typescript`/`tsx` checks. Not extensible via registry.
2. **Scope stack mutation** during tree walk — fragile for malformed AST
3. **No cycle detection** in dataflow BFS paths — can revisit nodes
4. **Statement-level mutation detection** misses inline mutations
5. **Follows the same monolith pattern** — extraction + DB write + query + CLI format all in one file

**Ideal:** Dataflow extraction should integrate with the AST analysis framework proposed above. The define-use chain walk is fundamentally the same visitor pattern as complexity and CFG — it just collects different data.

---

## 8. Extractors Refactoring — The Right Pattern, Applied Once

**Previous state:** parser.js at 404 lines with inline extractors.

**Current state:** `src/extractors/` directory with 11 files totaling 2,299 lines:

| File | Lines | Language |
|------|-------|----------|
| `javascript.js` | 750 | JS/TS/TSX |
| `csharp.js` | 248 | C# |
| `php.js` | 243 | PHP |
| `java.js` | 230 | Java |
| `rust.js` | 225 | Rust |
| `ruby.js` | 188 | Ruby |
| `go.js` | 172 | Go |
| `python.js` | 150 | Python |
| `hcl.js` | 73 | Terraform/HCL |
| `helpers.js` | 11 | Shared utilities |
| `index.js` | 9 | Barrel export |

**This is the correct decomposition pattern.** Each language has its own file. A shared helpers module provides `nodeEndLine()` and `findChild()`. The barrel export keeps the public API clean. All extractors return a consistent structure: `{ definitions, calls, imports, classes, exports }`.

**This pattern should be replicated for:**
- `complexity.js` → `src/complexity/rules/{language}.js` (same per-language rule pattern)
- `cfg.js` → `src/cfg/rules/{language}.js` (same per-language rule pattern)
- `dataflow.js` → `src/dataflow/extractors/{language}.js` (when more languages are supported)

The extractors refactoring proved the pattern works. Now apply it consistently.

---

## 9. ast.js — Stored Queryable AST Nodes

**Not in previous revision** — new module from PR #279.

**Current state:** 392 lines. Stores selected AST nodes during build for later querying:
- Node kinds: `call`, `new`, `string`, `regex`, `throw`, `await`
- Pattern matching via SQL GLOB with auto-wrapping
- Parent resolution via narrowest enclosing definition

**Architectural assessment:** This is a well-scoped module. At 392 lines it's appropriately sized. It follows the dual-function pattern (`astQueryData()` / `astQuery()`) but is otherwise clean.

**The main concern** is that AST node extraction during build overlaps with what `dataflow.js` and `cfg.js` also do — all three walk the AST. With the unified AST analysis framework proposed in item #6, a single AST walk could populate all three subsystems in one pass.

---

## 10. viewer.js at 948 Lines — Self-Contained but Bloated

**Not in previous revision** — new module from PR #268.

**Current state:** 948 lines generating self-contained interactive HTML with vis-network. Features: layout switching, physics toggle, search, color/size/cluster overlays, drill-down, detail panel, community detection.

**Architectural assessment:**
- Embeds ALL node/edge data as JSON in the HTML — scales poorly for large graphs
- Client-side filtering only — no server-side optimization
- Hardcoded thresholds (fanIn >= 10, MI < 40) not derived from distribution
- Tight vis-network coupling — custom clustering logic deeply integrated
- Good: configuration cascading via `.plotDotCfg` with deep merge

**This module is isolated** — it has minimal impact on the rest of the architecture. The main risk is HTML size growth for large codebases.

---

## 11. Qualified Names + Hierarchical Scoping — Partially Addressed

**Previous state:** Flat node model with no scope or parent information.

**Current state:** Partially addressed via PR #270:
- `parent_id` column added to `nodes` table (migration v11)
- `contains` edges track parent-child relationships
- `parameter_of` edges link parameters to functions
- `childrenData()` query returns child symbols
- Extended kinds (`parameter`, `property`, `constant`) model sub-declarations

**What's still missing:**
- `qualified_name` column (e.g., `DateHelper.format`)
- `scope` column (e.g., `DateHelper`)
- `visibility` column (`public`/`private`/`protected`)
- The `parent_id` FK only goes one level — deeply nested scopes (namespace > class > method > closure) aren't fully represented

**Revised priority:** Medium → Low-Medium. The `parent_id` + `contains` edges solve the 80% case (class methods, interface members, struct fields). The remaining 20% (qualified names, deep nesting) is a polish item.

---

## 12. builder.js at 1,355 Lines — Pipeline Now Has 7+ Opt-In Stages

**Previous state:** 1,173 lines with complexity as the only opt-in stage.

**Current state:** 1,355 lines. The build pipeline now has 4 opt-in stages:

```
Core pipeline (always):
  collectFiles → detectChanges → parseFiles → insertNodes →
  resolveImports → buildCallEdges → buildClassEdges →
  resolveBarrels → insertEdges → buildStructure → classifyRoles

Opt-in stages:
  --complexity  → computeComplexity()
  --dataflow    → buildDataflowEdges()    (dynamic import)
  --cfg         → buildCFGData()          (dynamic import)
  AST nodes     → extractASTNodes()       (always, post-parse)
```

**Positive development:** The opt-in stages use dynamic imports — `dataflow.js` and `cfg.js` are only loaded when their flags are passed. This keeps default builds fast.

**The pipeline architecture from the previous revision is even more relevant now.** Seven core stages + 4 opt-in stages = 11 total. Each should be independently testable with the pipeline runner handling transactions, logging, progress, and statistics.

---

## 13. Export Formats — 6 Formats, Well-Contained

**Previous state:** DOT, Mermaid, JSON.

**Current state:** DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j CSV. Export.js at 681 lines (unchanged — the new formats were already counted in the previous revision).

**Assessment:** Well-contained. The export module adds formats without affecting other modules. No architectural concerns.

---

## 14. Constants Hierarchy — A Good Foundation

**Not in previous revision** — introduced across PRs #267, #270, #279.

**Current state:** Three-tiered constants in `queries.js`:

```js
// Symbol kinds
CORE_SYMBOL_KINDS    = ['function', 'method', 'class', 'interface', 'type',
                        'struct', 'enum', 'trait', 'record', 'module']
EXTENDED_SYMBOL_KINDS = ['parameter', 'property', 'constant']
EVERY_SYMBOL_KIND    = [...CORE_SYMBOL_KINDS, ...EXTENDED_SYMBOL_KINDS]
ALL_SYMBOL_KINDS     = CORE_SYMBOL_KINDS  // backward compat alias

// Edge kinds
CORE_EDGE_KINDS      = ['imports', 'imports-type', 'reexports', 'calls', 'extends', 'implements']
STRUCTURAL_EDGE_KINDS = ['parameter_of', 'receiver']
EVERY_EDGE_KIND      = [...CORE_EDGE_KINDS, ...STRUCTURAL_EDGE_KINDS]

// AST node kinds (in ast.js)
AST_NODE_KINDS       = ['call', 'new', 'string', 'regex', 'throw', 'await']
```

**This is well-designed.** The tiered approach lets older code use `ALL_SYMBOL_KINDS` (10 core kinds) while new code can opt into `EVERY_SYMBOL_KIND` (13 kinds). The `contains` edge is stored in the `edges` table but excluded from coupling metrics via the `STRUCTURAL_EDGE_KINDS` distinction.

**One concern:** These constants are scattered across multiple files (`queries.js`, `ast.js`). They should all live in a single `shared/constants.js` as proposed in item #3.

---

## Updated Priority Summary

### Items That Improved Since Last Revision

| # | Item | What improved |
|---|------|--------------|
| 9 | Parser plugin system (was #20) | Extractors split into `src/extractors/` — **done** |
| 11 | Qualified names (was #12) | `parent_id`, `contains` edges, `parameter_of` — **partially done** |
| 5 | CLI surface area (was #5) | 5 commands consolidated in PR #280 — **started** |
| 3 | Constants organization (was part of #3) | Tiered `CORE_`/`EXTENDED_`/`EVERY_` hierarchy — **started** |
| -- | normalizeSymbol (new) | Stable JSON schema utility — **done** |

### Items That Worsened Since Last Revision

| # | Item | What worsened |
|---|------|--------------|
| 1 | Dual-function pattern | 15 → 19 modules |
| 2 | Repository pattern | 9 → 13 tables, 20 → 25+ modules with raw SQL |
| 3 | queries.js size | 3,110 → 3,395 lines |
| 4 | MCP monolith | 25 → 34 tools in one file |
| 5 | CLI size | 1,285 → 1,557 lines (despite consolidation) |
| 6 | Public API | 120+ → 140+ exports |
| 8 | AST analysis duplication | 1 module (complexity) → 3 modules (+ cfg, dataflow) with parallel rule engines |

---

## Revised Summary — Priority Ordering by Architectural Impact

| # | Change | Impact | Category | Previous # |
|---|--------|--------|----------|------------|
| **1** | **Command/Query separation — eliminate dual-function pattern across 19 modules** | **Critical** | Separation of concerns | #1 (15→19 modules) |
| **2** | **Repository pattern for data access — raw SQL in 25+ modules, 13 tables** | **Critical** | Testability, maintainability | #2 (9→13 tables) |
| **3** | **Decompose queries.js (3,395 lines) into analysis modules + shared constants** | **Critical** | Modularity | #3 (3,110→3,395) |
| **4** | **Unified AST analysis framework — complexity + CFG + dataflow share no infrastructure** | **Critical** | Code duplication | New (3 modules, ~4.8K lines, parallel rule engines) |
| **5** | **Composable MCP tool registry (34 tools in 1,370 lines)** | **High** | Extensibility | #4 (25→34 tools) |
| **6** | **CLI command objects (47 commands in 1,557 lines)** | **High** | Maintainability | #5 (45→47 commands, consolidation started) |
| **7** | **Curated public API surface (140+ to ~35 exports)** | **High** | API stability | #6 (120→140+ exports) |
| **8** | **Domain error hierarchy (50 modules, inconsistent handling)** | **High** | Reliability | #7 (35→50 modules) |
| **9** | **Builder pipeline architecture (1,355 lines, 11 stages, 4 opt-in)** | **High** | Testability, reuse | #9 (1,173→1,355, +2 opt-in stages) |
| **10** | **Embedder subsystem (1,113 lines, 3 search engines)** | **Medium-High** | Extensibility | #10 (unchanged) |
| **11** | **Unified graph model for structure/cochange/communities/viewer** | **Medium-High** | Cohesion | #11 (viewer now also builds its own graph) |
| **12** | **Pagination standardization (SQL-level + command runner)** | **Medium** | Consistency | #13 (unchanged) |
| **13** | **Testing pyramid with InMemoryRepository** | **Medium** | Quality | #14 (59→70 test files, same DB coupling) |
| **14** | **Event-driven pipeline for streaming** | **Medium** | Scalability, UX | #15 (unchanged) |
| **15** | **Qualified names (remaining: qualified_name, scope, visibility columns)** | **Low-Medium** | Data model | #12 (partially addressed by parent_id) |
| **16** | **Query result caching (34 MCP tools)** | **Low-Medium** | Performance | #16 (25→34 tools) |
| **17** | **Unified engine interface (Strategy)** | **Low-Medium** | Abstraction | #17 (unchanged) |
| **18** | **Subgraph export with filtering** | **Low-Medium** | Usability | #18 (unchanged) |
| **19** | **Transitive import-aware confidence** | **Low** | Accuracy | #19 (unchanged) |
| **20** | **Config profiles for monorepos** | **Low** | Feature | #21 (unchanged) |

### Items Resolved / Downgraded

| Previous # | Item | Status |
|------------|------|--------|
| #20 | Parser plugin system | **Resolved** — extractors split into `src/extractors/` |
| #8 | Decompose complexity.js (standalone) | **Subsumed** by new #4 (unified AST analysis framework) |

---

## New Architectural Concern: Three Independent AST Rule Engines

The most significant architectural development since the last revision is the emergence of **three independent AST analysis modules** that share the same fundamental pattern but no infrastructure:

| Module | Lines | Languages | Pattern |
|--------|-------|-----------|---------|
| `complexity.js` | 2,163 | 8 | Per-language rules map → AST walk → collect metrics |
| `cfg.js` | 1,451 | 9 | Per-language rules map → AST walk → build basic blocks |
| `dataflow.js` | 1,187 | 1 (JS/TS) | Scope stack → AST walk → collect flows |

Total: **4,801 lines** of parallel AST walking implementations. All three:
- Walk function-level ASTs from tree-sitter parse trees
- Use language-specific rule maps keyed by AST node type
- Build intermediate data structures during the walk
- Write results to dedicated DB tables
- Provide query functions + CLI formatters

Additionally, `ast.js` (392 lines) does a fourth AST walk to extract stored nodes.

**The extractors refactoring showed the path:** split per-language rules into files, share the engine. `cfg.js` already took a step in this direction with `makeCfgRules(overrides)` — a factory function for language-specific CFG rules with defaults. Apply this pattern to all four AST analysis passes:

```
src/
  ast-analysis/
    visitor.js                 # Shared AST visitor with hook points
    rules/
      complexity/{lang}.js     # Cognitive/cyclomatic rules
      cfg/{lang}.js            # Basic-block rules
      dataflow/{lang}.js       # Define-use chain rules
      ast-store/{lang}.js      # Node extraction rules
    engine.js                  # Single-pass or multi-pass orchestrator
```

A single AST walk with pluggable visitors would:
1. Eliminate 3 redundant tree traversals per function
2. Share language-specific node type mappings
3. Allow new analyses to plug in without creating another 1K+ line module
4. Enable the 4 opt-in build stages to share a single parse pass

---

*Revised 2026-03-03. Cold architectural analysis — no implementation constraints applied.*
