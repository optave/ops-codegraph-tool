# Plan: Centralize Hardcoded Configuration

> **Goal:** Eliminate magic numbers scattered across the codebase by routing all tunable parameters through the existing `.codegraphrc.json` config system (`DEFAULTS` in `src/infrastructure/config.js`).

## Problem

The config system already exists and handles env overrides, but ~70 individual behavioral constants (34 inventory entries expanding to ~70 discrete values when counting sub-keys in B1, B2, and E1) are hardcoded in individual modules and never read from config. Users cannot tune thresholds, depths, weights, or limits without editing source code.

---

## Inventory of Hardcoded Values

### Category A — Analysis Parameters (high user value)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| A1 | `maxDepth = 5` | `domain/analysis/impact.js` | 111 | `fn-impact` transitive caller depth |
| A2 | `maxDepth = 3` | `domain/analysis/impact.js` | 31, 144 | BFS default depth for impact/diff-impact |
| A3 | `maxDepth = 3` | `features/audit.js` | 102 | Audit blast-radius depth |
| A4 | `maxDepth = 3` | `features/check.js` | 220 | CI check blast-radius depth |
| A5 | `maxDepth = 10` | `features/sequence.js` | 91 | Sequence diagram traversal depth |
| A6 | `FALSE_POSITIVE_CALLER_THRESHOLD = 20` | `domain/analysis/module-map.js` | 37 | Generic function false-positive filter |
| A7 | `resolution = 1.0` | `graph/algorithms/louvain.js` | 17 | Louvain community detection granularity |
| A8 | `driftThreshold = 0.3` | `features/structure.js` | 581 | Structure cohesion drift warning |
| A9 | `maxCallers >= 10` | `domain/analysis/brief.js` | 38 | `brief` high-risk tier threshold |
| A10 | `maxCallers >= 3` | `domain/analysis/brief.js` | 39 | `brief` medium-risk tier threshold |
| A11 | `maxDepth = 5` | `domain/analysis/brief.js` | 47 | `brief` transitive caller BFS depth |
| A12 | `maxDepth = 5` | `domain/analysis/brief.js` | 73 | `brief` transitive importer BFS depth |

### Category B — Risk & Scoring Weights (medium-high user value)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| B1 | `fanIn: 0.25, complexity: 0.3, churn: 0.2, role: 0.15, mi: 0.1` | `graph/classifiers/risk.js` | 10-14 | Risk score weighting |
| B2 | `core: 1.0, utility: 0.9, entry: 0.8, adapter: 0.5, leaf: 0.2, dead: 0.1` | `graph/classifiers/risk.js` | 21-27 | Role importance weights |
| B3 | `DEFAULT_ROLE_WEIGHT = 0.5` | `graph/classifiers/risk.js` | 30 | Fallback role weight |

### Category C — Search & Embedding (already partially in config)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| C1 | `limit = 15` | `domain/search/search/hybrid.js` | 12 | Hybrid search default limit |
| C2 | `rrfK = 60` | `domain/search/search/hybrid.js` | 13 | RRF fusion constant |
| C3 | `limit = 15` | `domain/search/search/semantic.js` | 12 | Semantic search default limit |
| C4 | `minScore = 0.2` | `domain/search/search/semantic.js` | 13, 52 | Minimum similarity threshold |
| C5 | `SIMILARITY_WARN_THRESHOLD = 0.85` | `domain/search/search/semantic.js` | 71 | Duplicate query warning |
| C6 | Batch sizes per model | `domain/search/models.js` | 66-75 | Embedding batch sizes |

### Category D — Display & Truncation (low-medium user value)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| D1 | `MAX_COL_WIDTH = 40` | `presentation/result-formatter.js` | 82 | Table column width |
| D2 | `50 lines` | `shared/file-utils.js` | 23 | Source context excerpt length |
| D3 | `100 chars` | `shared/file-utils.js` | 48, 63 | Summary/docstring truncation |
| D4a | `10 lines` | `shared/file-utils.js` | 36 | JSDoc block-end scan depth (upward scan for `*/`) |
| D4b | `20 lines` | `shared/file-utils.js` | 54 | JSDoc opening scan depth (upward scan for `/**`) |
| D5 | `5 lines` | `shared/file-utils.js` | 76 | Multi-line signature gather |

### Category E — MCP Pagination (medium user value)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| E1 | `MCP_DEFAULTS` (22 entries) | `shared/paginate.js` | 9-34 | Per-tool default page sizes |
| ~~E2~~ | ~~`MCP_MAX_LIMIT = 1000`~~ | — | — | Moved to Category F (see below) |

### Category F — Infrastructure (low user value, keep hardcoded)

