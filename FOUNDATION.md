# Codegraph Foundation Document

**Project:** `@optave/codegraph`
**License:** Apache-2.0
**Established:** 2026 | Optave AI Solutions Inc.

---

## Why Codegraph Exists

There are 20+ code analysis and code graph tools in the open-source ecosystem. They all force a choice: **fast local analysis with no AI, or powerful AI features that require full re-indexing through cloud APIs on every change.** None of them give you an always-current graph that you can rebuild on every commit and optionally enhance with the LLM provider you already use.

Codegraph exists to be **the code intelligence engine that keeps up with your commits** — an always-fresh graph that works at zero cost out of the box, with optional LLM enhancement through the provider you choose. Your code only goes where you send it.

---

## Core Principles

These principles define what codegraph is and is not. Every feature decision, PR review, and architectural choice should be measured against them.

### 1. The graph is always current

**Codegraph must rebuild fast enough to run on every commit, every save, in every agent loop.**

This is our single most important differentiator. Every competitor in this space either re-indexes from scratch on every change (making them unusable in tight loops) or requires cloud API calls baked into the rebuild pipeline (making them slow and costly to run frequently).

File-level MD5 hashing means only changed files are re-parsed. Change one file in a 3,000-file project → rebuild in under a second. This makes commit hooks, watch mode, and AI-agent-triggered rebuilds practical. The graph is never stale.

The core pipeline is pure local computation — tree-sitter + SQLite. No API calls, no network latency, no cost. This isn't about being anti-cloud. It's about being fast enough that the graph can stay current without waiting on anything external.

*Test: after changing one file in a 1000-file project, does `codegraph build .` complete in under 500ms? Can it run in a commit hook without the developer noticing?*

### 2. Native speed, universal reach

**The dual engine is our architectural moat.**

Native Rust via napi-rs (rayon-parallelized tree-sitter) for platforms we support. Automatic WASM fallback for everything else. The user never chooses — `--engine auto` detects the right path.

We publish platform-specific optional packages (`@optave/codegraph-{platform}-{arch}`) that npm resolves automatically. This gives us 10-100x parsing speed on supported platforms with zero configuration, while never breaking on unsupported ones.

No other tool in this space has both native performance and universal portability in a single npm package.

*Test: does `codegraph build .` work on macOS ARM, macOS x64, Linux x64, and Windows x64 with native speed — and still work (slower) on any other Node.js-capable platform?*

### 3. Confidence over noise

**Every result should tell you how much to trust it.**

Our 6-level import resolution scores every edge 0.0-1.0. Most tools return all matches (noise) or pick the first one (often wrong). We quantify uncertainty.

This principle extends beyond import resolution. When we add features — dead code detection, impact analysis, search results — they should include confidence or relevance scores. AI agents and developers both benefit from ranked, scored results over raw dumps.

*Test: does every query result include enough context for the consumer to judge its reliability?*

### 4. Zero-cost core, LLM-enhanced when you choose

**The full graph works with no API keys. AI features are an optional layer on top.**

The core pipeline — parse, resolve, store, query, impact analysis — runs entirely locally with zero cost. No accounts, no API keys, no cloud calls. This is the mode that runs on every commit.

LLM-powered features (richer embeddings, semantic search, AI-enhanced analysis) are an optional enhancement layer. When enabled, they use whichever provider the user already works with (OpenAI, etc.). Your code goes to exactly one place: the provider you chose. No additional third-party services, no surprise cloud calls.

This dual-mode approach is unique in the competitive landscape. Competitors either require cloud APIs for core functionality (code-graph-rag, autodev-codebase) or offer no AI enhancement at all (CKB, axon, arbor). Nobody else offers both modes in one tool.

*Test: does every core command (`build`, `query`, `fn`, `deps`, `impact`, `diff-impact`, `cycles`, `map`) work with zero API keys? Are LLM features additive, never blocking?*

### 5. Functional CLI, embeddable API

**Codegraph is a CLI tool and MCP server that delivers code intelligence directly.**

