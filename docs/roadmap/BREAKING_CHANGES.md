# MCP Tool Surface Optimization — Proposal

**Status:** Suggestion (not scheduled)
**Last updated:** 2026-03-07
**Motivation:** Reduce AI token waste and decision paralysis by restructuring the 32 MCP tools for faster, more accurate tool selection.

---

## Problem Statement

Codegraph exposes 32 MCP tools in a flat, unordered list. When an AI agent connects, it must read all 32 descriptions and decide which to call — often picking suboptimal tools, calling redundant ones, or skipping critical orientation steps. This directly undermines the project's core goal: **helping AI agents navigate codebases without wasting tokens**.

Key symptoms:
- **Decision paralysis**: 32 flat tools with no priority signal means the AI spends tokens deliberating instead of acting
- **Overlapping tools**: Multiple tools answer the same question at different granularity (e.g., `fn_impact` vs `impact_analysis` vs `diff_impact` vs `audit` all address "what breaks if I change this?")
- **No workflow guidance**: Nothing tells the AI to orient first, analyze second, validate last — it can jump straight to `diff_impact` without understanding the code
- **Redundant tools**: `path` is 100% equivalent to `query(mode: "path")`; `list_functions` overlaps heavily with `where(file_mode: true)`

---

## How to Read This Proposal

Each task has a title, description, rationale, and assessment columns matching the [BACKLOG.md](roadmap/BACKLOG.md) format:

| Column | Meaning |
|--------|---------|
| **Zero-dep** | Can this be done without adding new runtime dependencies? |
| **Foundation-aligned** | Does it align with [FOUNDATION.md](../FOUNDATION.md) core principles? |
| **Problem-fit (1-5)** | How directly does it reduce AI token waste or prevent mistakes? |
| **Breaking** | Does it change existing MCP tool contracts, CLI output, or API signatures? |

---

## Task 1 — Add `codemap` meta-tool

**Priority:** High | **Effort:** Medium

### Description

Add a single new tool at the top of the tool list that returns a compact codebase orientation **and** recommends which tools to call next based on the AI's stated goal.

```
codemap({ goal: "modify the parser" })
```

Returns:

```
## Codebase Map
12 source files, 847 symbols.
Hub: parser.js (42 connections) | Entry: builder.js | Core: queries.js

## Recommended tools for "modify the parser"
1. context("extractJS", file: "parser.js") — source + deps + callers
2. fn_impact("extractJS") — blast radius (23 transitive callers)
3. [after editing] diff_impact(staged: true) — verify nothing broke

## All tools by stage
Orient:   where, context, audit, module_map, structure
Analyze:  query, fn_impact, execution_flow, dataflow, complexity, cfg
Validate: diff_impact, check, find_cycles
```

### Rationale

Instead of hard-gating tools behind stages (which breaks if the AI skips orientation), this tool **soft-guides** the AI toward the right workflow. It works because:

- AI models reliably follow explicit recommendations in tool output
- The codebase map provides instant orientation without the AI having to call `module_map` + `structure` + `where` separately
- Goal-aware recommendations eliminate the "which of these 32 tools do I need?" deliberation
- If the AI skips `codemap`, everything still works — no gating, no lockout

The `goal` parameter enables context-sensitive recommendations. A "find dead code" goal recommends `node_roles(role: "dead")` + `ast_query`; a "review PR impact" goal recommends `diff_impact` + `check`.

Under the hood, `codemap` composes existing functions: `moduleMapData()` for the map, a static recommendation table for tool sequences, and optionally `triageData()` for top-risk highlights.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes (P1: always-current map; P4: zero-cost; P5: embeddable) | 5 — directly reduces orientation tokens and prevents wrong-tool selection | No — purely additive |

---

## Task 2 — Enrich tool descriptions with usage tiers

**Priority:** High | **Effort:** Low

### Description

Restructure every tool description to include a tier prefix and a "USE THIS WHEN" hint. AI models weight early tokens in descriptions heavily, so the prefix acts as a priority signal.

Current:
```
"Find where a symbol is defined and used, or list symbols/imports/exports for a file. Minimal, fast lookup."
```

Proposed:
```
"[ORIENT] Find where a symbol is defined and used. START HERE for any symbol lookup.
Use this when: you need to locate a function, class, or file before deeper analysis.
Prefer over: list_functions (which only lists, doesn't show usage), semantic_search (which needs embeddings)."
```

Tier prefixes:
- `[ORIENT]` — Call these first to understand the code: `where`, `context`, `audit`, `module_map`, `structure`
- `[ANALYZE]` — Go deeper after orientation: `query`, `fn_impact`, `execution_flow`, `dataflow`, `complexity`, `cfg`, `communities`, `co_changes`, `sequence`
- `[VALIDATE]` — After making changes: `diff_impact`, `check`, `find_cycles`, `branch_compare`
- `[UTILITY]` — On-demand specialized tools: `batch_query`, `export_graph`, `triage`, `node_roles`, `code_owners`, `ast_query`, `semantic_search`, `symbol_children`, `list_functions`, `file_deps`, `file_exports`

