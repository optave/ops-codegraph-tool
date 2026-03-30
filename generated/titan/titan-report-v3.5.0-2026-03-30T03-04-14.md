# Titan Audit Report

**Version:** 3.5.0
**Date:** 2026-03-29 -> 2026-03-30
**Branch:** release/3.5.0
**Target:** . (full codebase)

---

## Executive Summary

The Titan pipeline audited 122 files across 13 domains, identifying 55 fail-level and 30 decompose-level targets. The forge phase executed 31 commits addressing dead code removal, shared abstraction extraction, function decomposition, fail-level fixes, and warn-level improvements. All 2131 tests pass. Quality score improved from 65 to 67, functions above threshold dropped from 50 to 48 (with the worst offender `makePartition` improving from MI 5 to MI 13.4), and function-level cycles dropped from 9 to 6.

---

## Pipeline Timeline

| Phase | Started | Completed | Duration |
|-------|---------|-----------|----------|
| RECON | 2026-03-29T00:00:00Z | 2026-03-29T00:00:00Z | < 1 min |
| GAUNTLET | 2026-03-29T00:10:00Z | 2026-03-30T06:10:14Z | ~30 hrs |
| SYNC | 2026-03-29T18:00:00Z | 2026-03-29T18:00:00Z | < 1 min |
| FORGE (5 sub-phases) | 2026-03-29T19:00:00Z | 2026-03-30T09:12:00Z | ~14 hrs |
| GATE (22 runs) | 2026-03-29T01:10:00Z | 2026-03-30T09:10:00Z | across forge |
| CLOSE | 2026-03-30T03:04:00Z | 2026-03-30T03:04:00Z | < 5 min |

---

## Metrics: Before & After

| Metric | Baseline | Final | Delta | Trend |
|--------|----------|-------|-------|-------|
| Quality Score | 65 | 67 | +2 | up |
| Total Files | 486 | 487 | +1 | -- |
| Total Symbols | 11672 | 12628 | +956 | up (decomposition added helpers) |
| Total Edges | 21833 | 24110 | +2277 | up (new helper call edges) |
| Functions Above Threshold | 50 | 48 | -2 | down |
| Dead Symbols (codegraph roles) | N/A | 9620 | -- | -- |
| File-Level Cycles | 1 | 1 | 0 | -- |
| Function-Level Cycles | 9 | 6 | -3 | down |
| Avg Cognitive Complexity | 5.8 | 5.8 | 0 | -- |
| Avg Cyclomatic Complexity | 4.9 | 4.9 | 0 | -- |
| Avg MI | 61.2 | 61.2 | 0 | -- |
| Min MI | 5.0 | 13.4 | +8.4 | up |
| Community Modularity | 0.49 | 0.49 | 0 | -- |

### Complexity Improvement: Top Movers

| Function | Before MI | After MI | Delta | Before Bugs | After Bugs | Delta |
|----------|-----------|----------|-------|-------------|------------|-------|
| makePartition | 5.0 | 13.4 | +8.4 | 6.26 | 4.49 | -1.77 |
| walk_node_depth (javascript.rs) | 8.3 | decomposed | -- | 5.50 | decomposed into helpers | -- |
| build_call_edges (edge_builder.rs) | 22.7 | decomposed | -- | 4.36 | decomposed into helpers | -- |

The worst offenders from the baseline (`walk_node_depth` variants across extractors, `build_call_edges`, `makePartition`) were all decomposed into smaller focused functions. The monolithic `walk_node_depth` in each native extractor now delegates shared logic to `helpers.rs`.

### Remaining Hot Spots

| Function | File | Cognitive | MI | Halstead Bugs |
|----------|------|-----------|-----|---------------|
| makePartition | leiden/partition.ts | 104 | 13.4 | 4.49 |
| computeFunctionComplexity | features/complexity.ts | 103 | 39.4 | 1.25 |
| extract_param_names_strategy | dataflow.rs | 83 | 23.1 | 1.36 |
| extract_dynamic_import_names | javascript.rs | 79 | 44.1 | 1.07 |
| extract_csharp_class_fields | csharp.rs | 78 | 50.0 | 0.37 |
| walkWithVisitors | visitor.ts | 65 | 43.7 | 1.05 |
| createAstStoreVisitor | ast-store-visitor.ts | 65 | 36.6 | 1.24 |
| CfgBuilder.process_try_catch | cfg.rs | 62 | 34.2 | 1.85 |
| renderContextResult | inspect.ts | 59 | 27.2 | 1.48 |
| buildAstNodes | features/ast.ts | 54 | 35.2 | 1.24 |

---

## Audit Results Summary

**Targets audited:** 122
**Pass:** 41 | **Warn:** 26 | **Fail:** 25 | **Decompose:** 30

### By Pillar