| # | Value | File | Line | Controls |
|---|-------|------|------|----------|
| F1 | `CACHE_TTL_MS = 86400000` | `infrastructure/update-check.js` | 10 | Version check cache (24h) |
| F2 | `FETCH_TIMEOUT_MS = 3000` | `infrastructure/update-check.js` | 11 | Version check HTTP timeout |
| F3 | `debounce = 300` | `domain/graph/watcher.js` | 80 | File watcher debounce (ms) |
| F4 | `maxBuffer = 10MB` | `features/check.js` | 260 | Git diff buffer |
| F5 | `volume / 3000` | `features/complexity.js` | 85 | Halstead bugs formula (standard) |
| F6 | `timeout = 10_000` | `infrastructure/config.js` | 110 | apiKeyCommand timeout |
| F7 | `MCP_MAX_LIMIT = 1000` | `shared/paginate.js` | 37 | Hard abuse-prevention cap — server-side safety boundary, not a tuning knob |

---

## Design

### Proposed `DEFAULTS` additions in `src/infrastructure/config.js`

```js
export const DEFAULTS = {
  // ... existing fields ...

  analysis: {
    defaultDepth: 3,           // A2: BFS depth for impact/diff-impact
    fnImpactDepth: 5,          // A1: fn-impact transitive depth
    auditDepth: 3,             // A3: audit blast-radius depth
    sequenceDepth: 10,         // A5: sequence diagram depth
    falsePositiveCallers: 20,  // A6: generic function filter threshold
    briefCallerDepth: 5,       // A11: brief transitive caller BFS depth
    briefImporterDepth: 5,     // A12: brief transitive importer BFS depth
    briefHighRiskCallers: 10,  // A9: brief high-risk tier threshold
    briefMediumRiskCallers: 3, // A10: brief medium-risk tier threshold
  },

  community: {
    resolution: 1.0,           // A7: Louvain resolution (only Louvain params here)
  },

  // build.driftThreshold stays in `build` (already wired in finalize.js line 52)
  // — it's a build-pipeline concern, not community detection

  structure: {
    cohesionThreshold: 0.3,    // A8: structure cohesion drift warning
  },

  risk: {
    weights: {                 // B1
      fanIn: 0.25,
      complexity: 0.3,
      churn: 0.2,
      role: 0.15,
      mi: 0.1,
    },
    roleWeights: {             // B2
      core: 1.0,
      utility: 0.9,
      entry: 0.8,
      adapter: 0.5,
      leaf: 0.2,
      dead: 0.1,
    },
    defaultRoleWeight: 0.5,    // B3
  },

  display: {
    maxColWidth: 40,           // D1
    excerptLines: 50,          // D2
    summaryMaxChars: 100,      // D3
    jsdocEndScanLines: 10,     // D4a: lines to scan upward for block-end marker (*/)
    jsdocOpenScanLines: 20,    // D4b: lines to scan upward for /** opening
    signatureGatherLines: 5,   // D5
  },

  search: {
    // defaultMinScore, rrfK, topK already exist in DEFAULTS —
    // add the missing C5 key:
    similarityWarnThreshold: 0.85, // C5: duplicate-query warning in multiSearchData
  },

  mcp: {
    defaults: { /* E1: current MCP_DEFAULTS object */ },
    // MCP_MAX_LIMIT stays hardcoded (Category F) — server-side safety boundary
  },
};
```

### What stays hardcoded (Category F)

- **Halstead `volume / 3000`** — industry-standard formula, not a tuning knob
- **Git `maxBuffer`** — platform concern, not analysis behavior
- **`apiKeyCommand` timeout** — security boundary, not user-facing
- **Update check TTL/timeout** — implementation detail
- **Watcher debounce** — could be configurable later but low priority
- **`MCP_MAX_LIMIT`** — server-side abuse-prevention cap; making it user-configurable via `.codegraphrc.json` would allow any process with project directory write access to raise it arbitrarily, defeating its security purpose

---

## Implementation Plan

### Phase 1 — Extend DEFAULTS schema (1 PR)

**Files:** `src/infrastructure/config.js`, `tests/unit/config.test.js`

1. Add `analysis`, `community`, `structure`, `risk`, `display`, `mcp` sections to `DEFAULTS`
2. Keep `build.driftThreshold` where it is (already wired in `finalize.js` — no migration needed)
3. **Hard prerequisite:** Update `mergeConfig` to perform recursive (deep) merging — at minimum 2 levels deep. The current implementation only merges 1 level deep, which means partial user overrides of nested objects like `risk.weights` (e.g. `{ "complexity": 0.4, "churn": 0.1 }`) will **silently drop** un-specified sibling keys (`fanIn`, `role`, `mi`), producing `NaN` risk scores. This must be fixed before any nested config keys are wired in subsequent phases
4. Add tests: loading config with overrides for each new section

### Phase 2 — Wire analysis parameters (1 PR)

