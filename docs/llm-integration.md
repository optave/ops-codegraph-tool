# LLM Integration — Feature Planning

> **Core principle:** Compute once at build time, serve compressed at query time. The graph tells you what's connected, the LLM tells you what it means, and the consuming AI gets both without reading raw code.

## Architecture

Two layers:

1. **Build-time LLM enrichment** — during `codegraph build`, an LLM annotates each function/class with semantic metadata (summaries, purpose, side effects, etc.) and stores it in the graph DB.
2. **Query-time token savings** — the consuming AI model (via MCP) gets pre-digested context instead of raw source code.

```
Code changes → codegraph build (+ LLM enrichment) → SQLite DB with semantic metadata
                                                          ↓
                                              AI model queries via MCP
                                                          ↓
                                              Gets structured summaries,
                                              not raw code → saves tokens
```

---

## Features by Category

### Understanding & Documentation

#### "What problem does this function solve?"
- `summaries` table — LLM-generated one-liner per node, stored at build time
- MCP tool: `explain_purpose <name>` — returns summary + caller context ("it's called by X to do Y")

#### "Summarize this module in plain English"
- Module-level rollup summaries — aggregate function summaries + dependency direction into a module narrative
- MCP tool: `explain_module <file>` — returns module purpose, key exports, role in the system

#### "Auto-generate meaningful docstrings"
- `docstrings` column on nodes — LLM-generated, aware of callers/callees/types
- CLI command: `codegraph annotate` — generates or updates docstrings for changed functions
- Diff-aware: only regenerate for functions whose code or dependencies changed

---

### Code Review & Quality

#### "Is this function doing too much?"
- `complexity_notes` column — LLM assessment stored at build time: responsibility count, cohesion rating
- Graph metrics feed into the assessment: fan-in, fan-out, edge count
- MCP tool: `assess <name>` — returns complexity rating + specific concerns

#### "Are there naming inconsistencies?"
- `naming_conventions` metadata per module — detected patterns (camelCase, snake_case, verb-first, etc.)
- CLI command: `codegraph lint-names` — LLM compares names against detected conventions, flags outliers

#### "Smart PR review"
- `diff-review` command — takes a diff, walks the graph for affected nodes, fetches their summaries
- Returns: what changed, what's affected, risk assessment, suggested review focus areas
- MCP tool: `review_diff <ref>` — structured review the consuming AI can relay to the user

#### "Show me a visual impact graph for this PR"
- **Foundation (implemented):** `codegraph diff-impact <base> --format mermaid -T` generates a Mermaid flowchart showing changed functions, transitive callers, and blast radius — color-coded by new/modified/blast-radius
- **CI automation:** GitHub Action that runs on every PR:
  1. `codegraph build .` (incremental, fast on CI cache)
  2. `codegraph diff-impact $BASE_REF --format mermaid -T` to generate the graph
  3. Post as a PR comment — GitHub renders Mermaid natively in markdown
  4. Update on new pushes (edit the existing comment)
- **LLM-enriched annotations:** Overlay the graph with semantic context:
  - For each changed function: one-line summary of WHAT changed (from diff hunks)
  - For each affected caller: WHY it's affected — what behavior might change downstream
  - Risk labels per node: `low` (cosmetic / internal), `medium` (behavior change), `high` (breaking / public API)
  - Node colors shift from green → yellow → red based on risk, replacing the static new/modified styling
- **Diff-aware narrative:** LLM reads the diff + graph and generates a structured PR summary:
  - "What changed and why it matters" per function
  - Potential breaking changes and side effects (from `side_effects` metadata)
  - Overall PR risk score (aggregate of node risks weighted by centrality)
- **Review focus:** Prioritize reviewer attention:
  - Rank affected files by risk × blast radius — "review this file first"
  - Highlight critical paths: the shortest path from a changed function to a high-fan-in entry point
  - Flag test coverage gaps for affected code (cross-reference with test file graph edges)
- **Historical context overlay:**
  - Annotate nodes with churn data: "this function changed 12 times in the last 30 days"
  - Highlight fragile nodes: high churn + high fan-in = high breakage risk
  - Track blast radius trends over time: "this PR's blast radius is 2× larger than your average"
- **Interactive rendering (stretch):**
  - Render as SVG with clickable nodes linking to file:line in the PR diff view
  - Collapse/expand depth levels to manage large graphs
  - Filter by risk level or file path

