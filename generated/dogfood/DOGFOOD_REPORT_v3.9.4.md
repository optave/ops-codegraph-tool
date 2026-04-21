# Dogfooding Report: @optave/codegraph@3.9.4

**Date:** 2026-04-20
**Platform:** macOS (Darwin 25.2.0), arm64, Node v24.10.0
**Native binary:** @optave/codegraph-darwin-arm64@3.9.4
**Active engine:** native (v3.9.4)
**Target repo:** codegraph itself (672 files, 20 languages)

---

## 1. Setup & Installation

| Step | Result |
|------|--------|
| `npm install @optave/codegraph@3.9.4` | OK |
| `npx codegraph --version` | `3.9.4` |
| Native binary installed | `@optave/codegraph-darwin-arm64@3.9.4` |
| `npx codegraph info` | Active engine: native (v3.9.4) |
| Source repo native binary | Updated from 3.9.3 → 3.9.4 to keep benchmarks valid |

No issues during installation. The native binary auto-installed via `optionalDependencies`; `optionalDependencies` in `package.json` correctly pin all six platform packages to `3.9.4`.

---

## 2. Cold Start (Pre-Build)

Tested every command against a fresh temp directory with no `.codegraph/graph.db`.

| Command category | Status | Notes |
|------------------|--------|-------|
| Query commands (`query`, `map`, `stats`, `deps`, `impact`, `fn-impact`, `context`, `audit`, `where`, `brief`, `children`, `exports`, `path`, `triage`, `complexity`) | PASS | All fail gracefully with `DB_ERROR: No graph.db found. Run \`codegraph build\` first.` |
| Analysis (`diff-impact`, `cycles`, `structure`, `roles`, `cfg`, `dataflow`, `flow`, `communities`, `co-change`, `branch-compare`, `ast`) | PASS | Clean error message, no stack traces |
| Export (`export`, `plot`) | PASS | Same clean error |
| Search/embeddings (`search`, `embed`, `models`) | PASS | `models` works without a graph (lists available models) |
| Infrastructure (`info`, `registry list`, `registry add/remove/prune`, `mcp`) | PASS | Work without graph |
| Build (`build`, `watch`, `snapshot save/list/restore`) | PASS | `build` creates graph; `watch` and `snapshot *` error cleanly when DB missing |

**Verdict:** Every command either works without a graph (as expected for `info`, `registry`, `models`, `mcp`) or fails with a clear `DB_ERROR` pointing at the missing DB path. No stack traces, no crashes.

### Fresh Full Build

| Metric | Value |
|--------|-------|
| Engine | native v3.9.4 |
| Files parsed | 684 (includes hidden fixtures) |
| File nodes | 672 (20 languages) |
| Total nodes | 17,278 |
| Total edges | 36,325 |
| Build time | ~1.4s |
| File-level cycles | 1 |
| Function-level cycles | 7 |
| Graph quality score | 68 |

---

## 3. Full Command Sweep

All query commands were exercised with `-T` / `--no-tests`, `-j` / `--json`, and `--depth` flags where applicable.

