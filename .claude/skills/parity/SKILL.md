---
name: parity
description: Audit WASM/native engine correctness parity across all resolution fixtures and fix any divergence at the root cause — both engines must produce identical graphs
argument-hint: "[--langs js,python] [--hybrid] [--audit-only]"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /parity — Engine Correctness Parity Audit & Fix

Codegraph has two engines that MUST produce identical results (see CLAUDE.md):

- **wasm** — JS pipeline + JS extractors + JS edge resolution
- **native** — full Rust orchestrator (`crates/codegraph-core/src/domain/graph/builder/pipeline.rs`)
- **hybrid** — JS pipeline + napi `buildCallEdges` (the fallback when the
  orchestrator is skipped: forced full rebuilds, older addons)

This skill runs `scripts/parity-compare.mjs`, which builds every
resolution-benchmark fixture with each engine and compares the **full node and
edge multisets** (kind, name, file, line, confidence, dynamic flag). Any
difference is a bug in the less-accurate engine — never an acceptable gap, and
never something to document as expected. The skill finds the root cause, fixes
it, and re-verifies until the audit is clean.

## Arguments

- `$ARGUMENTS` may contain:
  - `--langs a,b,c` — restrict to specific fixture names (e.g. `javascript,pts-javascript`)
  - `--hybrid` — also audit the hybrid path (recommended; slower)
  - `--audit-only` — report divergences without fixing them
  - No arguments — full audit across all fixtures, then fix divergences

## Phase 0 — Pre-flight

All steps run from the repo root.

1. Confirm `scripts/parity-compare.mjs` exists. If not, this repo doesn't have
   the parity tooling — stop and report.
2. Build the TypeScript dist (the script imports `dist/index.js`, and extractor
   changes in `src/` are invisible until rebuilt):
   ```bash
   npm run build
   ```
3. Ensure the native addon reflects the local Rust source:
   ```bash
   cd crates/codegraph-core && npx napi build --platform --release && cd ../..
   ```
   On macOS, locally built binaries must be re-signed or Node kills the process
   (exit 137):
   ```bash
   codesign --sign - --force crates/codegraph-core/*.node
   ```
4. Verify the loader picks up the **locally built** binary, not the published
   package. First check which path is actually resolved:
   ```bash
   node -e "
     const { createRequire } = require('node:module');
     const r = createRequire(require.resolve('./dist/index.js'));
     try { console.log(r.resolve('codegraph-core')); } catch { console.log('not found via require'); }
   "
   ```
   If the resolved path points to
   `node_modules/@optave/codegraph-<platform>-<arch>/codegraph-core.node`
   (the installed package), copy your freshly built binary over it:
   ```bash
   cp crates/codegraph-core/*.node node_modules/@optave/codegraph-<platform>-<arch>/codegraph-core.node
   ```
   Then confirm the loader picks it up:
   ```bash
   node -e "import('./dist/infrastructure/native.js').then(m => console.log(m.isNativeAvailable()))"
   ```
   If `false`, stop and report — auditing parity without the native engine is
   meaningless.

## Phase 1 — Audit

Run the comparison (pass through `--langs` / `--hybrid` from `$ARGUMENTS`):

```bash
node scripts/parity-compare.mjs [--langs ...] [--hybrid] 2>/dev/null
```

- Exit 0 → parity holds. Skip to Phase 4 and report a clean audit.
- Exit 1 → divergences or fixture build failures. Collect every `[node]` /
  `[edge]` diff line and any `BUILD FAILED` fixtures.
- Exit 2 → pre-flight failure; go back to Phase 0.

For machine-readable output (useful when many fixtures diverge), re-run with
`--json` and parse `fixtures[].comparisons[].nodeDiffs/edgeDiffs`.

If `--audit-only` was passed: report the diffs (Phase 4 format) and stop.

## Phase 2 — Root-cause and fix

For each divergence, identify which engine is wrong — the one missing edges or
producing lower-quality resolution is usually the buggy one, but verify by
reading the fixture source and deciding what the *correct* graph is.

**Localize the bug by which paths disagree:**

