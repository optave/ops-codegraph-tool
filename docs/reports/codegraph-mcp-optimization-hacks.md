# Codegraph MCP Optimization: Tricks & Hacks for Claude Code Integration

**Source:** Claude Code v2.1.88 source analysis via [sanbuphy/claude-code-source-code](https://github.com/sanbuphy/claude-code-source-code) + [openedclaude/claude-reviews-claude](https://github.com/openedclaude/claude-reviews-claude)

**Date:** 2026-03-31
**Verified against:** Claude Code v2.1.88. Internal APIs (`_meta["anthropic/alwaysLoad"]`, `_meta["anthropic/searchHint"]`, `annotations.readOnlyHint`) are reverse-engineered from source — they are not part of the MCP specification and may change without notice in future Claude Code releases. Review these hacks against new releases periodically.
**Goal:** Make codegraph's MCP server a first-class citizen inside Claude Code — as discoverable and effective as built-in tools like Grep, Glob, and Read.

---

## The Discovery Problem

By default, **ALL MCP tools are deferred** in Claude Code. The model sees only tool names in `<system-reminder>` messages — no descriptions, no schemas. To use an MCP tool, the model must:

1. Notice the tool name in the deferred list
2. Call `ToolSearchTool` with relevant keywords
3. Get the full schema loaded via `tool_reference` content blocks
4. Only then invoke the tool

This means **codegraph tools are invisible by default** — the model has to actively search for them. Here's how to fix that.

---

## Hack 1: `alwaysLoad` — Bypass Deferred Loading (Critical)

**The single most impactful change.**

Claude Code checks `tool._meta['anthropic/alwaysLoad']` on each MCP tool. When `true`, the tool bypasses the deferred system and loads with **full schema into the initial prompt** — equivalent to built-in tools.

### Implementation

In codegraph's MCP `tools/list` response, set `_meta` on core tools:

```typescript
{
  name: "query",
  description: "...",
  inputSchema: { ... },
  _meta: {
    "anthropic/alwaysLoad": true
  }
}
```

### Which tools to always-load

Be selective — each always-loaded tool consumes context window tokens. Recommended:

| Tool | Why |
|------|-----|
| `query` | Core dependency analysis — the most versatile tool |
| `audit` | One-stop structural analysis — replaces multiple grep/read patterns |
| `where` | Symbol location — directly competes with Grep for "find this function" |

Everything else (`cfg`, `dataflow`, `sequence`, `communities`, `complexity`, `map`, `stats`, etc.) stays deferred and discoverable via ToolSearch.

---

## Hack 2: `searchHint` — Win the ToolSearch Scoring (High Impact)

When tools ARE deferred, `ToolSearchTool` uses a keyword scoring algorithm:

| Match Type | Score |
|------------|-------|
| Exact name-part match | **10-12 points** |
| Partial name-part match | **5-6 points** |
| `searchHint` word boundary match | **4 points** |
| Description word boundary match | **2 points** |

The `searchHint` field scores **2x description weight**. Set it via `_meta["anthropic/searchHint"]` on every tool:

```typescript
{
  name: "diff_impact",
  _meta: {
    "anthropic/searchHint": "blast radius changes diff staged commit git impact analysis"
  }
}
```

### Recommended searchHints per tool

| Tool | searchHint |
|------|------------|
| `query` | `"function call chain callers callees dependency trace"` |
| `audit` | `"code structure analysis health impact report architecture"` |
| `where` | `"find symbol locate definition search function class method"` |
| `diff_impact` | `"blast radius changes diff staged commit git impact"` |
| `context` | `"function source code dependencies callers full context"` |
| `map` | `"module overview codebase map most connected files"` |
| `stats` | `"graph health quality score metrics statistics"` |
| `complexity` | `"cyclomatic cognitive halstead maintainability function complexity"` |
| `path` | `"shortest path between two functions dependency chain"` |
| `exports` | `"export consumers who uses this symbol import"` |
| `triage` | `"priority queue risk ranked audit hotspot"` |
| `cfg` | `"control flow graph branches loops conditionals"` |
| `dataflow` | `"data flow analysis variable tracking taint"` |
| `communities` | `"module clusters community detection grouping cohesion"` |
| `roles` | `"dead code unreferenced core symbols hub bridge"` |
| `structure` | `"directory tree cohesion scores codebase layout"` |
| `batch` | `"multiple queries batch parallel targets"` |
| `fn_impact` | `"function impact blast radius callers affected"` |
| `children` | `"sub declarations parameters properties constants"` |
| `search` | `"semantic search embeddings natural language"` |
| `ast` | `"AST call sites kind filter abstract syntax tree"` |
| `check` | `"CI validation cycles complexity boundaries gates"` |

---

## Hack 3: `readOnlyHint` Annotation — Enable Parallel Execution (High Impact)

Claude Code checks `tool.annotations.readOnlyHint` to determine concurrency safety:

```typescript
isConcurrencySafe() { return tool.annotations?.readOnlyHint ?? false }
```

When `true`, the model can fire **multiple codegraph queries in parallel** — e.g., `query A` + `query B` + `where C` simultaneously.

### Implementation

Set annotations on all read-only tools in the `tools/list` response:

```typescript
{
  name: "query",
  annotations: {
    readOnlyHint: true,    // enables parallel execution
    destructiveHint: false,
    openWorldHint: false
  }
}
```

**Read-only tools** (most of them): `query`, `where`, `context`, `fn_impact`, `diff_impact`, `map`, `stats`, `complexity`, `path`, `exports`, `triage`, `children`, `search`, `ast`, `audit`, `roles`, `structure`, `communities`, `batch`, `check`, `cfg`, `dataflow`

**Not read-only** (writes to DB): `build`, `embed` (if exposed via MCP)

---

## Hack 4: Tool Naming for Maximum Discoverability

ToolSearch gives **10-12 points for exact name-part matches** vs 2 points for description matches. Tool names are split on underscores for matching.

### Current vs Optimized Names

| Current | Issue | Better |
|---------|-------|--------|
| `query` | Generic, clashes with DB concepts | `dependency_query` or keep `query` with strong searchHint |
| `where` | Ambiguous (SQL keyword) | `symbol_locate` or keep with searchHint |
| `map` | Generic | `module_map` |
| `stats` | Generic | `graph_stats` |
| `path` | Very generic | `dependency_path` |

**Trade-off:** Longer names are more discoverable but consume more tokens. Since codegraph tools are prefixed with `mcp__codegraph__`, the server name already provides namespace. The model searches for `mcp__codegraph__query` — the `codegraph` part helps.

---

## Hack 5: Description Front-Loading (Medium Impact)

Tool descriptions are truncated to **2048 characters**. The model only sees descriptions after ToolSearch loads them. Front-load the most critical information:

```
BAD:  "Codegraph is a dependency analysis tool that builds function-level
       graphs from source code using tree-sitter parsing..."

GOOD: "Find function callers, callees, and full dependency chains.
       Returns call paths, impact analysis, and dependency trees for any
       symbol in the codebase. Supports --kind, --file, -T (exclude tests) filters."
```

**First 200 chars should make the tool's value immediately obvious** — that's what the model uses to decide whether to invoke.

---

## Hack 6: Result Size Management (Medium Impact)

Claude Code enforces a **25,000 token limit** on MCP tool results (configurable via `MAX_MCP_OUTPUT_TOKENS` env var). The hard character limit is 100,000. Results exceeding this are truncated with a message telling the model to use pagination.

### Strategies

1. **Default to summary mode.** Return top-N results with a count of remaining. Include a hint: "Use `--limit` and `--offset` for pagination."

2. **Support `limit`/`offset` parameters** on high-volume tools (query, audit, triage, roles, exports).

3. **Structured output.** Return JSON objects, not giant text blocks. Claude Code processes `structuredContent` in MCP results and adds schema inference headers for better model parsing.

4. **Progressive disclosure.** Return a summary with tool-specific "drill down" suggestions:
   ```
   Found 47 callers of `buildGraph`. Top 5 by impact:
   1. cli.ts:buildCommand (fan-out: 12)
   2. ...

   Use `query buildGraph --limit 47` for complete list.
   Use `fn-impact buildGraph` for blast radius analysis.
   ```

---

## Hack 7: MCP Server Instructions (Medium Impact)

The `initialize` response can include server-level instructions (truncated to 2048 chars). These are injected into the model's context. Use them for high-level guidance:

```typescript
{
  serverInfo: { name: "codegraph", version: "3.6.0" },
  instructions: `Codegraph provides function-level dependency analysis for this codebase.

PREFER codegraph over Grep/Glob when you need:
- Who calls a function (query <name>)
- Impact of changing a function (fn-impact <name> or diff-impact --staged)
- Understanding code structure (audit <target>)
- Finding where a symbol is defined (where <name>)

USE Grep/Glob when you need:
- String/regex search across files
- Finding files by name pattern
- Reading raw file contents

Key flags: -T (exclude tests), -j (JSON output), --file <path> (scope to file)`
  }
}
```

This is the **only place to tell the model when to prefer codegraph over built-in tools** without consuming per-tool context.

---

## Hack 8: Hook Integration — Enrich Context Passively (Already Implemented)

Codegraph already uses `enrich-context.sh` as a PostToolUse hook on Read/Grep to inject dependency context. This is highly effective because:

1. **It's passive** — runs automatically without the model requesting it
2. **It augments built-in tool results** — the model gets codegraph data even when using Read/Grep
3. **It uses `<system-reminder>` tags** — which the model treats as system-level context

### Optimization opportunities

- **Be selective about when to enrich.** Not every Read needs dependency context. Check if the file is in the graph before running codegraph.
- **Keep output compact.** Hook results add to context consumption. Focus on: file's imports, file's exports and their consumers, file's direct dependencies. Skip deep transitive chains.
- **Use exit code 0 always.** Exit code 2 blocks the tool. The enrich hook should never block.

---

## Hack 9: Subagent Passthrough (Free Win)

From Claude Code source:

```typescript
// Allow MCP tools for all agents
if (tool.name.startsWith('mcp__')) {
  return true
}
```

**All MCP tools pass through to subagents unconditionally.** They bypass agent disallow lists. This means codegraph tools are automatically available to every Agent/Explore/Plan subagent the model spawns.

No action needed for the current read-only tool set — this is free. But it means **codegraph tools work in parallel agent workflows** out of the box.

**Security caveat:** The passthrough is unconditional and cannot be overridden per-agent. If codegraph ever exposes write-capable tools (`build`, `embed`) via MCP, those tools would be available to every child agent (Agent, Explore, Plan) regardless of the orchestrator's intended restrictions. Keep write-capable tools out of the MCP server surface, or gate them behind explicit opt-in, to preserve child-agent capability boundaries.

---

## Hack 10: Compete with Built-in Tools on Their Turf

Claude Code has built-in tools for code exploration: `Grep`, `Glob`, `Read`. Codegraph can position itself as a **higher-level alternative** for specific use cases:

| User Intent | Built-in Approach | Codegraph Approach |
|-------------|------------------|-------------------|
| "Find where X is called" | `Grep("X(")` — noisy, includes strings/comments | `query X` — precise, function-level |
| "What does this file depend on?" | `Read file` + manual analysis | `where --file path` — instant inventory |
| "Impact of changing X" | Multiple Greps + manual tracing | `fn-impact X` — full transitive analysis |
| "Understand this code" | `Read` multiple files | `audit X` — structure + impact + health |
| "Find dead code" | Manual search | `roles --role dead` — precise |
| "PR review" | `git diff` + Read files | `diff-impact main` — structural analysis |

The server instructions (Hack 7) and `alwaysLoad` (Hack 1) are key to making the model choose codegraph over grep when appropriate.

---

## Hack 11: Prompt Cache Stability

Claude Code's prompt cache saves money by caching the system prompt. Tool ordering matters:

- Built-in tools appear as a **contiguous prefix**
- MCP tools appear as a **suffix**
- Adding/removing an MCP tool doesn't invalidate built-in tool cache

For codegraph: **keep the tool list stable across sessions.** Don't dynamically add/remove tools based on graph state. If a tool isn't applicable (e.g., `search` without embeddings), keep it listed but return a helpful error message when called.

---

## Implementation Priority

| Hack | Impact | Effort | Do Now? |
|------|--------|--------|---------|
| 1. `alwaysLoad` on core tools | **Critical** | Trivial | **Yes** |
| 2. `searchHint` on all tools | **High** | Low | **Yes** |
| 3. `readOnlyHint` annotations | **High** | Trivial | **Yes** |
| 7. Server instructions | **Medium** | Low | **Yes** |
| 6. Result size management | **Medium** | Medium | Soon |
| 5. Description front-loading | **Medium** | Low | Soon |
| 8. Optimize enrich hook | **Medium** | Low | Soon |
| 4. Tool naming review | **Low** | Low | Later |
| 11. Stable tool list | **Low** | Low | Later |

---

## Quick Implementation Checklist

```typescript
// In codegraph's MCP tools/list handler:

const CORE_TOOLS = ['query', 'audit', 'where'];

tools.map(tool => ({
  ...tool,

  // Hack 1: Always load core tools
  _meta: {
    ...(CORE_TOOLS.includes(tool.name) && { "anthropic/alwaysLoad": true }),
    // Hack 2: searchHint for all tools
    "anthropic/searchHint": SEARCH_HINTS[tool.name]
  },

  // Hack 3: Mark read-only tools for parallel execution
  annotations: {
    readOnlyHint: !WRITE_TOOLS.includes(tool.name),
    destructiveHint: false,
    openWorldHint: false
  }
}));

// Hack 7: Server instructions in initialize response
{
  instructions: SERVER_INSTRUCTIONS  // 2048 char max, when to prefer codegraph
}
```

---

## Key Insight

Claude Code treats MCP tools as second-class citizens by default (deferred, no schema visible, no concurrent execution). But it provides explicit escape hatches (`alwaysLoad`, `searchHint`, `readOnlyHint`) that can elevate MCP tools to **first-class status** — indistinguishable from built-in tools in the model's decision-making. Codegraph should use all of them.