**Infrastructure needed:**
| What | Where | Depends on |
|------|-------|------------|
| GitHub Action workflow | `.github/workflows/impact-graph.yml` | `diff-impact --format mermaid` (done) |
| LLM diff summarizer | `llm.js` + `queries.js` | LLM provider abstraction, `summaries` table |
| Risk scoring per node | `nodes` table column | LLM assessment + graph centrality metrics |
| Churn tracking | `metadata` table | Git log integration at build time |
| SVG renderer | New module or external tool | Mermaid CLI (`mmdc`) or D3-based renderer |

---

### Refactoring Assistance

#### "Can I safely split this file?"
- `split_analysis <file>` — graph identifies clusters of tightly-coupled functions within the file, LLM suggests groupings
- Returns: proposed split, edges that would cross file boundaries, risk of circular imports

#### "Which functions are extraction candidates?"
- `extraction_candidates` query — find functions called from multiple modules (high fan-in, low internal coupling)
- LLM ranks them by utility: "this is a pure helper" vs "this has side effects, risky to move"

#### "Suggest backward-compatible signature change"
- `signature_impact <name>` — graph provides all call sites, LLM reads each one
- Returns: suggested new signature, adapter pattern if needed, list of call sites that need updating

---

### Architecture & Design

#### "Why does module A depend on module B?"
- `dependency_path <A> <B>` — graph finds shortest path(s), LLM narrates each hop
- Returns: "A imports X from B because A needs to validate tokens, and B owns the token schema"

#### "What's the most fragile part of the codebase?"
- `fragility_report` — combines graph metrics (high fan-in + high fan-out + on many paths) with LLM reasoning
- `risk_score` column per node — computed at build time from graph centrality + LLM complexity assessment
- CLI command: `codegraph hotspots` — ranked list of riskiest nodes with explanations

#### "Suggest better module boundaries"
- `boundary_analysis` — graph clustering algorithm identifies tightly-coupled groups that span modules
- LLM suggests reorganization: "these 4 functions in 3 different files all deal with auth, consider consolidating"

---

### Onboarding & Navigation

#### "Where should I start reading?"
- `entry_points` query — graph finds roots (high fan-out, low fan-in) + LLM ranks by importance
- `onboarding_guide` command — generates a reading order based on dependency layers
- MCP tool: `get_started` — returns ordered list: "start here, then read this, then this"

#### "What's the flow when a user clicks submit?"
- `trace_flow <entry_point>` — graph walks the call chain, LLM narrates each step
- Returns sequential narrative: "1. handler validates input → 2. calls createOrder → 3. writes to DB → 4. emits event"
- `flow_narratives` table — pre-computed for key entry points at build time

#### "What would I need to change to add feature X?"
- `change_plan <description>` — LLM reads the description, graph identifies relevant modules, LLM maps out touch points
- Returns: files to modify, functions to change, new functions needed, test coverage gaps

---

### Bug Investigation

#### "What upstream functions could cause this bug?"
- `trace_upstream <name>` — graph walks callers recursively, LLM reads each and flags suspects
- `side_effects` column per node — pre-computed: "mutates state", "writes DB", "calls external service"
- Returns ranked list: "most likely cause is X because it modifies the same state"

#### "What are the side effects of calling this function?"
- `effect_analysis <name>` — graph walks the full callee tree, aggregates `side_effects` from every descendant
- Returns: "calling X will: write to DB (via Y), send email (via Z), log to file (via W)"
- Pre-computed at build time, invalidated when any descendant changes

---

## New Infrastructure Required

| What | Where | When computed |
|------|-------|---------------|
| `summaries` — one-line purpose per node | `nodes` table column | Build time, incremental |
| `side_effects` — mutation/IO tags | `nodes` table column | Build time, incremental |
| `complexity_notes` — risk assessment | `nodes` table column | Build time, incremental |
| `risk_score` — fragility metric | `nodes` table column | Build time, from graph + LLM |
| `flow_narratives` — traced call stories | New table | Build time for entry points |
| `module_summaries` — file-level rollups | New table | Build time, re-rolled on change |
| `naming_conventions` — detected patterns | Metadata table | Build time per module |
| LLM provider abstraction | `llm.js` | Config: local/API/none |
| Cascade invalidation | `builder.js` | When a node changes, mark dependents for re-enrichment |