| wasm | hybrid | native | Bug location |
|------|--------|--------|--------------|
| A | A | B | Rust pipeline prep (`pipeline.rs`) or Rust extractor (`crates/.../extractors/`) — the napi solver gets correct input from JS but the orchestrator's own input differs |
| A | B | B | Rust `build_edges.rs` solver (shared by hybrid + native) |
| A | B | A | JS↔napi boundary: `NativeFileEntry` plumbing in `build-edges.ts` or the wasm-worker protocol |
| B | A | A | JS extractor or JS resolution (`src/extractors/`, `src/domain/graph/builder/stages/build-edges.ts`) |

**Fix rules (from CLAUDE.md — non-negotiable):**

- Fix the extraction/resolution layer that produces incorrect results. Never
  add comments, tests, or fixture exclusions that frame wrong output as
  expected.
- Changes may land in either language or both — create the best version based
  on both implementations, don't restrict the fix to one side.
- The module layout is mirrored between `src/` and `crates/codegraph-core/src/`
  — read the TS and Rust counterparts side by side (e.g.
  `src/domain/graph/builder/stages/build-edges.ts` ↔
  `crates/.../domain/graph/builder/stages/build_edges.rs`).
- Mirror *semantics exactly*: confidence constants, hop penalties, tie-breaking
  order, first-wins vs highest-wins rules. A 0.05 confidence difference is a
  parity failure.
- Add a focused unit test next to the fix (Rust `#[cfg(test)]` or vitest) that
  pins the behavior.

**Gotchas that mask fixes:**

- `src/` changes need `npm run build` before the script (which imports dist)
  sees them.
- Rust changes need the napi rebuild + macOS codesign from Phase 0.
- New `ExtractorOutput` fields must be added to `SerializedExtractorOutput` in
  `src/domain/wasm-worker-{protocol,entry,pool}.ts` or they are silently
  dropped at the Worker-thread boundary.
- New per-file fields crossing the napi boundary need: the `FileSymbols` /
  `FileEdgeInput` structs in `crates/.../types.rs` & `build_edges.rs`, the
  `NativeFileEntry` assembly in `build-edges.ts`, and the orchestrator's own
  assembly in `pipeline.rs` (`build_and_insert_call_edges`). Missing the last
  one produces hybrid-OK/native-broken splits.
- Out-of-scope findings discovered along the way (pre-existing bugs, refactor
  opportunities) → `gh issue create` immediately, then continue.

## Phase 3 — Verify

Repeat until the audit is clean — never stop at "fewer diffs than before":

1. Rebuild whichever side changed (`npm run build` / napi build + codesign).
2. Re-run the Phase 1 audit command. Any remaining divergence → back to Phase 2.
3. Once clean, run the full verification suite — all must pass:
   ```bash
   cargo test --manifest-path crates/codegraph-core/Cargo.toml
   npm test
   npx vitest run tests/benchmarks/resolution/resolution-benchmark.test.ts
   ```
   (From a `.claude` worktree, vitest needs the worktree override config —
   check memory/project notes if no tests are found.)
4. If any verification step cannot run, STOP and report it — never proceed
   with unverified changes.

## Phase 4 — Report

Print a summary:

```
PARITY AUDIT — <date>
Fixtures audited: N (wasm vs native[, hybrid])
Divergences found: M
Fixed: <file:line summary per fix, with engine + root cause>
Verification: cargo test ✓ | npm test ✓ | resolution benchmark ✓
Issues filed: #NNN (out-of-scope findings)
```

- If divergences were found and fixed, list each root cause in one line —
  which engine was wrong, which layer, what semantic was mismatched.
- If `--audit-only`: list divergences grouped by fixture with the
  wasm/hybrid/native localization table applied.
- Suggest committing engine fixes separately from unrelated work (one PR = one
  concern).

## Rules

- **Zero divergence is the only passing state** — a single edge differing in
  confidence is a failure.
- **Never exclude a fixture or file to make the audit pass.**
- **Never run the audit against a stale dist or stale native binary** — Phase 0
  is mandatory after any code change.
- **The wasm/hybrid/native disagreement pattern localizes the bug** — use the
  table before reading code.
- **Both engines evolve together**: a feature added to one engine without the
  other is a parity bug from day one. New resolution techniques must land in
  `src/` and `crates/codegraph-core/src/` in the same PR.
