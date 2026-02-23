# Codegraph 2.1.0 Dogfood Report & Improvement Plan

**Date:** 2026-02-22
**Version tested:** 2.1.0 (npm), native engine v0.1.0
**Tested on:** codegraph's own codebase (87 files, 443 nodes, 1393 edges)

---

## Part 1: Dogfood Findings

### Critical Bug Found & Fixed

**MCP server crash with `@modelcontextprotocol/sdk` >= 1.26.0**
- `server.setRequestHandler('tools/list', ...)` crashes with `Schema is missing a method literal`
- Root cause: SDK breaking change — `setRequestHandler` now requires Zod schema objects (`ListToolsRequestSchema`, `CallToolRequestSchema`) instead of string method names
- Since `package.json` specifies `^1.0.0`, users installing fresh get the incompatible version
- **Fix applied:** Import schema objects from `@modelcontextprotocol/sdk/types.js` and use them instead of strings
- **Files changed:** `src/mcp.js`, `tests/unit/mcp.test.js`

### Call Resolution False Positives (Most Impactful Quality Issue)

The function-level call graph has significant false positives from **name collision**. Any call to a common method name gets resolved to the wrong function:

| Call site | Actual target | Resolved to |
|-----------|---------------|-------------|
| `insertNode.run(...)` in builder.js | SQLite prepared statement `.run()` | `f run` in tests/integration/cli.test.js:42 |
| `deleteEdgesForFile.run(...)` | SQLite prepared statement | same test `run` |
| `upsertHash.run(...)` | SQLite prepared statement | same test `run` |
| `path.normalize(...)` in resolve.js | Node.js built-in | `f normalize` in tests/engines/parity.test.js:65 |

**Impact:** `buildGraph` shows 23 callees, but 12 (52%) are false positives. Every function that calls `db.run()` appears to call the test helper. This makes the call graph unreliable for understanding code flow.

**Root cause:** Call resolution treats any `identifier(...)` call as a match for any global function with that name, without considering:
1. **Receiver/qualifier context** — `stmt.run()` is a method call on `stmt`, not a call to a standalone `run` function
2. **Import scope** — `run` is never imported in `builder.js`, so it can't be called directly
3. **File boundary** — test files shouldn't be callee candidates for source files (unless explicitly imported)

### Duplicate Call Edges

Many caller/callee relationships appear multiple times:
- `buildGraph` → `run`: appears 12 times (once per call site, but all resolve to the same target)
- `normalizePath` appears 6x as callee of `resolveImportPathJS`
- `tests/unit/db.test.js` appears 3x as caller of `openDb`

Expected behavior: each unique caller→callee pair should appear once, optionally with a count of call sites.

### Missing Symbols

- **`cli.js` shows 0 symbols** — Commander-style `program.command(...).action(async () => {...})` callbacks are not extracted. This is the main entry point and has the most complex orchestration logic.
- **`.cjs` files show 0 symbols** — `scripts/gen-deps.cjs` and others have `module.exports` and `require()` patterns that aren't extracted (CommonJS).
- **Prepared statements not tracked** — `const insertNode = db.prepare(...)` creates callable objects that are used throughout, but they're just `const` assignments, not function definitions.

### Other Observations

| Area | Finding | Severity |
|------|---------|----------|
| `fn` search | Substring matching: `fn run` returns `pruneRegistry` (contains "run") first | Low — but confusing when looking for exact names |
| `fn` disambiguation | When multiple matches exist, all results are shown but without guidance on which is most relevant | Low |
| `diff-impact` | Shows `changedFiles: 5, affectedFunctions: 0` in worktree — the 5 changed files are probably build artifacts, but they're not function-bearing | Low |
| `hotspots` | No `--functions` flag — only file-level hotspots available | Feature gap |
| `cycles --functions` | Works correctly; found the real `walkPythonNode ↔ findPythonParentClass` mutual recursion | Good |
| `search` | Semantic search works well with good ranking | Good |
| `stats` | Clean summary, correct data | Good |
| `structure` | Excellent output with cohesion scores | Good |
| All `--json` flags | Work correctly across all commands | Good |
| Error messages | Clean, helpful messages for missing files/functions | Good |

### Test Suite

- **423/423 tests pass** (5 skipped, all for platform-specific reasons)
- Test suite runs in ~2.3 seconds — fast

---

## Part 2: Improvement Plan for AI Agent Usage

The goal: make codegraph the **essential first tool** an AI agent uses when working on any codebase. Every improvement below targets a specific problem AI agents (like Claude) face.

### Priority 1: Fix Call Resolution Accuracy (HIGH IMPACT)

**Problem:** AI agents trust the call graph to understand what code does. With 52% false positives on common function names, agents will waste tokens investigating wrong call chains, make incorrect assumptions about dependencies, and suggest changes that break things they didn't know were related.

**Solution: Qualified Call Resolution**

