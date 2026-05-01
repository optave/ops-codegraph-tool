# Configuration Reference

All codegraph behavior is configured through a single file at the project root. This guide covers every option, grouped by concern. The authoritative source is `DEFAULTS` in [`src/infrastructure/config.ts`](../../src/infrastructure/config.ts) — if anything here drifts, the code wins.

## File location

Codegraph looks for, in order:

1. `.codegraphrc.json`
2. `.codegraphrc`
3. `codegraph.config.json`

The first one found is used. All values are optional — anything you don't set falls back to the default.

## Merge semantics

Config is deep-merged with defaults. Partial overrides preserve sibling keys:

```json
{ "build": { "incremental": false } }
```

Leaves `build.dbPath`, `build.driftThreshold`, etc. at their defaults. Arrays are replaced wholesale, not concatenated.

## Top-level shorthand

`excludeTests` may be set at the top level as a shorthand for `query.excludeTests`. If both are present, `query.excludeTests` wins.

```json
{ "excludeTests": true }
```

---

## File selection

Controls which files codegraph parses.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `include` | `string[]` | `[]` | Glob patterns to include. Empty means "everything not excluded". |
| `exclude` | `string[]` | `[]` | Glob patterns to skip. |
| `ignoreDirs` | `string[]` | `[]` | Directory names to skip entirely (added to a built-in list of `node_modules`, `.git`, `dist`, etc.). |
| `extensions` | `string[]` | `[]` | File extensions to parse. Empty means "use the language registry's default extensions". |
| `aliases` | `Record<string, string>` | `{}` | Path alias map for import resolution (e.g. `"@/": "./src/"`). |

```json
{
  "include": ["src/**", "lib/**"],
  "exclude": ["**/*.test.js", "**/__mocks__/**"],
  "ignoreDirs": ["fixtures", "vendor"],
  "aliases": { "@/": "./src/", "@utils/": "./src/utils/" }
}
```

---

## Build (`build`)

Controls graph construction.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `incremental` | `boolean` | `true` | Reuse cached file hashes; only re-parse changed files. Set `false` to force a full rebuild. |
| `dbPath` | `string` | `".codegraph/graph.db"` | Path to the SQLite database, relative to the project root. |
| `driftThreshold` | `number` | `0.2` | Fraction (0–1). If incremental rebuild changes node or edge counts by more than this, codegraph warns and suggests `--no-incremental`. |
| `smallFilesThreshold` | `number` | `5` | When ≤ this many files change in an incremental build, codegraph takes faster code paths (skips full rebuilds of structure metrics, scoped barrel re-parsing, JS fallback for inserts). |

---

## Query defaults (`query`)

Defaults applied to graph queries when the CLI flag is omitted.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `defaultDepth` | `number` | `3` | Default transitive depth for callers/callees queries. |
| `defaultLimit` | `number` | `20` | Default max results per query. |
| `excludeTests` | `boolean` | `false` | When `true`, commands exclude test/spec files by default. Pass `--include-tests` on any command to override per-invocation. |

---

## Embeddings (`embeddings`)

Controls the local embedding model used by `codegraph embed` and `codegraph search`.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `model` | `string` | `"nomic-v1.5"` | Model registry key (see `src/domain/search/models.ts`). Common options: `"nomic-v1.5"`, `"bge-large"`, `"nomic"`. |
| `llmProvider` | `string \| null` | `null` | Optional LLM provider for query expansion. `null` disables it. |

---

## LLM credentials (`llm`)

Used by features that call out to a chat-completion API (e.g. query expansion). Codegraph never hardcodes a provider — you pick one.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `provider` | `string \| null` | `null` | Provider name (e.g. `"openai"`, `"anthropic"`). |
| `model` | `string \| null` | `null` | Model identifier passed to the provider. |
| `baseUrl` | `string \| null` | `null` | Override the provider's base URL (for compatible proxies, local servers, etc.). |
| `apiKey` | `string \| null` | `null` | Plaintext API key. Prefer `apiKeyCommand` or env vars over this. |
| `apiKeyCommand` | `string \| null` | `null` | Shell-out command that prints the key to stdout. Split on whitespace and run via `execFileSync` (no shell — `$(...)`, pipes, globs, and variable expansion are not supported). 10s timeout, 64 KB max output. |