**Files to change:**
- `src/domain/analysis/impact.js` → read `config.analysis.defaultDepth` / `config.analysis.fnImpactDepth`
- `src/features/audit.js` → read `config.analysis.auditDepth`
- `src/features/check.js` → replace hardcoded `3` with `config.check.depth` (already in DEFAULTS, sole authoritative key for check depth — do **not** chain with `config.analysis.defaultDepth`)
- `src/features/sequence.js` → read `config.analysis.sequenceDepth`
- `src/domain/analysis/module-map.js` → read `config.analysis.falsePositiveCallers`
- `src/domain/analysis/brief.js` → read `config.analysis.briefCallerDepth`, `config.analysis.briefImporterDepth`, `config.analysis.briefHighRiskCallers`, `config.analysis.briefMediumRiskCallers` (PR #480)

**Pattern:** Each module calls `loadConfig()` (or receives config as a parameter). Replace the hardcoded value with `config.analysis.X ?? FALLBACK`. The fallback ensures backward compatibility if config is missing.

**Tests:** Update integration tests to verify custom config values flow through.

### Phase 3 — Wire risk & community parameters (1 PR)

**Files to change:**
- `src/graph/classifiers/risk.js` → read `config.risk.weights`, `config.risk.roleWeights`, `config.risk.defaultRoleWeight`
- `src/graph/algorithms/louvain.js` → accept `resolution` parameter, default from config
- `src/features/structure.js` → read `config.structure.cohesionThreshold`

**Pattern:** These modules don't currently receive config. Options:
1. **Preferred:** Accept an `options` parameter that callers populate from config
2. **Alternative:** Import `loadConfig` directly (adds coupling but simpler)

**Tests:** Unit tests for risk scoring with custom weights. Integration test for Louvain with custom resolution.

### Phase 4 — Wire search parameters (1 PR)

**Files to change:**
- `src/domain/search/search/hybrid.js` → read `config.search.rrfK`, `config.search.topK`
- `src/domain/search/search/semantic.js` → read `config.search.defaultMinScore` and `config.search.similarityWarnThreshold` (C5, replaces hardcoded `SIMILARITY_WARN_THRESHOLD`)
- `src/domain/search/models.js` → batch sizes could be config-overridable per model

**Note:** `config.search` already exists with `defaultMinScore`, `rrfK`, `topK`. The modules just don't read from it — they duplicate the values. This phase wires the existing config keys.

### Phase 5 — Wire display & MCP parameters (1 PR)

**Files to change:**
- `src/presentation/result-formatter.js` → read `config.display.maxColWidth`
- `src/shared/file-utils.js` → read `config.display.excerptLines`, `config.display.jsdocEndScanLines` (D4a, 10 lines), `config.display.jsdocOpenScanLines` (D4b, 20 lines — note different default values), `config.display.summaryMaxChars`, `config.display.signatureGatherLines`
- `src/shared/paginate.js` → read `config.mcp.defaults` (`MCP_MAX_LIMIT` stays hardcoded — security boundary)

**Consideration:** `file-utils.js` and `paginate.js` are low-level shared utilities. They shouldn't call `loadConfig()` directly. Instead, pass display/mcp settings down from callers, or use a module-level config cache set at startup.

### Phase 6 — Documentation & migration (1 PR)

1. Update `README.md` configuration section with the full schema
2. Add a `docs/configuration.md` reference with all keys, types, defaults, and descriptions
3. Document the `structure.cohesionThreshold` key and its relationship to A8
4. Add a JSON Schema file (`.codegraphrc.schema.json`) for IDE autocomplete
5. Add a **Configuration** section to `CLAUDE.md` that documents:
   - The `.codegraphrc.json` config file and its location
   - The full list of configurable sections (`analysis`, `community`, `risk`, `display`, `mcp`, `search`, `check`, `coChange`, `manifesto`)
   - Key tunable parameters and their defaults (depth limits, risk weights, thresholds)
   - How `mergeConfig` works (partial overrides deep-merge with defaults)
   - Env var overrides (`CODEGRAPH_LLM_*`)
   - Guidance: when adding new behavioral constants, always add them to `DEFAULTS` in `config.js` and wire them through — never introduce new hardcoded magic numbers

---

## Migration & Backward Compatibility

- All new config keys have defaults matching current hardcoded values → **zero breaking changes**
- Existing `.codegraphrc.json` files continue to work unchanged
- `mergeConfig` will be updated to deep-merge recursively (Phase 1 prerequisite), so users only need to specify the keys they want to override
- `build.driftThreshold` stays in place — no migration needed

## Example `.codegraphrc.json` after this work

```json
{
  "analysis": {
    "fnImpactDepth": 8,
    "falsePositiveCallers": 30
  },
  "risk": {
    "weights": {
      "complexity": 0.4,
      "churn": 0.1
    }
  },
  "community": { "resolution": 1.5 },
  "structure": { "cohesionThreshold": 0.25 },
  "display": {
    "maxColWidth": 60
  }
}
```

---

## Estimated Scope

| Phase | Files changed | New tests | Risk |
|-------|--------------|-----------|------|
| 1 — Schema | 2 | 3-4 | Low |
| 2 — Analysis wiring | 6 | 4-5 | Low |
| 3 — Risk/community | 3 | 2-3 | Medium (parameter threading) |
| 4 — Search wiring | 3 | 2 | Low (config keys already exist) |
| 5 — Display/MCP | 3 | 2 | Medium (shared utility coupling) |
| 6 — Docs + CLAUDE.md | 5 | 0 | None |

**Total: ~22 files changed, 6 PRs, one concern per PR.**