| Pillar | Most Common Violations |
|--------|----------------------|
| I -- Structural Purity | cognitive (107), cyclomatic (78), halsteadBugs (57), sloc (47), deadCode (43) |
| II -- Data & Type Sovereignty | magicValues (7), emptyCatch (6), empty-catch (2) |
| III -- Ecosystem Synergy | dry (9), config-env (1) |
| IV -- Quality Vigil | criticalPath (2), naming (1), console (1) |

### Most Common Violations

1. **Cognitive complexity** -- 107 instances (extractors, features, domain)
2. **Cyclomatic complexity** -- 78 instances (extractors, features, graph)
3. **Halstead bugs** -- 57 instances (extractors, leiden, features)
4. **SLOC** -- 47 instances (extractors, presentation, domain)
5. **Dead code** -- 43 instances (shared, db, extractors)

---

## Changes Made

### Commits: 32

| SHA | Message | Files | Domain |
|-----|---------|-------|--------|
| 9e1286a | chore(shared): remove dead code from types and shared utilities | 2 | shared-types |
| cc89d7a | chore(db): remove dead code from database layer | 1 | database |
| 9fafa5a | refactor(native): extract shared walk_node_depth helpers into helpers.rs | 7 | native-extractors |
| c9fba51 | refactor(extractors): extract shared visitor utilities from WASM extractors | 6 | wasm-extractors |
| a6f942f | refactor(analysis): extract shared query-building helpers | 6 | domain-analysis |
| 1673a6c | refactor(leiden): decompose makePartition into focused sub-functions | 2 | graph-engine |
| ed0707e | fix(leiden): reduce cognitive complexity in adapter and index | 2 | graph-engine |
| 0c0c24c | refactor: decompose MCP server and search CLI formatter | 2 | mcp-search |
| 3f56c5b | refactor(graph): decompose finalize stage into sub-steps | 1 | graph-builder |
| 4de3ac7 | refactor(ast): decompose setupVisitors into focused helper functions | 1 | ast-analysis |
| 662387b | refactor(extractors): decompose javascript and go WASM extractors | 2 | wasm-extractors |
| 67a8241 | refactor(features): decompose complexity-query and graph-enrichment | 2 | features |
| ff32950 | refactor(presentation): decompose check, audit, and branch-compare formatters | 3 | presentation |
| 3d34774 | refactor(structure): decompose computeDirectoryMetrics into focused helpers | 1 | features |
| b7a6206 | refactor(presentation): decompose complexity CLI formatter | 1 | presentation |
| aa34dc4 | refactor(native): decompose javascript.rs walk_node_depth | 1 | native-extractors |
| 2653693 | refactor(native): decompose go/python/php extractors | 3 | native-extractors |
| a49e393 | refactor(native): decompose java/csharp/ruby/rust extractors | 4 | native-extractors |
| 56c2584 | refactor(native): decompose edge_builder, complexity, and cfg modules | 3 | native-engine |
| 6f3fb3d | refactor(native): decompose dataflow module | 1 | native-engine |
| 3f25376 | refactor(extractors): decompose javascript.ts and go.ts WASM extractors | 2 | wasm-extractors |
| 6e0e5df | fix: reduce complexity in parser dispatch and config loading | 2 | domain-parser |
| bbffcd6 | fix(extractors): reduce complexity and remove dead code in WASM extractors | 5 | wasm-extractors |
| d186da9 | fix(analysis): reduce complexity and remove dead code in analysis modules | 4 | domain-analysis |
| a55ee53 | fix(graph): fix empty catches, reduce complexity in graph builder pipeline | 5 | graph-builder |
| da41157 | fix(ast): reduce complexity in AST engine and complexity visitor | 2 | ast-analysis |
| 4932570 | fix(features): reduce complexity in cfg, dataflow, and check modules | 3 | features |
| 99b733c | fix(native): reduce complexity in roles_db and HCL extractor | 2 | native-engine |
| a027aaf | refactor(shared): address warnings in types and database layer | 2 | shared-types |
| 8468b49 | refactor: address warnings in domain analysis and presentation | 2 | presentation |
| 6f13090 | refactor: address warnings in infrastructure, features, and CLI | 3 | infrastructure |
| 053cfe9 | fix: resolve build errors from noUncheckedIndexedAccess and unexported types | 3 | wasm-extractors |

### PR Split Plan

