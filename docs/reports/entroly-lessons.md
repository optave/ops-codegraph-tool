# Lessons from Entroly: LLM-Native Context Assembly

**Date:** 2026-04-24
**Source:** Analysis of [juyterman1000/entroly](https://github.com/juyterman1000/entroly) (commit on `main` at fetch time, Apr 2026) cross-referenced with codegraph's current CLI, MCP tool registry, and query layer.

---

## Executive Summary

Entroly is a Rust/Python tool whose pitch is "compress a 2M-token repo into optimal context for an LLM within a token budget." It overlaps with codegraph on the substrate (parse a repo, build a dep graph, expose over MCP) but solves a different top-level problem: **context packing under a hard token budget**. Codegraph answers *"what depends on what?"*; entroly answers *"given this query and N tokens, what should the LLM see?"*.

Most of entroly's surface (federated swarm learning, self-evolving daemons, SAST scanning, chat-ops integrations, LLM response distillation, agentskills.io export) is either scope creep or marketing. A small core is genuinely worth learning from:

1. **Hierarchical / multi-resolution output** — Level 1 (one-line-per-file map) → Level 2 (skeleton/signatures) → Level 3 (full source). Codegraph has only full-detail output today; `--no-source` (`src/cli/commands/context.ts:18`) is a coarse binary toggle, not a resolution ladder.
2. **Token-budgeted selection** — a `--budget <tokens>` flag that caps output to fit a target model's context window. Codegraph has `limit`/`offset` pagination but no token awareness.
3. **Dep-graph-constrained packing** — when budget is tight, keep selected symbols' direct dependencies together rather than dropping them independently. Codegraph already *computes* the edges; the packing policy is missing.
4. **Entropy as a secondary ranking signal** — compression-ratio-derived information density, used alongside fan-in/complexity to break ties when selecting which symbols to show.

Four concrete, bounded additions are proposed below (F1–F4), numbered in the recommended build order. None require the ML/self-learning machinery. All plug into existing codegraph layers.

---

## What Entroly Actually Is (grounded)

| Claim | Verified from |
|---|---|
| Rust core + Python CLI, ~30 crates-worth of source | `entroly-core/src/` (30 `.rs` files, ~1.5 MB) and `entroly/` (~40 Python modules) |
| Core is a 0/1 knapsack over "context fragments" | `entroly-core/src/knapsack.rs` — differentiable soft bisection finds the Lagrange multiplier for the budget constraint; falls back to exact DP when weights converge |
| Scoring = recency + frequency + semantic + entropy | `ScoringWeights` in `knapsack.rs` (0.30/0.25/0.25/0.20 defaults) |
| Keyword retrieval via BM25 with path/identifier boosts | `entroly-core/src/bm25.rs` |
| Dependency-aware selection (callee pinning, component cohesion) | `entroly-core/src/depgraph.rs` — directed dep graph over fragments, not just files |
| Information density via Kolmogorov (DEFLATE) entropy | `entroly-core/src/entropy.rs` — `kolmogorov_entropy()` uses LZ77 compression ratio |
| Three-level hierarchical output: map → skeleton → full | `entroly-core/src/hierarchical.rs` and `skeleton.rs` |
| Near-duplicate detection via SimHash + multi-probe LSH | `entroly-core/src/lsh.rs` (12 tables × 10 bits, 3-probe) |
| MCP server with ~35 tools | `entroly/server.py` — `remember_fragment`, `optimize_context`, `recall_relevant`, `explain_context`, `prefetch_related`, `get_stats`, etc. |
| Federated learning, self-evolving "dreaming loop" | `entroly/evolution_daemon.py`, `federation.py` — genuine code, not just README theater, but orthogonal to codegraph's purpose |
| SAST-style vulnerability scanning | `entroly-core/src/sast.rs` (124 KB) — scope creep for a context-packing tool |

**Benchmarks claimed:** 100% NeedleInAHaystack retention, 3.6% LongBench saving with a small accuracy gain at n=100, gpt-4o-mini. Confidence intervals overlap baseline on all seven benchmarks — i.e., the honest read is "compression does not hurt accuracy at these scales," not "compression improves accuracy."

**Red flags to ignore:** the README's ROI table ("save $10K–$14K/month on day 1"), the "competitive compounding" section, and the "95% token savings" headline all lack methodology links. Learn from the engineering, not the marketing.

---

## What Codegraph Already Has (verified)

Before proposing additions, facts that bound the gap analysis (verified against `src/` on this branch). Line numbers below are accurate at commit `0d7fa6a` — treat `:N` suffixes as pointers, not load-bearing references; if drift matters, grep for the named symbol.

| Capability | Status | Location |
|---|---|---|
| Token/byte-budget flag on any command | **No** | No `--budget`/`--max-tokens` in `src/cli.ts` or `src/cli/commands/*.ts` |
| Signature-only output mode | **Binary toggle** (`--no-source`) | `src/cli/commands/context.ts:18`, `src/mcp/tool-registry.ts:228` |
| Per-file symbol inventory, single file | **Yes** | `codegraph where --file <path>` → `src/cli/commands/where.ts` |
| Whole-repo per-file symbol map in one shot | **No** | `codegraph map` is directory-level connectivity, not file-level symbols — `src/presentation/queries-cli/overview.ts:261` |
| BM25 / lexical retrieval | **Yes** | `mode: 'keyword'` in `semantic_search` MCP tool — `src/mcp/tools/semantic-search.ts:22`, `ftsSearchData` in `src/domain/search/index.ts:10` |
| Hybrid keyword + embedding search | **Yes** | `mode: 'hybrid'` — `src/mcp/tool-registry.ts:299` |
| Info-density / entropy metric per file or symbol | **No** | `src/features/complexity.ts` has cognitive/cyclomatic/MI; no entropy |
| Dep-aware context packing under a budget | **No** | Edges exist; no selection policy consumes them |
| MCP `brief` tool (curated token-light summary) | **Yes** | `src/mcp/tool-registry.ts:120` — closest existing analog to entroly's `optimize_context` |
| Resolution ladder (summary → signatures → full) | **Limited** | `--quick` on audit, `--no-source` on context, `depth` on MCP `context`. No formal tier system |

So: codegraph is strong on *what the graph contains* and weak on *how to serve a bounded slice of it to a constrained consumer*. That is exactly entroly's strength.

---

## Proposed Additions

### F1 — Whole-Repo File Skeleton Map

**What:** A new command `codegraph skeleton-map` (or extend `map --per-file`) that prints, for every non-test file in the repo, a single line of the form:

```
src/domain/parser.ts → LANGUAGE_REGISTRY, parseFile(), extractImports(), EXTRACTORS{…}
src/db/index.ts → openDb(), insertNode(), insertEdge(), applySchema()
```

One line per file, top N exported symbols per file, sorted by fan-in or path. Designed to fit in a 2K–10K token budget for a medium repo.

**Why:** Codegraph's existing `map` reports directory connectivity (`src/presentation/queries-cli/overview.ts` — `TopNode[]` with in/out edge counts). That answers "which files are central" but not "what does this codebase expose." The file-skeleton map is the canonical cold-start context for an agent: before any query, show the LLM what *exists*. Entroly's `compress_level1` (`entroly-core/src/hierarchical.rs`) is exactly this pattern, and it's the cheapest form of full-repo visibility.

**Where it plugs in:**
- Query: already have `symbols_by_file` and `exports` in `src/domain/queries.ts` / `src/domain/analysis/`. Aggregate them — no new schema.
- Presentation: new file `src/presentation/skeleton-map.ts`.
- Also register as an MCP tool `repo_skeleton` in `src/mcp/tool-registry.ts`, budget-aware (F3). This is the single most useful tool to give an agent before it starts asking questions.

**Effort:** ~1 day. Mostly a new SELECT + a formatter.

---

### F2 — Skeleton / Signature-Only Output Mode

**What:** A formal `--skeleton` (or `--level signatures`) output mode that emits, for each selected symbol: kind, name, parameters, return type, modifiers, and a one-line leading comment — but not the body. Works on `context`, `audit`, `exports`, and `where --file`.

**Why:** Entroly's empirical claim (from `entroly-core/src/skeleton.rs`: "skeleton carries ~90% of structural information at ~10–30% of the token cost") matches the intuition every code reviewer already has: signatures are usually enough. Today, `--no-source` elides bodies *and* most metadata — there's no middle setting.

**Where it plugs in:**
- Tree-sitter already gives us parameter ranges and return-type ranges during extraction (`src/domain/parser.ts`, per-language extractors). We can emit signature slices without re-parsing if we persist signature byte offsets on the node row. For v1, re-slice on demand from the source file — fast enough to avoid a schema change.
- Add a renderer in `src/presentation/skeleton.ts` that walks selected nodes and emits the signature format. Reuse from F3's degradation ladder.
- Language coverage: JS/TS/Python/Go/Rust cover the hot path; other languages can fall back to the full signature line from `nodes.start_line` through the first `{` / `:` / newline.

**Non-goals:** Do not ship entroly's regex-style fallback (`entroly-core/src/skeleton.rs` detects language from filename and pattern-matches — fragile). We already have tree-sitter; use it.

**Effort:** ~2 days for the renderer plus per-language signature-extent coverage.

---

### F3 — Token-Budgeted Output Flag

**What:** Add `--budget <tokens>` (and `--model <name>` to pick a tokenizer) to commands whose output is commonly piped into an LLM: `context`, `audit`, `batch`, `brief`, `query`, and `exports`. When the flag is set, the command measures its serialized output against the budget and progressively downgrades detail until it fits.

**Why:** The hard constraint every AI-assistant caller hits is the context window. Today, consumers (humans, hooks, agents) pick detail level manually via `-T`, `--no-source`, and `--quick`. A budget flag lets the command decide — and makes the MCP tools safe to call without first knowing how big the answer will be. This is the single change with the highest leverage for agent-driven usage.

**Where it plugs in:**
- Tokenizer: add `src/infrastructure/tokenizer.ts` — thin wrapper over `@dqbd/tiktoken` or a cheap byte-heuristic fallback (chars/4). Don't add a heavy ML dependency.
- Budget-aware serializer: extend `src/presentation/result-formatter.ts` with `formatWithBudget(result, budget, tokenizer)`.
- Degradation ladder (in order): full source → signature-only (F2) → name + path only → elided with a "N more symbols" tail. Emit a warning to stderr naming what was dropped.
- Wire the flag through commander in `src/cli.ts`; expose the same parameter on the matching MCP tools in `src/mcp/tool-registry.ts`.

**Non-goals:** No knapsack/LP solver, no differentiable bisection. A sorted greedy fill by existing risk/role rank is enough and keeps the code reviewable. If we ever need it, the entry point exists.

**Effort:** ~1 day for the tokenizer + formatter plumbing, plus per-command wiring (mostly mechanical).

---

### F4 — Dep-Aware Context Packing

**What:** When `context <name>` or `audit` emits callees/callers under a budget (F3), prefer keeping direct dependencies of an included symbol over unrelated siblings. I.e., if `foo` is in the output, `foo`'s called functions should be preferred over other candidates at the same rank.

**Why:** Entroly frames this as "context is not additive" (`entroly-core/src/depgraph.rs`): dropping a called function from a kept caller produces a broken slice the LLM hallucinates over. Codegraph already has the `calls` edges to enforce this — the packing policy just doesn't use them today.

**Where it plugs in:**
- Sort-phase modification in `src/domain/analysis/context.ts` (or wherever the F3 greedy fill lives): after scoring, add a second pass that boosts the score of candidates that are direct callees of already-selected symbols. Single-pass boost is fine; no need for iterative fixed-point.
- Same policy naturally falls out for `features/sequence.ts` output (BFS already pins callees).

**Non-goals:** Don't ship entroly's connected-component analysis or graph-constrained DP. A one-pass dependency boost captures ≥80% of the value at a fraction of the complexity.

**Effort:** ~0.5 day.

---

## Explicitly Not Adopting

Documenting these so a future agent doesn't re-open the question.

| Entroly feature | Why not for codegraph |
|---|---|
| Federated swarm learning (`entroly/federation.py`) | Privacy posture requires legal review; infra obligations (coordination server, weight-sharing protocol); no clear user demand. Codegraph's value prop is *local, deterministic, reproducible* — opposite of "your AI got smarter overnight because other people's did." |
| Self-evolving "dreaming loop" (`evolution_daemon.py`) | Non-determinism is antithetical to a build tool used in pre-commit hooks. Same graph input must produce same graph output. |
| SAST vulnerability scanner (`entroly-core/src/sast.rs`, 124 KB) | Separate product. The existing `docs/reports/static-analysis-feature-opportunities.md` proposals (A5 SQL injection, B3 resource leaks) are the right envelope for security-adjacent checks — narrow, deterministic, opt-in `check` predicates. Don't clone 124 KB of another tool's lint rules. |
| LLM response distillation ("strip 40% filler") | Codegraph doesn't produce LLM responses. |
| Telegram/Discord/Slack chat integrations | Scope creep. Hooks and the MCP server are the correct integration surface. |
| SimHash + multi-probe LSH dedup (`entroly-core/src/lsh.rs`) | Our "fragments" are graph nodes with stable IDs; near-dup detection is unnecessary. This matters for entroly because it treats arbitrary text chunks as candidates. |
| Differentiable soft-bisection knapsack (`knapsack.rs`) | The 100+ lines of Lagrangian/KKT math are optimizing for a regime codegraph doesn't hit (500+ candidates with continuous feedback signals). Sorted greedy fill under F3 is within 5% of optimal for our case and 50× simpler to review. |
| BM25 implementation | Already have it via SQLite FTS5 — `src/domain/search/index.ts:10`. |

---

## Implementation Order

F1 (skeleton map) → F2 (signature mode) → F3 (budget flag, using F2 as the middle rung) → F4 (dep-aware packing). The F-numbers match this order — F1 is built first.

This order ships user-visible value at each step:
- After F1: agents get a cheap cold-start map — improvement even without budget support.
- After F2: human users get a readable middle-detail mode.
- After F3: MCP tool calls become safe under context-window constraints.
- After F4: quality-of-slice for the already-useful tools improves.

Total estimated effort: ~5 engineering days. No schema migrations. No new runtime dependencies beyond a tokenizer (opt-in, falls back to char heuristic).

---

## Open Questions

1. **Which tokenizer?** `@dqbd/tiktoken` is GPT-accurate but ~1 MB WASM. Claude uses a different tokenizer that isn't publicly shipped. A chars/4 heuristic is within 15% for code and has no dependency. Recommend heuristic as default, tiktoken as opt-in via `--model`. Confirm with user.
2. **Should `--budget` be opt-in or on-by-default for MCP tools?** MCP consumers are always agents that care about context size. Argue: default to a generous budget (e.g., 16K tokens) on MCP tools, no-op on CLI unless passed. Needs product decision.
3. **Is the file-skeleton map part of `brief` or a new command?** `brief` is symbol-scoped; the repo-skeleton-map is repo-scoped. They should coexist — different zoom levels. Keep separate.
