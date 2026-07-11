# Contributing to Codegraph

Thanks for your interest in contributing! Codegraph is an open-source project
under the [Apache-2.0 license](LICENSE), and we welcome contributions of all
kinds — bug fixes, new features, documentation, and new language support.

---

## Getting Started

```bash
git clone https://github.com/optave/ops-codegraph-tool.git
cd codegraph
npm install                      # also installs git hooks via husky
npm test                         # run the full test suite
```

**Requirements:** Node.js >= 22.12.0 (see `engines.node` in `package.json`)

**Working in multiple git worktrees?** Each worktree gets its own untracked
`node_modules/` and `grammars/` — neither is shared via git — so every fresh
`git worktree add` needs its own `npm install`. A worktree set up before a
host Node upgrade, or where `npm install` was interrupted, can be left with a
`better-sqlite3` binary compiled for the wrong Node ABI or an incomplete
`grammars/` directory; both fail in confusing ways deep inside a build or test
run. Run `npm run doctor` to check (or `npm run doctor -- --fix` to repair
in place, scoped to the current worktree) — it also runs automatically before
`npm test` via `pretest`.

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

Source is TypeScript under `src/`, compiled via `tsc`; the native engine
lives in `crates/codegraph-core/` (Rust, via napi-rs) and mirrors the `src/`
tree module-for-module. `src/` is organized by layer, not by language:

```
src/
  cli.ts, cli/        # Commander CLI entry point + per-command modules
  index.ts            # Programmatic API exports
  shared/             # Cross-cutting constants, error types, kind enums
  infrastructure/     # Config loading, logging, native addon loader, doctor
  db/                 # SQLite schema and operations (better-sqlite3)
  domain/             # Parsing, graph building, import resolution, queries
  extractors/         # Per-language symbol extractors (WASM/TS side)
  features/           # Composable feature modules (audit, complexity, dataflow, ...)
  presentation/       # Output formatting + CLI command wrappers
  graph/              # Unified CodeGraph model + algorithms + classifiers
  mcp/                # MCP server for AI agent integration
  ast-analysis/       # Shared AST walker + pluggable analysis visitors

crates/codegraph-core/ # Native (Rust/napi-rs) engine — mirrors src/ layout
scripts/               # Build, benchmark, and release tooling (TypeScript)
tests/                 # vitest test suite
docs/                  # Extended documentation
```

For the authoritative, actively-maintained module-by-module breakdown (what
each file does, key design decisions, the native↔TypeScript mirroring table),
see the **Architecture** section of [`CLAUDE.md`](CLAUDE.md) — it is kept in
sync with the codebase as part of every PR that changes structure, so it's a
better long-term reference than a second copy here.

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
npx vitest run tests/parsers/go.test.ts   # Single test file
npx vitest run -t "finds cycles"          # Single test by name
npm run build                    # Compile TypeScript (tsc) to dist/
npm run typecheck                # Type-check only, no emit
npm run build:wasm               # Rebuild WASM grammars from devDependencies
npm run doctor                   # Check for a stale native binary / missing WASM grammars
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
  integration/          # buildGraph + full query commands
  graph/                # Cycle detection, DOT/Mermaid export
  parsers/              # Language parser extraction (one file per language)
  search/               # Semantic search + embeddings
  benchmarks/resolution/ # Call resolution precision/recall (per-language fixtures)
                          #   + tracer/ — dynamic call tracers used to validate fixtures
  fixtures/             # Sample projects used by tests
```

- Integration tests create temporary copies of fixture projects for isolation
- Parser tests use inline code strings parsed directly with tree-sitter
- Always run the full suite (`npm test`) before submitting a PR

## Regression Benchmarks

Several regression benchmarks track codegraph's accuracy and performance across
versions. Some live in `scripts/` (run manually), while the resolution benchmark
runs automatically as part of `npm test`. If your PR touches code covered by a
benchmark, you **must** run it before and after your changes and include the
results in the PR description.

| Benchmark | What it measures | When to run |
|-----------|-----------------|-------------|
| `npm run benchmark` | Build speed (native vs WASM), query latency | Changes to `domain/graph/builder/`, `domain/parser.ts`, `domain/queries.ts`, `domain/graph/resolve.ts`, `db/`, or the native engine |
| `node scripts/node-ts.js scripts/embedding-benchmark.ts` | Search recall (Hit@1/3/5/10) across models | Changes to `domain/search/` or embedding strategies |
| `node scripts/node-ts.js scripts/query-benchmark.ts` | Query depth scaling, diff-impact latency | Changes to `domain/queries.ts`, `domain/graph/resolve.ts`, or `db/` |
| `node scripts/node-ts.js scripts/incremental-benchmark.ts` | Incremental build, import resolution throughput | Changes to `domain/graph/builder/`, `domain/graph/resolve.ts`, `domain/parser.ts`, or `domain/graph/journal.ts` |
| `npx vitest run tests/benchmarks/resolution/` | Call resolution precision/recall per language | Changes to `domain/graph/builder/stages/build-edges.ts`, `domain/graph/resolve.ts`, `domain/parser.ts`, or any extractor |

### Resolution precision/recall benchmark

The resolution benchmark (`tests/benchmarks/resolution/`) measures how
accurately codegraph resolves call edges. It uses hand-annotated fixture projects
with an `expected-edges.json` manifest per language that declares every call edge
that should be detected.

The benchmark runner builds the graph for each fixture, compares resolved edges
against the manifest, and reports:

- **Precision** — what fraction of resolved edges are correct (no false positives)
- **Recall** — what fraction of expected edges were found (no false negatives)
- **Per-mode breakdown** — separate recall for `static`, `receiver-typed`, and
  `interface-dispatched` resolution modes

**CI gate:** The benchmark runs as part of `npm test`. If precision or recall
drops below the configured thresholds for any language, the test fails.

**Adding a new language fixture:**

1. Create `tests/benchmarks/resolution/fixtures/<language>/` with source files
2. Add an `expected-edges.json` manifest (see the JSON schema at
   `tests/benchmarks/resolution/expected-edges.schema.json`)
3. Add thresholds in `resolution-benchmark.test.ts` → `THRESHOLDS`
4. The benchmark runner auto-discovers fixtures with an `expected-edges.json`

### How to report results

Both scripts output JSON to stdout (progress goes to stderr). Run the relevant
benchmark on `main` (before), then on your branch (after), and paste both in
your PR description:

```bash
git stash && git checkout main
npm run benchmark > before.json

