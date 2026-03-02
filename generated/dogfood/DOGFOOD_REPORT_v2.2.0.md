# Dogfooding Report: @optave/codegraph@2.2.0

**Date:** 2026-02-23
**Tested against:** codegraph repo itself (92 files, 527 nodes)
**Engine:** Native v0.1.0 (auto)

## Working Commands (20/22)

| Command | Status | Notes |
|---------|--------|-------|
| `build` | PASS | Native engine, 92 files, 527 nodes, 526 edges |
| `query` | PASS | Correct callers/callees for `buildGraph` |
| `impact` | PASS | 13 transitive deps for `src/db.js` |
| `map` | PASS | Clean module overview |
| `stats` | PASS | Full graph health overview |
| `deps` | PASS | Correct imports/imported-by |
| `fn` | PASS | Function-level call chain |
| `fn-impact` | PASS | 3 transitive dependents |
| `context` | PASS | Full source, deps, callers, tests |
| `explain` (file) | PASS | Clean structural summary |
| `explain` (function) | PASS | Calls, callers, tests |
| `where` | PASS | Fast symbol lookup |
| `diff-impact` | PASS | 11 changed functions, 44 callers affected |
| `cycles` | PASS | 1 cycle: queries.js <-> cycles.js |
| `hotspots` | PASS | Correct fan-in rankings |
| `export` (DOT/Mermaid/JSON) | PASS | All 3 formats work |
| `info` | PASS | Correct version + engine info |
| `models` | PASS | Lists all 7 models |
| `registry` | PASS | list/add/remove/prune subcommands |
| `watch` | PASS | Starts, watches for changes |
| `mcp` | PASS | Server initializes correctly via JSON-RPC |

## Bugs Found

### 1. `structure .` returns empty results (Medium severity)

- `codegraph structure .` → "No directory structure found"
- `codegraph structure` (no arg) → works perfectly (18 directories)
- `codegraph structure src` → works correctly

**Root cause:** In `structureData()` (`src/structure.js`), passing `.` as the `directory` filter normalizes to `"."` and then filters `d.name === '.' || d.name.startsWith('./')` — which matches nothing since directory names stored in the DB are relative paths like `src`, `tests`, etc.

**Fix:** Treat `.` (or current dir equivalent) as `null`/no filter in `structureData()`.

> **FIXED** — `structureData()` now normalizes the directory argument and treats `"."` as null/no filter. (`src/structure.js`)

### 2. Stale embeddings after rebuild (Medium severity)

- After an incremental `build`, embedding `node_id`s become orphaned (e.g. old IDs in 3077-range, new IDs in 4335-range)
- `search` returns 0 results even at `--min-score 0.05` because no embeddings join to current nodes
- Verified: 310 embeddings existed but 0 matched any node in the `nodes` table

**Root cause:** `build` deletes and re-inserts nodes (getting new auto-increment IDs) but does not invalidate or rebuild embeddings.

**Fix:** Either preserve node IDs across rebuilds, invalidate embeddings when node IDs change, or warn the user to re-run `embed`.

> **FIXED** — Build now invalidates embeddings alongside nodes. Full builds clear the embeddings table entirely. Incremental builds delete embeddings for affected files before deleting their nodes (order matters — need node IDs to find them). After the build, any remaining orphaned embeddings trigger a warning: `"N embeddings are orphaned (nodes changed). Run codegraph embed to refresh."` (`src/builder.js`)

### 3. `embed` default model requires HuggingFace auth (Medium severity)

- `codegraph embed .` crashes with `Error: Unauthorized access to file` for the default `jina-code` model
- The Jina model is gated on HuggingFace and requires an `HF_TOKEN` environment variable
- `codegraph embed . --model minilm` works fine (public model)
- The error is an unhandled exception with a full stack trace — not user-friendly

**Fix:** Either default to a public model (e.g. `minilm`), auto-fallback to `minilm` on auth failure, or catch the error and provide a clear message with instructions.

> **FIXED** — Default model changed from `nomic-v1.5` (gated, requires HF_TOKEN) to `minilm` (public, 23MB, always works). Additionally, `loadModel()` now catches auth/download failures and prints a clear message with options (set HF_TOKEN or use `--model minilm`) instead of crashing with a raw stack trace. (`src/embedder.js`, `src/cli.js`)

### 4. Cross-language false positive in export (Low severity)

- One low-confidence (0.3) call edge: `main` (build.rs) → `setup` (tests/unit/structure.test.js)
- Shows up in Mermaid/DOT exports as a spurious connection
- Only 1 instance found across the entire graph

**Fix:** Export commands could support a `--min-confidence` filter, or the default export could exclude edges below a threshold (e.g. 0.5).

> **FIXED** — Added `--min-confidence <score>` option to the `export` command (default: 0.5). All three formats (DOT, Mermaid, JSON) filter edges by confidence at the SQL level. The 0.3-confidence false positive is excluded by default. Users can pass `--min-confidence 0` to include all edges. (`src/export.js`, `src/cli.js`)

## `--no-tests` Flag

Tested on `stats` and `map` — both correctly filter out test files:
- `stats --no-tests`: 427 nodes (vs 527 total), 59 files (vs 92)
- `map --no-tests`: excludes test files from ranking

## Embedding & Search

- `embed --model minilm` successfully generated 392 embeddings (384d)
- `search "build graph"` returned 15 results after fresh embeddings (top hit: 37.9% `test_triangle_cycle`)
- Search quality is reasonable but not ideal — `buildGraph` itself didn't appear in results for "build graph"

> **FIXED** — Embedding text now includes a readable split of the identifier name (e.g. `buildGraph` → `"function buildGraph (build Graph) in src/builder.js"`). This lets the model naturally associate "build graph" queries with `buildGraph` without needing hybrid search. camelCase, PascalCase, snake_case, and kebab-case are all handled. (`src/embedder.js`)