### Rationale

This is the highest bang-for-buck change. No code logic changes, no schema changes — just string edits to `BASE_TOOLS` in `mcp.js`. The tier prefix gives the AI an instant priority signal without reading the full description. The "Prefer over" hint resolves the overlap confusion that causes redundant tool calls.

Stage-based tiers (orient/analyze/validate) were chosen over task-based modules (refactoring/planning/linting) because:
- Tools don't map 1:1 to tasks — `context` is useful for refactoring, planning, AND developing
- Tasks are fluid — a conversation shifts from planning to refactoring mid-stream
- Every AI task follows the same orient-analyze-act-validate pattern regardless of task type

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes (P5: better tool discovery for programmatic consumers) | 5 — AI picks correct tools faster, fewer wasted calls | No — description text is not a contract |

---

## Task 3 — Reorder tool list by priority

**Priority:** High | **Effort:** Low

### Description

Reorder `BASE_TOOLS` in `mcp.js` so the most universally useful tools appear first. AI models give more weight to tools earlier in the list.

Current order is essentially by implementation date (query, path, file_deps, ...). Proposed order:

```
Tier 1 — Orient (always useful):
  1. where
  2. context
  3. audit
  4. module_map
  5. structure

Tier 2 — Analyze (deep dive):
  6. query
  7. fn_impact
  8. diff_impact
  9. execution_flow
  10. dataflow

Tier 3 — Specialized analysis:
  11. complexity
  12. cfg
  13. communities
  14. co_changes
  15. sequence

Tier 4 — Utility:
  16. batch_query
  17. triage
  18. check
  19. find_cycles
  20. branch_compare
  21. node_roles
  22. code_owners
  23. export_graph
  24. semantic_search
  25. ast_query
  26. symbol_children
  27. list_functions
  28. file_deps
  29. file_exports
```

### Rationale

Zero-effort change (just move array elements in `mcp.js`) with measurable impact on tool selection accuracy. When the MCP client presents tools to the AI, earlier tools get more attention. Putting `where` and `context` first means the AI naturally orients before diving into analysis.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes | 4 — improves tool selection without any contract change | No — tool order is not a contract |

---

## Task 4 — Remove redundant `path` tool

**Priority:** Medium | **Effort:** Low

### Description

Remove the standalone `path` tool. It is 100% redundant with `query(mode: "path", name: <from>, to: <to>)`.

Both tools:
- Take `from`/`to` symbol names
- Accept `depth`, `edge_kinds`, `from_file`, `to_file`
- Return the same shortest-path result

The only difference is parameter naming (`from`/`to` vs `name`/`to`), which means an AI must understand both schemas for the same operation.

### Rationale

Every redundant tool adds ~200 tokens of schema that the AI must read and differentiate. Removing `path` saves those tokens and eliminates a decision point. Users of the `path` MCP tool can switch to `query(mode: "path")` with no loss of functionality. The CLI `codegraph path <from> <to>` command can remain as a convenience alias.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes (P5: smaller, cleaner API surface) | 3 — small token saving per session | **Yes** — removes an existing MCP tool |

---

## Task 5 — Merge `impact_analysis` into `fn_impact`

**Priority:** Medium | **Effort:** Medium

### Description

Remove the standalone `impact_analysis` tool. Add a `level` parameter to `fn_impact`:

```
fn_impact({ name: "parser.js", level: "file" })   // replaces impact_analysis
fn_impact({ name: "extractJS", level: "function" }) // current behavior (default)
```

Currently:
- `impact_analysis` takes a `file` path and returns transitively affected **files**
- `fn_impact` takes a function `name` and returns transitively affected **functions**

These are the same operation at different granularity. An AI seeing both tools must figure out which granularity it needs before choosing — often guessing wrong and calling both.

### Rationale

Unifying under one tool with a `level` parameter makes the choice explicit rather than implicit. The AI sees one tool for "what breaks if I change X?" and picks the granularity via a parameter, not by choosing between two different tools.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes | 4 — eliminates a common wrong-tool-choice | **Yes** — removes `impact_analysis` MCP tool, changes `fn_impact` schema |

---

## Task 6 — Merge `list_functions` into `where`

**Priority:** Low | **Effort:** Medium

### Description

`list_functions` lists symbols filtered by file/pattern. `where` with `file_mode: true` lists symbols/imports/exports for a file. These overlap significantly.

