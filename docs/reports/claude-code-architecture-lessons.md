# What Codegraph Can Learn from Claude Code's Architecture

**Source:** [claude-reviews-claude](https://github.com/openedclaude/claude-reviews-claude) — Claude's self-analysis of Claude Code v2.1.88 (1,902 files, 477K lines TypeScript, 17 architecture deep-dives)

**Date:** 2026-03-31
**Coverage:** All 17 architecture episodes + README + DISCLAIMER (100% of repo)

---

## Executive Summary

Claude Code is a 477K-line TypeScript CLI built on Bun with a terminal UI (React + Ink). Its architecture — analyzed across 17 detailed episodes covering the query engine, tool system, multi-agent coordinator, plugins, hooks, bash engine, permissions, agent swarms, session persistence, context assembly, compaction, startup, bridge system, UI, services/API, and infrastructure — reveals patterns directly applicable to codegraph. This report extracts **22 actionable patterns** organized by domain.

---

## Part I: Tool & MCP Architecture

### 1. Schema-Driven Tool Registration

**What Claude Code Does:**
Every tool declares a **Zod v4 `inputSchema`** that simultaneously drives runtime validation, JSON Schema generation for the LLM API, TypeScript type inference, and permission pattern matching. A `buildTool()` factory applies **fail-closed defaults** — omitted security declarations default to restrictive behavior (`isConcurrencySafe: false`, `isReadOnly: false`).

Tools are self-contained directories with no cross-tool imports:
```
tools/ToolName/
├── ToolName.ts      # implementation
├── prompt.ts        # LLM-facing description
├── UI.tsx           # rendering
├── constants.ts
└── __tests__/
```

The 13-stage execution pipeline: Tool discovery → Abort check → Schema validation → Custom validation → Speculative execution → PreToolUse hooks → Permission decision → Tool invocation → PostToolUse hooks → Result mapping → Large result persistence → Context modification → Message injection.

**Codegraph Opportunity:**
- **MCP tool definitions.** Hand-written tool objects in `src/mcp/` could use Zod to eliminate duplicate type definitions, enable automatic runtime validation, and ensure new tools get conservative defaults by construction.
- **CLI command registration.** A single schema driving both Commander argument parsing and programmatic API validation in `cli.ts`.

---

### 2. Deferred/Lazy Tool Loading

**What Claude Code Does:**
Tools marked `shouldDefer: true` appear as **name-only stubs** initially. The model calls `ToolSearchTool` with keywords to load full schemas on demand. A `searchHint` property enables keyword matching. This keeps the system prompt compact.

**Codegraph Opportunity:**
Codegraph's MCP server exposes 30+ tools. Reducing initial exposure to core operations (`query`, `audit`, `map`, `stats`) and letting agents discover specialized tools (`cfg`, `dataflow`, `sequence`, `communities`) on demand would significantly cut token consumption.

---

### 3. Prompt Cache Stability via Tool Partitioning

**What Claude Code Does:**
Tools are sorted deterministically: built-in tools as a contiguous prefix, MCP tools as a suffix. Adding an MCP tool doesn't invalidate cache keys for built-in tools — preventing 12x token cost inflation. Beta headers "latch" (once activated, never deactivated mid-session) to preserve cache key stability.

**Codegraph Opportunity:**
`buildToolList(multiRepo)` should ensure core tools always appear in the same order. Multi-repo tools append as a suffix. New tools append — never reorder existing tools. Small detail but matters for any MCP consumer that caches tool schemas.

---

### 4. Large Result Persistence

**What Claude Code Does:**
Results exceeding per-tool `maxResultSizeChars` thresholds persist to `~/.claude/tool-results/` with a disk path returned to the model. This prevents token overflow while preserving full data access.

**Codegraph Opportunity:**
When MCP queries return massive dependency trees or impact analyses, return a summary + file path for full results. Prevents token overflow in agent contexts. Low effort, high impact for MCP usability.

---

## Part II: Query Engine & Streaming

### 5. AsyncGenerator State Machine

**What Claude Code Does:**
The core `query()` function is an `async *generator` providing natural backpressure, lazy evaluation, composability, and cancellation via `return()`. The entire engine communicates exclusively through `yield`. This enables the retry wrapper (`withRetry`) to be an AsyncGenerator too — yielding status events between attempts while returning the final result.

**Codegraph Opportunity:**
- **Watch mode:** `codegraph watch` could use generators for composable pipelines: `watchChanges() |> filterRelevant() |> rebuildGraph() |> reportImpact()`
- **MCP streaming:** Tool responses could stream incrementally rather than buffering
- **Retry with visibility:** Build operations could yield progress events between retries

---

### 6. Five-Stage Compression Pipeline

**What Claude Code Does:**
Before each API call, messages pass through five sequential stages:
1. **Tool Result Budget** — Caps aggregate tool output, persists to disk
2. **History Snip** — Removes stale conversation segments
3. **Microcompact** — Cache-aware surgical editing of past messages (time-decay)
4. **Context Collapse** — Archives old turns with projected view
5. **Autocompact** — Full conversation summarization near token limits

Circuit breaker: max 3 consecutive failures halts compression. Token estimation uses three tiers: rough (bytes/4), proxy (Haiku tokens), exact (countTokens API).

**Codegraph Opportunity:**
Formalize **tiered result depth** for all query commands:
- **Quick:** Summary metrics only (what `--quick` already does for `audit`)
- **Standard:** Top-N impacts with truncation
- **Full:** Complete results (possibly persisted to file)
- **Progressive MCP:** Return summary first; agent requests expansion of specific sections

---

### 7. Streaming Tool Executor

**What Claude Code Does:**
`StreamingToolExecutor` processes incoming `tool_use` blocks concurrently during response streaming. Tool execution begins immediately upon block arrival, overlapping with continued API streaming. Claude Code bypasses the Anthropic SDK's `BetaMessageStream` to avoid O(n^2) partial JSON parsing, processing raw SSE events directly. A 90-second idle watchdog aborts streams producing no data.

**Codegraph Opportunity:**
If codegraph ever implements streaming query results (e.g., for large `batch` operations or `triage` scans), this pattern of starting work before the full request is parsed is worth adopting.

---

## Part III: Multi-Agent & Coordination

### 8. Coordinator Pattern: Synthesis as First-Class Responsibility

**What Claude Code Does:**
Coordinator mode transforms Claude Code from single-agent to orchestrator. Workers are **fully isolated** — zero shared conversation context. The coordinator must write self-contained prompts. A four-phase workflow enforces discipline:
1. **Research** (parallel workers)
2. **Synthesis** (coordinator only — explicitly forbidden from lazy delegation)
3. **Implementation** (sequential per file set)
4. **Verification** (fresh workers, never continued from implementation)

Worker results arrive as XML `<task-notification>` in user-role messages.

**Codegraph Opportunity:**
The **batch command** (`codegraph batch t1 t2 t3`) already fans out queries. Applying the coordinator pattern:
- Results could be synthesized into a unified report rather than just concatenated
- A `codegraph orchestrate` command could run research → analysis → report workflows
- MCP integration could expose a "plan-then-execute" workflow for complex analyses

---

### 9. File-Based Mailbox IPC for Multi-Agent

**What Claude Code Does:**
Agent swarms communicate via JSON files in `~/.claude/teams/{name}/inboxes/`. Lockfile-based mutual exclusion (exponential backoff, 5ms → 100ms, 10 attempts). Seven message types including idle notifications, permission delegation, and plan approval.

Design rationale: cross-process capability, crash persistence, debuggability (inspectable via `cat`/`grep`), no daemon/port/discovery needed.

**Codegraph Opportunity:**
Multi-session codegraph use (documented in CLAUDE.md) could benefit from a lightweight coordination file:
- `.codegraph/sessions.json` tracking active sessions and their worktrees
- Lock-based protection for concurrent graph builds
- Crash-safe: JSON files survive process death

---

### 10. Fork Subagent: Context-Sharing Optimization

**What Claude Code Does:**
Two spawn types: Fresh agents (zero context, new cache) for independent tasks vs. Fork agents (inherit parent's full context and prompt cache) for research/open-ended questions. Forks optimize token usage by reusing parent cache.

**Codegraph Opportunity:**
For MCP, this maps to query scoping. A "forked" query could inherit the current graph state and filter context rather than re-loading from scratch. Relevant for `codegraph context` and `codegraph audit` which build on shared graph data.

---

## Part IV: Security & Permissions

### 11. Seven-Step Permission Pipeline with Bypass-Immune Safety Checks

**What Claude Code Does:**
Seven ordered steps, each can short-circuit:
1. Tool-level deny rules (hard deny, can't override)
2. Tool-level ask rules (sandbox can bypass)
3. Tool-specific permission check
4-7. **Bypass-immune safety guardrails** — fire even in `bypassPermissions` mode

Six permission modes: `default`, `plan`, `acceptEdits`, `bypassPermissions`, `dontAsk`, `auto`.

The YOLO classifier (auto mode) uses a 2-stage approach: fast 64-token nudge → only if blocked, full 4096-token chain-of-thought. Critical security detail: **assistant text is excluded from classifier input** — only tool_use blocks appear, preventing the model from crafting persuasive text to influence the safety classifier.

**Codegraph Opportunity:**
- **`codegraph check` pipeline:** Formalize ordered check stages where certain checks (cycles, dead exports) are bypass-immune — they always run regardless of `--skip` flags
- **Denial circuit breakers:** Track consecutive check failures; after N failures, escalate to error rather than warning

---

### 12. Fail-Closed vs Fail-Open Boundaries

**What Claude Code Does:**
- **Security-critical:** fail-closed (unknown command → deny, omitted flags → restrictive)
- **Availability-critical:** fail-open with degradation (stale-while-error cache, log error, retry)
- 6-layer Bash defense: wrapper stripping → 23 injection patterns → AST parsing → command whitelist → path validation → OS sandbox
- Bare git repo attack prevention: blocks planted HEAD/objects/refs/hooks/config files

**Codegraph Opportunity:**
- Unknown check types in `codegraph check` should fail, not silently pass
- New checks should be opt-out, not opt-in
- When native and WASM engines diverge, fail-closed: flag the bug, don't silently pick one
- Parser failures for required languages should be hard errors; optional languages can fail-open

---

## Part V: Persistence & Context

### 13. Append-Only JSONL Session Storage

**What Claude Code Does:**
Sessions stored as JSONL files with parent-UUID linked lists enabling fork detection and compaction boundaries. 100ms write coalescing with per-file queues. A 64KB head+tail window enables millisecond session listing without full file reads.

20+ entry types: transcript messages, metadata, session context, operational records. Sync direct-write path for exit cleanup bypasses the async queue.

**Codegraph Opportunity:**
**Change journal.** Codegraph already has `domain/graph/journal.ts` and `domain/graph/change-journal.ts`. The append-only JSONL pattern with coalescing writes is worth adopting if not already used. The 64KB window trick could speed up journal scanning for incremental builds.

---

### 14. Three-Layer Context Assembly

**What Claude Code Does:**
1. **System Prompt (cached)** — Static identity + rules before dynamic boundary; dynamic sections after
2. **User/System Context (memoized)** — CLAUDE.md files, git status; computed once per session via `lodash/memoize`
3. **Per-Turn Attachments (ephemeral)** — 30+ types recomputed each turn with 1-second timeout via AbortController

Memory files support recursive `@include` (5 levels deep) with circular reference prevention. Conditional rules in `.claude/rules/` use frontmatter glob patterns to restrict application to specific file paths.

**Codegraph Opportunity:**
**`.codegraphrc.json` conditional rules.** Similar to Claude Code's glob-gated rules:
```json
{
  "rules": {
    "src/domain/**": { "complexity.maxCyclomatic": 15 },
    "src/presentation/**": { "complexity.maxCyclomatic": 25 }
  }
}
```
Path-specific configuration thresholds would let teams set stricter limits for core domain code vs presentation layers.

---

### 15. Skill Budget Management (Tiered Degradation)

**What Claude Code Does:**
Skill listings consume ~1% of context window through tiered degradation:
- **Tier 1:** Full descriptions for all skills
- **Tier 2:** Bundled skills keep full; others truncate to 250 chars
- **Tier 3:** Extreme overflow shows names only

**Codegraph Opportunity:**
MCP tool descriptions could implement similar tiering. When context is tight, return abbreviated tool descriptions. When context is ample, include usage examples and parameter documentation.

---

## Part VI: Startup & Performance

### 16. Fast-Path Cascade

**What Claude Code Does:**
CLI entry point dispatches based on command:
- `--version`: zero imports (~5ms)
- `--dump-system-prompt`: config + prompts only
- `--daemon-worker`: worker-specific modules
- Default: full 200+ imports

Each path uses dynamic `await import()` to load only necessary modules. Early input capture buffers keystrokes during ~500ms module evaluation.

**Codegraph Opportunity:**
Codegraph commands have varying import needs:
- `codegraph stats` needs only DB access — skip parser loading
- `codegraph where` needs only the query layer — skip analysis features
- `codegraph build` needs everything

Dynamic imports for heavy modules (tree-sitter, analysis features) based on which command is invoked could measurably improve startup for lightweight queries.

---

### 17. Import-Gap Parallelism

**What Claude Code Does:**
Launches async I/O between synchronous ES module `import` statements, exploiting ~135ms of import evaluation time as a "free" parallel window.

**Codegraph Opportunity:**
Start config read + SQLite connection while WASM grammars compile. Micro-optimization but compounds on large repos.

---

### 18. Generation Counter for Overlapping Async Inits

**What Claude Code Does:**
Singleton services increment a generation counter on each init. The `.then()` callback checks if its generation is still current before updating state. Prevents stale initialization from overwriting newer state.

**Codegraph Opportunity:**
Relevant for `codegraph watch` — if multiple file changes trigger concurrent rebuilds, a generation counter ensures only the latest rebuild's results are applied.

---

## Part VII: Architecture & Design Patterns

### 19. Leaf Module Isolation

**What Claude Code Does:**
The most-imported global state module (`bootstrap/state.ts`) imports **nothing** from application code — enforced by custom ESLint rules. This prevents the highest-coupling module from creating circular dependencies.

**Codegraph Opportunity:**
Codegraph's `shared/constants.ts`, `shared/kinds.ts`, and `shared/errors.ts` are imported across the entire codebase. Enforce that `shared/` never imports from `domain/`/`features/`/`presentation/` — dogfood codegraph's own `boundaries` feature. A `codegraph check --boundaries` rule could enforce this in CI.

---

### 20. Error Recovery as Architecture

**What Claude Code Does:**
Every error code maps to a specific recovery strategy. The retry engine is an AsyncGenerator yielding status events between attempts. Foreground/background classification prevents cascade amplification — background queries bail immediately on 529 (overload) instead of retrying.

**Codegraph Opportunity:**

| Error | Recovery Strategy |
|-------|----------|
| WASM grammar missing | Auto-run `npm run build:wasm` |
| SQLite locked | Retry with backoff (concurrent session) |
| Parser timeout | Skip file, warn, continue build |
| Native addon crash | Fall back to WASM engine |
| Out of memory | Reduce batch size, retry |

Partially implemented (native→WASM fallback) but could be formalized as a first-class pipeline.

---

### 21. Closure Factory + Sticky-On Latches

**What Claude Code Does:**
- **Closure factories** over classes: private state is scope-invisible, no `this` binding issues, no inheritance temptation
- **Sticky-on latches:** Once-activated boolean flags remain active for the session to preserve cache stability. Toggling costs ~$0.15-$0.21 in wasted tokens per flip.
- **Stale-while-error:** Serve cached data on transient failures rather than surfacing errors (macOS Keychain integration)
- **Re-entrancy guards:** Boolean flags short-circuit recursive call chains

**Codegraph Opportunity:**
- Closure factories align with codegraph's existing style for parser extractors; adopt consistently for new code
- Stale-while-error is relevant for the native engine loader — if the addon fails to load once, cache the WASM fallback decision rather than retrying every operation

---

### 22. Plugin/Skill Composition Model ("Prompt as Code")

**What Claude Code Does:**
Skills = YAML frontmatter + markdown prompt workflows. Six sources merged hierarchically. Kubernetes-operator-style reconciliation for plugin installation (declare desired → diff actual → install missing → report extra). Three-tier skill budget prevents context overflow regardless of installed plugin count.

**Codegraph Opportunity:**
**Codegraph "recipes" or "presets"** — reusable analysis workflows:

```yaml
# .codegraph/recipes/pr-review.yaml
name: PR Review
steps:
  - command: diff-impact main
  - command: check --cycles --complexity --boundaries
  - command: triage
output: markdown
```

Valuable for CI templates, team conventions, and MCP agent prompts.

---

## Part VIII: Bridge, UI & Services (Lower Priority)

### Notable Patterns (Not Directly Actionable)

| Pattern | Source | Why It's Interesting |
|---------|--------|---------------------|
| **Poll-dispatch-heartbeat loop** | Bridge System (Ep 13) | Remote execution model; relevant if codegraph ever supports remote graph servers |
| **Epoch-based conflict resolution** | Bridge System | Stale requests get 409; could apply to concurrent MCP sessions |
| **35-line minimal store** | UI (Ep 14) | `getState/setState/subscribe` with `useSyncExternalStore`; validates minimalism |
| **W3C event model in terminal** | UI (Ep 14) | Capture/bubble phases for overlapping dialogs; overkill for codegraph CLI |
| **Packed Int32Array screen buffer** | UI (Ep 14) | Zero-GC rendering; relevant only if codegraph adds a TUI |
| **Vim mode as pure-function FSM** | UI (Ep 14) | Discriminated union states with exhaustive matching; elegant but codegraph has no editor |
| **Multi-provider API factory** | Services (Ep 15) | Dynamic `await import()` per provider; relevant if codegraph supports multiple embedding providers |
| **Drop-in config directories** | Infrastructure (Ep 16) | `managed-settings.d/*.json` for enterprise; relevant if codegraph targets enterprise deployment |
| **Zero-token side channel** | Bash Engine (Ep 6) | Stderr tags extracted before model sees output; clever but codegraph isn't an LLM shell |
| **DreamTask** | Agent Swarms (Ep 8) | Background memory consolidation agent; novel concept for auto-documenting patterns |

---

## Priority Matrix

| # | Pattern | Impact | Effort | Priority |
|---|---------|--------|--------|----------|
| 1 | Schema-driven MCP tools (Zod) | High | Medium | **P1** |
| 2 | Deferred MCP tool loading | Medium | Low | **P1** |
| 4 | Large result persistence for MCP | High | Low | **P1** |
| 6 | Tiered query result depth | Medium | Medium | **P2** |
| 19 | Leaf module isolation enforcement | Medium | Low | **P2** |
| 14 | Conditional config rules (path-scoped) | Medium | Medium | **P2** |
| 11 | Bypass-immune check stages | Medium | Low | **P2** |
| 16 | Fast-path CLI dispatch | Medium | Medium | **P2** |
| 20 | Error recovery pipeline | Medium | Medium | **P3** |
| 3 | Prompt cache stability (tool ordering) | Low | Low | **P3** |
| 17 | Startup parallelism | Low | Medium | **P3** |
| 18 | Generation counter for watch mode | Low | Low | **P3** |
| 21 | Stale-while-error for native loader | Low | Low | **P3** |
| 7 | Streaming tool executor pattern | Low | High | **P4** |
| 13 | Append-only JSONL for change journal | Medium | Low | **P2** |
| 5 | AsyncGenerator for watch/MCP streaming | Medium | High | **P4** |
| 22 | Recipe/preset system | High | High | **P4** |
| 8 | Coordinator pattern for batch | Medium | High | **P4** |
| 15 | MCP tool description tiering | Low | Low | **P4** |
| 9 | Multi-session coordination file | Low | Medium | **P4** |
| 10 | Fork-style query context sharing | Low | High | **P4** |
| 12 | Fail-closed engine divergence | Low | Low | **P4** |

---

## Key Takeaways

### 1. "Dumb Scaffold, Smart Model"
Claude Code's most transferable insight: the harness does boring, reliable things (validation, caching, compression, security) while intelligence lives elsewhere. Codegraph already follows this for its core pipeline. The opportunities extend this philosophy to the **edges**: MCP integration, CI gates, error recovery, and extensibility.

### 2. MCP Is the Highest-Leverage Surface
Three of the top-5 priorities target MCP. As AI agents become primary consumers of codegraph, the MCP interface deserves the same engineering rigor Claude Code applies to its tool system: schema-driven validation, deferred loading, large result handling, and deterministic ordering.

### 3. Defense in Depth Applies to Analysis Tools
Claude Code's 7-step permission pipeline with bypass-immune safety checks translates to codegraph's `check` command: certain checks (cycles, dead exports) should be immune to `--skip` flags. The fail-closed vs fail-open distinction applies to every codegraph boundary.

### 4. The Append-Only Pattern Is Universally Applicable
JSONL with parent-UUID chains, coalescing writes, and head/tail windows for fast scanning. Codegraph's change journal could adopt this for incremental build reliability.

### 5. Context Is the Scarcest Resource
Claude Code spends 8,000+ lines managing 200K tokens. Codegraph's MCP tools should be equally conscious of how much context they consume — tiered results, deferred loading, and progressive disclosure are not optimizations, they're requirements for effective agent integration.