The CLI (`src/cli.js`) and MCP server (`src/mcp.js`) are the primary interfaces — the things we ship and the way people use codegraph. Every capability is also available through the programmatic API (`src/index.js`), so codegraph can be imported into VS Code extensions, CI pipelines, other MCP servers, and any JavaScript tooling.

Most competitors are either library-only (requiring integration work) or server-only (requiring infrastructure). Codegraph works out of the box as a CLI, serves AI agents via MCP, and can be embedded when needed.

*Test: does every feature work from the CLI with zero integration effort? Can another npm package also `import { buildGraph, queryFunction } from '@optave/codegraph'` and use the full feature set programmatically?*

### 6. One registry, one schema, no magic

**Adding a language is one data entry, not an architecture change.**

`LANGUAGE_REGISTRY` in `parser.js` is a declarative list mapping each language to `{ id, extensions, grammarFile, extractor, required }`. `EXTENSIONS` in `constants.js` is derived from it. `SYMBOL_KINDS` in `queries.js` is the exhaustive list of node types.

No language gets special-cased. No hidden configuration. No scattered if-else chains. When someone wants to add Kotlin or Swift support, they add one registry entry and one extractor function.

*Test: can a contributor add a new language in under 100 lines of code, touching at most 2 files?*

### 7. Security-conscious defaults

**Multi-repo access is opt-in, never opt-on.**

The MCP server defaults to single-repo mode. Tools have no `repo` property and `list_repos` is not exposed. Only explicit `--multi-repo` or `--repos` flags enable cross-repo access. `allowedRepos` restricts what an MCP client can see.

Credentials are resolved through `apiKeyCommand` (shelling out to external secret managers via `execFileSync` with no shell) — never stored in config files.

This matters because codegraph runs inside AI agents that have broad tool access. Leaking cross-repo data or credentials through an MCP server is a real attack surface.

*Test: does a default `codegraph mcp` invocation expose only the single repo it was pointed at?*

### 8. Honest about what we're not

**We are not an application. We are not a coding tool. We are not an AI agent.**

We are a code intelligence engine — a library that parses, indexes, and queries structural relationships. We don't have a GUI, we don't open in a browser, and we don't present dashboards. Applications are built *on top* of codegraph, not inside it.

We offer semantic search via optional embeddings, but we are not a coding assistant. We don't generate code, suggest fixes, refactor, or translate natural language to code. Tools that do those things can use our graph as their foundation.

We expose tools to AI agents via MCP, but we are not an agent ourselves. We don't make decisions, run multi-step workflows, or modify code. We answer structural questions so that agents can make better decisions.

Staying in our lane means we can be embedded inside IDEs, AI agents, CI pipelines, and developer platforms — without competing with them or duplicating their responsibilities.

---

## What We Build vs. What We Don't

### We will build

- Features that deepen **structural code understanding**: dead code detection, complexity metrics, path finding, community detection — all derivable from our existing graph
- Features that improve **result quality**: fuzzy search, confidence scoring, node classification, compound queries that reduce agent round-trips
- Features that improve **speed**: faster native parsing, smarter incremental builds, lighter-weight search alternatives (FTS5/TF-IDF alongside full embeddings)
- Features that improve **embeddability**: better programmatic API, streaming results, output format options
- **Optional LLM provider integration**: bring-your-own provider (OpenAI, etc.) for richer embeddings, AI-powered search, and enhanced analysis — always as an additive layer that never blocks the core pipeline (Principle 4)

### We will not build

- External database backends (Memgraph, Neo4j, Qdrant, etc.) — violates Principle 1 (speed) and zero-infrastructure goal
- Cloud API calls in the core pipeline — violates Principle 1 (the graph must always rebuild in under a second) and Principle 4 (zero-cost core)
- AI-powered code generation or editing — violates Principle 8
- Multi-agent orchestration — violates Principle 8
- Native desktop GUI — outside our lane; we're a CLI tool and engine, not a desktop app
- Features that require non-npm dependencies — keeps deployment simple