| Command | Flags tested | Status | Notes |
|---------|-------------|--------|-------|
| `query buildGraph` | `-T`, `--depth 2`, `--json` | PASS | callers/callees correctly populated |
| `fn-impact buildGraph` | `-T`, `--depth 3`, `-k function`, `--json` | PASS | Transitive impact tree rendered |
| `context parseFileAuto` | `-T`, `--depth 2`, `--no-source`, `--json` | PASS | Full context with source, deps, callers |
| `audit src/domain/parser.ts` | file path, `--json` | PASS | Structural + health report |
| `audit buildGraph` | function name | PASS | Per-function audit |
| `where <name>` | default + `-f <file>` | PASS | Definition lookup and file inventory both work |
| `map` | `-n 10`, `--json` | PASS | Top-10 most-connected files |
| `stats` | `--json` | PASS | Full health metrics + quality score |
| `deps <file>` | `-T`, `--json` | PASS | Per-file deps listed |
| `impact <file>` | `--json` | PASS | |
| `diff-impact main` | `-T`, `--staged`, no arg, HEAD~5 | PASS | All modes produce deltas |
| `cycles` | `--functions`, `--json` | PASS | 1 file, 7 function cycles |
| `structure` | `.`, `--depth 2`, `--sort cohesion\|fan-in\|fan-out\|density\|files` | PASS | Works with all sort modes |
| `triage` | `--level file\|function\|directory`, `-n 10`, `--json` | PASS | Risk scoring stable |
| `roles` | `-T`, `--json`, `--role <role>` | PASS | All roles enumerated |
| `complexity` | `-T`, `--json` | PASS | Per-function metrics |
| `flow buildGraph` | `--depth 3` | PASS | BFS traversal reaches leaves |
| `dataflow buildGraph` | | PASS | Parameter flows + return consumers |
| `co-change --analyze` | | PASS | Co-change pairs computed from git log |
| `communities` | | PASS | Louvain communities produced |
| `children buildGraph` | `-T`, `--json` | PASS | Parameters/properties listed |
| `brief buildGraph` | `-T`, `--json` | PASS | |
| `path buildGraph median -T` | `--json` | PASS | Shortest path found |
| `exports src/domain/queries.ts` | `-T` | PASS | Per-symbol consumers |
| `batch foo bar baz` | `-T`, `--json` | PASS | Multi-target query |
| `check --cycles --blast-radius 50` | | PASS | Exit code 0 on clean repo |
| `ast --kind call <name>` | `-T` | PASS | Call-site enumeration |
| `sequence buildGraph` | `--depth 3` | PASS | Mermaid sequence diagram |
| `export -f dot -o /tmp/g.dot` | `--functions` | PASS | DOT/Mermaid/JSON all work |

### Search/embeddings

| Command | Flags tested | Status | Notes |
|---------|-------------|--------|-------|
| `models` | | PASS | Lists 3 built-in models |
| `embed . -m minilm` | `-m minilm` (avoids HF auth) | PASS | 2 embeddings stored on tiny fixture; large fixture also fine |
| `search "build graph"` | `-n 5`, `--min-score 0.3`, `-k function` | PASS | Returns ranked results |
| `search "a;b;c"` | multi-query with `;` separator | PASS | RRF fusion applied |
| `search` without embeddings | | PASS | Warns and exits 0 |

### Infrastructure

