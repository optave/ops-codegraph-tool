# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Use codegraph before editing code.** This project has a pre-built dependency graph at `.codegraph/graph.db`. Before modifying any function or file, run `node src/cli.js where <name>` to locate it, `node src/cli.js explain <target>` to understand the structure, `node src/cli.js context <name> -T` to gather full context, and `node src/cli.js fn-impact <name> -T` to check blast radius. After staging changes, run `node src/cli.js diff-impact --staged -T` to verify impact. This saves tokens, prevents blind edits, and catches breakage before it happens. See the [Dogfooding](#dogfooding--codegraph-on-itself) section for the full command reference.

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
| `queries.js` | Query functions: symbol search, file deps, impact analysis, diff-impact; `SYMBOL_KINDS` constant defines all node kinds |
| `embedder.js` | Semantic search with `@huggingface/transformers`; multi-query RRF ranking |
| `db.js` | SQLite schema and operations (`better-sqlite3`) |
| `mcp.js` | MCP server exposing graph queries to AI agents; single-repo by default, `--multi-repo` to enable cross-repo access |
| `cycles.js` | Circular dependency detection |
| `export.js` | DOT/Mermaid/JSON graph export |
| `watcher.js` | Watch mode for incremental rebuilds |
| `config.js` | `.codegraphrc.json` loading, env overrides, `apiKeyCommand` secret resolution |
| `constants.js` | `EXTENSIONS` (derived from parser registry) and `IGNORE_DIRS` constants |
| `native.js` | Native napi-rs addon loader with WASM fallback |
| `registry.js` | Global repo registry (`~/.codegraph/registry.json`) for multi-repo MCP |
| `resolve.js` | Import resolution (supports native batch mode) |
| `logger.js` | Structured logging (`warn`, `debug`, `info`, `error`) |

**Key design decisions:**
- **Dual-engine architecture:** Native Rust parsing via napi-rs (`crates/codegraph-core/`) with automatic fallback to WASM. Controlled by `--engine native|wasm|auto` (default: `auto`)
- Platform-specific prebuilt binaries published as optional npm packages (`@optave/codegraph-{platform}-{arch}`)
- WASM grammars are built from devDeps on `npm install` (via `prepare` script) and not committed to git — used as fallback when native addon is unavailable
- **Language parser registry:** `LANGUAGE_REGISTRY` in `parser.js` is the single source of truth for all supported languages — maps each language to `{ id, extensions, grammarFile, extractor, required }`. `EXTENSIONS` in `constants.js` is derived from the registry. Adding a new language requires one registry entry + extractor function
- **Node kinds:** `SYMBOL_KINDS` in `queries.js` lists all valid kinds: `function`, `method`, `class`, `interface`, `type`, `struct`, `enum`, `trait`, `record`, `module`. Language-specific types use their native kind (e.g. Go structs → `struct`, Rust traits → `trait`, Ruby modules → `module`) rather than mapping everything to `class`/`interface`
- `@huggingface/transformers` and `@modelcontextprotocol/sdk` are optional dependencies, lazy-loaded
- Non-required parsers (all except JS/TS/TSX) fail gracefully if their WASM grammar is unavailable
- Import resolution uses a 6-level priority system with confidence scoring (import-aware → same-file → directory → parent → global → method hierarchy)
- Incremental builds track file hashes in the DB to skip unchanged files
- **MCP single-repo isolation:** `startMCPServer` defaults to single-repo mode — tools have no `repo` property and `list_repos` is not exposed. Passing `--multi-repo` or `--repos` to the CLI (or `options.multiRepo` / `options.allowedRepos` programmatically) enables multi-repo access. `buildToolList(multiRepo)` builds the tool list dynamically; the backward-compatible `TOOLS` export equals `buildToolList(true)`
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

## Dogfooding — codegraph on itself

Codegraph is **our own tool**. Use it to analyze this repository before making changes. If codegraph reports an error, crashes, or produces wrong results when analyzing itself, **fix the bug in the codebase** — don't just work around it.

### Before modifying code, always:
1. `node src/cli.js where <name>` — find where the symbol lives
2. `node src/cli.js explain <file-or-function>` — understand the structure
3. `node src/cli.js context <name> -T` — get full context (source, deps, callers)
4. `node src/cli.js fn-impact <name> -T` — check blast radius before editing

### After modifying code:
5. `node src/cli.js diff-impact --staged -T` — verify impact before committing

### Other useful commands
```bash
node src/cli.js build .              # Build/update the graph (incremental)
node src/cli.js map --limit 20       # Module overview & most-connected nodes
node src/cli.js stats                # Graph health and quality score
node src/cli.js fn <name> -T         # Function call chain (callers + callees)
node src/cli.js deps src/<file>.js   # File-level imports and importers
node src/cli.js diff-impact main     # Impact of current branch vs main
node src/cli.js cycles               # Check for circular dependencies
node src/cli.js search "<query>"     # Semantic search (requires `embed` first)
```

### Flags
- `-T` / `--no-tests` — exclude test files (use by default)
- `-j` / `--json` — JSON output for programmatic use
- `-f, --file <path>` — scope to a specific file (partial match)
- `-k, --kind <kind>` — filter by symbol kind (function, method, class, etc.)

## Parallel Sessions

Multiple Claude Code instances run concurrently in this repo. **Every session must start with `/worktree`** to get an isolated copy of the repo before making any changes. This prevents cross-session interference entirely.

**Safety hooks** (`.claude/hooks/guard-git.sh` and `track-edits.sh`) enforce these rules automatically:

- `guard-git.sh` (PreToolUse on Bash) **blocks**: `git add .`, `git add -A`, `git reset`, `git checkout -- <file>`, `git restore <file>`, `git clean`, `git stash`. It allows `git restore --staged <file>` for safe unstaging.
- `guard-git.sh` also **validates commits**: compares staged files against the session edit log and blocks commits that include files you didn't edit.
- `track-edits.sh` (PostToolUse on Edit/Write) logs every file you touch to `.claude/session-edits.log` (gitignored, per-worktree).

**Rules:**
- Run `/worktree` before starting work
- Stage only files you explicitly changed
- Commit with specific file paths: `git commit <files> -m "msg"`
- Ignore unexpected dirty files — they belong to another session
- Do not clean up lint/format issues in files you aren't working on

## Git Conventions

- Never add AI co-authorship lines (`Co-Authored-By` or similar) to commit messages.
- Never add "Built with Claude Code", "Generated with Claude Code", or any variation referencing Claude Code or Anthropic to commit messages, PR descriptions, code comments, or any other output.

## Node Version

Requires Node >= 20.
