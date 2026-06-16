# Competitive Deep-Dive: Codegraph vs cocoindex-code

**Date:** 2026-06-15
**Competitors:** `@optave/codegraph` v3.x (Apache-2.0) vs `cocoindex-io/cocoindex-code` v0.2.35 (Apache-2.0)
**Context:** cocoindex-code does not appear in the current [competitive analysis](./COMPETITIVE_ANALYSIS.md) ranking. The parent library `cocoindex-io/cocoindex` has 10,299 stars; the CLI wrapper `cocoindex-code` itself has 1,880 stars. Both are Apache-2.0. Both expose MCP servers and target AI coding agent workflows. Their overlap is limited but grows as cocoindex-code expands.

---

## Executive Summary

cocoindex-code and codegraph address different stages of the same AI-agent problem — but from opposite ends:

| Dimension | cocoindex-code | Codegraph |
|-----------|----------------|-----------|
| **Core question answered** | "Find me code that does X" | "What breaks if I change function X?" |
| **Analysis model** | Vector similarity over text chunks | Named-symbol dependency graph |
| **AST role** | Chunking boundaries only (where to split) | Full symbol extraction (what symbols exist and what they call) |
| **Graph model** | None | Directed: symbols as nodes, imports/calls/dataflow/CFG as edges |
| **MCP tools** | 1 (`search`) | 32 structured query tools |
| **CLI commands** | 9 | 41 |
| **Language** | Python app, Rust core (PyO3/CocoIndex) | TypeScript app, Rust core (napi-rs) |
| **Installation** | `pipx install cocoindex-code` (Python ≥ 3.11) | `npm install -g @optave/codegraph` (Node.js ≥ 22.6) |
| **Embeddings** | Core feature (required for any query) | Optional layer (`codegraph embed`) |
| **Structural analysis** | None | Cycles, blast radius, call graphs, complexity, dead code, CFG, dataflow |
| **Incremental rebuild** | Hash-based, file-level | Hash-based, 3-tier change detection, <500ms |