Proposed: add a `list` mode to `where`:
```
where({ target: "extractJS" })                    // current: find definition + usages
where({ target: "parser.js", file_mode: true })   // current: list file symbols
where({ file: "parser.js", list: true })           // replaces list_functions scoped to file
where({ pattern: "extract*", list: true })         // replaces list_functions with pattern
```

### Rationale

`list_functions` is the 10th-most-used tool but overlaps with `where` enough that AIs frequently call both. Merging reduces the tool count and makes `where` the single entry point for "find/list symbols."

However, this is lower priority because the overlap is partial — `list_functions` supports `pattern` glob matching that `where` doesn't, and `where` provides usage context that `list_functions` doesn't. The merge requires careful parameter design.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes | 3 — moderate token saving, moderate confusion reduction | **Yes** — removes `list_functions` MCP tool |

---

## Task 7 — Consolidate `file_deps` + `file_exports` into `inspect`

**Priority:** Low | **Effort:** Medium

### Description

Replace two file-scoped tools with one:

```
inspect({ file: "parser.js" })
// Returns: { imports: [...], importedBy: [...], exports: [{ name, consumers: [...] }] }
```

Currently an AI that wants to understand a file's API surface must decide between `file_deps` (imports/importers) and `file_exports` (exports/consumers) — and often calls both.

### Rationale

These tools answer two facets of the same question: "tell me about this file's boundaries." Merging them into a single `inspect` tool means one call returns the complete picture. The combined response is still compact because file-level data is inherently bounded.

Lower priority because the individual tools are well-scoped and their descriptions are clear enough that wrong-tool selection is less common than with the impact analysis tools.

### Assessment

| Zero-dep | Foundation-aligned | Problem-fit | Breaking |
|----------|-------------------|-------------|----------|
| Yes | Yes (P5: fewer tools, same capability) | 3 — saves one round-trip when both are needed | **Yes** — removes two MCP tools, adds one |

---

## Summary — Implementation Order

Non-breaking changes first (no major version bump needed), then breaking changes batched into a single major release:

### Phase 1 — Non-breaking (ship immediately, any minor release)

| Task | Effort | Token impact |
|------|--------|-------------|
| **Task 2** — Enrich descriptions with tier prefixes | Low | High — AI picks right tool on first try |
| **Task 3** — Reorder tool list by priority | Low | Medium — orient tools get more attention |
| **Task 1** — Add `codemap` meta-tool | Medium | High — eliminates multi-tool orientation |

### Phase 2 — Breaking (batch into next major release)

| Task | Effort | Token impact |
|------|--------|-------------|
| **Task 4** — Remove `path` tool | Low | Small — one fewer tool to parse |
| **Task 5** — Merge `impact_analysis` into `fn_impact` | Medium | Medium — resolves common confusion |
| **Task 6** — Merge `list_functions` into `where` | Medium | Small — partial overlap |
| **Task 7** — Merge `file_deps` + `file_exports` into `inspect` | Medium | Small — saves one round-trip |

After Phase 2, the tool count drops from **32 to 28** (remove 4, add `codemap`), with significantly better descriptions and ordering. The remaining tools have clearer boundaries and the AI has a reliable "start here" entry point.

---

## Alternatives Considered

### Task-based modules (refactoring / planning / developing / linting)

Grouping tools by user intent was considered but rejected because:

1. **Tools don't map 1:1 to tasks** — `context` is useful for refactoring, planning, AND developing. You'd duplicate tools across modules or force the AI to pick a module before picking a tool (two decisions instead of one).
2. **Tasks are fluid** — a conversation starts as "planning" then shifts to "refactoring" when the AI discovers a problem. Module switching adds friction.
3. **Stage-based tiers are universal** — every task follows orient-analyze-validate regardless of whether it's refactoring or linting. Stages map to what the AI needs at each step, not what the human wants to accomplish.

### Progressive disclosure (hard-gated stages)

Exposing only Stage 1 tools initially and unlocking Stage 2 after orientation was considered but rejected because:

1. **Fragile** — if the AI skips orientation (e.g., user says "check fn_impact for X"), it's locked out of the tool it needs
2. **Stateful complexity** — requires a session state machine in the MCP server
3. **Soft guidance achieves 80% of the benefit** — tier prefixes in descriptions + `codemap` recommendations steer the AI without restricting it

### Aggressive consolidation (32 to ~15 tools)

Merging more aggressively (e.g., `query` absorbing `execution_flow`, `audit` absorbing `complexity`) was considered but rejected because:

1. **Overloaded tools are worse than many tools** — a single `query` tool with 15 parameters and 6 modes is harder to use correctly than 3 focused tools
2. **Description quality matters more than count** — 28 well-described tools outperform 15 vague ones
3. **Incremental approach is safer** — we can measure token savings after Phase 1 before committing to more breaking changes