---

## Competitive Position

As of February 2026, codegraph is **#7 out of 22** in the code intelligence tool space (see [COMPETITIVE_ANALYSIS.md](./generated/competitive/COMPETITIVE_ANALYSIS.md)).

Six tools rank above us on feature breadth and community size. But none of them can answer yes to all three questions:

1. **Can you rebuild the graph on every commit in a large codebase?** — Only codegraph has incremental builds. Everyone else re-indexes from scratch.
2. **Does the core pipeline work with zero API keys and zero cost?** — Tools like code-graph-rag and autodev-codebase require cloud APIs for core features. Codegraph's full graph pipeline is local and costless.
3. **Can you optionally enhance with your LLM provider?** — Local-only tools (CKB, axon, arbor) have no AI enhancement path. Cloud-dependent tools force it. Only codegraph makes it optional.

| What competitors force you to choose | What codegraph gives you |
|--------------------------------------|--------------------------|
| Fast local analysis **or** AI-powered features | Both — zero-cost core + optional LLM layer |
| Full re-index on every change **or** stale graph | Always-current graph via incremental builds |
| Code goes to multiple cloud services **or** no AI at all | Code goes only to the one provider you chose |
| Docker + Python + external DB **or** nothing works | `npm install` and done |

Our path to #1 is not feature parity with every competitor. It's being **the only code intelligence tool where the graph is always current, works at zero cost, and optionally gets smarter with the LLM you already use.**

---

## Landscape License Overview

How the competitive field is licensed (relevant for understanding what's available to learn from, fork, or integrate):

| License | Count | Projects |
|---------|-------|----------|
| **MIT** | 10 | [code-graph-rag](https://github.com/vitali87/code-graph-rag), [glimpse](https://github.com/seatedro/glimpse), [arbor](https://github.com/Anandb71/arbor), [codexray](https://github.com/NeuralRays/codexray), [codegraph-cli](https://github.com/al1-nasir/codegraph-cli), [Bikach/codeGraph](https://github.com/Bikach/codeGraph), [repo-graphrag-mcp](https://github.com/yumeiriowl/repo-graphrag-mcp), [code-context-mcp](https://github.com/RaheesAhmed/code-context-mcp), [shantham/codegraph](https://github.com/shantham/codegraph), [khushil/code-graph-rag](https://github.com/khushil/code-graph-rag) |
| **Apache-2.0** | 2 | **[@optave/codegraph](https://github.com/optave/codegraph)** (us), [loregrep](https://github.com/Vasu014/loregrep) |
| **Custom/Other** | 1 | [CodeMCP/CKB](https://github.com/SimplyLiz/CodeMCP) (non-standard license) |
| **No license** | 9 | [axon](https://github.com/harshkedia177/axon), [autodev-codebase](https://github.com/anrgct/autodev-codebase), [Claude-code-memory](https://github.com/Durafen/Claude-code-memory), [claude-context-local](https://github.com/anasdayeh/claude-context-local), [CodeInteliMCP](https://github.com/rahulvgmail/CodeInteliMCP), [MCP_CodeAnalysis](https://github.com/0xjcf/MCP_CodeAnalysis), [0xd219b/codegraph](https://github.com/0xd219b/codegraph), [badger-graph](https://github.com/floydw1234/badger-graph), [CodeRAG](https://github.com/m3et/CodeRAG) |

**Key implications:**
- MIT-licensed projects (10/22) are fully open — their approaches, algorithms, and code can be studied and adapted freely
- 9 projects have **no license at all**, meaning they are proprietary by default under copyright law — their code cannot legally be copied or forked, even though it's publicly visible on GitHub
- CKB (CodeMCP) has a custom license that should be reviewed before any integration or inspiration
- Our Apache-2.0 license provides patent protection to users (stronger than MIT) while remaining fully open source — a deliberate choice for enterprise adoption

---

*This document should be revisited when the competitive landscape shifts meaningfully, or when a proposed feature contradicts one of the core principles above.*
