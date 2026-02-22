# Codegraph Foundation Document

**Project:** `@optave/codegraph`
**License:** Apache-2.0
**Established:** 2026 | Optave AI Solutions Inc.

---

## Why Codegraph Exists

There are 20+ code analysis and code graph tools in the open-source ecosystem. Most require Docker, Python environments, cloud API keys, or external databases. None of them ship as a single npm package with native performance.

Codegraph exists to be **the code intelligence engine for the JavaScript ecosystem** — the one you `npm install` and it just works, on every platform, with nothing else to set up.

---

## Core Principles

These principles define what codegraph is and is not. Every feature decision, PR review, and architectural choice should be measured against them.

### 1. Zero-infrastructure deployment

**Codegraph must never require anything beyond `npm install`.**

No Docker. No external databases. No cloud accounts. No API keys for core functionality. No Python. No Go toolchain. No manual compilation steps.

SQLite is our database because it's embedded. WASM grammars are our fallback because they run everywhere Node.js runs. Optional dependencies (`@huggingface/transformers`, `@modelcontextprotocol/sdk`) are lazy-loaded and degrade gracefully.

This is our single most important differentiator. Every competitor that adds Docker to their install instructions loses users we should capture.

*Test: can a developer on a fresh machine run `npm install @optave/codegraph && codegraph build .` with zero prior setup? If not, we broke this principle.*

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

### 4. Incremental by default

**Never re-parse what hasn't changed.**

File-level MD5 hashing tracks what changed between builds. Only modified files get re-parsed, and their stale nodes/edges are cleaned before re-insertion. This makes watch-mode and AI-agent loops practical — rebuilds drop from seconds to milliseconds.

This is not a feature flag. It's the default behavior. The graph is always fresh with minimum work.

*Test: after changing one file in a 1000-file project, does `codegraph build .` complete in under 500ms?*

### 5. Embeddable first, CLI second

**Codegraph is a library that happens to have a CLI, not the other way around.**

Every capability is available through the programmatic API (`src/index.js`). The CLI (`src/cli.js`) and MCP server (`src/mcp.js`) are thin wrappers. This means codegraph can be imported into VS Code extensions, Electron apps, CI pipelines, other MCP servers, and any JavaScript tooling.

Most competitors are CLI-first or server-first. We are library-first. The API surface is the product; the CLI is a convenience.

*Test: can another npm package `import { buildGraph, queryFunction } from '@optave/codegraph'` and use the full feature set programmatically?*

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

**We are not a graph database. We are not a RAG system. We are not an AI agent.**

We use SQLite, not Neo4j/Memgraph/KuzuDB. Our queries are hand-written SQL, not Cypher. This is intentional — it keeps us at zero infrastructure.

We offer semantic search via optional embeddings, but we are not a RAG pipeline. We don't generate code, answer questions, or translate natural language to queries.

We expose tools to AI agents via MCP, but we are not an agent ourselves. We don't make decisions, run multi-step workflows, or modify code.

Staying in our lane means we can be embedded inside tools that do those things — without competing with them or duplicating their responsibilities.

---

## What We Build vs. What We Don't

### We will build

- Features that deepen **structural code understanding**: dead code detection, complexity metrics, path finding, community detection — all derivable from our existing graph
- Features that improve **result quality**: fuzzy search, confidence scoring, node classification, compound queries that reduce agent round-trips
- Features that improve **speed**: faster native parsing, smarter incremental builds, lighter-weight search alternatives (FTS5/TF-IDF alongside full embeddings)
- Features that improve **embeddability**: better programmatic API, streaming results, output format options

### We will not build

- External database backends (Memgraph, Neo4j, Qdrant, etc.) — violates Principle 1
- Cloud API integrations for core functionality — violates Principle 1
- AI-powered code generation or editing — violates Principle 8
- Multi-agent orchestration — violates Principle 8
- Native desktop GUI — outside our lane; we're a library
- Features that require non-npm dependencies — violates Principle 1

---

## Competitive Position

As of February 2026, codegraph is **#7 out of 22** in the code intelligence tool space (see [COMPETITIVE_ANALYSIS.md](./COMPETITIVE_ANALYSIS.md)).

Six tools rank above us on feature breadth and community size. But none of them occupy our niche: **the npm-native, zero-config, dual-engine code intelligence library.**

| What competitors need | What codegraph needs |
|-----------------------|----------------------|
| Docker (Memgraph, Neo4j, Qdrant, Dgraph) | Nothing |
| Python environment | Nothing |
| Cloud API keys (OpenAI, Gemini, Voyage AI) | Nothing |
| Manual Rust/Go compilation | Nothing |
| External secret management setup | Nothing |
| `npm install @optave/codegraph` | That's it |

Our path to #1 is not feature parity with every competitor. It's making codegraph **the obvious default for any JavaScript developer or tool that needs code intelligence** — because it's the only one that doesn't ask them to leave the npm ecosystem.

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
