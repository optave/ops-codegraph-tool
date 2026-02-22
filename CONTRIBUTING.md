# Contributing to Codegraph

Thanks for your interest in contributing! Codegraph is an open-source project
under the [Apache-2.0 license](LICENSE), and we welcome contributions of all
kinds — bug fixes, new features, documentation, and new language support.

---

## Getting Started

```bash
git clone https://github.com/optave/codegraph.git
cd codegraph
npm install
npm test                         # run the full test suite
```

**Requirements:** Node.js >= 20

## Project Structure

```
src/
  cli.js          # Commander CLI entry point
  index.js        # Programmatic API exports
  builder.js      # Graph building: file collection, parsing, import resolution
  parser.js       # tree-sitter WASM wrapper + symbol extractors per language
  queries.js      # Query functions: symbol search, file deps, impact analysis
  embedder.js     # Semantic search with @huggingface/transformers
  db.js           # SQLite schema and operations
  mcp.js          # MCP server for AI agent integration
  cycles.js       # Circular dependency detection
  export.js       # DOT / Mermaid / JSON graph export
  watcher.js      # Watch mode for incremental rebuilds
  config.js       # .codegraphrc.json loading
  constants.js    # EXTENSIONS and IGNORE_DIRS

grammars/         # Pre-built .wasm grammar files (committed)
scripts/          # Build scripts (build-wasm.js)
tests/            # vitest test suite
docs/             # Extended documentation
```

## Development Workflow

1. **Fork** the repository and clone your fork
2. Create a feature branch: `git checkout -b feat/my-feature`
3. Make your changes
4. Run the tests: `npm test`
5. Commit with a descriptive message (see [Commit Convention](#commit-convention))
6. Push and open a Pull Request against `main`

## Commands

```bash
npm test                         # Run all tests (vitest)
npm run test:watch               # Watch mode
npm run test:coverage            # Coverage report
npx vitest run tests/parsers/go.test.js   # Single test file
npx vitest run -t "finds cycles"          # Single test by name
npm run build:wasm               # Rebuild WASM grammars
```

## Commit Convention

We use short conventional-style prefixes:

| Prefix | Use for |
|--------|---------|
| `feat:` | New features or capabilities |
| `fix:` | Bug fixes |
| `docs:` | Documentation only |
| `refactor:` | Code changes that don't fix bugs or add features |
| `test:` | Adding or updating tests |
| `chore:` | Maintenance, dependencies, CI |

Examples:
```
feat: add C language support
fix: resolve false positive cycles in HCL modules
docs: update adding-a-language guide
test: add parity tests for Python extractor
```

## Testing

Tests use [vitest](https://vitest.dev/) with a 30-second timeout and globals
enabled. The test structure:

```
tests/
  integration/     # buildGraph + full query commands
  graph/           # Cycle detection, DOT/Mermaid export
  parsers/         # Language parser extraction (one file per language)
  search/          # Semantic search + embeddings
  fixtures/        # Sample projects used by tests
```

- Integration tests create temporary copies of fixture projects for isolation
- Parser tests use inline code strings parsed directly with tree-sitter
- Always run the full suite (`npm test`) before submitting a PR

## Common Contribution Types

### Bug Fixes

1. Write a failing test that reproduces the bug
2. Fix the code
3. Verify the test passes and no others break

### New Language Support

Adding a new language is one of the most impactful contributions. We have a
dedicated step-by-step guide:

**[Adding a New Language](docs/adding-a-language.md)**

This covers the full dual-engine workflow (WASM + native Rust), including every
file to modify, code templates, and a verification checklist.

### Parser Improvements

If an existing language parser misses certain constructs (e.g. decorators,
generics, nested types):

1. Find the tree-sitter AST node type using the
   [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground)
2. Add a `case` in the corresponding `extract<Lang>Symbols()` function
3. Add a test case in `tests/parsers/<lang>.test.js`

### Documentation

Documentation improvements are always welcome. The main docs live in:

- `README.md` — user-facing overview and usage
- `CLAUDE.md` — AI agent context (architecture, commands, design decisions)
- `docs/` — extended guides and proposals

## Architecture Notes

**Pipeline:** Source files -> tree-sitter parse -> extract symbols -> resolve
imports -> SQLite DB -> query/search

**Key design decisions:**
- WASM grammars are pre-built and committed in `grammars/` — no native compilation needed at install time
- Optional dependencies (`@huggingface/transformers`, `@modelcontextprotocol/sdk`) are lazy-loaded
- Parsers that can't load fail gracefully — they log a warning and skip those files
- Import resolution uses a 6-level priority system with confidence scoring
- The `feat/rust-core` branch introduces an optional native Rust engine via napi-rs for 5-10x faster parsing, with automatic fallback to WASM

**Database:** SQLite at `.codegraph/graph.db` with tables: `nodes`, `edges`,
`metadata`, `embeddings`

## WASM Grammars

The `.wasm` files in `grammars/` are pre-built and committed. You only need to
rebuild them if you:

- Add a new language
- Upgrade a `tree-sitter-*` devDependency version

```bash
npm run build:wasm
```

## Reporting Issues

Use [GitHub Issues](https://github.com/optave/codegraph/issues) with:

- A clear title describing the problem
- Steps to reproduce (if a bug)
- Expected vs actual behavior
- Node.js version and OS

## Code Style

- All source is plain JavaScript (ES modules) — no transpilation
- No linter is currently configured; keep style consistent with existing code
- Use `const`/`let` (no `var`)
- Prefer early returns over deep nesting
- Keep functions focused and reasonably sized

---

Thank you for helping make codegraph better!
