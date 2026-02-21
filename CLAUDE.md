# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codegraph (`@optave/codegraph`) is a local code dependency graph CLI. It parses codebases with tree-sitter (WASM), builds function-level dependency graphs stored in SQLite, and supports semantic search with local embeddings. No cloud services required.

**Languages supported:** JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C#, PHP, Ruby, Terraform/HCL

## Commands

```bash
npm install --legacy-peer-deps   # Install (--legacy-peer-deps required)
npm test                         # Run all tests (vitest)
npm run test:watch               # Watch mode
npm run test:coverage            # Coverage report
npx vitest run tests/parsers/javascript.test.js   # Single test file
npx vitest run -t "finds cycles"                  # Single test by name
npm run build:wasm               # Rebuild WASM grammars (only after upgrading grammar devDeps)
```

No linter is currently configured.

## Architecture

**Pipeline:** Source files → tree-sitter parse → extract symbols → resolve imports → SQLite DB → query/search

All source is plain JavaScript (ES modules) in `src/`. No transpilation step.

| File | Role |
|------|------|
| `cli.js` | Commander CLI entry point (`bin.codegraph`) |
| `index.js` | Programmatic API exports |
| `builder.js` | Graph building: file collection, parsing, import resolution, incremental hashing |
| `parser.js` | tree-sitter WASM wrapper; extracts functions, classes, methods, imports, exports, call sites |
| `queries.js` | Query functions: symbol search, file deps, impact analysis, diff-impact |
| `embedder.js` | Semantic search with `@huggingface/transformers`; multi-query RRF ranking |
| `db.js` | SQLite schema and operations (`better-sqlite3`) |
| `mcp.js` | MCP server exposing graph queries to AI agents |
| `cycles.js` | Circular dependency detection |
| `export.js` | DOT/Mermaid/JSON graph export |
| `watcher.js` | Watch mode for incremental rebuilds |
| `config.js` | `.codegraphrc.json` loading |
| `constants.js` | `EXTENSIONS` and `IGNORE_DIRS` constants |

**Key design decisions:**
- WASM grammars are pre-built and committed in `grammars/` — no native compilation needed
- `@huggingface/transformers` and `@modelcontextprotocol/sdk` are optional dependencies, lazy-loaded
- HCL and Python parsers fail gracefully if unavailable
- Import resolution uses a 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy)
- Incremental builds track file hashes in the DB to skip unchanged files

**Database:** SQLite at `.codegraph/graph.db` with tables: `nodes`, `edges`, `metadata`, `embeddings`

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

## Node Version

Requires Node >= 20.