Resolution order (first non-empty wins): `apiKeyCommand` output → `CODEGRAPH_LLM_API_KEY` env var → `apiKey` field.

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKeyCommand": "op read op://vault/openai/api-key"
  }
}
```

Works with any single-binary secret manager: 1Password CLI (`op`), Bitwarden (`bw`), `pass`, Vault (`vault`), macOS Keychain (`security`), AWS Secrets Manager (`aws secretsmanager get-secret-value ...`), etc.

### Environment overrides

These env vars override the corresponding `llm.*` fields when set:

- `CODEGRAPH_LLM_PROVIDER` → `llm.provider`
- `CODEGRAPH_LLM_MODEL` → `llm.model`
- `CODEGRAPH_LLM_API_KEY` → `llm.apiKey`

---

## Semantic search (`search`)

Knobs for `codegraph search` and the `semantic_search` MCP tool.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `defaultMinScore` | `number` | `0.2` | Minimum cosine similarity for a match to be returned. |
| `rrfK` | `number` | `60` | Reciprocal-rank-fusion constant for multi-query search. Higher values dampen the influence of top-ranked results. |
| `topK` | `number` | `15` | Default number of results returned per query. |
| `similarityWarnThreshold` | `number` | `0.85` | When two queries in a multi-query search have similarity above this, codegraph warns about redundancy. |

---

## CI quick gates (`ci`)

Coarse, single-flag CI checks.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `failOnCycles` | `boolean` | `false` | If `true`, `codegraph build` exits non-zero when cycles are detected. |
| `impactThreshold` | `number \| null` | `null` | If set, `diff-impact` exits non-zero when a changed function's blast radius exceeds this number of callers. |

For richer CI gating use `manifesto` and `check`.

---

## Manifesto rules (`manifesto`)

Pass/fail thresholds for `codegraph check` (manifesto mode). Each rule has `warn` (soft, exit 0) and optional `fail` (hard, exit 1) thresholds. `null` disables the rule.

| Rule | Direction | Default `warn` | Default `fail` | Notes |
|------|-----------|----------------|----------------|-------|
| `cognitive` | upper bound | `15` | none | Cognitive complexity per function. |
| `cyclomatic` | upper bound | `10` | none | McCabe cyclomatic complexity per function. |
| `maxNesting` | upper bound | `4` | none | Max nesting depth per function. |
| `maintainabilityIndex` | lower bound | `20` | `null` | Microsoft MI score per function. Lower is worse. |
| `importCount` | upper bound | `null` | `null` | Imports per file. |
| `exportCount` | upper bound | `null` | `null` | Exports per file. |
| `lineCount` | upper bound | `null` | `null` | Lines per function or file. |
| `fanIn` | upper bound | `null` | `null` | Number of inbound dependencies. |
| `fanOut` | upper bound | `null` | `null` | Number of outbound dependencies. |
| `noCycles` | upper bound | `null` | `null` | Allowed cycle count (set `fail: 0` to forbid cycles). |
| `boundaries` | upper bound | `null` | `null` | Boundary violations against `manifesto.boundaries`. |

```json
{
  "manifesto": {
    "rules": {
      "cognitive": { "warn": 15, "fail": 30 },
      "cyclomatic": { "warn": 10, "fail": 20 },
      "maintainabilityIndex": { "warn": 40, "fail": 20 },
      "noCycles": { "fail": 0 }
    }
  }
}
```

### Boundaries (`manifesto.boundaries`)

Architecture constraints between layers. Accepts a free-form rule object or one of the built-in presets (e.g. `"onion"` — see [`src/features/boundaries.ts`](../../src/features/boundaries.ts)). Set to `null` (default) to disable.

---

## Check predicates (`check`)

Toggles for the lightweight `codegraph check` command (separate from manifesto).

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `cycles` | `boolean` | `true` | Fail if cycles exist. |
| `blastRadius` | `number \| null` | `null` | Fail if any function's caller count exceeds this. |
| `signatures` | `boolean` | `true` | Warn on signature changes in the diff. |
| `boundaries` | `boolean` | `true` | Honor the `manifesto.boundaries` rules. |
| `depth` | `number` | `3` | Transitive depth for blast-radius calculation. |

---

## Co-change analysis (`coChange`)

Configures `codegraph co-changes` (files that historically change together based on git history).

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `since` | `string` | `"1 year ago"` | Git revision range start (anything `git log --since` accepts). |
| `minSupport` | `number` | `3` | Minimum number of co-occurring commits before a pair is reported. |
| `minJaccard` | `number` | `0.3` | Minimum Jaccard similarity (`|A∩B| / |A∪B|`) for a pair. |
| `maxFilesPerCommit` | `number` | `50` | Skip commits touching more than this many files (avoids noise from large refactors / merges). |

---

## Analysis depth & sampling (`analysis`)

Defaults for transitive traversal across analysis commands.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `impactDepth` | `number` | `3` | Default depth for `impact-analysis` (file-level). |
| `fnImpactDepth` | `number` | `5` | Default depth for `fn-impact` (function-level). |
| `auditDepth` | `number` | `3` | Default depth for `audit`. |
| `sequenceDepth` | `number` | `10` | Max BFS depth for `sequence` diagram generation. |
| `falsePositiveCallers` | `number` | `20` | Threshold above which a caller count is flagged as a likely false-positive name collision in `module_map`/quality reports. |
| `briefCallerDepth` | `number` | `5` | Caller depth for `brief`. |
| `briefImporterDepth` | `number` | `5` | Importer depth for `brief`. |
| `briefHighRiskCallers` | `number` | `10` | Number of high-risk callers to surface in `brief`. |
| `briefMediumRiskCallers` | `number` | `3` | Number of medium-risk callers to surface in `brief`. |

---

## Community detection (`community`)

Parameters for the Leiden/Louvain community detector used by `codegraph communities`.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `resolution` | `number` | `1.0` | Resolution parameter — higher values produce more, smaller communities. |
| `maxLevels` | `number` | `50` | Max number of multi-level passes. |
| `maxLocalPasses` | `number` | `20` | Max local-moving passes per level. |
| `refinementTheta` | `number` | `1.0` | Leiden refinement temperature. |

---

## Structure (`structure`)

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `cohesionThreshold` | `number` | `0.3` | Cohesion score below which a directory is flagged as low-cohesion in `codegraph structure`. |

---

## Risk scoring (`risk`)

Weights for the per-symbol risk score (used by `triage` and `audit`).

### Component weights (`risk.weights`)

Sum doesn't have to equal 1; codegraph normalizes internally.

| Key | Default | Component |
|-----|---------|-----------|
| `fanIn` | `0.25` | Number of callers. |
| `complexity` | `0.30` | Cognitive/cyclomatic blend. |
| `churn` | `0.20` | Git history churn. |
| `role` | `0.15` | Symbol role weight (see below). |
| `mi` | `0.10` | Maintainability Index. |

### Role weights (`risk.roleWeights`)

Multiplier per classified role.

| Role | Default |
|------|---------|
| `core` | `1.0` |
| `utility` | `0.9` |
| `entry` | `0.8` |
| `adapter` | `0.5` |
| `leaf` | `0.2` |
| `test-only` | `0.1` |
| `dead` | `0.1` |
| `dead-leaf` | `0.0` |
| `dead-entry` | `0.3` |
| `dead-ffi` | `0.05` |
| `dead-unresolved` | `0.15` |

### Fallback (`risk.defaultRoleWeight`)

| Key | Default | Purpose |
|-----|---------|---------|
| `defaultRoleWeight` | `0.5` | Weight for any role not explicitly listed in `roleWeights`. |

---

## Display (`display`)

CLI-output formatting.

| Key | Type | Default | Purpose |
|-----|------|---------|---------|
| `maxColWidth` | `number` | `40` | Max width per column in tabular output. |
| `excerptLines` | `number` | `50` | Lines of source returned when no explicit end-line is given. |
| `summaryMaxChars` | `number` | `100` | Max length of extracted JSDoc/comment summaries. |
| `jsdocEndScanLines` | `number` | `10` | How far back to scan for the closing `*/` of a JSDoc above a symbol. |
| `jsdocOpenScanLines` | `number` | `20` | How far back to scan for the opening `/**` once the close is found. |
| `signatureGatherLines` | `number` | `5` | How many lines to gather to reconstruct multi-line function signatures. |

---

## MCP server (`mcp`)

Configures the Model Context Protocol server (`codegraph mcp`).

### Per-tool page-size defaults (`mcp.defaults`)

Default `limit` value applied when an MCP client calls a tool without specifying one. Override any subset:

```json
{
  "mcp": {
    "defaults": {
      "list_functions": 50,
      "module_map": 100
    }
  }
}
```

| Key | Default | Tool |
|-----|---------|------|
| `list_functions` | `100` | `list_functions` |
| `query` | `10` | `query` |
| `where` | `50` | `where` |
| `node_roles` | `100` | `node_roles` |
| `export_graph` | `500` | `export_graph` |
| `fn_impact` | `5` | `fn_impact` |
| `context` | `5` | `context` |
| `explain` | `10` | Used internally by `audit`. |
| `file_deps` | `20` | `file_deps` |
| `file_exports` | `20` | `file_exports` |
| `diff_impact` | `30` | `diff_impact` |
| `impact_analysis` | `20` | `impact_analysis` |
| `semantic_search` | `20` | `semantic_search` |
| `execution_flow` | `50` | `execution_flow` |
| `hotspots` | `20` | Used internally by `triage`. |
| `co_changes` | `20` | `co_changes` |
| `complexity` | `30` | `complexity` |
| `manifesto` | `50` | Used internally by `check`. |
| `communities` | `20` | `communities` |
| `structure` | `30` | `structure` |
| `triage` | `20` | `triage` |
| `ast_query` | `50` | `ast_query` |
| `implementations` | `50` | `implementations` |
| `interfaces` | `50` | `interfaces` |

### Tool filtering (`mcp.disabledTools`) <a id="mcp-tool-filtering"></a>

Hide MCP tools from `tools/list` (and reject them from `tools/call`) to shrink the schema for small-context models or lock down agent capabilities.

```json
{
  "mcp": {
    "disabledTools": ["execution_flow", "sequence", "communities", "co_changes"]
  }
}
```

**Name normalization.** Each entry is trimmed, lowercased, and has a leading `codegraph<digits>_` prefix stripped before comparison. All of these match the same tool:

```
"module_map", "Module_Map", "  module_map  ", "codegraph2_module_map"
```

The `codegraph<digits>_` prefix exists because some MCP clients namespace tools per-server when multiple servers are connected.

**Runtime behavior.** Disabled tools are removed from `tools/list`. A `tools/call` invocation against a disabled name returns:

```json
{ "isError": true, "content": [{ "type": "text", "text": "Unknown tool: <name>" }] }
```

This is the same response a truly unknown name produces — config-disabled, unknown, and mode-disabled (e.g. `list_repos` in single-repo mode) tools all behave the same.

**Available tool names** (one per line — copy into `disabledTools`):

```
query, path, where, file_deps, brief, file_exports, context, symbol_children,
list_functions, impact_analysis, fn_impact, diff_impact, branch_compare,
module_map, structure, find_cycles, node_roles, complexity, audit, triage,
check, communities, co_changes, code_owners, export_graph, sequence,
execution_flow, cfg, dataflow, semantic_search, ast_query, implementations,
interfaces, batch_query, list_repos
```

`list_repos` is only registered when the server is started with `--multi-repo` or `--repos`.

---

## Where new options should live

If you contribute a new behavioral constant, add it to `DEFAULTS` in `src/infrastructure/config.ts` under the appropriate group, mirror the type in `CodegraphConfig` (`src/types.ts`), and update this guide. Don't introduce hardcoded magic numbers in individual modules — `DEFAULTS` is the single source of truth.

The only exception is **Category F values**: safety boundaries, standard formulas, and platform constraints (e.g. POSIX path separators, SQLite `BUSY_TIMEOUT`, IEEE 754 epsilons). Those stay inline.