**Bottom line:** cocoindex-code is a semantic *retrieval* engine — it finds code by meaning. Codegraph is a structural *intelligence* engine — it maps what code depends on what and why. A user wanting to point an AI agent at a codebase and have it find relevant sections by description would choose cocoindex-code. A user wanting function-level call graphs, cycle detection, impact analysis, and an always-current dependency graph would use codegraph. Their overlap is the optional semantic search layer (`codegraph search` vs. cocoindex-code's entire purpose).

---

## Problem Alignment with FOUNDATION.md

Codegraph's foundation document defines the problem as: *"Fast local analysis with no AI, or powerful AI features that require full re-indexing through cloud APIs on every change. None of them give you an always-current graph."*

### Principle-by-principle evaluation

| # | Principle | Codegraph | cocoindex-code | Verdict |
|---|-----------|-----------|----------------|---------|
| 1 | **The graph is always current** — rebuild on every commit/save/agent loop | 3-tier change detection (journal → mtime+size → hash). Change 1 file in 3,000 → <500ms rebuild. Watch mode, commit hooks, agent loops all practical | Hash-based incremental reindex at file granularity. No sub-second claim published; known scalability failure at ~55k files (LMDB `MDB_MAP_FULL`, issue #185). No watch mode. | **Codegraph wins.** cocoindex-code is incremental but lacks watch mode, has no <500ms guarantee, and has a known ceiling on large repos |
| 2 | **Native speed, universal reach** — dual engine (Rust + WASM) | Native napi-rs with rayon parallelism + automatic WASM fallback. `npm install` on any platform | Single engine: Python application with Rust core via PyO3. `pipx install`. Slim Docker ~450 MB; full Docker ~5 GB (torch + transformers) | **Codegraph wins.** Single-engine Python with optional 5 GB model bundle vs. dual-engine automatic platform selection at ~50 MB |
| 3 | **Confidence over noise** — scored results | 6-level import resolution with 0.0–1.0 confidence on every edge. False-positive filtering. Graph quality score | Similarity scores (0–1) on search results — cosine distance, not confidence in structural correctness. No call/import edge model | **Tie with different axes.** Both score results, but the scoring domains are unrelated: structural confidence vs. vector similarity |
| 4 | **Zero-cost core, LLM-enhanced when you choose** | Full pipeline local, zero API keys. Optional embeddings with user's LLM provider | Embeddings are mandatory — the tool cannot function without them. Local models available (`[full]` install adds torch/transformers). Cloud models (OpenAI, Gemini, etc.) via LiteLLM | **Codegraph wins.** Structural graph is always available without any LLM. cocoindex-code is embeddings-dependent by design |
| 5 | **Functional CLI, embeddable API** | 41 CLI commands + 32-tool MCP server + full programmatic JS API | 9 CLI commands + 1-tool MCP server (`search` only). No programmatic API (CLI-only). Daemon architecture for persistent model | **Codegraph wins.** 32 MCP tools vs. 1, 41 CLI commands vs. 9, full JS API vs. none |
| 6 | **One registry, one schema, no magic** | `LANGUAGE_REGISTRY` — add a language in <100 lines, 2 files | 31 languages in README table; parent engine recognizes 100+. Language selection via `settings.yaml` include/exclude patterns. No public registry API | **Codegraph wins.** Explicit, documented language registry with uniform tree-sitter extraction vs. YAML pattern matching against a parent-library registry |
| 7 | **Security-conscious defaults** — multi-repo opt-in | Single-repo MCP default. `apiKeyCommand` for secrets. `--multi-repo` opt-in | Anonymous usage telemetry collected by default (opt-out via env var). No mention of MCP isolation or multi-repo sandboxing. Enterprise feature: "share indexes with teammates" on shared repos | **Codegraph wins.** Security-by-default (no telemetry, single-repo MCP) vs. telemetry-on-default with no described isolation model |
| 8 | **Honest about what we're not** | Code intelligence engine. Not an app, not a coding tool, not an agent | "AST-based semantic code search that just works." Claims "Instant token saving by 70%" in README headline. The 70% claim is marketing copy with no published benchmark | **Tie with a caveat.** Codegraph is honest about its scope. cocoindex-code's "70% token saving" claim lacks benchmarks |

**Score: Codegraph 5, cocoindex-code 0, Tie 3** — against codegraph's own principles. The tie in P3 reflects genuinely different but valid scoring models; P8 is a soft tie. The clearest losses for cocoindex-code are P4 (embeddings-mandatory), P5 (1 MCP tool vs. 32), and P1 (scalability ceiling on large repos).

---

## Feature-by-Feature Comparison

### A. Parsing & Language Support

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Parser technology** | tree-sitter (WASM + native Rust), symbol-level extraction | tree-sitter via CocoIndex parent (chunk boundaries only); falls back to regex for languages without grammars | **Codegraph** — tree-sitter for structured symbol extraction; cocoindex-code uses it only for split-point heuristics |
| **JavaScript** | tree-sitter (native + WASM), full symbol/call extraction | Recognized; chunked at JS syntax boundaries | **Codegraph** — symbol model vs. text chunks |
| **TypeScript** | tree-sitter, first-class TS + TSX | Recognized; TSX included in patterns | **Codegraph** — qualified names, call resolution, type maps |
| **Python** | tree-sitter | tree-sitter via parent engine | **Tie** for parsing; **Codegraph** for analysis depth |
| **Go / Rust / Java** | tree-sitter | tree-sitter via parent engine | **Codegraph** — structural extraction; **Tie** for chunking |
| **CSS / HTML / JSON / YAML** | Not supported for symbol extraction | Recognized and indexed as text | **cocoindex-code** — broader "index anything" coverage |
| **Markdown / plain text** | Not applicable | Indexed; useful for README/doc search | **cocoindex-code** |
| **Kotlin / Swift** | Not supported | Recognized via parent engine | **Tie** — neither extracts call graphs for Kotlin/Swift |
| **Binary analysis** | Not supported | Not supported | **Tie** |
| **Language count (symbol extraction)** | 34 languages, full symbol model | 31 languages in README table; 100+ patterns in parent engine (but chunking only, no symbol model) | **Codegraph** for analysis depth; **cocoindex-code** for pure retrieval breadth |
| **Adding a language** | 1 registry entry + 1 extractor (<100 lines, 2 files) | Add file extension patterns to `settings.yaml` (no code required — but also no structural extraction) | **Depends on goal.** cocoindex-code is trivially extensible for retrieval; codegraph requires extractor code for structural analysis |
| **Incomplete/non-compilable code** | Requires syntactically valid input (tree-sitter); error nodes produce partial extraction | Chunks whatever is present — broken code still returns search results | **cocoindex-code** for resilience; structural extraction degrades gracefully in codegraph via tree-sitter error recovery |
| **Large repo scalability** | 34 languages; native Rust parallelism (rayon) | Known LMDB map-size failure at ~55k files (issue #185); mitigation via env var `COCOINDEX_LMDB_MAP_SIZE` | **Codegraph** — SQLite has no map-size limit |

---

### B. Analysis Model

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Analysis unit** | Named symbol (function, class, method, type, struct, enum, trait, record, module) | Text chunk (~1,000 chars / ~300 tokens) | **Different paradigms** — not directly comparable |
| **Graph model** | Directed: symbols → nodes, imports/calls/dataflow/CFG as edges | None | **Codegraph** |
| **Call graphs** | Multi-phase CHA + type maps + receiver dispatch + super dispatch | Not available | **Codegraph** |
| **Import/dependency edges** | 6-level priority resolution with confidence scores | Not available | **Codegraph** |
| **Cycle detection** | Tarjan SCC, `cycles` command | Not available | **Codegraph** |
| **Control Flow Graph** | Intraprocedural CFG for all 34 languages; basic blocks + branches | Not available | **Codegraph** |
| **Dataflow analysis** | `flows_to` / `returns` / `mutates` edges (intraprocedural), all 34 languages | Not available | **Codegraph** |
| **Complexity metrics** | Cognitive, cyclomatic, Halstead, MI per function | Not available | **Codegraph** |
| **Dead code detection** | `roles --role dead` — unreferenced non-exported symbols | Not available | **Codegraph** |
| **Impact / blast radius** | `fn-impact`, `diff-impact --staged`, `diff-impact main` | Not available | **Codegraph** |
| **Node role classification** | Auto-tags every symbol: `entry`/`core`/`utility`/`adapter`/`dead`/`leaf` | Not available | **Codegraph** |
| **Community detection** | Louvain algorithm with drift analysis | Not available | **Codegraph** |
| **Architecture boundaries** | `boundaries` command with onion architecture preset | Not available | **Codegraph** |
| **Stored AST** | `ast_nodes` table; `ast` CLI/MCP command for calls, new, string, regex, throw, await | Not available | **Codegraph** |
| **Semantic search** | Optional (`codegraph embed` + `codegraph search`) | Core feature — entire tool is semantic search | **cocoindex-code** for semantic search quality and model variety |
| **Vector similarity search** | Local embeddings (optional), keyword fallback | Local + 14 LiteLLM-compatible cloud providers; `[full]` bundle includes Nomic-embed | **cocoindex-code** for embedding breadth; **Codegraph** for zero-dependency baseline |
| **Result ranking** | Structural graph traversal (BFS/Tarjan) + optional semantic similarity | Cosine similarity over chunk vectors | **Different paradigms** |

---

### C. Query Interface

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Query types** | 41 structural commands: callers, callees, paths, cycles, impact, complexity, context, etc. | 1 query type: semantic similarity search | **Codegraph** for structural queries; **cocoindex-code** for meaning-based lookup |
| **Natural language queries** | Requires `codegraph embed` (optional) | Core interface — all queries are natural language or code snippets | **cocoindex-code** for NL out of the box |
| **Exact symbol lookup** | `codegraph where <name>`, `codegraph context <name>` — instant, no embeddings | Not available (no symbol model) | **Codegraph** |
| **Call chain tracing** | `codegraph query <name>` — callers + callees | Not available | **Codegraph** |
| **Path finding** | `codegraph path <from> <to>` | Not available | **Codegraph** |
| **File inventory** | `codegraph where --file <path>` | `ccc search` with `--path` filter | **Codegraph** for structural inventory |
| **Filter by language** | `--kind`, `--file`, per-command | `ccc search --lang python` | **Tie** — both support language filtering |
| **Filter by path** | `--file <path>` scope | `ccc search --path src/` | **Tie** |
| **JSON output** | `--json` on every command | JSON lines in daemon protocol; `--json` not documented in README | **Codegraph** — consistent flag across all commands |
| **AI agent interface** | 32-tool MCP server; `context`/`explain`/`audit` compound commands minimize round-trips | 1-tool MCP server; `ccc mcp` runs stdio MCP server | **Codegraph** — 32 tools vs. 1 |
| **Compound queries** | `context` (source + deps + callers + tests in 1 call), `audit` (explain + impact + health in one call) | Not applicable (single search operation) | **Codegraph** for token-efficient agent workflows |
| **Pagination** | Built-in pagination helpers with configurable limits | `--offset` + `--limit` on search | **Tie** |
| **Visualization** | DOT, Mermaid, JSON, GraphML, GraphSON, Neo4j CSV, interactive HTML viewer | None | **Codegraph** |
| **Sequence diagrams** | `codegraph sequence <name>` — Mermaid from call graph | Not available | **Codegraph** |

---

### D. Performance & Resource Usage

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Cold build (small project, ~100 files)** | <2 seconds | Not benchmarked (model load time excluded; embedding generation dominates) | **Likely comparable or Codegraph** — embedding generation is inherently slower than graph extraction |
| **Incremental rebuild (1 file changed)** | <500ms (3-tier change detection) | File-hash based; no published latency | **Codegraph** — explicit <500ms SLA; no such claim from cocoindex-code |
| **Large repo (55k+ files)** | Supported; rayon parallel parsing | Known failure: LMDB map-size exceeded (issue #185) | **Codegraph** |
| **Memory usage (idle)** | <100 MB typical | Daemon keeps embedding model in memory: ~200 MB (Nomic-embed quantized) to >1 GB (full torch models) | **Codegraph** — structural graph has no model to keep warm |
| **Startup latency** | <100ms (Node.js) | Daemon model-load on first query: 1–10 seconds depending on model size | **Codegraph** — no model warm-up |
| **Storage format** | SQLite (~<10 MB for medium projects) | Two SQLite DBs (state + `sqlite-vec` vector table). Full index grows with embedding dimensions × chunk count | **Comparable** — both SQLite; vector storage grows faster than graph storage |
| **No-model baseline** | Full structural graph, all 41 commands, no model | Not functional — embeddings are mandatory | **Codegraph** — zero-dependency baseline |
| **Watch mode** | Built-in (`codegraph watch`) | Not available | **Codegraph** |
| **Commit hook viability** | Yes — <500ms rebuilds | Not designed for commit hooks | **Codegraph** |
| **CI pipeline viability** | Yes — `check --staged` returns exit 0/1 in seconds | Not designed for CI | **Codegraph** |
| **Parallel parsing** | Native Rust with rayon (native engine) | CocoIndex parent handles parallelism internally (Rust tokio) | **Tie** — both use Rust async/parallel internally |

---

### E. Installation & Deployment

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Install method** | `npm install -g @optave/codegraph` | `pipx install 'cocoindex-code[full]'` or slim | **Tie** — both are single-command installs in their respective ecosystems |
| **Runtime dependency** | Node.js ≥ 22.6 | Python ≥ 3.11 | **Depends on user's stack.** Python is more common in data/ML teams; Node.js in frontend/fullstack |
| **Local embedding model** | Optional; requires separate `codegraph embed` setup | `[full]` install bundles torch + transformers; slim installs use cloud | **cocoindex-code** for batteries-included local embeddings; **Codegraph** for no-model baseline |
| **Disk footprint (tool)** | ~50 MB (WASM grammars bundled) | Slim: ~450 MB Docker; Full: ~5 GB Docker (torch included) | **Codegraph** — 10–100x smaller |
| **Offline capability** | Full functionality offline; embeddings optional | Local model required for offline; slim install needs cloud API key | **Codegraph** for offline structural analysis; **Tie** for offline embeddings (if full install) |
| **Docker support** | No official Docker image | Official Docker images (slim + full); Docker Compose example | **cocoindex-code** |
| **Daemon model** | No daemon (stateless CLI + native binary) | Background daemon keeps model warm; CLI/MCP talk to daemon via Unix socket | **Codegraph** for simplicity; **cocoindex-code** for warm model across sessions |
| **Configuration** | `.codegraphrc.json` + env vars + `apiKeyCommand` | `settings.yaml` per project + env vars | **Tie** — both use project-scoped config |
| **Telemetry** | None | Opt-out (`COCOINDEX_DISABLE_USAGE_TRACKING=1`) | **Codegraph** — no telemetry at all |

---

### F. AI Agent & MCP Integration

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **MCP server** | First-party, 32 tools, single-repo default, `--multi-repo` opt-in | First-party, 1 tool (`search`), `ccc mcp` | **Codegraph** — 32 tools covering call graph, impact, cycles, context, audit, dataflow, CFG, AST, exports, complexity, boundaries |
| **MCP tool count** | 32 | 1 | **Codegraph** |
| **Semantic search via MCP** | Yes (`search_code` MCP tool, requires `codegraph embed`) | Yes (`search` — the only tool) | **cocoindex-code** for semantic-only use cases |
| **Structural queries via MCP** | Yes — callers, callees, path, cycles, impact, context, audit, ast, cfg, dataflow, etc. | No | **Codegraph** |
| **Token efficiency** | `context`/`explain`/`audit` compound commands reduce agent round-trips 50–80% | Single search call returns ranked chunks; agent must synthesize structure from text | **Codegraph** for structural synthesis; **cocoindex-code** for retrieval |
| **Claude Code skill** | Used internally for `enrich-context.sh` hooks | Ships a Claude Code skill via `npx skills add cocoindex-io/cocoindex-code` | **cocoindex-code** for agent-installable skill; **Codegraph** for depth |
| **Supported AI editors** | Claude Code, Cursor (via MCP) | Claude Code, Codex, Cursor, OpenCode | **cocoindex-code** for broader editor claim; **Codegraph** for MCP depth |
| **Multi-repo support** | Registry-based, `--multi-repo` opt-in | Not documented | **Codegraph** |
| **Programmatic API** | Full JS API: `import { buildGraph, queryNameData } from '@optave/codegraph'` | None (CLI-only) | **Codegraph** |

---

### G. Developer Productivity Features

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **Impact analysis (function-level)** | `fn-impact <name>` — transitive callers + downstream impact | Not available | **Codegraph** |
| **Impact analysis (git-aware)** | `diff-impact --staged`, `diff-impact main` | Not available | **Codegraph** |
| **CI gate** | `check --staged` — exit code 0/1, checks cycles/complexity/blast radius/boundaries | Not applicable | **Codegraph** |
| **Complexity metrics** | `complexity` — cognitive, cyclomatic, Halstead, MI per function | Not available | **Codegraph** |
| **Code health manifesto** | `manifesto` — configurable rule engine with warn/fail thresholds | Not available | **Codegraph** |
| **Cycle detection** | `cycles` command | Not available | **Codegraph** |
| **Structure analysis** | `structure` — directory hierarchy with cohesion scores | Not available | **Codegraph** |
| **Hotspot detection** | `hotspots` — files with extreme fan-in/fan-out | Not available | **Codegraph** |
| **Co-change analysis** | `co-change` — git history for files that change together | Not available | **Codegraph** |
| **Branch comparison** | `branch-compare` — structural diff between refs | Not available | **Codegraph** |
| **Triage / risk ranking** | `triage` — ranked audit queue by composite risk score | Not available | **Codegraph** |
| **CODEOWNERS integration** | `owners` — maps functions to code owners | Not available | **Codegraph** |
| **Dead export detection** | `exports --unused` | Not available | **Codegraph** |
| **Semantic search** | Optional (`codegraph embed` + `codegraph search`) | Core feature; all queries are semantic | **cocoindex-code** for semantic search quality and embedding variety |
| **Index status** | `codegraph stats` — graph health + quality score | `ccc status` — chunk count, file count, language breakdown | **Tie** |
| **Diagnostics** | `codegraph stats`, build logs | `ccc doctor` — settings, daemon, model, file matching, index health | **cocoindex-code** for user-facing diagnostics; **Codegraph** for structural health |

---

### H. Ecosystem & Community

| Feature | Codegraph | cocoindex-code | Best Approach |
|---------|-----------|----------------|---------------|
| **GitHub stars** | N/A (private/commercial) | 1,880 (this repo) + 10,299 (parent `cocoindex`) | **cocoindex-code** — significant community |
| **Contributors** | Small team | 14 (cocoindex-code), 75+ (parent engine) | **cocoindex-code** |
| **Release cadence** | Regular, PR-driven | ~10 releases/month (30 in 3 months, v0.1.11→v0.2.35) | **cocoindex-code** — very active early-stage development |
| **Project age** | Established | First release: 2026-03-10 (~3 months old) | **Codegraph** for maturity |
| **License** | Apache-2.0 | Apache-2.0 | **Tie** |
| **Documentation** | CLAUDE.md, CLI `--help`, programmatic API docs | README (~820 lines), EMBEDDINGS.md (100+ lines), translated to 9 languages, cocoindex.io/docs | **cocoindex-code** for user-facing docs quantity; **Codegraph** for technical depth |
| **Commercial backing** | Optave AI Solutions Inc. | CocoIndex (cocoindex.io); enterprise offering mentioned | **Tie** — both commercially backed small teams |
| **Telemetry** | None | Opt-out | **Codegraph** |
| **Programmatic library** | Full JS/TS API (`@optave/codegraph`) | None; Python parent library not scoped to code search | **Codegraph** |

---

## Where Each Tool is the Better Choice

### Choose Codegraph when:

1. **You need structural code intelligence** — call graphs, dependency graphs, cycle detection, blast radius analysis. None of this is available in cocoindex-code.
2. **You're building AI-agent-driven structural workflows** — 32 MCP tools covering every graph query vs. 1 search tool. Agents can ask "what calls this function?" via MCP; cocoindex-code cannot answer.
3. **You want the graph without any LLM** — codegraph's full 41-command suite works offline with no embedding model. cocoindex-code cannot index or query without embeddings.
4. **You need CI gate or commit hook integration** — `check --staged` in <500ms. cocoindex-code is not designed for this use case.
5. **You're working in a Node.js / TypeScript ecosystem** — codegraph is `npm install`, embeds in Node.js projects, and exports a full programmatic API.
6. **You have a large repo (55k+ files)** — cocoindex-code has a known LMDB ceiling; codegraph uses SQLite with no map-size limit.
7. **You need impact analysis or code quality metrics** — complexity, roles, triage, co-change, structure, manifesto. cocoindex-code has none of these.
8. **You need watch mode or live incremental updates** — codegraph has built-in `watch`; cocoindex-code requires manual `ccc index` re-runs.

### Choose cocoindex-code when:

1. **Your primary need is semantic code retrieval** — "find code that does X" in natural language. This is cocoindex-code's core value and where its embedding models shine. Codegraph's semantic search is optional and secondary.
2. **You want multi-provider embedding flexibility** — 14 LiteLLM-compatible providers (OpenAI, Gemini, Ollama, etc.) with documented model benchmarks. Codegraph's embedding setup is less documented.
3. **You're in a Python ecosystem** — `pipx install` vs. `npm install`. Python data/ML teams will find cocoindex-code more natural.
4. **You want to index non-code files** — Markdown, JSON, YAML, HTML, plain text. Codegraph is code-only.
5. **You need a batteries-included local embedding setup** — `[full]` install bundles torch + transformers + Nomic-embed. No separate embedding config needed.
6. **You prefer Docker-based deployment** — official Docker images (slim + full) with Docker Compose examples. Codegraph has no official Docker image.
7. **You use Codex or OpenCode** — cocoindex-code documents setup for more AI editors. Codegraph currently documents Claude Code and Cursor.

### Use both together when:

- **Agent retrieval + structural navigation:** cocoindex-code finds which files are relevant to a query; codegraph analyzes those files structurally (call chains, blast radius, cycles). Complementary workflow.
- **Discovery then impact:** cocoindex-code `search` points the agent to the right function; codegraph `fn-impact` tells the agent what changing that function would break.
- **Documentation search + code graph:** cocoindex-code indexes Markdown/README for doc search; codegraph covers the structural code graph. MCP config includes both servers.

---

## Gap Analysis: What Codegraph Could Learn from cocoindex-code

### Worth adopting (adapted to codegraph's model)

| cocoindex-code Feature | Adaptation for Codegraph | Effort | Priority |
|------------------------|--------------------------|--------|----------|
| **Multi-provider embedding config** | Improve `codegraph embed` setup to document LiteLLM-compatible providers with YAML examples similar to EMBEDDINGS.md. Currently codegraph's embedding docs are thin | Low | Medium — improves adoption for teams using cloud LLMs |
| **`doctor` diagnostics command** | Add `codegraph doctor` that checks: Node.js version, native binary availability + codesign, SQLite integrity, WASM grammar presence, DB schema version, `.codegraphrc.json` validity. cocoindex-code's `ccc doctor` is well-designed | Low | Medium — reduces "why isn't this working?" support burden |
| **Docker image** | Publish an official slim Docker image (`FROM node:22-alpine`, install codegraph, expose as CLI). cocoindex-code has official slim + full images with Compose examples | Medium | Low — most codegraph users install via npm, but Docker aids CI pipelines |
| **Claude Code skill distribution** | cocoindex-code ships an installable Claude Code skill (`npx skills add cocoindex-io/cocoindex-code`). Codegraph could ship a skill that teaches agents the `context`/`audit`/`fn-impact` workflow | Low | Medium — lowers the bar for AI agent onboarding |
| **Status breakdown by language** | `ccc status` shows chunk count and language breakdown. `codegraph stats` could add a per-language symbol count table to surface coverage gaps | Low | Low |

### Not worth adopting (violates FOUNDATION.md)

| cocoindex-code Feature | Why Not |
|------------------------|---------|
| **Embeddings-as-core** | Codegraph's P4 principle is "zero-cost core, LLM-enhanced when you choose." Making embeddings mandatory would break every offline use case and all CI pipelines. The optional semantic search layer is the correct architecture |
| **Daemon architecture** | A persistent background process adds installation complexity and a new failure mode (daemon crashes, stale sockets). Codegraph's stateless CLI + native binary is simpler and more robust for the CI/commit-hook use cases it targets |
| **Chunk-based analysis** | cocoindex-code's text-chunk model is the right model for semantic search. But it cannot answer structural questions. Adopting it would replace codegraph's symbol model rather than complement it — wrong tradeoff |
| **Telemetry on by default** | Violates P7 (security-conscious defaults). Codegraph ships no telemetry and should keep it that way |
| **14-provider LiteLLM embedding support** | The optional `codegraph embed` feature already supports the most critical path (local + OpenAI). Pulling in LiteLLM as a runtime dependency inflates the install footprint for most users who don't use embeddings at all |

---

## Competitive Positioning Statement

> **cocoindex-code is purpose-built for one thing: finding code by meaning.** Its vector similarity engine, multi-provider embedding support, and daemon-backed fast consecutive queries make it the best available tool for "show me code that does X." The backing parent library (10,299 stars, Rust core) gives it a credible infrastructure story for long-term development.
>
> **Codegraph occupies a different problem space entirely:** it maps *what code depends on what* — call graphs, import chains, blast radius, cycles, complexity. The 32-tool MCP server gives AI agents structural answers that no semantic search engine can provide, because vector similarity does not know what function calls what.
>
> The practical competitive concern is the **MCP server positioning.** Both tools are pitched as "add to your AI agent's MCP config." A user choosing a single MCP server gets 1 search tool from cocoindex-code or 32 structural tools from codegraph. The compelling answer is that these tools are complementary, not alternatives — but if forced to choose, codegraph's 32 tools address more of the AI-agent's actual code understanding workflow.

---

## Key Metrics Summary

| Metric | Codegraph | cocoindex-code | Winner |
|--------|-----------|----------------|--------|
| Structural analysis (call graphs, cycles, impact) | Full suite | None | Codegraph |
| Semantic search | Optional | Core feature | cocoindex-code |
| MCP tools | 32 | 1 | Codegraph |
| CLI commands | 41 | 9 | Codegraph |
| Embedding providers | Limited | 14 (LiteLLM) | cocoindex-code |
| Requires embeddings to function | No (optional) | Yes (mandatory) | Codegraph |
| Install footprint | ~50 MB | ~450 MB slim / ~5 GB full | Codegraph |
| Docker support | None | Official images | cocoindex-code |
| Watch mode | Yes | No | Codegraph |
| Large repo (55k+ files) | Supported | Known failure (LMDB) | Codegraph |
| Incremental rebuild SLA | <500ms | Not published | Codegraph |
| Non-code file indexing | No | Yes (MD, JSON, YAML) | cocoindex-code |
| Programmatic API | Full JS/TS API | None | Codegraph |
| CI/CD gate | Yes (`check --staged`) | No | Codegraph |
| Telemetry | None | Opt-out | Codegraph |
| GitHub stars | N/A | 1,880 (+10,299 parent) | cocoindex-code |
| Release cadence | Regular | ~10/month (very active) | cocoindex-code |
| License | Apache-2.0 | Apache-2.0 | Tie |

**Final score against FOUNDATION.md principles: Codegraph 5, cocoindex-code 0, Tie 3.**
cocoindex-code doesn't compete on codegraph's structural analysis principles — it competes on semantic retrieval, which is a complementary capability rather than a substitute.

---

## cocoindex-code-Inspired Feature Candidates

Features from sections **E. Installation & Deployment**, **F. AI Agent & MCP Integration**, and **G. Developer Productivity Features** above, assessed using the [BACKLOG.md](../../docs/roadmap/BACKLOG.md) tier and grading system.

### Tier 1 — Zero-dep + Foundation-aligned

| ID | Title | Description | Category | Benefit | Zero-dep | Foundation-aligned | Problem-fit (1-5) | Breaking |
|----|-------|-------------|----------|---------|----------|-------------------|-------------------|----------|
| CC1 | `codegraph doctor` diagnostics command | New command that verifies the codegraph installation is healthy: checks Node.js version ≥ 22.6, native binary presence + codesign status, WASM grammar availability, SQLite DB integrity, `.codegraphrc.json` schema validity, and graph build recency. Returns a structured pass/fail report with fix suggestions. Inspired by `ccc doctor` | Navigation | Reduces "why isn't codegraph working?" friction for new users and agent setups — currently diagnosing a broken install requires manual debugging | ✓ | ✓ | 3 | No |
| CC2 | Installable Claude Code skill | Publish a Claude Code skill (via `npx skills add` or MCP install convention) that teaches agents the `context` → `fn-impact` → `audit` workflow: when to call each command, how to interpret results, and how to chain structural queries. Inspired by `npx skills add cocoindex-io/cocoindex-code` | Agent integration | Agents onboard to codegraph's 32-tool MCP with zero manual documentation reading — the skill embeds usage patterns directly into the agent context | ✓ | ✓ | 4 | No |
| CC3 | Per-language symbol count in `stats` | Extend `codegraph stats` output to include a per-language breakdown: symbol count, edge count, coverage quality per language. Inspired by `ccc status` which shows language distribution of indexed chunks | Analysis | Surfaces coverage gaps immediately — if Go has 3 symbols but TypeScript has 3,000, the agent (and user) understands why Go impact results are incomplete | ✓ | ✓ | 3 | No |
| CC4 | Embedding provider documentation | Write `docs/embeddings.md` documenting how to configure `codegraph embed` with all supported providers: local (default), OpenAI, Ollama, and LiteLLM-compatible endpoints. Include YAML config examples and quality-vs-speed guidance for each. Inspired by cocoindex-code's `EMBEDDINGS.md` | Documentation | Teams using cloud LLMs currently have no clear guide for wiring them into `codegraph embed` — this is a configuration barrier, not a code gap | ✓ | ✓ | 2 | No |

### Not adopted (violates FOUNDATION.md)

| cocoindex-code Feature | Section | Why Not |
|------------------------|---------|---------|
| **Embeddings-mandatory architecture** | B | Violates P4 — zero-cost core is a defining principle. Requiring an embedding model would break CI pipelines, offline use, and all 41 structural commands that currently need no LLM |
| **Daemon process** | E | Adds a stateful background process with new failure modes (socket, crash, stale PID). Codegraph's stateless CLI is more robust for CI and commit hooks. The warm-model benefit is only relevant for embedding queries, which are already optional |
| **LiteLLM as runtime dependency** | E | Pulls in a large Python-ecosystem dependency tree for a feature most users don't enable. The optional `codegraph embed` design is the correct isolation boundary |
| **Text-chunk analysis model** | B | Replacing or parallel-tracking the symbol model with text chunks would dilute the structural graph. The correct design (already in place) is: symbol extraction first, optional embeddings on top |
| **Telemetry** | H | Violates P7. Codegraph ships no telemetry and should not add opt-out telemetry — the correct default is no collection |
