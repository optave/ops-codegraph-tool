# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Hooks enforce code quality.** This project uses Claude Code hooks (`.claude/hooks/`) to automatically inject file-level dependency context on reads, rebuild the graph after edits, block commits with cycles or dead exports, run lint on staged files, and show diff-impact before commits. If codegraph reports an error or produces wrong results when analyzing itself, **fix the bug in the codebase**.

## Codegraph Workflow

Hooks handle: file-level deps on reads, graph rebuild after edits, commit-time checks (cycles, dead exports, diff-impact, lint). **You must actively run these for function-level understanding:**

### Before modifying code:
1. `codegraph where <name>` — find where the symbol lives
2. `codegraph audit --quick <target>` — understand the structure
3. `codegraph context <name> -T` — get full context (source, deps, callers)
4. `codegraph fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `codegraph diff-impact --staged -T` — verify impact before committing

### Navigation
- `codegraph where --file <path>` — file inventory (symbols, imports, exports)
- `codegraph query <name> -T` — function call chain (callers + callees)
- `codegraph path <from> <to> -T` — shortest call path between two symbols
- `codegraph exports <file> -T` — per-symbol export consumers
- `codegraph children <name> -T` — sub-declarations (parameters, properties, constants)
- `codegraph search "<query>"` — semantic search (requires `codegraph embed`)
- `codegraph ast --kind call <name> -T` — find all call sites of a function

### Impact & analysis
- `codegraph diff-impact main -T` — impact of branch vs main
- `codegraph audit <target> -T` — structural summary + impact + health in one report
- `codegraph triage -T` — ranked audit priority queue
- `codegraph complexity -T` — per-function complexity metrics
- `codegraph batch t1 t2 t3 -T --json` — batch query multiple targets

### Overview & health
- `codegraph map` — module overview (most-connected files)
- `codegraph stats` — graph health and quality score
- `codegraph structure --depth 2` — directory tree with cohesion scores
- `codegraph roles --role dead -T` — find dead code (unreferenced symbols)
- `codegraph roles --role core -T` — find core symbols (high fan-in)
- `codegraph branch-compare main HEAD -T` — structural diff between refs

### Flags
- `-T` — exclude test files (use by default) · `-j` — JSON output
- `-f, --file <path>` — scope to file · `-k, --kind <kind>` — filter kind

## Project Overview

Codegraph (`@optave/codegraph`) is a local code dependency graph CLI. It parses codebases with tree-sitter (WASM), builds function-level dependency graphs stored in SQLite, and supports semantic search with local embeddings. No cloud services required.

**Languages supported:** JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C#, PHP, Ruby, Terraform/HCL

## Commands

```bash
npm install                      # Install dependencies
npm test                         # Run all tests (vitest)
npm run test:watch               # Watch mode
npm run test:coverage            # Coverage report
npx vitest run tests/parsers/javascript.test.ts   # Single test file
npx vitest run -t "finds cycles"                  # Single test by name
npm run build:wasm               # Rebuild WASM grammars from devDeps (built automatically on npm install)
```

**Linter/Formatter:** [Biome](https://biomejs.dev/) — config in `biome.json`, scoped to `src/` and `tests/`.

```bash
npm run lint                     # Check for lint + format issues
npm run lint:fix                 # Auto-fix lint + format issues
npm run format                   # Auto-format only
npm run release                  # Bump version, update CHANGELOG, create tag (auto-detects semver from commits)
npm run release:dry-run          # Preview what release would do without writing anything
```

## Architecture

**Pipeline:** Source files → tree-sitter parse → extract symbols → resolve imports → SQLite DB → query/search

Source is TypeScript in `src/`, compiled via `tsup`. The Rust native engine lives in `crates/codegraph-core/`.

| Path | Role |
|------|------|
| `cli.ts` | Commander CLI entry point (`bin.codegraph`) |
| `index.ts` | Programmatic API exports |
| **`shared/`** | **Cross-cutting constants and utilities** |
| `shared/constants.ts` | `EXTENSIONS` (derived from parser registry) and `IGNORE_DIRS` constants |
| `shared/errors.ts` | Domain error hierarchy (`CodegraphError`, `ConfigError`, `ParseError`, etc.) |
| `shared/kinds.ts` | Symbol and edge kind constants (`CORE_SYMBOL_KINDS`, `EVERY_SYMBOL_KIND`, `VALID_ROLES`) |
| `shared/paginate.ts` | Pagination helpers for bounded query results |
| **`infrastructure/`** | **Platform and I/O plumbing** |
| `infrastructure/config.ts` | `.codegraphrc.json` loading, env overrides, `apiKeyCommand` secret resolution |
| `infrastructure/logger.ts` | Structured logging (`warn`, `debug`, `info`, `error`) |
| `infrastructure/native.ts` | Native napi-rs addon loader with WASM fallback |
| `infrastructure/registry.ts` | Global repo registry (`~/.codegraph/registry.json`) for multi-repo MCP |
| `infrastructure/update-check.ts` | npm update availability check |
| **`db/`** | **Database layer** |
| `db/index.ts` | SQLite schema and operations (`better-sqlite3`) |
| **`domain/`** | **Core domain logic** |
| `domain/parser.ts` | tree-sitter WASM wrapper; `LANGUAGE_REGISTRY` + per-language extractors for functions, classes, methods, imports, exports, call sites |
| `domain/queries.ts` | Query functions: symbol search, file deps, impact analysis, diff-impact |
| `domain/graph/builder.ts` | Graph building: file collection, parsing, import resolution, incremental hashing |
| `domain/graph/cycles.ts` | Circular dependency detection (delegates to `graph/` subsystem) |
| `domain/graph/resolve.ts` | Import resolution (supports native batch mode) |
| `domain/graph/watcher.ts` | Watch mode for incremental rebuilds |
| `domain/graph/journal.ts` | Change journal for incremental builds |
| `domain/graph/change-journal.ts` | Change event tracking (NDJSON) |
| `domain/analysis/` | Query-layer analysis: context, dependencies, exports, impact, module-map, roles, symbol-lookup |
| `domain/search/` | Embedding subsystem: model management, vector generation, semantic/keyword/hybrid search, CLI formatting |
| **`features/`** | **Composable feature modules** |
| `features/audit.ts` | Composite audit command: explain + impact + health in one call |
| `features/batch.ts` | Batch querying for multi-agent dispatch |
| `features/boundaries.ts` | Architecture boundary rules with onion architecture preset |
| `features/cfg.ts` | Control-flow graph generation |
| `features/check.ts` | CI validation predicates (cycles, complexity, blast radius, boundaries) |
| `features/communities.ts` | Louvain community detection, drift analysis (delegates to `graph/` subsystem) |
| `features/complexity.ts` | Cognitive, cyclomatic, Halstead, MI computation from AST |
| `features/dataflow.ts` | Dataflow analysis |
| `features/export.ts` | Graph export orchestration: loads data from DB, delegates to `presentation/` serializers |
| `features/manifesto.ts` | Configurable rule engine with warn/fail thresholds; CI gate |
| `features/owners.ts` | CODEOWNERS integration for ownership queries |
| `features/sequence.ts` | Sequence diagram data generation (BFS traversal) |
| `features/snapshot.ts` | SQLite DB backup and restore |
| `features/structure.ts` | Codebase structure analysis |
| `features/triage.ts` | Risk-ranked audit priority queue (delegates scoring to `graph/classifiers/`) |
| `features/graph-enrichment.ts` | Data enrichment for HTML viewer (complexity, communities, fan-in/out) |
| **`presentation/`** | **Pure output formatting + CLI command wrappers** |
| `presentation/viewer.ts` | Interactive HTML renderer with vis-network |
| `presentation/queries-cli/` | CLI display wrappers for query functions, split by concern: `path.ts`, `overview.ts`, `inspect.ts`, `impact.ts`, `exports.ts` |
| `presentation/*.ts` | Command formatters (audit, batch, check, communities, complexity, etc.) — call `features/*.ts`, format output, set exit codes |
| `presentation/export.ts` | DOT/Mermaid/GraphML/Neo4j serializers |
| `presentation/sequence-renderer.ts` | Mermaid sequence diagram rendering |
| `presentation/table.ts`, `result-formatter.ts`, `colors.ts` | CLI table formatting, JSON/NDJSON output, color constants |
| **`graph/`** | **Unified graph model** |
| `graph/` | `CodeGraph` class (`model.ts`), algorithms (Tarjan SCC, Louvain, BFS, shortest path, centrality), classifiers (role, risk), builders (dependency, structure, temporal) |
| **`mcp/`** | **MCP server** |
| `mcp/` | MCP server exposing graph queries to AI agents; single-repo by default, `--multi-repo` to enable cross-repo access |
| `ast-analysis/` | Unified AST analysis framework: shared DFS walker (`visitor.ts`), engine orchestrator (`engine.ts`), extracted metrics (`metrics.ts`), and pluggable visitors for complexity, dataflow, and AST-store |

**Key design decisions:**
- **Dual-engine architecture:** Native Rust parsing via napi-rs (`crates/codegraph-core/`) with automatic fallback to WASM. Controlled by `--engine native|wasm|auto` (default: `auto`)
- Platform-specific prebuilt binaries published as optional npm packages (`@optave/codegraph-{platform}-{arch}`)
- WASM grammars are built from devDeps on `npm install` (via `prepare` script) and not committed to git — used as fallback when native addon is unavailable
- **Language parser registry:** `LANGUAGE_REGISTRY` in `domain/parser.ts` is the single source of truth for all supported languages — maps each language to `{ id, extensions, grammarFile, extractor, required }`. `EXTENSIONS` in `shared/constants.ts` is derived from the registry. Adding a new language requires one registry entry + extractor function
- **Node kinds:** `SYMBOL_KINDS` in `domain/queries.ts` lists all valid kinds: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`. Language-specific types use their native kind (e.g. Go structs → `struct`, Rust traits → `trait`, Ruby modules → `module`) rather than mapping everything to `class`/`interface`
- `@huggingface/transformers` and `@modelcontextprotocol/sdk` are optional dependencies, lazy-loaded
- Non-required parsers (all except JS/TS/TSX) fail gracefully if their WASM grammar is unavailable
- Import resolution uses a 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy)
- Incremental builds track file hashes in the DB to skip unchanged files
- **MCP single-repo isolation:** `startMCPServer` defaults to single-repo mode — tools have no `repo` property and `list_repos` is not exposed. Passing `--multi-repo` or `--repos` to the CLI (or `options.multiRepo` / `options.allowedRepos` programmatically) enables multi-repo access. `buildToolList(multiRepo)` builds the tool list dynamically; the backward-compatible `TOOLS` export equals `buildToolList(true)`
- **Credential resolution:** `loadConfig` pipeline is `mergeConfig → applyEnvOverrides → resolveSecrets`. The `apiKeyCommand` config field shells out to an external secret manager via `execFileSync` (no shell). Priority: command output > env var > file config > defaults. On failure, warns and falls back gracefully

**Configuration:** All tunable behavioral constants live in `DEFAULTS` in `src/infrastructure/config.ts`, grouped by concern (`analysis`, `risk`, `search`, `display`, `community`, `structure`, `mcp`, `check`, `coChange`, `manifesto`). Users override via `.codegraphrc.json` — `mergeConfig` deep-merges recursively so partial overrides preserve sibling keys. Env vars override LLM settings (`CODEGRAPH_LLM_*`). When adding new behavioral constants, **always add them to `DEFAULTS`** and wire them through config — never introduce new hardcoded magic numbers in individual modules. Category F values (safety boundaries, standard formulas, platform concerns) are the only exception.

**Database:** SQLite at `.codegraph/graph.db` with tables: `nodes`, `edges`, `metadata`, `embeddings`, `function_complexity`

## Test Structure

Tests use vitest with 30s timeout and globals enabled.

```
tests/
├── integration/          # buildGraph + all query commands
├── graph/                # Cycle detection, DOT/Mermaid export
├── parsers/              # Language parser extraction
├── search/               # Semantic search + embeddings
└── fixtures/sample-project/  # ES module fixture (math.js, utils.js, index.js)
```

Integration tests create a temp copy of the fixture project for isolation.

## Release Process

Releases are triggered via the `publish.yml` workflow (`workflow_dispatch`). By default, `commit-and-tag-version` auto-detects the semver bump from commit history since the last tag:
- `BREAKING CHANGE` footer or `type!:` → **major**
- `feat:` → **minor**
- everything else → **patch**

The workflow can be overridden with a specific version via the `version-override` input. Locally, `npm run release:dry-run` previews the bump and changelog.

## Hooks

Codegraph is **our own tool** — hooks in `.claude/hooks/` use it to enforce quality automatically:

| Hook | What it does |
|------|-------------|
| `enrich-context.sh` | Injects file deps on every Read/Grep (passive context) |
| `pre-commit.sh` | Blocks commits with cycles or dead exports; warns on signature changes; shows diff-impact |
| `lint-staged.sh` | Blocks commits with lint errors in session-edited files |
| `guard-git.sh` | Blocks dangerous git commands; validates commits against edit log |
| `update-graph.sh` | Rebuilds graph after edits |

See `docs/examples/claude-code-hooks/README.md` for details.

## Parallel Sessions

Multiple Claude Code instances run concurrently in this repo. **Every session must start with `/worktree`** to get an isolated copy of the repo before making any changes. This prevents cross-session interference entirely.

**Safety hooks** enforce these rules automatically — see the Hooks section above.

**Rules:**
- Run `/worktree` before starting work
- **Always sync with `origin/main` before starting feature work.** Run `git fetch origin && git log --oneline origin/main -10` to check recent merges. If the current branch is behind main, create a new branch from `origin/main`. Never implement features on stale branches — the work may already exist on main.
- Stage only files you explicitly changed
- Commit with specific file paths: `git commit <files> -m "msg"`
- Ignore unexpected dirty files — they belong to another session
- Do not clean up lint/format issues in files you aren't working on

## Git Conventions

- Never add AI co-authorship lines (`Co-Authored-By` or similar) to commit messages.
- Never add "Built with Claude Code", "Generated with Claude Code", or any variation referencing Claude Code or Anthropic to commit messages, PR descriptions, code comments, or any other output.
- **One PR = one concern.** Each pull request should address a single feature, fix, or refactor. Do not pile unrelated changes into an existing PR — open a new branch and PR instead. If scope grows during implementation, split the work into separate PRs before pushing.

## PR Reviews (Greptile)

This repo uses [Greptile](https://greptile.com) for automated PR reviews. After pushing fixes that address review feedback, trigger a re-review by commenting `@greptileai` on the PR. Do **not** use the GitHub "re-request review" API — Greptile only responds to the comment trigger.

## Node Version

Requires Node >= 22.6.