git checkout - && git stash pop
npm run benchmark > after.json
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

**[Adding a New Language](docs/contributing/adding-a-language.md)**

This covers the full dual-engine workflow (WASM + native Rust), including every
file to modify, code templates, and a verification checklist.

### Parser Improvements

If an existing language parser misses certain constructs (e.g. decorators,
generics, nested types):

1. Find the tree-sitter AST node type using the
   [tree-sitter playground](https://tree-sitter.github.io/tree-sitter/playground)
2. Add a `case` in the corresponding `extract<Lang>Symbols()` function in
   `src/extractors/<lang>.ts` (WASM) — and the mirrored extractor in
   `crates/codegraph-core/src/extractors/` (native) if the change affects both
   engines, per the dual-engine parity requirement in `CLAUDE.md`
3. Add a test case in `tests/parsers/<lang>.test.ts`

### Harness Engineering (Claude Code Hooks)

If you're working on the Claude Code hooks in `.claude/hooks/`, see the dedicated guide:

**[Harness Engineering Guide](docs/contributing/harness-engineering.md)**

This covers the principles behind AI agent harnesses, how our hooks work, and how to add or modify them.

### Documentation

Documentation improvements are always welcome. The main docs live in:

- `README.md` — user-facing overview and usage
- `CLAUDE.md` — AI agent context (architecture, commands, design decisions)
- `docs/` — extended guides and proposals

## Architecture Notes

**Pipeline:** Source files -> tree-sitter parse -> extract symbols -> resolve
imports -> SQLite DB -> query/search

**Key design decisions:**
- **Dual-engine:** native Rust parsing via napi-rs (`crates/codegraph-core/`), with automatic fallback to WASM (`--engine native|wasm|auto`, default `auto`). Both engines must produce identical results — see `CLAUDE.md` for the mirrored module layout
- Optional dependencies (`@huggingface/transformers`, `@modelcontextprotocol/sdk`) are lazy-loaded
- Non-required parsers (everything except JS/TS/TSX) fail gracefully if their WASM grammar is unavailable — they log a warning and skip those files
- Import resolution uses a 6-level priority system with confidence scoring
- Incremental builds track file hashes in the DB to skip unchanged files

**Database:** SQLite at `.codegraph/graph.db`. See the **Database** entry in
`CLAUDE.md` for the current table list — it's kept up to date there rather
than duplicated here.

This is a summary; for full detail (module-by-module responsibilities,
configuration system, credential resolution, MCP isolation model) see
`CLAUDE.md`, which is the actively-maintained reference.

## WASM Grammars

Most `.wasm` grammar files are **not** committed to git — they're built from
`devDependencies` into `grammars/` automatically via the `prepare` npm script
(`npm run build:wasm`), which runs on every `npm install`; pinned exceptions
such as `grammars/tree-sitter-erlang.wasm` remain tracked. Each git worktree
therefore needs its own `npm install` before its `grammars/` directory is
populated (see "Working in multiple git worktrees?" above; `npm run doctor`
detects a missing or incomplete `grammars/`).

Rebuild manually if you:

- Add a new language
- Upgrade a `tree-sitter-*` devDependency version

```bash
npm run build:wasm
```

## Reporting Issues

Use [GitHub Issues](https://github.com/optave/ops-codegraph-tool/issues) with:

- A clear title describing the problem
- Steps to reproduce (if a bug)
- Expected vs actual behavior
- Node.js version and OS

## Code Style

- Source is TypeScript (`src/`), compiled via `tsc`/`tsup`; run `npm run typecheck` to type-check without emitting
- [Biome](https://biomejs.dev/) is used for linting and formatting (config in `biome.json`, scoped to `src/` and `tests/`)
- Run `npm run lint` to check and `npm run lint:fix` to auto-fix
- The pre-commit hook runs the linter automatically
- Use `const`/`let` (no `var`)
- Prefer early returns over deep nesting
- Keep functions focused and reasonably sized

---

Thank you for helping make codegraph better!