1. **Distinguish method calls from function calls**
   - `obj.method()` should only match methods defined on that object's type or prototype
   - `standalone()` should only match imported/in-scope standalone functions
   - Implementation: During extraction, tag call sites with their receiver (if any). During resolution, only match method calls to methods and standalone calls to functions.

2. **Respect import scope**
   - A call to `foo()` in file A should only resolve to a function `foo` if:
     - `foo` is defined in file A, OR
     - `foo` is imported (directly or via re-export) in file A, OR
     - `foo` is a global/built-in (and should be excluded)
   - This alone would eliminate most false positives.

3. **Deduplicate call edges**
   - Store unique `(caller, callee)` pairs with an optional `count` field
   - Display: `-> openDb (calls, 3 sites) src/db.js:72` instead of 3 duplicate lines

4. **Exclude built-in/library calls**
   - `db.run()`, `path.normalize()`, `console.log()`, `Array.map()` etc. are not user code
   - Don't create edges for calls where the receiver is a known library/built-in object
   - Optionally, create a separate "external calls" edge type for traceability

### Priority 2: New `context` Command (HIGH IMPACT)

**Problem:** When an AI agent needs to understand or modify a function, it currently must:
1. Use `fn` to find the function and its call chain (tokens for parsing output)
2. Read the source file to see the implementation (tokens for file content)
3. Read each dependency file to understand called functions (many more tokens)
4. Often re-read files because it forgot details

This "read-think-read" loop consumes 50-80% of an agent's token budget on navigation alone.

**Solution: `codegraph context <name>` command**

Returns everything an AI needs to understand and safely modify a function in one call:

```
codegraph context buildGraph

# buildGraph (function) — src/builder.js:143-310
## Source
  <full function body>

## Direct Dependencies (what it calls)
  openDb() — src/db.js:72 — Opens or creates the SQLite database
  initSchema() — src/db.js:80 — Creates tables if they don't exist
  collectFiles() — src/builder.js:14 — Walks directory tree respecting ignore rules
  parseFilesAuto() — src/parser.js:276 — Parses files with tree-sitter
  resolveImportsBatch() — src/resolve.js:150 — Resolves all import paths
  <each with 1-line summary extracted from JSDoc or first comment>

## Callers (what breaks if this changes)
  cli.js — main build command handler
  watcher.js:watchProject — incremental rebuild trigger

## Type/Shape Info
  Parameters: (dir, options={})
  Returns: { nodeCount, edgeCount, dbPath }

## Related Tests
  tests/integration/build.test.js — 6 tests
  tests/integration/build-parity.test.js — 2 tests
```

**Options:**
- `--depth N` — Include source of called functions up to N levels deep
- `--no-source` — Metadata only (for quick orientation)
- `--include-tests` — Include test source code too
- `--json` — Machine-readable output

### Priority 3: New `explain` Command (MEDIUM IMPACT)

**Problem:** AI agents spend many tokens reading code to figure out "what does this module do?" and "how do these pieces fit together?" before they can start actual work. This is especially wasteful for large files like `queries.js` (1009 lines, 21 symbols).

**Solution: `codegraph explain <file|function>` command**

Generates a structural summary without requiring the agent to read the entire file:

```
codegraph explain src/builder.js

# src/builder.js — Graph Building Pipeline
  600 lines, 8 exported functions

## Public API
  buildGraph(dir, options) — Main entry: scans files, parses, resolves imports, stores in DB
  collectFiles(dir, config) — Directory walker with .gitignore and config-based filtering
  getChangedFiles(db, files) — Incremental: returns only files whose hash changed

## Internal
  loadPathAliases(config) — Loads tsconfig/jsconfig path aliases
  fileHash(content) — SHA-256 content hash for incremental tracking
  getResolved(imports, ...) — Resolves import paths with priority scoring
  resolveBarrelExport(db, ...) — Follows re-exports through index.js barrel files
  buildMetrics(db, file, ...) — Computes per-file metrics (line count, import/export counts)

## Data Flow
  buildGraph calls: collectFiles → getChangedFiles → parseFilesAuto → getResolved → resolveBarrelExport
  Each file is: hashed → parsed → symbols extracted → imports resolved → stored in DB

## Key Patterns
  - Uses better-sqlite3 prepared statements for all DB operations
  - Incremental: skips files whose hash matches the DB record
  - Handles barrel re-exports by following index.js chains
```

### Priority 4: Smarter `fn` Search (MEDIUM IMPACT)

**Problem:** `fn run` returns `pruneRegistry` first because it substring-matches "run" in "p**run**eRegistry". An AI agent looking for a specific function wastes tokens processing irrelevant results.

**Improvements:**
1. **Exact match priority** — If there's an exact name match, show it first (before substring matches)
2. **File-scoped search** — `fn buildGraph --file src/builder.js` to narrow results
3. **Kind filter** — `fn --kind method run` to search only methods
4. **Relevance scoring** — Rank by: exact match > prefix match > substring match > fuzzy match. Weight by fan-in (more-connected functions are more likely targets)

