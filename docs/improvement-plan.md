# Codegraph v2.0.0 Improvement Plan

Results from dogfooding codegraph on itself (February 2026). Includes bugs found, fixes applied, and strategic improvement recommendations.

---

## Bugs Found & Fixed

### Fixed in this session

| # | Severity | Bug | Fix |
|---|----------|-----|-----|
| 1 | **CRITICAL** | Native Rust engine produces 0 import edges — `resolveImport` returns `"src/./db.js"` instead of `"src/db.js"` | Fixed in Rust (`import_resolution.rs`) via `Path::components().collect()` normalization + JS-side `path.normalize()` wrapper in `resolve.js` as defense-in-depth |
| 2 | **HIGH** | `--version` reports `1.3.0` instead of `2.0.0` — hardcoded in `cli.js:35` | Read version from `package.json` dynamically |
| 3 | **MEDIUM** | `resolveViaAlias` crashes on `node:` prefixed imports when `aliases.paths` is null | Added null guard: `Object.entries(aliases.paths \|\| {})` |
| 4 | **MEDIUM** | Registry polluted with 30+ dead temp directory entries from tests | Added `skipRegistry` option to `buildGraph`; integration tests now pass `skipRegistry: true`; CLI tests call `pruneRegistry()` in `afterAll` |
| 5 | **LOW** | `git diff` usage spam in test output (hundreds of lines of stderr) | Added `.git` directory check before running `git diff` in `diffImpactData`; returns clean error `"Not a git repository"` instead; suppressed stderr via `stdio: ['pipe','pipe','pipe']` |

---

## Graph Health Snapshot

| Metric | Value |
|--------|-------|
| Files parsed | 74 |
| Symbols (nodes) | 426 |
| Edges total | 1,570 |
| Import edges | 80 |
| Reexport edges | 15 |
| Call edges | ~1,390 |
| File-level cycles | 0 |
| Function-level cycles | 1 (findPythonParentClass <-> walk in parser.js) |

### Module coupling (top 10)

| File | Fan-in | Fan-out | Notes |
|------|--------|---------|-------|
| db.js | 16 | 1 | Most-imported module |
| parser.js | 15 | 2 | Second most-imported; 2200+ line monolith |
| logger.js | 12 | 0 | Pure leaf (no imports) |
| native.js | 11 | 0 | Pure leaf |
| builder.js | 7 | 7 | Orchestrator; highest fan-out |
| constants.js | 7 | 1 | Widely used |
| resolve.js | 6 | 2 | |
| cycles.js | 5 | 1 | |
| queries.js | 5 | 1 | |
| config.js | 4 | 1 | |

---

## Improvement Plan

### P0 — Critical (fix before next release)

All P0 items have been fixed in this session:

- **Native engine path normalization** — Fixed in both Rust (`import_resolution.rs`: `Path::components().collect()`) and JS (`resolve.js`: `path.normalize()` wrapper). Import edges now correctly resolve with both engines.
- **Version string** — `cli.js` now reads from `package.json` dynamically.
- **Registry pollution** — Tests no longer pollute the global registry.
- **Git diff noise** — Clean error handling for non-git directories.

---

### P1 — High priority (next 1-2 releases)

#### 3. Split parser.js into per-language extractors
**Found by:** `codegraph deps src/parser.js` (fan-in 15), `codegraph cycles --functions` (1 cycle)

`parser.js` is a 2200+ line file with 47 function definitions. Each language extractor has its own `walk()` function, creating ambiguous function names in the graph. The Rust engine already has this structure (`crates/codegraph-core/src/extractors/`).

**Action:** Create `src/extractors/` directory with one file per language:
```
src/extractors/
  javascript.js    # JS/TS/TSX
  python.js
  go.js
  rust.js
  java.js
  csharp.js
  ruby.js
  php.js
  hcl.js
```

Keep `LANGUAGE_REGISTRY` in `parser.js` but import extractors from the new files.

**Benefits:**
- Resolves the `findPythonParentClass <-> walk` function-level cycle
- Disambiguates function names for codegraph's own analysis
- Each extractor becomes independently testable
- Aligns with Rust codebase structure

#### 4. Clean up stale registry entries
**Found by:** `codegraph registry list` (30+ dead temp dir entries)

Integration tests register temp directories that are never cleaned up. The registry grows unbounded.

**Action:**
- Add `registry prune` command (or make existing `pruneRegistry` accessible via CLI) to remove entries with missing DBs
- Add `afterAll` cleanup in integration test fixtures
- Consider adding a TTL or auto-prune on `registry list`
- Optionally: skip registry for paths under `$TMPDIR`/`os.tmpdir()`

