# PR Review Comment Taxonomy

> Analysis of **1,017** inline review comments across **300 PRs** (PR #431 -- #789)
> 
> Date: 2026-04-03 | Coverage: **100%** categorized

## Priority Distribution

| Priority | Count | % |
|----------|------:|--:|
| P0 | 2 | 0.2% |
| P1 | 355 | 34.9% |
| P2 | 521 | 51.2% |
| P3/unmarked | 139 | 13.7% |
| **Total** | **1017** | **100%** |

## Category Summary

| # | Category Group | Count | % | P0 | P1 | P2 |
|--:|---------------|------:|--:|---:|---:|---:|
| 1 | **Bug** | 321 | 31.6% | 1 | 140 | 140 |
| 2 | **Security** | 15 | 1.5% | 0 | 1 | 9 |
| 3 | **Type Safety** | 49 | 4.8% | 0 | 11 | 36 |
| 4 | **Engine Parity** | 27 | 2.7% | 0 | 11 | 12 |
| 5 | **Performance** | 33 | 3.2% | 0 | 6 | 23 |
| 6 | **Dead Code & Unused** | 32 | 3.1% | 0 | 8 | 19 |
| 7 | **Architecture** | 175 | 17.2% | 0 | 41 | 104 |
| 8 | **Testing** | 42 | 4.1% | 1 | 10 | 14 |
| 9 | **Documentation** | 111 | 10.9% | 0 | 31 | 62 |
| 10 | **Database** | 7 | 0.7% | 0 | 3 | 3 |
| 11 | **Process** | 38 | 3.7% | 0 | 17 | 19 |
| 12 | **Titan Pipeline** | 55 | 5.4% | 0 | 23 | 25 |
| 13 | **Stale / Outdated References** | 52 | 5.1% | 0 | 18 | 27 |
| 14 | **Shell Script** | 48 | 4.7% | 0 | 20 | 22 |
| 15 | **Display / Output** | 9 | 0.9% | 0 | 3 | 5 |
| 16 | **Other** | 3 | 0.3% | 0 | 1 | 2 |

## Key Insights

### Top 15 Subcategories

| # | Subcategory | Count | % |
|--:|------------|------:|--:|
| 1 | Bug / Silent Failure & No-Op | 76 | 7.5% |
| 2 | Bug / Incorrect Logic | 72 | 7.1% |
| 3 | Titan Pipeline / Procedure Gap | 55 | 5.4% |
| 4 | Architecture / Duplication & Overlap | 52 | 5.1% |
| 5 | Stale / Outdated References | 52 | 5.1% |
| 6 | Bug / Null / Undefined / NaN / Division-by-Zero | 48 | 4.7% |
| 7 | Shell Script / Check Logic Bug | 48 | 4.7% |
| 8 | Documentation / Inaccurate Claim | 39 | 3.8% |
| 9 | Dead Code & Unused | 32 | 3.1% |
| 10 | Architecture / Missing Validation or Guard | 30 | 2.9% |
| 11 | Documentation / Numbering & Scoring Errors | 29 | 2.9% |
| 12 | Engine Parity / Native vs WASM Divergence | 27 | 2.7% |
| 13 | Bug / Path & Platform Compatibility | 25 | 2.5% |
| 14 | Type Safety / Unsafe Cast or any | 23 | 2.3% |
| 15 | Architecture / Inconsistent Behavior | 21 | 2.1% |

### Most Commented Files

| File | Comments |
|------|--------:|
| `.claude/skills/create-skill/SKILL.md` | 64 |
| `.claude/skills/create-skill/scripts/lint-skill.sh` | 48 |
| `.claude/skills/titan-run/SKILL.md` | 40 |
| `.claude/skills/titan-gate/SKILL.md` | 35 |
| `.claude/skills/review/SKILL.md` | 27 |
| `.claude/skills/titan-forge/SKILL.md` | 25 |
| `.claude/skills/bench-check/SKILL.md` | 23 |
| `docs/roadmap/ROADMAP.md` | 22 |
| `generated/competitive/COMPETITIVE_ANALYSIS.md` | 22 |
| `docs/roadmap/BACKLOG.md` | 18 |
| `src/graph/algorithms/leiden/optimiser.js` | 15 |
| `docs/tasks/PLAN_centralize_config.md` | 14 |
| `.claude/skills/deps-audit/SKILL.md` | 14 |
| `.claude/skills/housekeep/SKILL.md` | 14 |
| `src/presentation/result-formatter.js` | 14 |
| `src/domain/parser.ts` | 13 |
| `tests/unit/db.test.js` | 11 |
| `docs/guides/adding-a-language.md` | 10 |
| `src/types.ts` | 10 |
| `.claude/skills/test-health/SKILL.md` | 9 |

### PRs with Most Comments

| PR | Comments |
|---:|--------:|
| #587 | 112 |
| #557 | 100 |
| #565 | 59 |
| #559 | 26 |
| #558 | 26 |
| #545 | 20 |
| #461 | 18 |
| #554 | 16 |
| #595 | 15 |
| #588 | 15 |
| #482 | 14 |
| #444 | 14 |
| #457 | 13 |
| #591 | 12 |
| #568 | 12 |
| #580 | 12 |
| #553 | 11 |
| #581 | 11 |
| #582 | 10 |
| #434 | 9 |

---

## Detailed Breakdown

### Bug (321 comments)

#### Silent Failure & No-Op (76) &mdash; P1: 37 | P2: 28 | unknown: 11

<details>
<summary>Show 76 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #745 | Method hierarchy callers silently dropped when native engine is active | P1 | `dependencies.ts` |
| #737 | WAL checkpoint result silently ignored | P1 | `insert-nodes.ts` |
| #732 | Isolated start nodes silently dropped by native path | P1 | `bfs.ts` |
| #732 | Native path silently drops valid paths in undirected `CodeGraph` | P1 | `shortest-path.ts` |
| #653 | Silent data loss on bulk-insert failure — no JS fallback | P1 | `cfg.ts` |
| #653 | Silent data loss on bulk-insert failure — no JS fallback | P1 | `dataflow.ts` |
| #651 | Unconditional early return swallows Rust-side failures silently | P1 | `ast.ts` |
| #640 | `warn` silently downgraded to `debug` for path-alias parse failures | P1 | `helpers.ts` |
| #595 | Same silent-pass risk in complex patterns suite | P1 | `cfg-all-langs.test.ts` |
| #591 | `nativeHasCalls` check can silently drop calls from `symbols.calls` | P1 | `ast.ts` |
| #591 | PHP `scoped_call_expression` receiver silently dropped | P1 | `helpers.rs` |
| #587 | Pattern 1 "Correct" example silently fails when `.codegraph/deploy-check/` doesn't exist | P1 | `SKILL.md` |
| #587 | Indented ```bash blocks silently skipped by all checks | P1 | `lint-skill.sh` |
| #587 | `\s` is a GNU awk extension — silent failure on macOS BSD awk | P1 | `lint-skill.sh` |
| #587 | Unclosed bash block at EOF silently skipped | P1 | `smoke-test-skill.sh` |
| #580 | `--no-complexity` and `--no-cfg` flags silently dropped | P1 | `build.ts` |
| #565 | Success path silently discards pre-existing changes | P1 | `SKILL.md` |
| #565 | `git ls-files --others --exclude-standard` silently misses gitignored dirt files | P1 | `SKILL.md` |
| #565 | ABORTED + `--compare-only` + no baseline silently produces no report | P1 | `SKILL.md` |
| #557 | `$BARREL_TMP` cleanup will silently fail — same shell-persistence bug as the previously fixed `$TITA | P1 | `SKILL.md` |
| #557 | Process substitution `<(...)` is not portable — D4 will silently fail on non-bash shells | P1 | `SKILL.md` |
| #557 | D2 intent-match check fails silently for dead-code targets | P1 | `SKILL.md` |
| #557 | `node -e` script has no error handling — silent failure produces no `arch-snapshot.json` | P1 | `SKILL.md` |
| #557 | Step 5.5 capture block silently corrupts comparison files on command failure | P1 | `SKILL.md` |
| #557 | D4 temp file missing file extension — language detection silently fails | P1 | `SKILL.md` |
| #557 | Step 5d barrel temp file missing extension — `codegraph exports` silently returns nothing | P1 | `SKILL.md` |
| #557 | Stale `origin/main` silently produces wrong divergence count on fetch failure | P1 | `SKILL.md` |
| #557 | Step 5a silently no-ops for entirely new files | P1 | `SKILL.md` |
| #554 | `NODE_OPTIONS` silently discards pre-existing value | P1 | `vitest.config.js` |
| #553 | Silent failure when vitest binary is not found | P1 | `test.js` |
| #545 | `diffCPM` silently ignores edge weights for directed graphs | P1 | `cpm.js` |
| #542 | `purgeAncillaryData` silently swallows all exceptions | P1 | `incremental.js` |
| #540 | False-negative: `//` inside string literals silently skips real imports | P1 | `verify-imports.js` |
| #522 | Embedded interfaces in Go are silently skipped | P1 | `go.js` |
| #498 | Mixed glob + non-glob patterns silently break non-glob substring matching | P1 | `filters.js` |
| #497 | Silent empty result if graph was built without test files | P1 | `roles.js` |
| #491 | Scoped build log silently dropped for zero-reverse-dep case | P1 | `detect-changes.js` |
| #779 | Silent failure swallows auto-install error in non-TTY | P2 | `models.ts` |
| #778 | Conflicting `--poll` and `--native` flags are silently resolved | P2 | `watch.ts` |
| #771 | New `cfgCyclomatic <= 0` guard silently changes WASM-path behavior | P2 | `engine.ts` |
| #758 | Rust also writes `codegraph_version`; JS value silently wins | P2 | `pipeline.ts` |
| #735 | `heal_file_metadata` — per-entry failures silently committed as partial results | P2 | `native_db.rs` |
| #733 | `_langId` is not forwarded to native functions — non-standard extensions silently skip the native pa | P2 | `engine.ts` |
| #732 | `LouvainOptions.maxLevels`, `maxLocalPasses`, and `refinementTheta` silently ignored on native path | P2 | `louvain.ts` |
| #730 | Exception aliases silently skipped | P2 | `ocaml.ts` |
| #719 | Silent delete errors may mask partial state | P2 | `native_db.rs` |
| #671 | `has_cfg_tables` swallows all errors indiscriminately | P2 | `read_queries.rs` |
| #669 | Errors silently swallowed in bulk insert methods | P2 | `native_db.rs` |
| #600 | Leading `..` components are silently dropped on an empty base | P2 | `import_resolution.rs` |
| #598 | Startup `catch` swallows all errors with exit code 0 | P2 | `server.ts` |
| #595 | Silent `return` shows as "passed", not "skipped" | P2 | `cfg-all-langs.test.ts` |
| #595 | Silent pass when all native defs lack CFG blocks | P2 | `cfg-all-langs.test.ts` |
| #587 | Pattern 2 "Correct" example silently swallows git errors via `2>&1` | P2 | `SKILL.md` |
| #568 | Phase 5 deliverables silently dropped | P2 | `ROADMAP.md` |
| #565 | Auto-commit fails silently when baseline values are unchanged | P2 | `SKILL.md` |
| #565 | Branch deletion silently skips user confirmation unlike worktree removal | P2 | `SKILL.md` |
| #565 | `stat` size comparison fails silently when both `stat` variants fail | P2 | `SKILL.md` |
| #557 | `--start-from forge` silently disables architectural comparison without warning | P2 | `SKILL.md` |
| #557 | A2 boundary check gated behind snapshot existence — silently disabled on standalone invocations | P2 | `SKILL.md` |
| #557 | A2 claims "runs unconditionally" but silently no-ops without `GLOBAL_ARCH.md` | P2 | `SKILL.md` |
| #554 | `_parsers` parameter is silently ignored | P2 | `parser.ts` |
| #553 | Substring check may suppress flag on Node 23 when CI sets the old flag | P2 | `test.js` |
| #539 | Silent mutation failure could cause false-positive passes | P2 | `incremental-edge-parity.test.js` |
| #497 | `--role test-only` silently returns empty without `-T` | P2 | `roles.js` |
| #482 | `mergeConfig` is shallow — `risk.weights` partial overrides will silently drop un-specified keys | P2 | `PLAN_centralize_config.md` |
| #470 | `minConfidence` silently ignored for Repository path | unknown | `dependency.js` |
| #462 | `minConfidence` silently ignored for Repository | unknown | `dependency.js` |
| #462 | Silent fallthrough for non-Repository `opts.repo` | unknown | `connection.js` |
| #461 | `Date` (and other special objects) silently dropped by `flattenObject` | unknown | `result-formatter.js` |
| #461 | `printCsv` silently emits nothing (not even a header) for empty result sets | unknown | `result-formatter.js` |
| #461 | `--table` on empty results suppresses all output silently | unknown | `result-formatter.js` |
| #461 | `outputResult` swallows fallback when items is not an array | unknown | `result-formatter.js` |
| #435 | Function-level cycle detection silently drops 7 node kinds | unknown | `cycles.js` |
| #434 | Symlink loop warning silently dropped + readdirSync hoisted before loop check | unknown | `helpers.js` |
| #434 | Analysis engine failures silently swallowed at debug level | unknown | `run-analyses.js` |
| #431 | Assertions inside `try/catch` can be silently skipped | unknown | `db.test.js` |

</details>

#### Incorrect Logic (72) &mdash; P1: 37 | P2: 26 | unknown: 9

<details>
<summary>Show 72 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #729 | Inverted condition causes struct members to never be collected | P1 | `solidity.ts` |
| #702 | `recon.startedAt` always fails on fresh runs — ENOENT | P1 | `SKILL.md` |
| #656 | `reply_count` breaks on multi-page responses | P1 | `SKILL.md` |
| #655 | Hook matcher syntax is incorrect for the hooks system | P1 | `settings.json` |
| #655 | Same invalid hook matcher disables PostToolUse hooks | P1 | `settings.json` |
| #655 | Same invalid matcher pattern in the example docs | P1 | `settings.json` |
| #654 | Exported constants counted twice | P1 | `javascript.ts` |
| #622 | Incremental `RoleSummary` under-counts when logged | P1 | `structure.ts` |
| #595 | `hasGoRangeFix` always evaluates to `false` | P1 | `cfg-all-langs.test.ts` |
| #591 | Go receiver extraction uses wrong field name | P1 | `helpers.rs` |
| #591 | C# receiver extraction always returns `None` | P1 | `helpers.rs` |
| #582 | `parseFilesAuto` attributed to wrong module | P1 | `adding-a-language.md` |
| #582 | Visibility helper path doesn't match module structure | P1 | `adding-a-language.md` |
| #582 | Template parameter `filePath` will fail Biome lint | P1 | `adding-a-language.md` |
| #568 | `--label` will fail if "follow-up" label doesn't exist | P1 | `SKILL.md` |
| #565 | Stash runs too late — backup is taken after files are already modified | P1 | `SKILL.md` |
| #565 | Success + `STASH_CREATED=1` incorrectly reverts npm changes | P1 | `SKILL.md` |
| #565 | `git diff --quiet` misses new files — baseline never committed on first run | P1 | `SKILL.md` |
| #565 | `git diff --cached --quiet` not scoped to bench-check files | P1 | `SKILL.md` |
| #565 | `COMPARE_ONLY` mode still commits when no regressions are found | P1 | `SKILL.md` |
| #565 | `--coverage` flag skips Phase 1 but leaves Phase 2 and Phase 4 running | P1 | `SKILL.md` |
| #565 | `stat` on directory paths returns metadata size, not content size | P1 | `SKILL.md` |
| #565 | Recovery option 3 cannot achieve its stated goal — stash already consumed | P1 | `SKILL.md` |
| #559 | Incorrect role names in new "vs arbor" section | P1 | `COMPETITIVE_ANALYSIS.md` |
| #558 | MCP tool passes `limit`/`offset` that are now explicitly excluded | P1 | `impact.ts` |
| #553 | `--import` targets the loader, not the hook — hooks won't register without `scripts/test.js` | P1 | `vitest.config.js` |
| #553 | Hook import appended without dedup guard — will double-register once wrong-file bug is fixed | P1 | `vitest.config.js` |
| #545 | Self-loop double-counted in directed path | P1 | `adapter.js` |
| #545 | Coarse graph self-loops double-count intra-community edge weights, inflating `quality()` | P1 | `optimiser.js` |
| #540 | False-negative: content after `*/` on same line is never scanned | P1 | `verify-imports.js` |
| #509 | `matchSubpathPattern` allows empty wildcard match | P1 | `resolve.js` |
| #506 | `display` config opts never passed by callers | P1 | `file-utils.js` |
| #505 | Semantic reversal of annotation-vs-constructor priority | P1 | `javascript.test.js` |
| #505 | `rights` array includes comma tokens, misaligning with `lefts` in multi-variable declarations | P1 | `go.js` |
| #505 | Factory heuristic fires on non-factory method calls | P1 | `javascript.js` |
| #501 | `self`/`cls` filter checks the type name, not the variable name | P1 | `python.js` |
| #476 | `git log` only checks one side of the conflict | P1 | `SKILL.md` |
| #788 | Fallback fires on genuinely unresolvable imports too | P2 | `build-edges.ts` |
| #700 | `stripQuotes` semantics differ subtly from replaced HCL regex | P2 | `helpers.ts` |
| #656 | Script selects all reviewer comments, including follow-up thread replies | P2 | `SKILL.md` |
| #636 | Self-contradicting LOC threshold claim | P2 | `ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md` |
| #636 | Incorrect language label for `walk_node_depth` complexity | P2 | `ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md` |
| #631 | Block comment stripping still runs before string protection | P2 | `helpers.ts` |
| #611 | Function-level cycle count halved without explanation | P2 | `DOGFOOD_REPORT_v3.4.0.md` |
| #602 | Incorrect edge label in comment — says `a -> d`, should be `c -> d` | P2 | `cycles.test.ts` |
| #595 | `hasGoRangeFix` heuristic is susceptible to false positives from non-range loops | P2 | `cfg-all-langs.test.ts` |
| #593 | VAR_BLOCK stores only the last assignment — false negatives for intermediate refs | P2 | `lint-skill.sh` |
| #587 | Checking `command -v bash` is tautological | P2 | `SKILL.md` |
| #587 | Validation bash block may short-circuit if lint exits 1 under `set -e` | P2 | `SKILL.md` |
| #570 | Redundant `g.inEdges` truthiness check — always true per typed interface | P2 | `optimiser.ts` |
| #568 | Issue number not captured before use in reply | P2 | `SKILL.md` |
| #565 | Coverage reporter mismatch — wrong output file | P2 | `SKILL.md` |
| #565 | `git stash drop/pop` targets stash by position, not by name | P2 | `SKILL.md` |
| #540 | Non-awaited `import()` calls are invisible to this script | P2 | `verify-imports.js` |
| #522 | Method-name-only matching produces false positives | P2 | `go.js` |
| #509 | `isSubpathMap` heuristic checks only the first key | P2 | `resolve.js` |
| #504 | `dead-ffi` priority blinds `dead-entry` for FFI files in entry-point paths | P2 | `roles.js` |
| #497 | Key separator `:` collides with `route:` / `event:` / `command:` prefixes | P2 | `roles.js` |
| #496 | Commit count is not unique across cherry-picks or rebases | P2 | `bench-version.js` |
| #494 | Self-referential skip instruction in drift detection | P2 | `SKILL.md` |
| #494 | Self-referential skip instruction in drift detection | P2 | `SKILL.md` |
| #485 | Wrong rollback step number referenced | P2 | `SKILL.md` |
| #484 | Early-return leaves pre-created `false_block` as an empty pass-through | P2 | `cfg.rs` |
| #473 | Incorrect violation detail in NDJSON example | unknown | `SKILL.md` |
| #472 | `"default"` condition points to ESM file, unsafe fallback in CJS contexts | unknown | `package.json` |
| #472 | Promise rejected on import failure is permanently cached by CJS module system | unknown | `index.cjs` |
| #459 | Wrong import path for `communitySummaryForStats` | unknown | `overview.js` |
| #443 | DISTINCT includes confidence for Mermaid | unknown | `export.js` |
| #437 | Dunder methods incorrectly classified as `'protected'` | unknown | `helpers.js` |
| #437 | C# `private protected` compound modifier returns wrong visibility | unknown | `helpers.js` |
| #436 | `edgeCount` double-counts edges on undirected graphs | unknown | `model.js` |
| #435 | `edgeCount` double-counts edges for undirected graphs | unknown | `model.js` |

</details>

#### Null / Undefined / NaN / Division-by-Zero (48) &mdash; P1: 16 | P2: 27 | unknown: 5

<details>
<summary>Show 48 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #745 | `getFileHash` silently returns `null` on native engine, dropping hash from all symbol results | P1 | `native-repository.ts` |
| #685 | Native and WASM benchmark data is null | P1 | `INCREMENTAL-BENCHMARKS.md` |
| #651 | `find_parent_id` silently disagrees with JS `findParentDef` on null `end_line` | P1 | `ast_db.rs` |
| #595 | Fast path skips `deleteCfgForNode` for all-null-cfg definitions | P1 | `cfg.ts` |
| #595 | Silent pass when `findFunctionNode` returns null for all defs | P1 | `cfg-all-langs.test.ts` |
| #581 | `McpToolContext.dbPath` typed non-optional but can be `undefined` at runtime | P1 | `server.ts` |
| #570 | Ineffective guard for unset `partition.graph` | P1 | `optimiser.ts` |
| #569 | `typeMap` can remain `undefined` for non-TS native results | P1 | `parser.ts` |
| #565 | `2>/dev/null` discards error messages that should be recorded | P1 | `SKILL.md` |
| #565 | Division-by-zero when baseline metric is `0` | P1 | `SKILL.md` |
| #557 | Undefined variable `previousAuditedCountBeforeAgent` in gauntlet efficiency check | P1 | `SKILL.md` |
| #556 | `theta ≤ 0` causes division by zero and NaN weights | P1 | `optimiser.js` |
| #556 | `NaN` theta bypasses the guard | P1 | `optimiser.js` |
| #552 | `theta <= 0` causes silent NaN / inverted distribution | P1 | `optimiser.js` |
| #494 | `closeDb` called with potentially undefined `ctx.db` | P1 | `pipeline.js` |
| #489 | `defaultKinds` crash when omitted | P1 | `find-nodes.js` |
| #778 | `--poll-interval` default is always truthy, `undefined` is never passed | P2 | `watch.ts` |
| #769 | JSDoc says `null` but function returns `undefined` | P2 | `zig.ts` |
| #733 | `cfg: null` defs are not excluded from the CFG override | P2 | `engine.ts` |
| #705 | `enterNode` returns `undefined` for matched nodes — walker still descends children | P2 | `ast-store-visitor.ts` |
| #629 | Duplicate `\| undefined` in return type | P2 | `types.ts` |
| #606 | Unnecessary optional chaining produces potentially-undefined `rows` | P2 | `structure.ts` |
| #604 | Redundant guard and inverted NaN-check order | P2 | `finalize.ts` |
| #587 | Pattern 9 instruction uses undefined `<result>` / `<Name>` placeholders — ambiguous guidance | P2 | `SKILL.md` |
| #587 | `2>/dev/null` justification is inaccurate after `ls`→`find` migration | P2 | `SKILL.md` |
| #587 | `> /dev/null 2>&1` usages lack Pattern 2 justification comments | P2 | `SKILL.md` |
| #587 | Check 2 misses `>/dev/null 2>&1` (no space after `>`) | P2 | `lint-skill.sh` |
| #587 | Pattern 16/17 "Correct" examples omit context comments for undefined variables | P2 | `SKILL.md` |
| #587 | Check 2 misses `&>/dev/null` bash shorthand | P2 | `lint-skill.sh` |
| #587 | Check 2 regex misses `>` followed by 2+ spaces before `/dev/null` | P2 | `lint-skill.sh` |
| #587 | Check 2 regex misses multiple spaces between `/dev/null` and `2>&1` | P2 | `lint-skill.sh` |
| #587 | Check 2 misses `2> /dev/null` (spaced redirect form) | P2 | `lint-skill.sh` |
| #581 | `nn()` silently erases null safety | P2 | `cfg-visitor.ts` |
| #581 | `customDbPath!` non-null assertion on a possibly-`undefined` value | P2 | `audit.ts` |
| #581 | `n.role!` silently drops nodes with a `null` role during role filtering | P2 | `graph-enrichment.ts` |
| #581 | `tree!` assertion can mask an undefined value | P2 | `cfg.ts` |
| #581 | `JS_TS_AST_TYPES!` non-null assertion on a potentially absent map entry | P2 | `ast.ts` |
| #569 | Guard now only catches null `extracted`, not empty `typeMap` | P2 | `parser.ts` |
| #565 | Missing `2>/dev/null` on BSD stat fallback in lock-file age computation | P2 | `SKILL.md` |
| #558 | Dropped `!` non-null assertion — silent failure path | P2 | `parser.ts` |
| #558 | `r.role as string` cast bypasses null-safety | P2 | `roles.ts` |
| #555 | `Statement.get` is missing `undefined` from its return type | P2 | `vendor.d.ts` |
| #527 | Dead code — `results.native` is always `null` here | P2 | `fork-engine.js` |
| #472 | Destructured `require()` silently returns `undefined` for all named exports | unknown | `index.cjs` |
| #461 | `Math.max(...spread)` crashes on large result sets | unknown | `result-formatter.js` |
| #461 | `html` may be undefined if `generatePlotHTML` returns void | unknown | `plot.js` |
| #434 | Crash if analysis engine fails — timing properties may be `undefined` | unknown | `pipeline.js` |
| #433 | `cosineSim` returns `NaN` for zero-magnitude vectors | unknown | `sqlite-blob.js` |

</details>

#### Path & Platform Compatibility (25) &mdash; P1: 9 | P2: 13 | unknown: 3

<details>
<summary>Show 25 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #588 | `engines` constraint too broad for `--experimental-strip-types` | P1 | `package.json` |
| #588 | Missing minor-version guard for `--experimental-strip-types` | P1 | `vitest.config.ts` |
| #587 | `mktemp --suffix` is GNU-only — violates Pattern 13 (also Pattern 3 at line 170) | P1 | `SKILL.md` |
| #587 | Missing bash 4+ version guard | P1 | `smoke-test-skill.sh` |
| #580 | Use `fileURLToPath` instead of manual regex for Windows path fix | P1 | `index.ts` |
| #565 | `lsof` unavailable treated as "no process holds the file" | P1 | `SKILL.md` |
| #554 | Fallback returns unstripped TypeScript source on Node < 22.6 | P1 | `ts-resolve-hooks.js` |
| #553 | `shell: true` breaks when project path contains spaces on Windows | P1 | `test.js` |
| #553 | `--experimental-strip-types` is deprecated on Node >= 23 | P1 | `test.js` |
| #593 | `declare -A` requires bash 4+ — fails on macOS default shell | P2 | `lint-skill.sh` |
| #588 | Hardcoded `--experimental-strip-types` is deprecated on Node 23+ | P2 | `pre-commit.sh` |
| #588 | Hardcoded `--experimental-strip-types` in update-report invocations | P2 | `benchmark.yml` |
| #588 | Hardcoded `--experimental-strip-types` across all npm scripts | P2 | `package.json` |
| #588 | Hardcoded `--experimental-strip-types` in verify-imports step | P2 | `ci.yml` |
| #588 | Hardcoded `--experimental-strip-types` in publish workflow | P2 | `publish.yml` |
| #588 | Same hardcoded `--experimental-strip-types` issue as line 227 | P2 | `publish.yml` |
| #587 | Unquoted `$FILE` in `git show` path argument | P2 | `SKILL.md` |
| #587 | Scaffold `mkdir` and idempotency guard use unquoted `$SKILL_NAME` | P2 | `SKILL.md` |
| #587 | Unquoted `$SKILL_NAME` in script invocations | P2 | `SKILL.md` |
| #554 | `module.register()` requires Node >= 20.6.0, not just Node >= 20 | P2 | `ts-resolve-loader.js` |
| #553 | Raw TypeScript source returned on Node < 22.6 outside Vitest's transform pipeline | P2 | `ts-resolver-loader.js` |
| #538 | `awk` replaces all `^version =` lines, not just the `[package]` version | P2 | `publish.yml` |
| #474 | `git checkout` breaks for fork PRs | unknown | `SKILL.md` |
| #473 | `/dev/stdin` is not available on Windows | unknown | `SKILL.md` |
| #473 | Installation `cp` command won't work from project root | unknown | `README.md` |

</details>

#### Missing Feature or Incomplete (21) &mdash; P0: 1 | P1: 5 | P2: 13 | unknown: 2

<details>
<summary>Show 21 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #491 | Missing `rootDir` argument dropped during extraction | P0 | `engine.js` |
| #591 | Early return on await drops string nodes inside awaited expressions (regression) | P1 | `helpers.rs` |
| #568 | Missing `--repo` flag on `gh issue create` | P1 | `SKILL.md` |
| #568 | Reply endpoint only covers inline comments | P1 | `SKILL.md` |
| #557 | Incomplete merge conflict detection — misses `AU`, `UA`, `DU`, `UD` markers | P1 | `SKILL.md` |
| #511 | `triage --level` missing `directory` option | P1 | `SKILL.md` |
| #736 | `children` field lacks `#[serde(default)]` for defensive deserialization | P2 | `insert_nodes.rs` |
| #713 | Missing delta indicators for 3.6.0 native row | P2 | `QUERY-BENCHMARKS.md` |
| #684 | Missing native benchmarks — consider adding a note | P2 | `QUERY-BENCHMARKS.md` |
| #678 | Missing field fallbacks compared to native `extract_call_name` | P2 | `ast-store-visitor.ts` |
| #621 | Missing `'files'` case in `getSortFn` — default sort is silently alphabetical | P2 | `structure-query.ts` |
| #603 | `.tsx` files not included in scan | P2 | `incremental-benchmark.ts` |
| #595 | `has_child_of_kind` only checks direct children | P2 | `cfg.rs` |
| #587 | Missing automated check for `## Examples` section | P2 | `lint-skill.sh` |
| #559 | Missing "vs arbor" section | P2 | `COMPETITIVE_ANALYSIS.md` |
| #502 | Go multi-name `var` declarations only capture the first name | P2 | `go.js` |
| #501 | Python annotated assignments (`x: Type = ...`) listed in PR description but not implemented | P2 | `python.js` |
| #494 | `rootDir` dropped from `ensureWasmTrees` call | P2 | `engine.js` |
| #494 | `rootDir` re-dropped from `ensureWasmTrees` call | P2 | `engine.js` |
| #469 | `needsComplexity` missing language/extension filter | unknown | `engine.js` |
| #461 | RFC 4180 CRLF line endings not honored | unknown | `result-formatter.js` |

</details>

#### Regex & Pattern Matching (17) &mdash; P1: 8 | P2: 8 | unknown: 1

<details>
<summary>Show 17 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #593 | `git add .` regex matches paths starting with a dot | P1 | `lint-skill.sh` |
| #587 | Check 9 phase-regex misses double-digit phase numbers | P1 | `lint-skill.sh` |
| #587 | Pattern 15 file-persistence example missing `mkdir -p` guard | P1 | `SKILL.md` |
| #587 | `grep -qF` produces false positives for variables sharing a name prefix | P1 | `lint-skill.sh` |
| #587 | File-persistence suppression misses `$(<file)` redirect form | P1 | `lint-skill.sh` |
| #565 | `grep` alternation syntax is not portable to macOS | P1 | `SKILL.md` |
| #527 | Regex truncates markdown links on every run | P1 | `update-benchmark-report.js` |
| #502 | Regex matches inside comments and string literals | P1 | `parser.js` |
| #587 | Pattern 12 (artifact reuse) missing from Phase 4 checklist | P2 | `SKILL.md` |
| #587 | Pattern 14 cd-cleanup template missing the `cd` step | P2 | `SKILL.md` |
| #587 | Pattern 2 "Correct" example missing cleanup trap — self-referential Pattern 14 violation | P2 | `SKILL.md` |
| #587 | Pattern 14 directory variant missing explicit cleanup and `trap - EXIT` | P2 | `SKILL.md` |
| #587 | Check 11 regex gap — unquoted single-letter `/tmp/` paths not caught | P2 | `lint-skill.sh` |
| #587 | Check 3 `--all` alternative lacks trailing word boundary | P2 | `lint-skill.sh` |
| #587 | Detection keywords `lock` and `package` are substring matches — no word boundary | P2 | `lint-skill.sh` |
| #584 | Filter could match parent path components | P2 | `pipeline.test.js` |
| #437 | `indexOf` truncates scope for multi-segment names | unknown | `insert-nodes.js` |

</details>

#### Algorithm & Data Structure (15) &mdash; P1: 6 | P2: 9

<details>
<summary>Show 15 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #732 | Multi-level Louvain uses incorrect `m2` from level 1 onwards | P1 | `graph_algorithms.rs` |
| #545 | `diffModularityDirected` underestimates gain by `2 × selfLoopWeight / m` for self-loop nodes | P1 | `modularity.js` |
| #545 | `diffCPM` (directed branch) also underestimates gain by `2 × selfLoopWeight` for self-loop nodes | P1 | `cpm.js` |
| #545 | `qualityCPM` evaluates a different objective than `diffCPM` optimizes | P1 | `cpm.js` |
| #508 | Implementors seeded into current frontier, causing callers to appear one depth level too shallow | P1 | `impact.js` |
| #506 | `community.resolution` is never consumed from config | P1 | `config.js` |
| #704 | `classifyRoles*` wrapped in `withExclusiveNativeWrite` despite being reads+writes | P2 | `build-structure.ts` |
| #552 | Directed graph BFS checks strong reachability, not weak connectivity | P2 | `optimiser.js` |
| #545 | Coarse graph always created as directed, even for undirected runs | P2 | `optimiser.js` |
| #545 | `quality()` evaluates at fixed `gamma=1.0`, not the optimization resolution | P2 | `index.js` |
| #545 | `buildCoarseGraph` doesn't transfer `g.selfLoop` node-level self-loops separately | P2 | `optimiser.js` |
| #545 | Self-loop counted in both `selfLoop[]` and `outEdges`/`inEdges` in directed path | P2 | `adapter.js` |
| #513 | Implementors and their direct callers collapse to the same depth level | P2 | `impact.js` |
| #480 | `utility` role unconditionally forces HIGH risk regardless of caller count | P2 | `brief.js` |
| #480 | `countTransitiveImporters` has no depth bound | P2 | `brief.js` |

</details>

#### Resource Leak (13) &mdash; P1: 3 | P2: 5 | unknown: 5

<details>
<summary>Show 13 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #757 | Uncaught `openDb` failure leaves `ctx.db` in a closed state | P1 | `pipeline.ts` |
| #598 | Process-level listeners accumulate without cleanup | P1 | `server.ts` |
| #512 | `cleanup()` from first `resolveBenchmarkSource()` call is never invoked | P1 | `benchmark.js` |
| #757 | `ctx.engineOpts.nativeDb` not cleared after analysis cleanup | P2 | `pipeline.ts` |
| #598 | `server.close()` is not awaited before `process.exit(0)` | P2 | `server.ts` |
| #557 | Step 5.5 cleanup not guaranteed to execute on failure or early exit | P2 | `SKILL.md` |
| #557 | Step 5d cleanup not guaranteed to run on early exit | P2 | `SKILL.md` |
| #539 | Missing try/finally for `db.close()` | P2 | `incremental-edge-parity.test.js` |
| #461 | `close()` not called if `findCycles` throws | unknown | `cycles.js` |
| #461 | `close()` called before neo4j file-write completes — then `return` bypasses `output` check | unknown | `export.js` |
| #434 | DB leaked if `collectFiles` or `detectChanges` throws | unknown | `pipeline.js` |
| #434 | DB leaked if setup phase throws before the try block | unknown | `pipeline.js` |
| #433 | DB connection leaked on unexpected SQL exception | unknown | `prepare.js` |

</details>

#### Data Loss & Corruption (12) &mdash; P1: 11 | unknown: 1

<details>
<summary>Show 12 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #685 | Files count is 0 — likely a failed benchmark run | P1 | `INCREMENTAL-BENCHMARKS.md` |
| #651 | Missing `busy_timeout` pragma turns SQLITE_BUSY into silent data loss | P1 | `ast_db.rs` |
| #651 | Individual execute failures commit partial data and misfire JS fallback | P1 | `ast_db.rs` |
| #565 | Stash pop/drop operates on wrong entry when Phase 0 stash was a no-op | P1 | `SKILL.md` |
| #565 | Dirt pattern removal can delete git-tracked files | P1 | `SKILL.md` |
| #565 | Empty baseline saved when all benchmarks fail or timeout | P1 | `SKILL.md` |
| #565 | `node_modules/` left out of sync after stash-pop conflict resolution | P1 | `SKILL.md` |
| #565 | `node_modules/` not re-synced after a clean stash pop on the success path | P1 | `SKILL.md` |
| #565 | Failure-path `git stash pop` applied to npm-modified manifests will conflict | P1 | `SKILL.md` |
| #542 | Reverse-dep edges permanently deleted when parse fails | P1 | `incremental.js` |
| #525 | Empty benchmark result committed — symbols: 0, models: {} | P1 | `EMBEDDING-BENCHMARKS.md` |
| #450 | Empty benchmark data committed | unknown | `EMBEDDING-BENCHMARKS.md` |

</details>

#### Off-by-One & Boundary (7) &mdash; P1: 2 | P2: 3 | unknown: 2

<details>
<summary>Show 7 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #557 | Efficiency check fires on the wrong variable — `countBeforeUpdate` accumulates correctly but the ite | P1 | `SKILL.md` |
| #557 | `executionOrder[currentPhase]` is an off-by-one array access | P1 | `SKILL.md` |
| #545 | `maxLocalPasses` off-by-one: executes `maxLocalPasses + 1` passes, not `maxLocalPasses` | P2 | `optimiser.js` |
| #545 | Same `maxLocalPasses` off-by-one in `refineWithinCoarseCommunities` | P2 | `optimiser.js` |
| #515 | Header shows page count instead of total count | P2 | `exports.js` |
| #473 | Artifact count is off by one | unknown | `README.md` |
| #457 | Ceiling test doesn't exercise ceiling logic | unknown | `db.test.js` |

</details>

#### Race Condition & Concurrency (6) &mdash; P1: 4 | P2: 1 | unknown: 1

<details>
<summary>Show 6 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #666 | Non-transactional multi-statement migrations can permanently corrupt the DB | P1 | `native_db.rs` |
| #634 | Edge deletion is not transactional with edge re-creation | P1 | `resolve-imports.ts` |
| #565 | Hardcoded `/tmp/test-health-runs/` path corrupts results under concurrent sessions | P1 | `SKILL.md` |
| #565 | Stale lock file deletion can corrupt active concurrent sessions | P1 | `SKILL.md` |
| #669 | Split atomicity between `purgeFilesData` and reverse-dep edge deletions | P2 | `detect-changes.ts` |
| #434 | `ctx.fileSymbols` mutated inside a SQLite transaction — partial population on rollback | unknown | `insert-nodes.js` |

</details>

#### Incorrect Operator / Expression (5) &mdash; P1: 1 | P2: 4

<details>
<summary>Show 5 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #545 | `\|\|` operator incorrectly used for numeric quality-gain fallback | P1 | `optimiser.js` |
| #775 | `parenDepthDelta` changes comma-split evaluation order | P2 | `query-builder.ts` |
| #722 | `->` right-assignment operator not handled correctly | P2 | `r.ts` |
| #708 | Kotlin `logical_node_type` covers only `&&`, not `\|\|` | P2 | `complexity.rs` |
| #642 | Qualifier ambiguity for bare `feat:` commits | P2 | `SKILL.md` |

</details>

#### String & Encoding (4) &mdash; P1: 1 | P2: 3

<details>
<summary>Show 4 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #565 | Unescaped stderr content produces malformed JSON | P1 | `SKILL.md` |
| #588 | `String.replace()` only replaces first occurrence | P2 | `package.json` |
| #565 | Corrupted em-dash character in "N/A" string | P2 | `SKILL.md` |
| #543 | Literal `\n` won't produce a newline via `-f body=` | P2 | `SKILL.md` |

</details>

### Security (15 comments)

#### SQL & Injection (10) &mdash; P2: 5 | unknown: 5

<details>
<summary>Show 10 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #666 | `pragma()` accepts write PRAGMAs without restriction | P2 | `native_db.rs` |
| #554 | `--import` injected without Node >= 20.6 guard | P2 | `vitest.config.js` |
| #504 | Non-parameterized LIKE pattern bypasses prepared statement convention | P2 | `query-builder.js` |
| #498 | Inline LIKE filter missing `ESCAPE` clause and wildcard escaping | P2 | `keyword.js` |
| #498 | Missing `escapeLike()` and `ESCAPE` clause (inconsistent with `keyword.js`) | P2 | `prepare.js` |
| #461 | `config` now injected into every domain call via spread | unknown | `options.js` |
| #446 | Stale JSDoc and duplicate `escapeLike` | unknown | `in-memory-repository.js` |
| #444 | `opts.file` LIKE escaping divergence vs SQLite | unknown | `in-memory-repository.js` |
| #437 | `opts.file` LIKE pattern does not escape SQL wildcards | unknown | `nodes.js` |
| #437 | Duplicate `escapeLike` function — `SyntaxError` in ESM | unknown | `nodes.js` |

</details>

#### Destructive Git Operations (3) &mdash; P1: 1 | P2: 2

<details>
<summary>Show 3 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #565 | `git pull` may rebase, violating the project's "never rebase" rule | P1 | `SKILL.md` |
| #787 | Prefer `--force-with-lease` over `--force` | P2 | `SKILL.md` |
| #787 | Same `--force` vs `--force-with-lease` concern in the Rules section | P2 | `SKILL.md` |

</details>

#### Credential & Secret Exposure (2) &mdash; P2: 2

<details>
<summary>Show 2 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #587 | "Wrong" example shadows reserved `TMPDIR` env var | P2 | `SKILL.md` |
| #482 | Making `MCP_MAX_LIMIT` user-configurable defeats its security purpose | P2 | `PLAN_centralize_config.md` |

</details>

### Type Safety (49 comments)

#### Unsafe Cast or any (23) &mdash; P2: 22 | unknown: 1

<details>
<summary>Show 23 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #764 | Unsafe `(e as Error).message` cast throughout PR | P2 | `connection.ts` |
| #699 | `config` typed as `any` leaks into the shared helper | P2 | `query-helpers.ts` |
| #591 | Unsafe cast hides potential `undefined` return | P2 | `ast-parity.test.ts` |
| #588 | Avoid the `Function` type — use a specific callback signature | P2 | `ts-resolve-hooks.ts` |
| #581 | Stale `as any` cast — `id` is now in `TreeSitterNode` | P2 | `ast-store-visitor.ts` |
| #581 | Stale `as any` cast — `id` now exists on `TreeSitterNode` | P2 | `complexity-visitor.ts` |
| #580 | `as any` cast on `buildGraph` options nullifies the type safety of the corrected fields | P2 | `build.ts` |
| #580 | `mcpOpts: any` — use an inline typed object instead of a mutable `any` bag | P2 | `mcp.ts` |
| #580 | `as any` cast on search options suppresses type checking | P2 | `search.ts` |
| #580 | Duck-typed `isMulti` check and `as any` casts weaken multi-batch handling | P2 | `batch.ts` |
| #580 | `plotCfg: any` allows silent field name mistakes | P2 | `plot.ts` |
| #580 | Redundant `as any` casts on `ctx.config` | P2 | `co-change.ts` |
| #580 | `MODELS` entry cast to `any` — consider a local interface | P2 | `models.ts` |
| #580 | `CommandOpts = any` makes downstream `as any` casts redundant | P2 | `types.ts` |
| #580 | Internal helpers use `any` instead of defined types | P2 | `triage.ts` |
| #570 | Unsafe `get()` cast strips `undefined` possibility | P2 | `module-map.ts` |
| #558 | `as any` cast for `Statement.raw()` may be unnecessary | P2 | `exports.ts` |
| #554 | `db: any` undermines migration goal across entire analysis layer | P2 | `context.ts` |
| #554 | `Map<string, any>` for WASM parsers — typed alternatives available | P2 | `parser.ts` |
| #554 | Double-cast reveals structural incompatibility in `BetterSqlite3Database` | P2 | `helpers.ts` |
| #554 | Overly complex type assertion — simpler alternative available | P2 | `in-memory-repository.ts` |
| #554 | `as NodeRow` cast hides triage-specific extra fields | P2 | `in-memory-repository.ts` |
| #463 | JSDoc `db` type overly broad for an exported function | unknown | `impact.js` |

</details>

#### Type Mismatch or Regression (20) &mdash; P1: 11 | P2: 8 | unknown: 1

<details>
<summary>Show 20 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #774 | Incorrect type for `hc` — TypeScript error when passed to `normalizeSymbol` | P1 | `dependencies.ts` |
| #729 | State variable emitted with wrong `kind` | P1 | `solidity.ts` |
| #708 | Kotlin `object_declaration` kind mismatch between engines | P1 | `kotlin.ts` |
| #640 | `transaction` return type erases argument types for callers | P1 | `types.ts` |
| #570 | Type lie for `graph` initialization | P1 | `partition.ts` |
| #569 | typeMap values are strings, not `TypeMapEntry` objects | P1 | `parser.ts` |
| #554 | `NativeAddon.resolveImports` signature doesn't match the actual call site | P1 | `types.ts` |
| #554 | `NativeAddon.parseFiles` signature doesn't match the actual call site | P1 | `types.ts` |
| #516 | `ExtendedSymbolKind` and `SubDeclaration.kind` are misaligned | P1 | `types.ts` |
| #516 | `EdgeRow.kind` is too wide — includes dataflow edge kinds that never appear in the `edges` table | P1 | `types.ts` |
| #516 | `AdjacentEdgeRow.edge_kind` should also be `EdgeKind`, not `AnyEdgeKind` | P1 | `types.ts` |
| #731 | Kind mismatch between contract children and standalone definitions | P2 | `solidity.ts` |
| #708 | Top-level `val`/`var` definitions emitted with `kind: 'function'` | P2 | `scala.ts` |
| #591 | `loadNative` import not type-safe — will crash if export name changes | P2 | `ast-parity.test.ts` |
| #576 | `TriageNodeRow extends NodeRow` over-promises available fields | P2 | `types.ts` |
| #570 | `transaction<T>` type change erases parameter types | P2 | `vendor.d.ts` |
| #558 | `parseFileAuto` / `parseFilesAuto` / `parseFileIncremental` now return `Promise<any>` — `ExtractorOu | P2 | `parser.ts` |
| #554 | Type regression: `BetterSqlite3.Database` → `any` | P2 | `watcher.ts` |
| #554 | Class `Repository` doesn't `implements` the interface `Repository` from `types.ts` | P2 | `base.ts` |
| #461 | Booleans misclassified as numeric columns | unknown | `result-formatter.js` |

</details>

#### Missing or Weak Types (6) &mdash; P2: 6

<details>
<summary>Show 6 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #612 | Missing TypeScript parameter types | P2 | `bench-config.ts` |
| #581 | `isMulti` has a weak inferred type | P2 | `batch.ts` |
| #558 | Untyped WeakMap caches — inconsistent with `StmtCache<T>` pattern | P2 | `nodes.ts` |
| #555 | `collectFiles` return type needs overloads | P2 | `helpers.ts` |
| #516 | `mergeCandidates` is typed as `unknown[]` while `splitCandidates` has a concrete shape | P2 | `types.ts` |
| #516 | `GraphNodeAttrs` and `GraphEdgeAttrs` provide no structural type safety | P2 | `types.ts` |

</details>

### Engine Parity (27 comments)

#### Native vs WASM Divergence (27) &mdash; P1: 11 | P2: 12 | unknown: 4

<details>
<summary>Show 27 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #732 | Undirected + `'backward'` direction still asymmetric on native path | P1 | `bfs.ts` |
| #732 | Undirected `CodeGraph` yields wrong fanIn/fanOut on native path | P1 | `centrality.ts` |
| #708 | Swift multiple-inheritance always emits `extends`, never `implements` | P1 | `swift.ts` |
| #678 | Recursing into all children diverges from native for chained calls | P1 | `ast-store-visitor.ts` |
| #658 | `dead-entry` detection diverges from JS implementation | P1 | `roles_db.rs` |
| #647 | Engine parity gap violates repo policy | P1 | `BUILD-BENCHMARKS.md` |
| #625 | Engine parity violation: nodes and edges diverge between native and WASM | P1 | `BUILD-BENCHMARKS.md` |
| #625 | New DB size divergence between engines | P1 | `BUILD-BENCHMARKS.md` |
| #611 | Engine divergence framed as acceptable — violates `CLAUDE.md` policy | P1 | `DOGFOOD_REPORT_v3.4.0.md` |
| #595 | `allCfgNative` diverges from `initCfgParsers` on `_tree` files | P1 | `cfg.ts` |
| #591 | Rust `method_call_expression` missing from `call_types` | P1 | `helpers.rs` |
| #733 | Native pass gate skips CFG/dataflow if `analyzeComplexity` is absent | P2 | `engine.ts` |
| #733 | `from_lang_id` fallback is called with the full file path | P2 | `analysis.rs` |
| #732 | Undirected `CodeGraph` loses symmetry in native "forward" BFS | P2 | `bfs.ts` |
| #726 | Dropping "(WASM)" from the column header loses important context | P2 | `README.md` |
| #725 | Asymmetric delta handling for 3.6.0 native vs wasm | P2 | `QUERY-BENCHMARKS.md` |
| #714 | Missing native engine row with no explanation | P2 | `INCREMENTAL-BENCHMARKS.md` |
| #712 | Engine context removed from summary table | P2 | `README.md` |
| #712 | Empty native columns in phase breakdown table | P2 | `BUILD-BENCHMARKS.md` |
| #705 | Undocumented conversion from `#`-alias imports to relative paths | P2 | `build-edges.ts` |
| #673 | Unexplained `kind != 'constant'` exclusion may mask parity gap | P2 | `build-parity.test.ts` |
| #672 | `hasTable` probe semantics changed for JS fallback path | P2 | `detect-changes.ts` |
| #594 | Divergent remap logic between single and batch paths | P2 | `resolve.ts` |
| #444 | `noTests` filter misses 3 exclusion patterns from SQLite | unknown | `in-memory-repository.js` |
| #444 | Same `noTests` divergence in `findNodesForTriage` | unknown | `in-memory-repository.js` |
| #444 | `findNodesWithFanIn` file filter escaping is stricter than SQLite | unknown | `in-memory-repository.js` |
| #444 | `opts.pattern` escaping diverges from SQLite's `nameLike` | unknown | `in-memory-repository.js` |

</details>

### Performance (33 comments)

#### Prepared Statement in Loop (11) &mdash; P1: 2 | P2: 9

<details>
<summary>Show 11 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #558 | `db.prepare()` inside nested BFS loops forces redundant SQL compilation and an extra DB roundtrip pe | P1 | `dependencies.ts` |
| #558 | Repeated `db.prepare()` calls inside map and nested loop | P1 | `exports.ts` |
| #738 | `getNodeIdStmt.get` called twice per source file | P2 | `build-edges.ts` |
| #606 | Export-marking UPDATE statement is re-prepared on every batch iteration | P2 | `insert-nodes.ts` |
| #558 | `db.prepare()` inside per-symbol closure — same pattern as the BFS-loop issue already fixed in this  | P2 | `exports.ts` |
| #558 | `db.prepare()` inside `getNode` closure — same pattern fixed elsewhere in this PR | P2 | `dependencies.ts` |
| #558 | `db.prepare()` recompiled on each recursive `explainCallees` call | P2 | `context.ts` |
| #558 | `db.prepare()` inside loop — same anti-pattern fixed elsewhere in this PR | P2 | `impact.ts` |
| #558 | `upstreamStmt` not cached via `StmtCache<T>` — inconsistent with PR pattern | P2 | `dependencies.ts` |
| #558 | `db.prepare()` inside `rolesData` — not using `cachedStmt` pattern | P2 | `roles.ts` |
| #542 | Prepared statements allocated inside hot-loop functions | P2 | `incremental.js` |

</details>

#### Unnecessary Recomputation (10) &mdash; P1: 2 | P2: 7 | unknown: 1

<details>
<summary>Show 10 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #757 | All DB nodes re-analyzed on every incremental build | P1 | `pipeline.ts` |
| #740 | Reverse-dependency files have edges purged but are never re-parsed | P1 | `build_pipeline.rs` |
| #634 | Version check runs on every call when versions match | P2 | `connection.ts` |
| #622 | `median` function is re-defined inside the incremental path | P2 | `structure.ts` |
| #587 | Check 1 reassignment lookup re-reads the blocks file on every variable × line iteration | P2 | `lint-skill.sh` |
| #584 | Consider filtering `.codegraph/` from the copy | P2 | `pipeline.test.js` |
| #558 | Schema probe re-runs on every `exportsData` call | P2 | `exports.ts` |
| #557 | Step 5c re-runs `codegraph diff-impact --staged` already executed in Step 1 | P2 | `SKILL.md` |
| #557 | Step 5b re-runs `codegraph check --staged` already executed in Step 1 | P2 | `SKILL.md` |
| #433 | Full embeddings table re-scanned once per sub-query | unknown | `hybrid.js` |

</details>

#### N+1 & Query Regression (8) &mdash; P1: 2 | P2: 5 | unknown: 1

<details>
<summary>Show 8 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #548 | Significant query latency regression in 3.3.1 | P1 | `QUERY-BENCHMARKS.md` |
| #523 | Significant query latency regression in 3.3.0 | P1 | `QUERY-BENCHMARKS.md` |
| #781 | Pre-aggregated fan-in/fan-out subqueries count ALL edge types, including edges between non-file node | P2 | `module-map.ts` |
| #656 | N+1 API calls — fetch comments once and process in-memory | P2 | `SKILL.md` |
| #646 | Unexplained 45% `diffImpact` regression may benefit from a note | P2 | `QUERY-BENCHMARKS.md` |
| #627 | Disproportionate 1-file rebuild regression | P2 | `INCREMENTAL-BENCHMARKS.md` |
| #535 | Significant query latency regression in dev | P2 | `QUERY-BENCHMARKS.md` |
| #463 | Full edge scan for `minConfidence` on Repository path | unknown | `dependency.js` |

</details>

#### Hot Path & Allocation (4) &mdash; P2: 2 | unknown: 2

<details>
<summary>Show 4 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #594 | `fs.existsSync` in batch hot path | P2 | `resolve.ts` |
| #556 | Per-node array allocation in hot loop creates GC pressure | P2 | `optimiser.js` |
| #444 | Sort comparator spreads nodes Map per comparison | unknown | `in-memory-repository.js` |
| #434 | Dynamic `fs` import inside hot-path function | unknown | `incremental.js` |

</details>

### Dead Code & Unused (32 comments)

#### Dead Code & Unused (32) &mdash; P1: 8 | P2: 19 | unknown: 5

<details>
<summary>Show 32 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #704 | `tryNativeInsert` guard still present — native node insertion permanently disabled | P1 | `insert-nodes.ts` |
| #702 | `startedAt` always overwritten on resume | P1 | `SKILL.md` |
| #702 | `close.completedAt` is never available when the report is generated | P1 | `SKILL.md` |
| #591 | `nativeSupportsCallAst` guard always evaluates to skip | P1 | `ast-parity.test.ts` |
| #565 | Unused-dependency search misses top-level source directories | P1 | `SKILL.md` |
| #565 | `STASH_CREATED=$?` is always `0` in modern git — STASH_CREATED=1 branches are dead code | P1 | `SKILL.md` |
| #545 | `maxLevels`/`maxLocalPasses` config entries are never read | P1 | `louvain.js` |
| #545 | `qualityCPMSizeAware` is byte-for-byte identical to `qualityCPM` — `cpmMode: 'size-aware'` is a dead | P1 | `cpm.js` |
| #764 | `suppressError` helpers added but never used | P2 | `errors.ts` |
| #708 | Dead code with a misleading name | P2 | `kotlin.rs` |
| #699 | Unused return value from `buildSortedCommunityIds` | P2 | `partition.ts` |
| #658 | Unused `params` import (also in `edges_db.rs`) | P2 | `roles_db.rs` |
| #636 | Inconsistent dead-code totals (8,285 vs 8,960) | P2 | `ARCHITECTURE_AUDIT_v3.4.0_2026-03-26.md` |
| #632 | Unused columns in full-path `leafRows` query | P2 | `structure.ts` |
| #629 | Dead code prefixed rather than removed | P2 | `adapter.ts` |
| #594 | `clearJsToTsCache` exported but not wired into test teardown | P2 | `resolve.ts` |
| #588 | New `.ts` loader duplicates existing `.js` loader but is unused | P2 | `ts-resolve-loader.ts` |
| #587 | `Agent` in `allowed-tools` is never invoked | P2 | `SKILL.md` |
| #570 | Empty `extends` interface — prefer a type alias | P2 | `index.ts` |
| #569 | `!patched.typeMap` guard is now dead code | P2 | `parser.ts` |
| #565 | Phase 5 subphases (5a–5d) are unreachable dead documentation | P2 | `SKILL.md` |
| #557 | D5 leftover check has no explicit verdict | P2 | `SKILL.md` |
| #557 | Duplicate `previousCompletedPhases` assignment — leftover from stall-detection fix | P2 | `SKILL.md` |
| #554 | Unused imports — missing `load` hook | P2 | `ts-resolve-hooks.js` |
| #528 | `clearConfigCache` exported but never imported anywhere | P2 | `config.js` |
| #513 | `totalUnused` / `totalExported` don't reflect re-exported symbols | P2 | `exports.js` |
| #502 | `methodCandidates` guard is effectively dead code | P2 | `build-edges.js` |
| #459 | Stale comment and potential dead code | unknown | `query.js` |
| #457 | Unused variable | unknown | `db.test.js` |
| #444 | `#nameIndex` is written but never read | unknown | `fixtures.js` |
| #437 | `_findNodesByScopeStmt` WeakMap is declared but never used | unknown | `nodes.js` |
| #433 | `_cos_sim` is loaded but never used | unknown | `models.js` |

</details>

### Architecture (175 comments)

#### Duplication & Overlap (52) &mdash; P1: 9 | P2: 32 | unknown: 11

<details>
<summary>Show 52 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #781 | Duplicate edges not deduplicated — regression vs. old `buildDependencyGraph` | P1 | `cycles.ts` |
| #654 | Edge INSERT missing conflict handler — duplicates on incremental builds | P1 | `insert_nodes.rs` |
| #558 | Duplicate `findCallers()` call — redundant DB roundtrip per node | P1 | `context.ts` |
| #558 | `LanguageRegistryEntry` duplicated with weaker types | P1 | `parser.ts` |
| #557 | A4 overlaps with A1 — produces false positives for touched symbols and duplicate warnings | P1 | `SKILL.md` |
| #546 | Duplicate ID 97 — conflicts with existing "Unified multi-repo graph" entry | P1 | `BACKLOG.md` |
| #508 | Same depth-level collision for mid-traversal interface callers | P1 | `impact.js` |
| #503 | Tier 1j items duplicated in ROADMAP without "PROMOTED" annotation | P1 | `BACKLOG.md` |
| #480 | `directImporters` not deduplicated — negative transitive count possible | P1 | `brief.js` |
| #749 | Redundant `existsSync` in outer caller after `resolveDbFile` | P2 | `query-benchmark.ts` |
| #673 | Duplicated lazy-loader pattern across three files | P2 | `snapshot.ts` |
| #631 | Duplicated `CODEGRAPH_VERSION` constant | P2 | `pipeline.ts` |
| #595 | Redundant intermediate variable in `has_child_of_kind` | P2 | `cfg.rs` |
| #595 | `allCfgNative` duplicates the per-file condition already in `initCfgParsers` | P2 | `cfg.ts` |
| #587 | Kebab-case validation defined twice — self-violation of Pattern 7 | P2 | `SKILL.md` |
| #584 | Same `.codegraph/` filter suggestion applies here | P2 | `scoped-rebuild.test.js` |
| #584 | Same filter precision concern | P2 | `scoped-rebuild.test.js` |
| #581 | Local `HalsteadMetrics` duplicates the canonical `HalsteadDerivedMetrics` | P2 | `complexity.ts` |
| #581 | Local `DataflowResult` duplicates the canonical type in `types.ts` | P2 | `dataflow.ts` |
| #580 | O(n²) `Array.includes` inside a loop — convert to a `Set` for O(n) deduplication | P2 | `index.ts` |
| #569 | Duplicate `biome-ignore` suppression for the same line | P2 | `parser.ts` |
| #559 | Duplicate rank number at tier boundary | P2 | `COMPETITIVE_ANALYSIS.md` |
| #558 | Duplicate inline Set construction — should be a module-level constant | P2 | `parser.ts` |
| #558 | Duplicate `findCallers()` in `contextData` path | P2 | `context.ts` |
| #557 | Step 5c and Step 5.5 A2 overlap — duplicate FAIL verdicts for the same boundary violation | P2 | `SKILL.md` |
| #554 | `canStripTypes` check triplicated across test files | P2 | `cli.test.js` |
| #553 | `NODE_OPTIONS` can accumulate duplicate hook registrations | P2 | `test.js` |
| #553 | `--strip-types` duplicated when running via `scripts/test.js` | P2 | `vitest.config.js` |
| #545 | `diffModularityDirected` imported and used redundantly | P2 | `optimiser.js` |
| #515 | `DISTINCT n.id, n.file` may yield duplicate target files | P2 | `exports.js` |
| #512 | `forkModel()` duplicates `runWorker()` logic from `fork-engine.js` | P2 | `embedding-benchmark.js` |
| #505 | Redundant first condition in uppercase guard | P2 | `javascript.js` |
| #504 | `LIKE 'dead%'` pattern duplicated across three sites | P2 | `query-builder.js` |
| #503 | Phase 4.6 overlaps substantially with the existing Phase 12.2 | P2 | `ROADMAP.md` |
| #502 | Redundant disk read when `source` is already in memory | P2 | `parser.js` |
| #501 | Redundant double processing of variable declarations in the walk path | P2 | `javascript.js` |
| #497 | Redundant array reset | P2 | `roles.js` |
| #494 | Inline patterns duplicate `testFilterSQL` utility | P2 | `structure.js` |
| #491 | `hasEmbeddings` detection duplicated across three extracted helpers | P2 | `detect-changes.js` |
| #490 | `handleRustTraitItem` + walker recursion creates duplicate definitions for trait methods with defaul | P2 | `rust.js` |
| #484 | Duplicate constant, consider a shared source of truth | P2 | `complexity.rs` |
| #464 | Duplicate `npm audit` deliverable creates ownership ambiguity | unknown | `ROADMAP.md` |
| #463 | Redundant alias variable | unknown | `check.js` |
| #461 | Redundant double-flattening in `autoColumns` | unknown | `result-formatter.js` |
| #461 | Duplicated flat-items + column-derivation block | unknown | `result-formatter.js` |
| #445 | Duplicate backlog ID 85 | unknown | `BACKLOG.md` |
| #444 | Duplicate node names silently corrupt edge resolution | unknown | `fixtures.js` |
| #444 | `findCallers` doesn't deduplicate while `findCallees` does | unknown | `in-memory-repository.js` |
| #444 | Duplicate node added to repo before the check fires | unknown | `fixtures.js` |
| #443 | Duplicate node declarations per edge | unknown | `export.js` |
| #436 | Duplicate if/else branches in `toGraphology` | unknown | `model.js` |
| #435 | Duplicate `if/else` branches in `toGraphology` | unknown | `model.js` |

</details>

#### Missing Validation or Guard (30) &mdash; P1: 13 | P2: 12 | unknown: 5

<details>
<summary>Show 30 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #628 | No guard when no prior reviewer trigger exists | P1 | `SKILL.md` |
| #587 | Scaffold template missing exit condition placeholders | P1 | `SKILL.md` |
| #587 | Phase 6 missing exit condition — fails its own `lint-skill.sh` Check 9 | P1 | `SKILL.md` |
| #587 | `bash -n` uses PATH bash, not the version-guarded bash | P1 | `smoke-test-skill.sh` |
| #587 | Phase 4 missing exit condition — fails its own Check 9 and checklist item | P1 | `SKILL.md` |
| #565 | Timeout rule has no enforcement mechanism in the code | P1 | `SKILL.md` |
| #565 | Phase 5 has no explicit skip guard when regressions are found | P1 | `SKILL.md` |
| #565 | `command -v lsof` guard described in prose but absent from code snippet | P1 | `SKILL.md` |
| #565 | No recovery path when tests fail after clean-pop + `npm install` | P1 | `SKILL.md` |
| #557 | Step 5d has no mechanism to capture the "before" export count | P1 | `SKILL.md` |
| #557 | Step 5c and A2 deduplication has no explicit tracking mechanism | P1 | `SKILL.md` |
| #502 | `extractTypeMapWalk` has no recursion depth guard | P1 | `javascript.js` |
| #489 | `hasTable` guard inconsistency: `UPDATE` is guarded, indexes are not | P1 | `migrations.js` |
| #735 | `get_collect_files_data` — two unguarded queries can return inconsistent `count` and `files` | P2 | `native_db.rs` |
| #666 | `schema_version` table has no UNIQUE constraint and allows multiple rows | P2 | `native_db.rs` |
| #643 | Exception check has no corresponding command | P2 | `SKILL.md` |
| #628 | No tooling provided for the elapsed-time check | P2 | `SKILL.md` |
| #587 | Idempotency guard has no explicit abort path | P2 | `SKILL.md` |
| #565 | `--compare-only` doesn't guard the "First run" baseline save | P2 | `SKILL.md` |
| #557 | "Unexpected commits" check has no decision logic | P2 | `SKILL.md` |
| #538 | No guard against an empty `$VERSION` value | P2 | `publish.yml` |
| #509 | `_exportsCache` not invalidated during watch mode | P2 | `resolve.js` |
| #498 | `column` parameter not validated before SQL interpolation | P2 | `query-builder.js` |
| #489 | `ALTER TABLE` calls unguarded while `hasTable` guard exists below | P2 | `migrations.js` |
| #484 | Depth guard belongs in `walk_children`, not only in `walk` | P2 | `complexity.rs` |
| #474 | No iteration cap on the retry loop | unknown | `SKILL.md` |
| #474 | No clean-tree check before each PR checkout | unknown | `SKILL.md` |
| #473 | Missing merge-conflict guard in pre-flight | unknown | `SKILL.md` |
| #469 | `db.close()` not guarded by `finally` | unknown | `incremental-parity.test.js` |
| #444 | Missing input validation for `kind` and `role` | unknown | `in-memory-repository.js` |

</details>

#### Inconsistent Behavior (21) &mdash; P1: 1 | P2: 17 | unknown: 3

<details>
<summary>Show 21 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #523 | Inconsistent `mid` benchmark targets between engines | P1 | `QUERY-BENCHMARKS.md` |
| #785 | Inconsistent concurrency key vs. sibling workflows | P2 | `codegraph-impact.yml` |
| #756 | Edge gap percentage uses inconsistent denominators | P2 | `DOGFOOD_REPORT_v3.8.0.md` |
| #669 | Inconsistent naming of internal `pub(crate)` function | P2 | `insert_nodes.rs` |
| #644 | Inconsistent scoping condition between `loadNodes` and `scopedLoad` | P2 | `build-edges.ts` |
| #640 | Inconsistent constructor cast left in `openReadonlyOrFail` | P2 | `connection.ts` |
| #611 | `EXTENSIONS`/`IGNORE_DIRS` breaking change inconsistently classified | P2 | `DOGFOOD_REPORT_v3.4.0.md` |
| #595 | Fast path bypasses `initCfgParsers` but slow path still runs for `_tree` files | P2 | `cfg.ts` |
| #587 | Inconsistent stderr suppression between `trap` and explicit cleanup | P2 | `SKILL.md` |
| #587 | `mktemp -d` without template is inconsistent with Pattern 13 | P2 | `SKILL.md` |
| #583 | Inconsistent health scores within the same document | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #568 | Rule propagation relies on verbatim copy by the orchestrator | P2 | `SKILL.md` |
| #558 | Inconsistent DB type source across analysis modules | P2 | `module-map.ts` |
| #557 | V13 hardcodes `npm test` — inconsistent with gate's tool detection | P2 | `SKILL.md` |
| #557 | Inconsistent glob prefix on `.claude/ | P2 | `vitest.config.js` |
| #545 | Inconsistent `maxLocalPasses` fallback pattern in `refineWithinCoarseCommunities` | P2 | `optimiser.js` |
| #534 | Inconsistent return value on first vs. subsequent cache hits | P2 | `config.js` |
| #490 | Inconsistent guard clause style in `handleGoFuncDecl` | P2 | `go.js` |
| #469 | `needsCfg` gate is looser than `needsWasmCfg` | unknown | `engine.js` |
| #463 | `opts.config` origin may differ from old `loadConfig(repoRoot)` fallback | unknown | `check.js` |
| #434 | Direct `fs.readFileSync` instead of `readFileSafe` | unknown | `build-structure.js` |

</details>

#### Scope & Encapsulation (18) &mdash; P1: 4 | P2: 9 | unknown: 5

<details>
<summary>Show 18 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #708 | Local CPP_AST_CONFIG shadows the richer helpers.rs version | P1 | `cpp.rs` |
| #617 | Domain barrel re-exports from presentation layer | P1 | `impact.ts` |
| #568 | Scope creep — unrelated files bundled into a single-concern PR | P1 | `SKILL.md` |
| #558 | Hoisted `db.prepare()` calls escape their intended scope | P1 | `exports.ts` |
| #775 | `shared/` importing from `infrastructure/` crosses layer boundary | P2 | `errors.ts` |
| #621 | Domain barrel re-exports from presentation layer | P2 | `impact.ts` |
| #619 | Internal helper functions unnecessarily exported | P2 | `cfg-try-catch.ts` |
| #619 | `ProcessStatementsFn` belongs in `cfg-shared.ts`, not `cfg-loops.ts` | P2 | `cfg-loops.ts` |
| #568 | Subagent result format doesn't surface created follow-up issues | P2 | `SKILL.md` |
| #558 | Inline SQL bypasses the `db/index.js` abstraction layer | P2 | `context.ts` |
| #558 | Local `EngineOpts` shadows the exported type and weakens `engine` typing | P2 | `parser.ts` |
| #553 | Misplaced import declaration | P2 | `test.js` |
| #480 | Inconsistent import pattern vs. all other MCP tools | P2 | `brief.js` |
| #462 | Dataflow path bypasses Repository abstraction | unknown | `sequence.js` |
| #457 | Test-only utility exported through the public barrel | unknown | `index.js` |
| #443 | Domain layer imports visual constants from presentation layer | unknown | `viewer.js` |
| #433 | Internal helpers exported without barrel protection | unknown | `models.js` |
| #433 | `initEmbeddingsSchema` exported without `@internal` tag | unknown | `generator.js` |

</details>

#### Config & Constants (17) &mdash; P1: 3 | P2: 14

<details>
<summary>Show 17 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #557 | `/tmp/titan-barrel-before.tmp` hardcoded path never cleaned up | P1 | `SKILL.md` |
| #482 | C5 `SIMILARITY_WARN_THRESHOLD` has no config key and no wiring phase | P1 | `PLAN_centralize_config.md` |
| #482 | `build.driftThreshold` belongs in `build`, not `community` | P1 | `PLAN_centralize_config.md` |
| #620 | Placement vs. `DEFAULTS` in `config.ts` | P2 | `helpers.ts` |
| #591 | Hardcoded argument-container kind names may miss some language grammars | P2 | `helpers.rs` |
| #587 | Inline-`fi` resets `in_detect` before the hardcoded-command check runs on the same line | P2 | `lint-skill.sh` |
| #583 | `~5.9` pin recommendation is unnecessary | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #568 | Issue body URL anchor hardcoded to inline-comment format | P2 | `SKILL.md` |
| #565 | Hardcoded threshold in saved `baseline.json` | P2 | `SKILL.md` |
| #565 | Hardcoded `15%` threshold in Phase 6 report template | P2 | `SKILL.md` |
| #552 | `refinementTheta` default not added to `DEFAULTS.community` | P2 | `optimiser.js` |
| #545 | `directed: false` hardcoded silently | P2 | `louvain.js` |
| #545 | New tunable constants not added to `DEFAULTS` config | P2 | `optimiser.js` |
| #541 | Consider extracting kind sets as named constants | P2 | `edge_builder.rs` |
| #496 | Hardcoded `dev.1` breaks benchmark deduplication uniqueness | P2 | `bench-version.js` |
| #482 | Inconsistent magic-number count between plan and PR description | P2 | `PLAN_centralize_config.md` |
| #482 | C6 has no config key and no definitive phase assignment | P2 | `PLAN_centralize_config.md` |

</details>

#### Error Handling (13) &mdash; P1: 4 | P2: 7 | unknown: 2

<details>
<summary>Show 13 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #628 | Decision matrix has two unhandled cases | P1 | `SKILL.md` |
| #616 | `(e as Error).message` unsafe for non-Error throws | P1 | `config.ts` |
| #598 | `uncaughtException` handler is too broad | P1 | `server.ts` |
| #587 | git repo validation in prose — no explicit error handling or `exit 1` | P1 | `SKILL.md` |
| #704 | `suspendJsDb` called outside `try` — if `close()` throws, DB stays closed | P2 | `ast.ts` |
| #699 | Error cast may mask non-Error rejections | P2 | `incremental.ts` |
| #565 | Non-timeout, non-zero vitest exit codes leave corrupt run files unhandled | P2 | `SKILL.md` |
| #557 | `git fetch` in divergence check has no error handling | P2 | `SKILL.md` |
| #512 | Promise may be resolved twice on spawn failure | P2 | `fork-engine.js` |
| #512 | `process.exit(1)` bypasses callers' `cleanup` callbacks | P2 | `fork-engine.js` |
| #489 | `getBuildMeta` now propagates unexpected DB errors | P2 | `migrations.js` |
| #434 | DB left open on unhandled stage errors | unknown | `pipeline.js` |
| #433 | Consolidated error message loses diagnostic distinction | unknown | `prepare.js` |

</details>

#### Dependency & Import (11) &mdash; P1: 4 | P2: 4 | unknown: 3

<details>
<summary>Show 11 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #588 | Missing `--import` loader — benchmark scripts will fail on Node 22 | P1 | `benchmark.yml` |
| #588 | Missing `--import` loader — same resolution failure as line 96 | P1 | `benchmark.yml` |
| #588 | Missing `--import` loader — same resolution failure as line 96 | P1 | `benchmark.yml` |
| #588 | Missing `--import` loader — same resolution failure as line 96 | P1 | `benchmark.yml` |
| #744 | `yarn` pulled in as a transitive runtime dependency | P2 | `package-lock.json` |
| #743 | `yarn` pulled in as a runtime dependency via `tree-sitter-solidity` | P2 | `package-lock.json` |
| #582 | Extractor template missing import block | P2 | `adding-a-language.md` |
| #503 | Synchronous `fs.readFileSync` blocks event loop in async context | P2 | `parser.js` |
| #744 | Use npm overrides | unknown | `package-lock.json` |
| #459 | Broken dynamic import — resolves to non-existent file | unknown | `co-change.js` |
| #449 | Extraneous dependencies leaked into generated file | unknown | `DEPENDENCIES.json` |

</details>

#### Mutable Shared State (8) &mdash; P1: 3 | P2: 5

<details>
<summary>Show 8 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #528 | Mutable object returned by reference from cache | P1 | `config.js` |
| #528 | Cache miss returns un-cloned reference | P1 | `config.js` |
| #509 | `_workspaceResolvedPaths` not cleared on re-registration | P1 | `resolve.js` |
| #640 | `withArrayCompat` mutates the input `Set` via a type cast | P2 | `constants.ts` |
| #634 | `withArrayCompat` mutates `SUPPORTED_EXTENSIONS` in place | P2 | `constants.ts` |
| #575 | Cache never hits in current call path | P2 | `module-map.ts` |
| #534 | Same raw-reference return for the defaults branch | P2 | `config.js` |
| #506 | Module-level mutable state causes test isolation issues | P2 | `middleware.js` |

</details>

#### Naming & Label Semantics (5) &mdash; P2: 4 | unknown: 1

<details>
<summary>Show 5 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #702 | `codebase` is a category, not a severity | P2 | `SKILL.md` |
| #546 | Unconventional prime-suffix tier naming | P2 | `BACKLOG.md` |
| #494 | `test-only` condition can be made self-documenting | P2 | `roles.js` |
| #482 | `analysis.defaultDepth` name implies a global fallback it doesn't provide | P2 | `PLAN_centralize_config.md` |
| #431 | Semantic mismatch: `DbError` for a user-input guard | unknown | `snapshot.js` |

</details>

### Testing (42 comments)

#### Flaky, Brittle, or Incorrect (16) &mdash; P1: 5 | P2: 6 | unknown: 5

<details>
<summary>Show 16 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #628 | `test()` regex will match the reviewer bot's own response comments | P1 | `SKILL.md` |
| #622 | Performance assertions may cause flaky CI failures | P1 | `incremental-parity.test.ts` |
| #582 | Test import will fail for new extractors not in `parser.ts`'s named re-export block | P1 | `adding-a-language.md` |
| #565 | Flaky detection loop discards output — nothing to parse | P1 | `SKILL.md` |
| #557 | Louvain community IDs are non-deterministic — A1 comparison will produce false positives | P1 | `SKILL.md` |
| #735 | `find_reverse_dependencies` — non-deterministic result ordering via `HashSet` | P2 | `native_db.rs` |
| #702 | Heredoc in subshell is fragile with special characters | P2 | `SKILL.md` |
| #602 | Test title says "adding" but test body shows "replacing" | P2 | `cycles.test.ts` |
| #591 | Exact count parity assertion is fragile | P2 | `ast-parity.test.ts` |
| #586 | Mock targets the compat re-export, not the canonical module | P2 | `queries-cli.test.js` |
| #556 | Custom message passed to wrong location in Vitest | P2 | `leiden.test.js` |
| #472 | Test bypasses the package exports map | unknown | `index-exports.test.js` |
| #457 | Flaky non-git fallback test — same issue that was fixed in `findRepoRoot` | unknown | `db.test.js` |
| #457 | `realExecFileSync` is not the real function — it's the spy | unknown | `db.test.js` |
| #457 | Test name does not match what is being verified | unknown | `db.test.js` |
| #457 | Test assertion will fail on macOS when `/tmp` is the temp dir | unknown | `db.test.js` |

</details>

#### Incomplete Coverage (14) &mdash; P1: 2 | P2: 7 | unknown: 5

<details>
<summary>Show 14 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #557 | Forge Step 10 missing explicit test runner detection block | P1 | `SKILL.md` |
| #553 | `load` hook missing — `.ts` files cannot execute outside Vitest | P1 | `ts-resolver-loader.js` |
| #780 | Test only covers `source` strategy, not `structured` | P2 | `embedding-strategy.test.ts` |
| #622 | Parity test only validates trivially non-structural changes | P2 | `incremental-parity.test.ts` |
| #600 | No unit tests for `clean_path` | P2 | `import_resolution.rs` |
| #587 | Check 4 coverage gap for `yarn test` and `pnpm test` | P2 | `lint-skill.sh` |
| #587 | Phase 5 smoke-test template scaffolds only the happy path | P2 | `SKILL.md` |
| #565 | No re-test after clean stash pop + `npm install` on success path | P2 | `SKILL.md` |
| #522 | Skipped parity test removes the native-engine safety net | P2 | `parity.test.js` |
| #472 | Test does not check for extra keys on the CJS side | unknown | `index-exports.test.js` |
| #463 | New `isRepo` paths are untested | unknown | `dependency.js` |
| #444 | Missing parity coverage for several methods | unknown | `repository-parity.test.js` |
| #444 | Parity tests don't cover `__tests__`/`.stories.` exclusion patterns | unknown | `repository-parity.test.js` |
| #444 | Parity test for `listFunctionNodes` pattern doesn't cover LIKE wildcards | unknown | `repository-parity.test.js` |

</details>

#### Weak or Missing Assertion (12) &mdash; P0: 1 | P1: 3 | P2: 1 | unknown: 7

<details>
<summary>Show 12 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #595 | `allCfgNative` vacuously returns `true` for WASM-only builds | P0 | `cfg.ts` |
| #602 | Test doesn't compare both engines — only calls JS twice | P1 | `cycles.test.ts` |
| #595 | `allCfgNative` vacuously returns `true` when `fileSymbols` is empty | P1 | `cfg.ts` |
| #586 | `symbolPath` error test doesn't assert `result` returns after printing | P1 | `queries-cli.test.js` |
| #729 | Trivially-passing test assertions give no coverage | P2 | `verilog.test.ts` |
| #472 | Test only asserts key presence, not value identity | unknown | `index-exports.test.js` |
| #469 | CFG and dataflow tests may pass vacuously | unknown | `incremental-parity.test.js` |
| #461 | Vacuous `isNumeric` right-aligns fallback `value` column on empty result sets | unknown | `result-formatter.js` |
| #457 | Test silently passes without asserting | unknown | `db.test.js` |
| #457 | `findDbPath` fallback test doesn't control the ceiling | unknown | `db.test.js` |
| #457 | Loose assertions don't validate the found DB location precisely | unknown | `db.test.js` |
| #457 | Caching test does not actually verify caching | unknown | `db.test.js` |

</details>

### Documentation (111 comments)

#### Inaccurate Claim (39) &mdash; P1: 12 | P2: 24 | unknown: 3

<details>
<summary>Show 39 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #756 | No-op benchmark data contradicts BUG 2 | P1 | `DOGFOOD_REPORT_v3.8.0.md` |
| #702 | `process.exit(1)` contradicts "do not stop the pipeline" | P1 | `SKILL.md` |
| #675 | Section 6.13 heading/body contradiction | P1 | `ROADMAP.md` |
| #638 | Table header version conflicts with 1-file benchmark data | P1 | `ROADMAP.md` |
| #587 | "Dependency validation" checklist item conflates Claude Code tools with shell commands | P1 | `SKILL.md` |
| #587 | Pattern 6 test runner contradicts the Rules section (Pattern 7/8 violation) | P1 | `SKILL.md` |
| #587 | Phase 5 description understates Check 4's yarn/pnpm coverage | P1 | `SKILL.md` |
| #565 | `--compare-only` with no baseline: "exit" is ambiguous and Phase 6 reports a misleading verdict | P1 | `SKILL.md` |
| #565 | ABORTED branch checked after SAVE_ONLY — misleading "BASELINE SAVED" report | P1 | `SKILL.md` |
| #559 | Key Metrics "growing fast" contradicts stagnation note | P1 | `narsil-mcp.md` |
| #502 | Misleading "native deferred" comment | P1 | `build.test.js` |
| #482 | D4 conflates two distinct constants with different values into one key | P1 | `PLAN_centralize_config.md` |
| #789 | PR description overstates bug fix count | P2 | `CHANGELOG.md` |
| #771 | Interface inserted inside misleading doc-comment block | P2 | `engine.ts` |
| #730 | Misleading "interface-specific" comment — handlers apply to `.ml` too | P2 | `ocaml.ts` |
| #721 | PR description mentions `libc` field restoration but diff shows no such change | P2 | `package-lock.json` |
| #652 | "4 runtime dependencies" claim may not hold | P2 | `ROADMAP.md` |
| #641 | PR description mentions `libc` restoration not present in diff | P2 | `package-lock.json` |
| #639 | PR description references a change not present in the diff | P2 | `package-lock.json` |
| #638 | Section 6.5 result conflicts with new benchmark table | P2 | `ROADMAP.md` |
| #595 | Inaccurate test description for `complex-dowhile.js` | P2 | `cfg-all-langs.test.ts` |
| #591 | Misleading variable name after semantic change | P2 | `ast.ts` |
| #587 | "Top 10" description contradicts 13 defined patterns | P2 | `SKILL.md` |
| #587 | Rules section understates prohibited npm commands | P2 | `SKILL.md` |
| #559 | PR description says "7 roadmap items" but 8 are marked DONE | P2 | `COMPETITIVE_ANALYSIS.md` |
| #558 | Underscore-prefix on used variables is misleading | P2 | `node-version.js` |
| #557 | `--yes` description inaccurate — forge no longer accepts this flag | P2 | `SKILL.md` |
| #557 | `--yes` description contradicts the Rules section and the dispatch code | P2 | `SKILL.md` |
| #557 | "Advisory" label misleading for semantic/arch FAILs | P2 | `SKILL.md` |
| #552 | Zero-dep ✓ claim may need a caveat for the seedable PRNG | P2 | `BACKLOG.md` |
| #510 | "cosmetic only" may over-reassure in edge cases | P2 | `info.js` |
| #503 | Tier 1j header incorrectly claims all items are zero-dep | P2 | `BACKLOG.md` |
| #498 | Inaccurate comment — array is passed directly, not joined | P2 | `search.js` |
| #482 | `briefBfsDepth` conflates two independently meaningful BFS depths | P2 | `PLAN_centralize_config.md` |
| #480 | Misleading "falls back to deps" comment — no actual fallback | P2 | `enrich-context.sh` |
| #479 | `COMMITS=0` produces a misleading version | P2 | `publish.yml` |
| #474 | Contradicts "one concern per commit" rule | unknown | `SKILL.md` |
| #472 | Node >= 22 sync-require comment is inaccurate | unknown | `index.cjs` |
| #443 | Module doc contradicts `loadPlotConfig` I/O | unknown | `viewer.js` |

</details>

#### Numbering & Scoring Errors (29) &mdash; P1: 12 | P2: 8 | unknown: 9

<details>
<summary>Show 29 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #638 | Benchmark totals significantly exceed sum of listed phases | P1 | `ROADMAP.md` |
| #559 | GitNexus overall score doesn't match breakdown sub-scores | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Sub-score mismatch on two updated entries | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Ranking inversion: rank #23 (3.3) scored lower than rank #24 (3.4) | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Ranking inversion: codegraph (#5, 4.5) placed below code-graph-rag (#4, 4.2) | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Scoring breakdown row numbers out of sync with ranking table after #23/#24 swap | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Ranking inversion: codebase-memory-mcp (4.3) placed below code-graph-rag (4.2) | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Ranking inversion: arbor (4.2) placed below 3.8-scoring entries (#9–#12) | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Three more sub-score/overall-score mismatches remaining | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Three more sub-score/overall-score mismatches remaining | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | SPA version attribution mismatch | P1 | `COMPETITIVE_ANALYSIS.md` |
| #559 | glimpse sub-scores don't match updated overall ranking score | P1 | `COMPETITIVE_ANALYSIS.md` |
| #756 | Build time figures differ 50% between Section 2 and Section 8 | P2 | `DOGFOOD_REPORT_v3.8.0.md` |
| #723 | Priority matrix is missing 2 of the 22 patterns | P2 | `claude-code-architecture-lessons.md` |
| #583 | Post-fix health score math doesn't add up | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #559 | Star count in section header diverges from ranking table | P2 | `COMPETITIVE_ANALYSIS.md` |
| #559 | Pre-existing sub-score/overall-score mismatches on two untouched entries | P2 | `COMPETITIVE_ANALYSIS.md` |
| #546 | "Depends on" column should reference #545 for items #100–#102 | P2 | `BACKLOG.md` |
| #514 | ID #97 inserted out of numerical order | P2 | `BACKLOG.md` |
| #482 | Phase count mismatch — plan body has 7 phases, scope table shows 6 | P2 | `PLAN_centralize_config.md` |
| #473 | Rule count mismatch: 31 vs 17 | unknown | `titan-paradigm.md` |
| #471 | Sub-section numbers don't match parent phase | unknown | `ROADMAP.md` |
| #471 | Same sub-section renumbering mismatch as Phase 2.5 | unknown | `ROADMAP.md` |
| #471 | Inconsistent phase cross-reference in Phase 11 note | unknown | `ROADMAP.md` |
| #471 | "Before" version in Phase 2.7 summary now equals Phase 2.5's completion version | unknown | `ROADMAP.md` |
| #470 | Missed section renumber | unknown | `ROADMAP.md` |
| #464 | Section 9.5 misplaced after Phase 10 | unknown | `ROADMAP.md` |
| #460 | Missed renumber: 9.6 → 10.6 | unknown | `ROADMAP.md` |
| #447 | Phase 3 progress count is inconsistent with ROADMAP. | unknown | `README.md` |

</details>

#### Missing or Incomplete (21) &mdash; P1: 4 | P2: 16 | unknown: 1

<details>
<summary>Show 21 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #582 | Guide omits required import block update in `parser.ts` | P1 | `adding-a-language.md` |
| #582 | `src/types.ts` requires more edits than noted — `LanguageId` union must be extended | P1 | `adding-a-language.md` |
| #565 | Timeout note is documented but never enforced | P1 | `SKILL.md` |
| #557 | G3 corruption recovery procedure is not documented | P1 | `SKILL.md` |
| #727 | Missing explanation for absent native engine | P2 | `INCREMENTAL-BENCHMARKS.md` |
| #642 | `claude` scope missing from PR description | P2 | `SKILL.md` |
| #587 | `find -quit` is a GNU extension — undocumented in Pattern 13 | P2 | `SKILL.md` |
| #587 | Undocumented behavioral change to hook scope | P2 | `settings.json` |
| #587 | lint-skill.sh description omits `npm run test` and `npm run lint` coverage | P2 | `SKILL.md` |
| #587 | `lint-skill.sh` description omits `git add -- .` | P2 | `SKILL.md` |
| #587 | Pattern 13 doesn't document the `\| grep -q .` alternative to `find -quit` | P2 | `SKILL.md` |
| #583 | 3 moderate vulnerabilities are unaccounted for in the Security Vulnerabilities section | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #583 | `tar` section missing CVSS scores | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #583 | Unspecified transitive path for `minimatch` and `tar` | P2 | `DEPS_AUDIT_2026-03-24.md` |
| #582 | `extractModifierVisibility` parameter type not documented | P2 | `adding-a-language.md` |
| #582 | `ExtractorOutput` interface snippet omits additional post-analysis fields | P2 | `adding-a-language.md` |
| #568 | No guidance on when "genuinely out of scope" applies | P2 | `SKILL.md` |
| #539 | JSDoc header missing Scenario 4 (file deletion) | P2 | `incremental-edge-parity.test.js` |
| #519 | "Behind" check doesn't show delta vs current branch | P2 | `SKILL.md` |
| #485 | `--yes` flag undocumented | P2 | `SKILL.md` |
| #457 | Undocumented behavior change for non-worktree users | unknown | `connection.js` |

</details>

#### Ambiguous or Confusing (10) &mdash; P1: 1 | P2: 8 | unknown: 1

<details>
<summary>Show 10 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #557 | "Steps 1-3, 5-8" range is ambiguous — Step 5.5 may be excluded by AI interpretation | P1 | `SKILL.md` |
| #700 | Empty `if` block obscures intent | P2 | `rust.ts` |
| #659 | Ambiguous referent for "these" | P2 | `CLAUDE.md` |
| #565 | Ambiguous if/if prose — timeout and non-zero checks can both trigger | P2 | `SKILL.md` |
| #557 | `diffWarnings` append semantics are ambiguous | P2 | `SKILL.md` |
| #557 | `"check": "D3\|D5"` schema notation is ambiguous — agent may emit a literal pipe-separated value | P2 | `SKILL.md` |
| #546 | `BLOCKED` implies future work is still needed after #545 ships | P2 | `BACKLOG.md` |
| #482 | Phase 2's `check.js` wiring is ambiguous about which key takes precedence | P2 | `PLAN_centralize_config.md` |
| #480 | Implicit assumption: `transitiveImporterCount` includes direct importers | P2 | `brief.js` |
| #437 | `LIMIT 1` silently hides ambiguous qualified names across files | unknown | `nodes.js` |

</details>

#### Stale or Wrong Comment (7) &mdash; P2: 5 | unknown: 2

<details>
<summary>Show 7 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #758 | Comment says `≤3.8.0` but check is strict equality | P2 | `pipeline.ts` |
| #737 | Comment references helpers that aren't used | P2 | `insert-nodes.ts` |
| #722 | Comment references the wrong grammar source | P2 | `clojure.ts` |
| #593 | Comment claims previous-line check, but implementation only checks current line | P2 | `lint-skill.sh` |
| #545 | Overly-specific catch comment | P2 | `overview.js` |
| #543 | Confirmed ✓ — the issues endpoint is now included in the checklist, so reviewers who only leave issu | unknown | `SKILL.md` |
| #443 | JSDoc documents wrong field name | unknown | `export.js` |

</details>

#### Broken Link or Anchor (5) &mdash; P1: 2 | P2: 1 | unknown: 2

<details>
<summary>Show 5 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #546 | Section description references a non-existent path | P1 | `BACKLOG.md` |
| #524 | Broken links to existing benchmark files removed from README | P1 | `README.md` |
| #602 | Issue link points to a different GitHub repository | P2 | `cycles.ts` |
| #471 | Broken anchor links to section 5.7 | unknown | `ROADMAP.md` |
| #471 | Broken anchor link (same issue as line 1230) | unknown | `ROADMAP.md` |

</details>

### Database (7 comments)

#### Schema & Migration (4) &mdash; P1: 2 | P2: 1 | unknown: 1

<details>
<summary>Show 4 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #757 | Empty `changedFiles` array generates invalid SQL | P1 | `pipeline.ts` |
| #558 | `exportedNodesStmt` prepared unconditionally — throws for older databases | P1 | `exports.ts` |
| #558 | `ChildNodeRow` is missing `file` — workaround cast in place of a type fix | P2 | `symbol-lookup.ts` |
| #437 | Migration doesn't backfill `qualified_name` for existing databases | unknown | `migrations.js` |

</details>

#### WAL & Integrity (3) &mdash; P1: 1 | P2: 2

<details>
<summary>Show 3 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #736 | Missing rusqlite WAL checkpoint before closing nativeDb | P1 | `pipeline.ts` |
| #737 | Native WAL checkpoint issued before `nativeDb.close()` | P2 | `insert-nodes.ts` |
| #651 | `bundled` feature embeds a second independent copy of SQLite into the process | P2 | `Cargo.toml` |

</details>

### Process (38 comments)

#### Procedure & Skill Violations (15) &mdash; P1: 8 | P2: 6 | unknown: 1

<details>
<summary>Show 15 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #673 | CLAUDE.md rule violation: parity bug documented as expected behavior | P1 | `build-parity.test.ts` |
| #593 | Pattern 15 "Correct" example violates Pattern 1 | P1 | `SKILL.md` |
| #587 | Pattern 6's "Correct" example violates Pattern 1 | P1 | `SKILL.md` |
| #587 | Phase 3 lint template violates Pattern 2 (its own rule) | P1 | `SKILL.md` |
| #587 | Missing Examples section violates own Phase 4 checklist | P1 | `SKILL.md` |
| #587 | Phase 3 lint template violates Pattern 13 (glob expansion) | P1 | `SKILL.md` |
| #587 | Pattern 15 "Correct" example violates Pattern 1 | P1 | `SKILL.md` |
| #565 | Lock file removal code does not respect `DRY_RUN` — violates the "DRY_RUN is sacred" rule | P1 | `SKILL.md` |
| #587 | Lint detection uses prose instead of an explicit script (violates Pattern 6) | P2 | `SKILL.md` |
| #565 | Commit command deviates from project's "specific file paths" convention | P2 | `SKILL.md` |
| #565 | `find` command bypasses Glob tool convention | P2 | `SKILL.md` |
| #517 | Missing YAML frontmatter — skill will not register correctly | P2 | `SKILL.md` |
| #517 | Missing worktree isolation step — violates parallel-session safety policy | P2 | `SKILL.md` |
| #517 | No commit or PR phase — canonical output will never reach git | P2 | `SKILL.md` |
| #474 | Missing `/worktree` isolation step | unknown | `SKILL.md` |

</details>

#### Incomplete Procedure (11) &mdash; P1: 3 | P2: 7 | unknown: 1

<details>
<summary>Show 11 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #587 | Phase 5 smoke test has no cleanup trap — working directory may be left dirty | P1 | `SKILL.md` |
| #565 | Phase 6 has no ABORTED report template, and Phase 7 summary is also missing the ABORTED case | P1 | `SKILL.md` |
| #557 | Step 3.5 missing explicit skip condition for `--start-from forge` | P1 | `SKILL.md` |
| #787 | Step 2f missing the "wrong branch" failure case present in the Rules section | P2 | `SKILL.md` |
| #677 | `<pre-merge-commit>` placeholder has no capture instruction | P2 | `SKILL.md` |
| #565 | Missing verdict path when `--save-baseline` is passed and a baseline already exists | P2 | `SKILL.md` |
| #565 | Phase 6 report template missing `BASELINE SAVED` verdict path | P2 | `SKILL.md` |
| #543 | Reviewer checklist missing the third endpoint | P2 | `SKILL.md` |
| #485 | Subphase tracking missing from execution state schema | P2 | `SKILL.md` |
| #482 | C3 (`semantic.js` limit) missing from Phase 4 wiring | P2 | `PLAN_centralize_config.md` |
| #467 | Missing "After modifying code" step | unknown | `CLAUDE.md` |

</details>

#### Version & Release (10) &mdash; P1: 4 | P2: 6

<details>
<summary>Show 10 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #710 | Incorrect language count in CHANGELOG summary | P1 | `CHANGELOG.md` |
| #552 | "Breaking: No" may be incorrect for a probabilistic algorithm change | P1 | `BACKLOG.md` |
| #514 | Breaking column should be `Yes`, not `No` | P1 | `BACKLOG.md` |
| #511 | `sync-native-versions.js` still modifies `Cargo.toml` — `version` hook won't stage it | P1 | `SKILL.md` |
| #777 | Exact version match vs. semver range | P2 | `build-edges.ts` |
| #718 | v3.6.0 CHANGELOG entry describes the wrong language batch | P2 | `CHANGELOG.md` |
| #552 | Breaking item not placed in separate subsection | P2 | `BACKLOG.md` |
| #499 | Two notable commits missing from changelog | P2 | `CHANGELOG.md` |
| #496 | `COMMITS=0` emits a clean semver dev build, no `-dev` suffix | P2 | `publish.yml` |
| #479 | Fallback commit count diverges from `publish.yml` | P2 | `bench-version.js` |

</details>

#### CI & Build (1) &mdash; P1: 1

<details>
<summary>Show 1 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #779 | `npm install` without `--no-save` will mutate the user's `package.json` in CI | P1 | `models.ts` |

</details>

#### Scope Creep & Bundling (1) &mdash; P1: 1

<details>
<summary>Show 1 comments</summary>

| PR | Title | Priority | File |
|---:|-------|:--------:|------|
| #640 | Behavioral change bundled into a type-only refactor | P1 | `resolve-imports.ts` |

</details>