### Priority 5: `where` / `locate` Command (MEDIUM IMPACT)

**Problem:** AI agents frequently need to answer "where is X defined?" or "where is X used?" without needing the full dependency chain. Currently they must use `fn` (which shows the full call graph) or `query` (similar), which returns too much data.

**Solution: `codegraph where <name>` — Minimal, fast lookup**

```
codegraph where buildGraph
  Defined: src/builder.js:143 (function, exported)
  Used in: src/cli.js:45, tests/integration/build.test.js:12, ...

codegraph where SYMBOL_KINDS
  Defined: src/queries.js:5 (const, exported)
  Used in: src/queries.js:88, src/queries.js:120, tests/unit/queries-unit.test.js:8

codegraph where --file src/builder.js
  Functions: buildGraph:143, collectFiles:14, getChangedFiles:87, ...
  Imports: db.js, parser.js, resolve.js, config.js, constants.js, logger.js
  Exported: buildGraph, collectFiles, getChangedFiles, loadPathAliases, fileHash
```

### Priority 6: Extract Symbols from Commander/Express Patterns (LOW IMPACT)

**Problem:** `cli.js` shows 0 symbols because all logic is in Commander `.action()` callbacks. This is the main entry point — knowing its structure is critical.

**Solution:** Recognize common callback patterns:
- Commander: `program.command('build').action(async (dir, opts) => {...})` → extract as `command:build`
- Express: `app.get('/api/users', handler)` → extract as `route:GET /api/users`
- Event emitters: `emitter.on('data', handler)` → extract as `event:data`

### Priority 7: Quality-of-Life Improvements

1. **Pin MCP SDK version** — Change `^1.0.0` to `~1.11.0` or a specific compatible range to prevent future breakage
2. **`stats` command enhancement** — Add a "graph quality" score based on:
   - % of functions with resolved callers
   - % of imports successfully resolved
   - Ratio of false-positive-prone names (like `run`, `get`, `set`) in the call graph
3. **`--no-tests` everywhere** — Add this flag to `map`, `hotspots`, `deps`, `impact` (currently only on `fn` variants)
4. **Warn on common false-positive names** — When a function named `run`, `get`, `set`, `init`, `start`, `handle` has > 20 callers, flag it as a potential resolution issue

---

## Part 3: Implementation Priority Matrix

| # | Feature | Impact on AI | Effort | Priority |
|---|---------|-------------|--------|----------|
| 1 | Fix call resolution (method vs function) | Critical — eliminates 50%+ false edges | Large | P0 |
| 2 | `context` command | Critical — saves 50-80% of navigation tokens | Medium | P0 |
| 3 | `explain` command | High — saves initial orientation tokens | Medium | P1 |
| 4 | Smarter `fn` search ranking | Medium — reduces noise in results | Small | P1 |
| 5 | `where` command | Medium — fast precise lookups | Small | P1 |
| 6 | Commander/Express extraction | Low — only affects specific patterns | Medium | P2 |
| 7 | QoL improvements | Low-Medium — polish | Small each | P2 |

### Suggested Implementation Order

1. **Call resolution fix** (P0) — This is the foundation. Every other feature's value depends on accurate edges.
2. **`context` command** (P0) — The single highest-ROI feature for AI agents.
3. **Deduplicate call edges** (part of P0) — Quick win during resolution refactor.
4. **Smarter `fn` search** (P1) — Small change, big usability improvement.
5. **`where` command** (P1) — Complements `context` for quick lookups.
6. **`explain` command** (P1) — Builds on `context` infrastructure.
7. **Everything else** (P2) — Polish and edge cases.

---

## Part 4: What Makes Codegraph Amazing for AI Agents

### Current Strengths (Keep & Amplify)
- **`map` command** is excellent for initial orientation — AI agents should always run this first
- **`structure` command** with cohesion scores gives perfect project overview
- **`--json` flags** on every command enable structured parsing
- **Semantic search** finds functions by intent, not just name
- **`fn-impact` / `diff-impact`** directly answers "what will break?"
- **Fast** — full build + query in seconds, not minutes

### The AI Agent Workflow This Enables

```
1. codegraph map --limit 30 --json          → "What are the key modules?"
2. codegraph structure --json               → "How is the project organized?"
3. codegraph where <function> --json        → "Where exactly is this?"
4. codegraph context <function> --json      → "Give me everything I need to modify this"
5. codegraph fn-impact <function> --json    → "What will break if I change this?"
6. codegraph diff-impact --json             → "Did my changes break anything?"
```

With these improvements, an AI agent can go from "I don't know this codebase" to "I have full context for this change" in 3-4 tool calls instead of 15-20 file reads. That's the difference between a confident, accurate AI assistant and one that guesses and backtracks.