#### 5. Improve search relevance for own codebase
**Found by:** `codegraph search "build dependency graph"` — top results were Rust extractors' `walk_node`, not `buildGraph`

The search query "build dependency graph" should rank `buildGraph` (src/builder.js:142) in the top 3, but it didn't appear at all. The default embedding model (minilm) may not understand code-specific semantics well enough.

**Action:**
- Run `codegraph embed --model jina-code` to use the code-aware embedding model and compare results
- Consider making `jina-code` the recommended default for code repositories
- Explore prepending function context (file path, kind) to the embedding input for better disambiguation

---

### P2 — Medium priority (next 2-3 releases)

#### 6. Guard `git diff` in non-repo contexts
**Found by:** Test output noise from `diff-impact` tests

When `diff-impact` runs in a non-git directory (e.g., temp dirs during tests), `git diff` prints its full usage help to stderr. This is noisy but doesn't fail tests.

**Action:** Check for `.git` directory or run `git rev-parse --git-dir` before calling `git diff`. Return a clear error message instead of letting git dump its help text.

#### 7. Add a `codegraph stats` command
**Found by:** Dogfooding — no single command shows graph health overview

Currently you need to run `map`, `cycles`, and read build output separately to assess graph health.

**Action:** Add `codegraph stats` that shows:
- Node/edge counts by kind
- File count and language distribution
- Cycle count (file + function level)
- Top 5 coupling hotspots
- Embedding status (model, count, staleness)

#### 8. Improve map command ranking
**Found by:** `codegraph map --limit 20` (WASM build)

When Rust files are parsed, the map is dominated by Rust extractor files (all with `inEdges: 1, outEdges: 0`). The ranking should prioritize files with meaningful import relationships over files with only `contains` edges.

**Action:** Weight import/reexport edges higher than `contains` edges in the `map` ranking algorithm. Consider filtering out files below a minimum edge threshold.

#### 9. builder.js fan-out reduction
**Found by:** `codegraph map` (fan-out 7, highest in codebase)

`builder.js` imports from 7 modules: config, constants, db, logger, parser, resolve, structure. As the build orchestrator this is somewhat expected, but the `structure.js` integration (already lazy-loaded via dynamic import) pattern could apply to other optional post-build steps.

**Action:** Consider lazy-loading `config.js` (only needed once at build start) and `resolve.js` (only needed during edge building).

---

### P3 — Low priority (future consideration)

#### 10. Improve test isolation for registry
Tests should not pollute the global `~/.codegraph/registry.json`. Consider using `XDG_DATA_HOME` or a test-specific registry path.

#### 11. Native engine fallback transparency
When the native engine is requested but unavailable, the warning is logged but easy to miss. Consider a more prominent indicator in the build output, or make `--engine native` fail hard instead of silently falling back.

#### 12. Embed and search as CI validation
Add an optional CI step that runs `codegraph embed` + `codegraph search` against known queries and validates that key functions appear in the top N results. This would catch embedding regressions.

#### 13. Python search improvements
`codegraph search` for Python-related queries could be improved if the `extractPythonSymbols` function names were more descriptive (currently `walk` is ambiguous across all language extractors).

---

## Testing Summary

| Test Suite | Result |
|-----------|--------|
| All tests | 367 passed, 43 skipped |
| `build` | Works (both WASM and native) |
| `cycles` | Works (0 file-level, 1 function-level) |
| `map` | Works (correct ranking with WASM) |
| `query` | Works |
| `deps` | Works with WASM; broken with native (fixed with JS workaround) |
| `impact` | Works with WASM; broken with native (fixed with JS workaround) |
| `fn` / `fn-impact` | Works |
| `diff-impact` | Works |
| `export` (dot/mermaid/json) | Works |
| `embed` | Works (310 symbols embedded) |
| `search` | Works (single + multi-query) |
| `models` | Works |
| `registry` | Works (but polluted with dead entries) |
| `--version` | Fixed (was 1.3.0, now reads from package.json) |
| Lint (biome) | Clean after format |

---

## Commands Used for This Analysis

```bash
# Install and verify
npm install -g @optave/codegraph@2.0.0

# Build graph
codegraph build .
node src/cli.js build . --no-incremental --engine wasm

# Test all commands
codegraph cycles
codegraph cycles --functions
codegraph map --limit 20
codegraph query buildGraph
codegraph deps src/builder.js
codegraph impact src/parser.js
codegraph fn buildGraph --no-tests
codegraph fn-impact buildGraph --no-tests
codegraph diff-impact main
codegraph export -f dot
codegraph export -f mermaid
codegraph export -f json
codegraph embed
codegraph search "build dependency graph"
codegraph search "parse source code; extract symbols"
codegraph models
codegraph registry list
```
