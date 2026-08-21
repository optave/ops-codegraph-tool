# Implementation Plan: <task title>

<!-- This header is provenance metadata, not decoration. The read-only staleness validator
     (/oversee "Validate plan freshness") diffs this plan's document dependency tree — the
     tracking issue, the roadmap phase entry, the ADRs it cites — for changes since the plan
     was authored. A plan missing the Tracking line is UNVERIFIABLE and is never executed.
     Keep all four lines. -->

**Date:** YYYY-MM-DD
**Author:** planner-agent
**Status:** Draft | In Review | Approved | In Progress | Complete
**Tracking:** issue #`<n>` · Roadmap `docs/roadmap/ROADMAP.md` Phase `<n.n>` (or `BACKLOG.md` entry, or "no roadmap entry — issue-only") · ADRs relied on: `<001-dual-engine-architecture | none>`

## Overview

<!-- 2-3 sentences: what is being built, why now, which subsystem it plugs into (parser /
     resolution / graph / features / presentation / MCP / native engine). Write it so someone
     who has not read the roadmap can still place the plan. -->

## Requirements

<!-- Hard constraints this plan must satisfy. Explicitly name which CLAUDE.md non-negotiables
     apply (dual-engine parity, DEFAULTS config, LANGUAGE_REGISTRY as single source of truth,
     runtime imports in `dependencies`, one PR = one concern) and any ADR that binds the
     approach. This is where a reviewer checks "does this plan respect the rules" without
     re-reading CLAUDE.md. -->

---

## Folder Structure

<!-- Every new/modified file, annotated NEW or MODIFIED with a one-line purpose. Required for
     every plan — no tree means the plan is incomplete. This is the fastest thing a human
     reviewer or the staleness validator scans to size the blast radius. -->

```text
src/domain/example.ts                          MODIFIED  <what changes and why>
crates/codegraph-core/src/domain/example.rs     MODIFIED  <mirrored native change>
tests/integration/example.test.ts               NEW       <what it proves>
```

## Dual-Engine Impact

<!-- MANDATORY. Both engines must produce identical results (CLAUDE.md). State one of:
     - "TS only — this path never runs in the native engine, because <reason>"
     - "Both engines — the mirrored native module is <path> and changes as follows: <...>"
     A plan that touches extraction, resolution, graph algorithms, or ast_nodes and does NOT
     name its mirrored native counterpart is incomplete, not concise. Note whether
     `npm run build` is required before any WASM-path check (the WASM engine parses in
     workers loading compiled `dist/`, so src-only edits are invisible to it). -->

## Configuration & Registry Impact

<!-- Any new behavioral constant goes in `DEFAULTS` (`src/infrastructure/config.ts`) and is
     wired through config — name the group (analysis/risk/search/display/community/structure/
     mcp/check/coChange/manifesto) and the key. Any new language needs one `LANGUAGE_REGISTRY`
     entry + extractor + matching `AST_TYPE_MAPS`/`AST_STRING_CONFIGS` entry AND the native
     `LangAstConfig` constant. State "none" explicitly when neither applies. -->

## Interface Definitions

<!-- Full typed signatures for any new seam (exported function, type, MCP tool, CLI command,
     napi binding). State whether this plan lands a signatures-only stub for downstream work to
     build against in parallel, or ships the full implementation — and why. -->

```ts
<typed signature block>
```

## Dependency Graph

<!-- ASCII diagram of the Work Units below, showing parallel lanes and sync points. -->

```text
WU-1 ──┬── WU-2 (parallel) ──┐
       └── WU-3 (parallel) ──┴── WU-4 (sync point)
```

## Work Units

<!-- Atomic, independently-testable pieces. Every field below is required — they are what let a
     builder agent execute the plan without re-deriving the design. The Implementation
     subsection is REQUIRED for any non-trivial WU: real code, not prose. -->

### WU-1: `<name>`

- **Layer:** shared | infrastructure | db | domain | features | presentation | graph | mcp | ast-analysis | native (Rust) | tests | docs
- **Blocked by:** `<WU-n>` or none
- **Blocks:** `<WU-n>` or none
- **Files:** `<paths this WU owns>`
- **Input contract:** `<what it consumes, from where>`
- **Output contract:** `<what it produces, for whom>`
- **Verification:** `<the exact command that proves it — e.g. `npx vitest run tests/parsers/x.test.ts`>`
- **Risk:** Low | Medium | High — `<why>`

#### Implementation

```ts
<actual code for this WU — not a description of code>
```

> **Why:** `<rationale for any non-obvious decision above>`

### WU-2: `<name>`

<!-- repeat the WU-1 shape for every work unit -->

## Critical Path

<!-- The longest sequential chain of Work Units, and why it is the bottleneck. -->

## Testing Strategy

<!-- Name the tier each test belongs to, and never let a cheap tier read as if it proved an
     expensive one:
       - unit / parser extraction (`tests/parsers/`)
       - integration over the fixture project (`tests/integration/`)
       - resolution precision/recall against an expected-edges manifest
         (`tests/benchmarks/resolution/`)
       - dual-engine parity (both engines on the same fixture must agree)
       - benchmark / perf canary
     If a change cannot be covered at the tier that would actually catch a regression, say so
     explicitly and name what a human must check instead. -->

## Verification Commands

<!-- The literal commands VERIFY will run. Keep them copy-pasteable and unpiped: piping a check
     through `tail`/`head` masks its exit code. -->

```bash
npm run lint
npx tsc --noEmit
npm run build            # required before ANY WASM-engine check — that engine loads dist/
npm test
npm run doctor
codegraph diff-impact --staged -T
# add `cargo test` / `cargo clippy --all-targets` if this plan touches crates/codegraph-core/
```

## Risks & Mitigations

<!-- Where you can anticipate a reviewer objection, pre-rebut it by pointing at the section that
     already answers it. -->

| Risk | Mitigation |
|---|---|
| `<risk>` | `<mitigation, cited to a section above where possible>` |

## Out of Scope (filed, not silently dropped)

<!-- CLAUDE.md scope discipline: anything found while planning that does not belong in this
     task gets a GitHub issue NOW, and is listed here with its issue number. "Noticed but not
     filed" is not an acceptable entry. -->

- `<finding>` → issue #`<n>`

## Success Criteria

<!-- One checklist restating Done-when across all Work Units — this plan's own acceptance test.
     A human approving the plan, or VERIFY checking the execute PR, should be able to confirm
     "done" against this list alone. -->

- [ ] `<criterion>`

---

<!-- Full Delivery Scope Rule: if a section above is genuinely empty for this task, write
     "N/A: <why>" rather than deleting it. An omitted section reads as an oversight; an explicit
     N/A reads as a checked box. -->