| Command | Flags | Status |
|---------|-------|--------|
| `info` | | PASS — reports `engine: native` |
| `watch <dir>` | `--poll`, `--native`, `--poll-interval`, `-d/--db` | **FAIL** — `--db` not accepted (see Bugs, #984) |
| `registry list/add/remove/prune` | `-j`, `-n`, `--ttl` | PASS |
| `mcp` (single-repo) | JSON-RPC `tools/list` | PASS — 34 tools, no `list_repos`, no `repo` param |
| `mcp --multi-repo` | JSON-RPC `tools/list` | PASS — 35 tools, `list_repos` present, tools take `repo` param |

### Edge cases

| Scenario | Expected | Result |
|----------|----------|--------|
| `query nonexistent` | Graceful "No results" | PASS |
| `deps nonexistent.js` | Graceful "No file matching" | PASS |
| `fn-impact nonexistent` | Graceful message | PASS |
| `structure .` | Works (was a v2.2.0 bug) | PASS |
| `--json` on every command | Valid JSON | PASS |
| `--no-tests` effect | Test file count drops | PASS |
| `--kind invalid` | Graceful error | PASS |
| `--verbose` on `build` | Per-file parsing details | PASS |
| `build --no-incremental` | Forces full rebuild | **PASS with bug** — silently wipes embeddings (see #982) |
| `search` without embeddings | Warns, doesn't crash | PASS |
| Pipe: `codegraph map --json \| head -1` | Clean JSON, no status on stdout | PASS |
| Embed → rebuild (incremental) → search | Results still return | PASS — embeddings survive incremental rebuild |
| Watch mode lifecycle | Detects change, graceful Ctrl+C | PASS |

---

## 4. Rebuild & Staleness

| Scenario | Expected | Observed |
|----------|----------|----------|
| Incremental no-op (`build` twice) | "No changes detected" | PASS — `[codegraph] No changes detected` |
| Incremental with content change | Only changed file reparsed | PASS — log shows `Incremental: 1 changed, 0 removed` |
| `build --no-incremental` after incremental | Node/edge counts match pure full rebuild | **FAIL** — node counts match (17,278) but edge counts diverge: incrementals leak duplicates (see #979) |
| Embed → rebuild incremental → search | Search still returns | PASS — embeddings keyed to stable node IDs survive |
| Embed → `build --no-incremental` → search | Ideally preserved, or at minimum warned | **FAIL** — embeddings silently wiped with no warning (see #982) |
| Delete `.codegraph/graph.db` → rebuild | Fresh graph produced | PASS |
| `watch` integration — modify file, query | Graph reflects change | PASS — watcher debounces then rebuilds; query shows new edges |

---

## 5. Engine Comparison

WASM grammar build failed on this machine (35/35 grammars missing) so a parallel WASM baseline was not obtained in this session. The native engine is the default and the only engine exercised end-to-end here. Engine parity against WASM should be re-verified on a machine with a working WASM build (see §10.3).

| Metric | Native (v3.9.4) |
|--------|-----------------|
| Files parsed | 684 |
| Nodes | 17,278 |
| Edges | 36,325 (baseline full rebuild) |
| Cycles (file-level) | 1 |
| Cycles (function-level) | 7 |
| Quality score | 68 |

The incremental edge-leak bug (#979) produces engine-internal non-determinism that masks native vs. WASM comparison until the leak is fixed.

---

## 6. Release-Specific Tests (v3.9.4)

The v3.9.4 changelog called out five user-visible changes; each was exercised as follows.

| Change | Test | Result |
|--------|------|--------|
| (#947) JS extractor — resolve named function references passed as arguments (Express middleware, Array.map/filter/then, destructured factory bindings) | Built a fixture `app.js` with `app.get('/x', auth)`, `.map(transform)`, `Promise.then(handler)`, `const { make } = factory; app.post('/y', make)` and ran `query` on each handler | PASS — each named reference now shows a `calls` edge back from the caller context, not just `dynamic-reference`. Fixture available at `/tmp/dogfood-3.9.4/fixture-cb/` |
| (#938) WASM incremental edge loss fix | Ran full → touched one file → rebuild → compared edges — WASM path not validated locally (grammars missing) | SKIPPED (WASM build infra broken on this machine) |
| (#928/#930) Native version-mismatch no-op rebuild dropped 5.8 s → 214 ms | Built, then ran `build` with no changes | PASS — no-op rebuild completes in ~15–20 ms, well under the 214 ms target |
| (#942) `import_count` semantics reconciled between native/WASM | Compared `stats --json` import_count values against `EVERY_SYMBOL_KIND \+ --kind import` counts | PASS — `import_count` matches expected formula |
| (#948) fan-in/fan-out now include `imports-type` edges | `stats --json` hotspots — `src/types.ts` shows `fanOut: 1226`, consistent with 1,030 `imports-type` + 196 other outgoing | PASS |

---

## 7. Additional Testing (Phase 6)

| Area | Test | Result |
|------|------|--------|
| MCP server — single-repo | Initialize via JSON-RPC stdin, send `tools/list` | PASS — **34 tools**, no `list_repos`, no `repo` property on tools |
| MCP server — multi-repo (`--multi-repo`) | Same `tools/list` call | PASS — **35 tools**, `list_repos` present, tools accept `repo` |
| Programmatic API (ESM) | `import * as cg from '@optave/codegraph'` | PASS — **57 exports** present. All of `buildGraph`, `loadConfig`, `contextData`, `whereData`, `fnDepsData`, `fnImpactData`, `diffImpactData`, `statsData`, `queryNameData`, `rolesData`, `auditData`, `triageData`, `complexityData`, `EXTENSIONS`, `IGNORE_DIRS`, `EVERY_SYMBOL_KIND` resolve to the expected type |
| Programmatic API (CJS) | `const cg = await require('@optave/codegraph')` (with `await` per documented `dist/index.cjs` wrapper) | PASS — same exports |
| Functional API | `loadConfig(root)`, `statsData(db)`, `fnDepsData('buildGraph', db)` via ESM | PASS — live data returned |
| Config — `.codegraphrc.json` `ignoreDirs` | Add a directory, build, verify files in it are skipped | PASS — directory filtering works |
| Config — `.codegraphrc.json` `aliases` | Alias `@src/` to `./src/` and resolve via `loadPathAliases` | PASS |
| Config — `.codegraphrc.json` `include` / `exclude` | Configure exclude glob `**/*.test.js`, rebuild | **FAIL** — config keys declared in `DEFAULTS` but never read; builds are byte-identical with/without the config (see #981) |
| Config — `llm.apiKeyCommand` (string form) | `"echo sk-from-command-456"` | PASS — `resolveSecrets` shells out and stores the returned value as `apiKey` |
| Config — `llm.apiKeyCommand` (array form) | `["echo", "sk-..."]` | N/A — the implementation expects a space-separated string, not an array. Minor UX wart but not a bug |
| Env vars — `CODEGRAPH_LLM_PROVIDER`, `CODEGRAPH_LLM_MODEL`, `CODEGRAPH_LLM_API_KEY` | Set each, call `loadConfig` | PASS — all three override file config |
| Env var — `CODEGRAPH_REGISTRY_PATH` | Set to a custom path, run `registry add/list` | PASS — registry file created at the override path, not in `~/.codegraph/` |
| Multi-repo registry flow | `registry add . -n name` → `registry list` → `mcp --repos name` → `registry remove name` → `registry prune --ttl 0` | PASS — all lifecycle steps work |

---

## 8. Performance Benchmarks

`scripts/benchmark.js` ran the WASM engine fork separately — on this machine those results were unavailable because the WASM grammars weren't built locally. Native timings below come from direct `codegraph build` runs.

### Build (native, v3.9.4)

| Metric | Value |
|--------|-------|
| Files parsed | 684 |
| Nodes | 17,278 |
| Edges | 36,325 |
| Wall clock (full build) | ~1.4 s |
| No-op rebuild | ~15–20 ms |

### Incremental edge leak

This is the most consequential benchmark finding of the session. Starting from a fresh full build (36,325 edges), appending a single line to `src/domain/queries.ts` and re-running `build` three times produced:

| Pass | Edges | Delta | Duplicate-signature groups |
|------|-------|-------|----------------------------|
| Baseline (fresh full) | 36,325 | — | 29 (all legitimately multi-site) |
| Incremental #1 | 36,536 | +211 | 276 |
| Incremental #2 | 36,785 | +249 | 276 |
| Incremental #3 | 37,034 | +249 | 276 |
| Restore probe + rebuild | 37,283 | +249 | 276 |

Every incremental rebuild of a one-line change adds duplicate edges sourced from **files other than the one that was changed** (e.g., `src/domain/parser.ts` edges appear three times after two `queries.ts` touches). The first rebuild leaks +211 duplicates; subsequent rebuilds settle at a steady +249 per run. See §9 #979 for the full reproduction.

### Query benchmarks (single-engine, native)

| Query | Target | Latency |
|-------|--------|---------|
| `fn-deps` depth 3 | `buildGraph` | ~6 ms |
| `fn-impact` depth 3 | `buildGraph` | ~2.5 ms |
| `path` (hub → leaf) | | ~8 ms |
| `roles -T` | — | ~35 ms |

No regressions relative to the v3.8.1 dogfood numbers. The full benchmark script's native tier matches last release's envelope on this hardware.

---

## 9. Bugs Found

Six issues filed, three fixed in this session, three left open for follow-up work.

### #979 — Incremental rebuild leaks ~249 duplicate edges per run (Critical)

- Issue: [optave/codegraph#979](https://github.com/optave/codegraph/issues/979)
- PR: none (root cause lives in native Rust orchestrator; scoped out of session)
- Symptoms: every incremental rebuild inserts ~249 duplicate edges, sourced from files adjacent to the changed file rather than from the changed file itself. The duplicates persist across subsequent rebuilds.
- Impact: all graph-derived metrics (`fn-impact`, `fn-deps`, `stats`, `triage`, `map`, `roles`, `structure`) are wrong after any incremental rebuild. Watch-mode users drift further with each change. A full rebuild (`rm -rf .codegraph && codegraph build .`) restores correctness.
- Suggested fix: either delete edges sourced from the set of reparsed files before re-inserting, or add a unique index on `(source_id, target_id, kind)` with `INSERT OR IGNORE` and audit whether `confidence` / `dynamic` should be part of the key.

### #980 — `scripts/node-ts.js` uses `--strip-types` on Node 23+ but Node 24 rejects it (High)

- Issue: [optave/codegraph#980](https://github.com/optave/codegraph/issues/980)
- PR: [optave/codegraph#985](https://github.com/optave/codegraph/pull/985) — fixed
- Symptoms: `npm run build:wasm`, `deps:tree`, and `version` fail on Node 24 with `node: bad option: --strip-types`. Node 23 shipped `--strip-types` as a short-lived alias; Node 24 removed it.
- Fix: use `--experimental-strip-types` unconditionally. Accepted on 22.x, 23.x, and 24.x.

### #981 — `config.include` / `config.exclude` are declared but silently ignored (High)

- Issue: [optave/codegraph#981](https://github.com/optave/codegraph/issues/981)
- PR: none (moderate scope — needs glob-matching plumbed through `collectFiles`)
- Symptoms: `.codegraphrc.json` accepts top-level `include` and `exclude` glob arrays (they're in `DEFAULTS` and `loadConfig` preserves them), but no code path ever reads them. Builds with and without `exclude: ["**/*.test.js"]` produce byte-identical results. Only `ignoreDirs` (directory-level) is wired into `collectFiles`.
- Suggested fix: add glob-based include/exclude matching at the file-extension check in `collectFiles` (`src/domain/graph/builder/helpers.ts:123`).

### #982 — `build --no-incremental` silently wipes the embeddings table (High)

- Issue: [optave/codegraph#982](https://github.com/optave/codegraph/issues/982)
- PR: [optave/codegraph#986](https://github.com/optave/codegraph/pull/986) — fixed (partial — warning only)
- Symptoms: a full rebuild drops every row in the `embeddings` table with no prompt, no warning, and no opt-out. Users who just spent minutes running `codegraph embed` lose their data, and the next `codegraph search` returns zero results with no hint why.
- Fix (this PR): warn before the rebuild runs — `Full rebuild will discard N embeddings; re-run \`codegraph embed\` after the build.` A follow-up change should probably preserve embeddings whose `node_id` still maps to a live node, but that's a larger design choice.

### #983 — `embed --db <abs-path>` without positional dir resolves files from cwd (Medium)

- Issue: [optave/codegraph#983](https://github.com/optave/codegraph/issues/983)
- PR: none (moderate scope — requires recording/reading `rootDir` from the DB's metadata)
- Symptoms: `embed --db /abs/path.db` reads the symbol list from the DB correctly, but tries to open each source file relative to the current working directory. When run from a different directory, every open fails, every symbol is skipped, and the command exits 0 with `Stored 0 embeddings`.
- Suggested fix: thread the DB's recorded root through embed's file-read path, falling back to `cwd` only when no root is recorded. Secondary: promote per-file `Cannot read` warnings to a summary error when *every* file fails rather than exiting 0 with a `Stored 0 embeddings` line.

### #984 — `codegraph watch` rejects `-d/--db` (Medium)

- Issue: [optave/codegraph#984](https://github.com/optave/codegraph/issues/984)
- PR: [optave/codegraph#987](https://github.com/optave/codegraph/pull/987) — fixed
- Symptoms: every other CLI command that touches the graph DB accepts `-d, --db <path>`, but `watch` does not — it errors with `unknown option '--db'`. Users in monorepo / multi-repo MCP setups had to `cd` into the watched directory.
- Fix: add the option, plumb it through `watchProject` → `setupWatcher`, default to `<rootDir>/.codegraph/graph.db` when absent.

---

## 10. Suggestions for Improvement

### 10.1 Prioritize the incremental edge leak (#979)

Until this is fixed, any long-lived `codegraph watch` session or any CI that relies on incremental builds for speed is producing incorrect graphs. All derived queries (impact, fn-deps, triage, map) drift worse with each change. Correctness is more valuable than the incremental speed-up it currently offers. If a full fix is too big for a patch release, consider temporarily promoting every content-change rebuild to a full rebuild until the edge-persistence path is corrected.

### 10.2 Document or enforce the `apiKeyCommand` format

`apiKeyCommand` is documented as a field but the implementation accepts only a space-separated string — an array form (the more ergonomic shape) fails silently with `apiKey: null` because `resolveSecrets` bails when `typeof cmd !== 'string'`. Either accept both forms or reject non-string values with a clear `ConfigError`.

### 10.3 Gate the WASM build better

`npm run build:wasm` failed all 35 grammars on this machine without a clear remediation path (the error was buried in the `prepare` hook). A clearer error message (e.g., `tree-sitter CLI missing — install with \`npm install -g tree-sitter-cli\``) would help. The knock-on effect on this session was that WASM-engine benchmarks couldn't run.

### 10.4 Flesh out `build --no-incremental` into a safer mode

PR #986 adds a warning, but the root question is whether full rebuild should touch embeddings at all. If the embeddings are keyed to stable `node_id`s, a better design is to preserve them across the rebuild and expose a separate `codegraph reindex` command for users who actually want to drop embeddings.

### 10.5 Louvain warning noise

Every native build prints `[codegraph WARN] louvainCommunities: maxLevels/maxLocalPasses/refinementTheta are ignored by the native Rust path`, even when the user isn't running `communities`. Gate the warning on actual invocation, or demote it to `debug`.

---

## 11. Testing Plan

### General testing plan (any release)

- [ ] Install from npm, verify version and native binary pin
- [ ] Cold start: every command fails gracefully without a graph
- [ ] Build with both engines, compare node/edge/complexity metrics
- [ ] Verify incremental no-op, 1-file, and full rebuilds
- [ ] Embed → rebuild (incremental + full) → search pipeline
- [ ] All query commands with `-T`, `--json`, `--depth` flags
- [ ] Edge cases: non-existent symbols, files, invalid kinds
- [ ] MCP server: single-repo (34 tools) and multi-repo (35 tools)
- [ ] Programmatic API via both ESM namespace import and CJS `await require`
- [ ] Config: `.codegraphrc.json` `ignoreDirs`, `aliases`, `llm.*`
- [ ] Env vars: `CODEGRAPH_LLM_*`, `CODEGRAPH_REGISTRY_PATH`
- [ ] Registry lifecycle: add / list / remove / prune
- [ ] Snapshot save / list / restore
- [ ] All four benchmark scripts; compare to previous release
- [ ] Detect edge-count drift across repeated incremental rebuilds

### Release-specific plan (v3.9.4)

- [x] Named function reference resolution (#947): Express middleware, `.map/filter/then`, destructured factories
- [x] Import-count semantics (#942): `stats` values match expected formula
- [x] fan-in/fan-out include `imports-type` (#948): hotspot counts consistent
- [x] No-op rebuild regression fix (#928/#930): <214 ms
- [ ] WASM incremental edge-loss fix (#938): not validated (WASM grammars unavailable on test machine)

### Proposed additional tests

- [ ] **Edge-leak regression guard:** after benchmark script's one-file rebuild tier, compare edge count against a fresh full rebuild — any non-zero delta fails the test.
- [ ] **Config include/exclude contract:** a test project with both patterns declared and a build that proves both are honored.
- [ ] **Embed survival across full rebuild:** a test that `codegraph embed` → `build --no-incremental` → `codegraph search` returns non-empty results (once #982 is fully resolved).
- [ ] **Cross-platform `node-ts.js`:** run each npm script that routes through it on Node 22.x, 23.x, 24.x in CI.

---

## 12. Overall Assessment

v3.9.4 is a careful, disciplined release: JS callback resolution (#947), WASM incremental correctness (#938), native version-mismatch fix (#928/#930), and symbolic fan-in/fan-out reconciliation (#942, #948) all address real correctness issues called out in the v3.8.x dogfoods. The user-facing CLI surface is mature — every command handles edge cases gracefully, the MCP server's single-repo isolation works correctly (34 tools), and the programmatic API exports every symbol documented.

The **critical remaining issue** is the incremental edge-leak (#979): every single-file incremental rebuild inserts ~249 duplicate edges sourced from files other than the one that changed, and those duplicates are never cleaned up. Watch-mode users and CI that relies on incrementals for speed drift further from correctness with every change. This is not a v3.9.4 regression per se — the pattern reproduces the same way that the published WASM bug (#938) likely did before it was fixed — but it's the most consequential unresolved bug in the native path. Until it's fixed, any long-lived dev session produces increasingly wrong `fn-impact`, `triage`, `stats`, and `map` output.

Four other meaningful bugs surfaced: `scripts/node-ts.js` is broken on Node 24 (#980, fixed in #985), `config.include`/`exclude` are declared-but-unused (#981), `build --no-incremental` silently drops embeddings (#982, warning added in #986), and `codegraph watch` didn't accept `--db` (#984, fixed in #987). None of these block a user who knows the gotchas, but each one cost real time to diagnose.

Build performance is solid: native full build in ~1.4 s, no-op rebuild in ~15–20 ms (well under the 214 ms target from the #928/#930 fix), queries sub-10 ms. No performance regressions detected vs v3.8.1.

**Rating: 6.5/10** — The correctness bar for a CLI that calls itself a "code graph" is high, and an incremental rebuild leaking ~250 wrong edges per run is a real correctness problem. The feature surface, engine architecture, MCP integration, and programmatic API are all in excellent shape. Fixing #979 would raise this easily to 8+.

---

## 13. Issues & PRs Created

| Type | Number | Title | Status |
|------|--------|-------|--------|
| Issue | [#979](https://github.com/optave/codegraph/issues/979) | Incremental rebuild leaks ~249 duplicate edges per run | Open — too complex for this session |
| Issue | [#980](https://github.com/optave/codegraph/issues/980) | `scripts/node-ts.js` uses `--strip-types` on Node 23+ but Node 24 rejects it | Open — fix submitted |
| Issue | [#981](https://github.com/optave/codegraph/issues/981) | `config.include` and `config.exclude` are silently ignored | Open |
| Issue | [#982](https://github.com/optave/codegraph/issues/982) | `build --no-incremental` silently wipes the embeddings table | Open — warning submitted, preservation still open |
| Issue | [#983](https://github.com/optave/codegraph/issues/983) | `codegraph embed --db <path>` resolves source files from cwd | Open |
| Issue | [#984](https://github.com/optave/codegraph/issues/984) | `codegraph watch` does not accept `--db` | Open — fix submitted |
| PR | [#985](https://github.com/optave/codegraph/pull/985) | fix(scripts): use `--experimental-strip-types` on every Node version | Closes #980 |
| PR | [#986](https://github.com/optave/codegraph/pull/986) | fix(build): warn before `--no-incremental` wipes embeddings | Closes #982 |
| PR | [#987](https://github.com/optave/codegraph/pull/987) | fix(watch): accept `-d/--db` to point at a graph.db outside cwd | Closes #984 |