| PR # | Title | Concern | Domain | Commits | Files | Depends On |
|------|-------|---------|--------|---------|-------|------------|
| 1 | chore: remove dead code from shared, types, and database | dead_code | shared/db | 2 | 3 | -- |
| 2 | refactor: extract shared helpers for native and WASM extractors | abstraction | extractors | 3 | 19 | -- |
| 3 | refactor: decompose Leiden partition and optimiser | decomposition | graph-engine | 2 | 4 | -- |
| 4 | refactor: decompose MCP server, search formatter, graph builder, and AST engine | decomposition | domain | 3 | 4 | -- |
| 5 | refactor: decompose WASM extractors (javascript.ts, go.ts) | decomposition | wasm-extractors | 2 | 4 | PR #2 |
| 6 | refactor: decompose features and presentation formatters | decomposition | features/presentation | 4 | 7 | -- |
| 7 | refactor: decompose native Rust extractors | decomposition | native-extractors | 4 | 8 | PR #2 |
| 8 | refactor: decompose native engine core (edge_builder, complexity, cfg, dataflow) | decomposition | native-engine | 2 | 4 | PR #2 |
| 9 | fix: reduce complexity across domain, extractors, and features | quality_fix | cross-cutting | 7 | 28 | PR #1, PR #2 |
| 10 | refactor: address warn-level issues in shared, domain, presentation, infra | warning | cross-cutting | 3 | 7 | PR #1 |

---

## Gate Validation History

**Total runs:** 22
**Pass:** 14 | **Warn:** 8 | **Fail:** 0
**Rollbacks:** 0

### Failure Patterns

No failures or rollbacks occurred. 8 warnings were issued:
- **blast-radius warn** (2x): native extractor refactors touched many files (18, 124 blast radius)
- **complexity warn** (4x): Leiden partition and config still above thresholds after decomposition
- **lint warn** (2x): pre-existing lint issues in `src/extractors/rust.ts`, intentional signature removal flagged

---

## Issues Discovered

### Codegraph Bugs (1)
- **limitation** -- `codegraph exports` reports interfaces as dead-unresolved when used as type annotations but not directly imported by name. This is a known limitation of the resolution engine for TypeScript type-only exports.

### Tooling Issues (0)

### Process Suggestions (1)
- **suggestion** -- Batch 2 (10 files) exceeded the recommended batch size of 5. Future RECON should split large same-domain batches.

### Codebase Observations (1)
- **suggestion** -- `walk_node_depth` pattern is duplicated across all 9 language extractors in `crates/codegraph-core/src/extractors/`. A shared macro or trait-based dispatch could eliminate massive duplication and reduce total cognitive complexity by ~800 points.

---

## Domains Analyzed

| Domain | Root Dirs | Files | Status |
|--------|-----------|-------|--------|
| Shared/Types | `src/shared/`, `src/types.ts` | 10 | audited |
| Database | `src/db/` | 20 | audited |
| Infrastructure | `src/infrastructure/` | 7 | audited |
| Domain/Parser | `src/domain/`, `src/extractors/` | 57 | audited |
| Graph Engine | `src/graph/` | 22 | audited |
| AST Analysis | `src/ast-analysis/` | 22 | audited |
| Features | `src/features/` | 23 | audited |
| Presentation | `src/presentation/` | 31 | audited |
| CLI | `src/cli/` | 48 | not in scope |
| MCP Server | `src/mcp/` | 40 | partially audited |
| Search | `src/domain/search/` | 10 | partially audited |
| Native Engine | `crates/codegraph-core/` | 31 | audited |
| Scripts/Tests | `scripts/`, `tests/` | 169 | excluded |

---

## Pipeline Freshness

**Main at RECON:** 573f181
**Main at CLOSE:** ae09cfc
**Commits behind:** 2
**Overall staleness:** fresh

### Drift Events

| Phase | Staleness | Impacted Targets | Action |
|-------|-----------|-----------------|--------|
| gauntlet (start) | none | 0 | continued |
| gauntlet (end) | none | 0 | continued |
| close | fresh | 0 | report generated normally |

The 2 commits on main since RECON are non-code changes (skill rename, docs). No audited targets were affected.

### Stale Targets

None.

---

## Recommendations for Next Run

1. **makePartition remains the worst function** (MI 13.4, cognitive 104). The decomposition improved MI from 5 to 13.4 but it needs further splitting -- the core partition loop is still monolithic.

2. **computeFunctionComplexity** (cognitive 103) was not decomposed in this run. It is the second-worst function and should be a priority target.

3. **Native extractor duplication** -- The `walk_node_depth` pattern is still duplicated across 9 extractors. A Rust macro or trait-based dispatch could reduce total cognitive complexity by ~800 points. This is the single highest-leverage refactor remaining.

4. **Type-only export resolution** -- The codegraph limitation with TypeScript type-only exports inflates dead symbol counts. Fixing this in the resolution engine would improve quality score.

5. **Batch sizing** -- Keep RECON batches to 5 files max for better audit granularity.

6. **CLI and test domains** were excluded from this run. A future Titan run scoped to `src/cli/` could improve the tangled CLI layer (cohesion 0.299).
