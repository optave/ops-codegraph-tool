# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codegraph (`@optave/codegraph`) is a local code dependency graph CLI. It parses codebases with tree-sitter (WASM), builds function-level dependency graphs stored in SQLite, and supports semantic search with local embeddings. No cloud services required.

**Languages supported:** JavaScript, TypeScript, TSX, Python, Go, Rust, Java, C#, PHP, Ruby, Terraform/HCL

## Commands

```bash
npm install                      # Install dependencies
npm test                         # Run all tests (vitest)
npm run test:watch               # Watch mode
npm run test:coverage            # Coverage report
npx vitest run tests/parsers/javascript.test.js   # Single test file
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

JS source is plain JavaScript (ES modules) in `src/`. No transpilation step. The Rust native engine lives in `crates/codegraph-core/`.

| File | Role |
|------|------|
| `cli.js` | Commander CLI entry point (`bin.codegraph`) |
| `index.js` | Programmatic API exports |
| `builder.js` | Graph building: file collection, parsing, import resolution, incremental hashing |
| `parser.js` | tree-sitter WASM wrapper; `LANGUAGE_REGISTRY` + per-language extractors for functions, classes, methods, imports, exports, call sites |
| `queries.js` | Query functions: symbol search, file deps, impact analysis, diff-impact |
| `embedder.js` | Semantic search with `@huggingface/transformers`; multi-query RRF ranking |
| `db.js` | SQLite schema and operations (`better-sqlite3`) |
| `mcp.js` | MCP server exposing graph queries to AI agents |
| `cycles.js` | Circular dependency detection |
| `export.js` | DOT/Mermaid/JSON graph export |
| `watcher.js` | Watch mode for incremental rebuilds |
| `config.js` | `.codegraphrc.json` loading, env overrides, `apiKeyCommand` secret resolution |
| `constants.js` | `EXTENSIONS` (derived from parser registry) and `IGNORE_DIRS` constants |
| `native.js` | Native napi-rs addon loader with WASM fallback |
| `resolve.js` | Import resolution (supports native batch mode) |
| `logger.js` | Structured logging (`warn`, `debug`, `info`, `error`) |

**Key design decisions:**
- **Dual-engine architecture:** Native Rust parsing via napi-rs (`crates/codegraph-core/`) with automatic fallback to WASM. Controlled by `--engine native|wasm|auto` (default: `auto`)
- Platform-specific prebuilt binaries published as optional npm packages (`@optave/codegraph-{platform}-{arch}`)
- WASM grammars are built from devDeps on `npm install` (via `prepare` script) and not committed to git — used as fallback when native addon is unavailable
- **Language parser registry:** `LANGUAGE_REGISTRY` in `parser.js` is the single source of truth for all supported languages — maps each language to `{ id, extensions, grammarFile, extractor, required }`. `EXTENSIONS` in `constants.js` is derived from the registry. Adding a new language requires one registry entry + extractor function
- `@huggingface/transformers` and `@modelcontextprotocol/sdk` are optional dependencies, lazy-loaded
- Non-required parsers (all except JS/TS/TSX) fail gracefully if their WASM grammar is unavailable
- Import resolution uses a 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy)
- Incremental builds track file hashes in the DB to skip unchanged files
- **Credential resolution:** `loadConfig` pipeline is `mergeConfig → applyEnvOverrides → resolveSecrets`. The `apiKeyCommand` config field shells out to an external secret manager via `execFileSync` (no shell). Priority: command output > env var > file config > defaults. On failure, warns and falls back gracefully

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

## Release Process

Releases are triggered via the `publish.yml` workflow (`workflow_dispatch`). By default, `commit-and-tag-version` auto-detects the semver bump from commit history since the last tag:
- `BREAKING CHANGE` footer or `type!:` → **major**
- `feat:` → **minor**
- everything else → **patch**

The workflow can be overridden with a specific version via the `version-override` input. Locally, `npm run release:dry-run` previews the bump and changelog.

## Git Conventions

- Never add AI co-authorship lines (`Co-Authored-By` or similar) to commit messages.

## Node Version

Requires Node >= 20.
