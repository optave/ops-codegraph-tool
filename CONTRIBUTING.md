# Contributing to Codegraph

Thanks for your interest in contributing! Codegraph is an open-source project
under the [Apache-2.0 license](LICENSE), and we welcome contributions of all
kinds — bug fixes, new features, documentation, and new language support.

---

## Getting Started

```bash
git clone https://github.com/optave/codegraph.git
cd codegraph
npm install                      # also installs git hooks via husky
npm test                         # run the full test suite
```

**Requirements:** Node.js >= 20

## Contributor License Agreement (CLA)

All contributors must sign the [Contributor License Agreement](CLA.md) before
their pull requests can be merged. This is a one-time requirement that protects
both you and Optave AI Solutions Inc.

**How to sign:**

1. Open a pull request
2. The CLA Assistant bot will post a comment if you haven't signed yet
3. Reply with the exact text:
   ```
   I have read the CLA Document and I hereby sign the CLA
   ```
4. The check will pass once all PR contributors have signed

If the CLA check needs to be re-evaluated, comment `recheck` on the PR to
re-trigger it.

Your signature applies to all future contributions — you only need to sign once.

## Development Environment

After `npm install`, [Husky](https://typicode.github.io/husky/) automatically
installs two git hooks:

- **pre-commit** — runs `npm run lint` (Biome) before each commit
- **commit-msg** — validates your commit message against the [commit convention](#commit-convention)

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

## Branch Naming Convention

Branch names **must** match one of these prefixes:

```
feat/    fix/    docs/    refactor/    test/    chore/
ci/      perf/   build/   release/     revert/  dependabot/
```

Examples: `feat/add-cpp-support`, `fix/cycle-detection-edge-case`,
`chore/update-deps`. This is enforced in CI on pull requests.

## Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/). Messages
are validated locally by a `commit-msg` hook and in CI on pull requests.

| Prefix | Use for |
|--------|---------|
| `feat:` | New features or capabilities |
| `fix:` | Bug fixes |
| `docs:` | Documentation only |
| `refactor:` | Code changes that don't fix bugs or add features |
| `test:` | Adding or updating tests |
| `chore:` | Maintenance, dependencies |
| `ci:` | CI/CD changes |
| `perf:` | Performance improvements |
| `build:` | Build system or external dependencies |
| `style:` | Code style (formatting, whitespace) |
| `revert:` | Reverting a previous commit |

Examples:
```
feat: add C language support
fix: resolve false positive cycles in HCL modules
docs: update adding-a-language guide
test: add parity tests for Python extractor
perf: cache tree-sitter parser instances
ci: add branch naming check to PR workflow
```

### Breaking Changes

For breaking changes, add a `!` after the type or include a `BREAKING CHANGE:`
footer:

```
feat!: rename --output flag to --format

fix: change default export format

BREAKING CHANGE: JSON export now uses camelCase keys instead of snake_case.
```

Breaking changes trigger a **major** version bump during release.

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

## Regression Benchmarks

Two regression benchmark scripts live in `scripts/`. These are **not** unit
tests — they measure performance metrics that reviewers use to judge whether a
change is acceptable. If your PR touches code covered by a benchmark, you
**must** run it before and after your changes and include the results in the PR
description.

| Benchmark | What it measures | When to run |
|-----------|-----------------|-------------|
| `node scripts/benchmark.js` | Build speed (native vs WASM), query latency | Changes to `builder.js`, `parser.js`, `queries.js`, `resolve.js`, `db.js`, or the native engine |
| `node scripts/embedding-benchmark.js` | Search recall (Hit@1/3/5/10) across models | Changes to `embedder.js` or embedding strategies |
| `node scripts/query-benchmark.js` | Query depth scaling, diff-impact latency | Changes to `queries.js`, `resolve.js`, or `db.js` |
| `node scripts/incremental-benchmark.js` | Incremental build, import resolution throughput | Changes to `builder.js`, `resolve.js`, `parser.js`, or `journal.js` |

### How to report results

Both scripts output JSON to stdout (progress goes to stderr). Run the relevant
benchmark on `main` (before), then on your branch (after), and paste both in
your PR description:

```bash
git stash && git checkout main
node scripts/benchmark.js > before.json

git checkout - && git stash pop
node scripts/benchmark.js > after.json
```

In the PR, include a table like:

```
## Benchmark results

| Metric       | Before | After  | Delta |
|--------------|--------|--------|-------|
| Build (ms)   | 1200   | 1180   | -20   |
| Hit@1        | 75.5%  | 76.2%  | +0.7% |
```

Regressions are not automatically blocking, but unexplained drops in speed or
recall will be questioned during review.

## Common Contribution Types

### Bug Fixes

1. Write a failing test that reproduces the bug
2. Fix the code
3. Verify the test passes and no others break

### New Language Support

Adding a new language is one of the most impactful contributions. We have a
dedicated step-by-step guide:

**[Adding a New Language](docs/guides/adding-a-language.md)**

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
- [Biome](https://biomejs.dev/) is used for linting and formatting (config in `biome.json`)
- Run `npm run lint` to check and `npm run lint:fix` to auto-fix
- The pre-commit hook runs the linter automatically
- Use `const`/`let` (no `var`)
- Prefer early returns over deep nesting
- Keep functions focused and reasonably sized

---

Thank you for helping make codegraph better!
