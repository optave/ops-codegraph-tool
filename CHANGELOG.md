# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [2.2.0](https://github.com/optave/codegraph/compare/v2.1.0...v2.2.0) (2026-02-23)

**New query commands, smarter call resolution, and full `--no-tests` coverage.** This release adds `explain`, `where`, and `context` commands for richer code exploration, introduces three-tier incremental change detection, improves call resolution accuracy, and extends the `--no-tests` flag to every query command.

### Features

* **cli:** add `codegraph explain <file|function>` command — structural summary without an LLM ([ff72655](https://github.com/optave/codegraph/commit/ff72655))
* **cli:** add `codegraph where <name>` command — fast symbol lookup for definition and usage ([7fafbaa](https://github.com/optave/codegraph/commit/7fafbaa))
* **cli:** add `codegraph context <name>` command — full function context (source, deps, callers) in one call ([3fa88b4](https://github.com/optave/codegraph/commit/3fa88b4))
* **cli:** add graph quality score to `stats` command ([130a52a](https://github.com/optave/codegraph/commit/130a52a))
* **cli:** add `--no-tests` flag to all remaining query commands for consistent test file filtering ([937b60f](https://github.com/optave/codegraph/commit/937b60f))
* **parser:** extract symbols from Commander/Express/Event callback patterns ([2ac24ef](https://github.com/optave/codegraph/commit/2ac24ef))
* **builder:** three-tier incremental change detection — skip unchanged, reparse modified, clean removed ([4b50af1](https://github.com/optave/codegraph/commit/4b50af1))
* **hooks:** add remind-codegraph hook to nudge agents before editing ([e6ddeea](https://github.com/optave/codegraph/commit/e6ddeea))
* **ci:** automated performance benchmarks per release ([f79d6f2](https://github.com/optave/codegraph/commit/f79d6f2))
* **ci:** add `workflow_dispatch` trigger for retrying failed stable releases ([8d4f0cb](https://github.com/optave/codegraph/commit/8d4f0cb))

### Bug Fixes

* **resolve:** improve call resolution accuracy with scoped fallback, dedup, and built-in skip ([3a11191](https://github.com/optave/codegraph/commit/3a11191))
* **parser:** add receiver field to call sites to eliminate false positive edges ([b08c2b2](https://github.com/optave/codegraph/commit/b08c2b2))
* **queries:** `statsData` fully filters test nodes and edges when `--no-tests` is set ([2f9730a](https://github.com/optave/codegraph/commit/2f9730a))
* **mcp:** fix file/kind parameter handling in MCP handlers ([d5af194](https://github.com/optave/codegraph/commit/d5af194))
* **mcp:** use schema objects for `setRequestHandler` instead of string literals ([fa0d358](https://github.com/optave/codegraph/commit/fa0d358))
* **security:** add path traversal guard and debug logging to file read helpers ([93a9bcf](https://github.com/optave/codegraph/commit/93a9bcf))
* **hooks:** fix Claude Code hooks for Windows and add branch name validation ([631e27a](https://github.com/optave/codegraph/commit/631e27a))
* **hooks:** add required `hookSpecificOutput` fields for context injection ([d51a3a4](https://github.com/optave/codegraph/commit/d51a3a4))
* **hooks:** guard-git hook validates branch name on `gh pr create` ([c9426fa](https://github.com/optave/codegraph/commit/c9426fa))
* **ci:** rewrite Claude Code workflow for working automated PR reviews ([1ed4121](https://github.com/optave/codegraph/commit/1ed4121))
* **ci:** move publish artifacts to `$RUNNER_TEMP` to prevent repo contamination ([d9849fa](https://github.com/optave/codegraph/commit/d9849fa))
* **ci:** make publish workflow resilient to partial failures ([5dd5b00](https://github.com/optave/codegraph/commit/5dd5b00))
* **ci:** validate version input in `workflow_dispatch` ([73a1e6b](https://github.com/optave/codegraph/commit/73a1e6b))
* fix default embedding model in README and enforce LF line endings ([c852707](https://github.com/optave/codegraph/commit/c852707))
* exclude dev dependencies from DEPENDENCIES.md ([63c6923](https://github.com/optave/codegraph/commit/63c6923))

### Documentation

* add AI Agent Guide with 6-step workflow, command reference, and MCP mapping ([5965fb4](https://github.com/optave/codegraph/commit/5965fb4))
* rewrite adding-a-language guide for LANGUAGE_REGISTRY architecture ([8504702](https://github.com/optave/codegraph/commit/8504702))
* add Codegraph vs Narsil-MCP and GitNexus comparison sections to README ([aac963c](https://github.com/optave/codegraph/commit/aac963c))
* update CLAUDE.md dogfooding section to follow recommended practices ([04dbfe6](https://github.com/optave/codegraph/commit/04dbfe6))
* update Claude Code hooks section with enrichment pattern and Windows notes ([4987de9](https://github.com/optave/codegraph/commit/4987de9))

## [2.1.0](https://github.com/optave/codegraph/compare/v2.0.0...v2.1.0) (2026-02-23)

**Parser refactor, unified publish pipeline, and quality-of-life improvements.** This release splits the monolithic parser into per-language extractor files, consolidates the dev and stable publish workflows into a single pipeline, adds the `codegraph stats` command, and hardens native engine path handling and registry management.

### Features

* **cli:** add `codegraph stats` command for graph health overview — node/edge counts, language breakdown, staleness check ([12f89fa](https://github.com/optave/codegraph/commit/12f89fa))
* **registry:** add TTL-based pruning for idle entries — stale repos auto-removed on access ([5e8c41b](https://github.com/optave/codegraph/commit/5e8c41b))
* **ci:** consolidate dev + stable publish into a single `publish.yml` workflow with automatic channel detection ([bf1a16b](https://github.com/optave/codegraph/commit/bf1a16b))
* **ci:** add embedding regression test with real ML model validation and dedicated weekly workflow ([5730a65](https://github.com/optave/codegraph/commit/5730a65))
* **ci:** add worktree workflow hooks (`guard-git.sh`, `track-edits.sh`) for parallel session safety ([e16dfeb](https://github.com/optave/codegraph/commit/e16dfeb))

### Bug Fixes

* **hooks:** replace `jq` with `node` in hooks for Windows compatibility ([ac0b198](https://github.com/optave/codegraph/commit/ac0b198))
* **native:** throw on explicit `--engine native` when addon is unavailable instead of silently falling back ([02b931d](https://github.com/optave/codegraph/commit/02b931d))
* **native:** normalize import paths to remove `.` and `..` segments in native engine ([5394078](https://github.com/optave/codegraph/commit/5394078))
* **native:** add JS-side `path.normalize()` defense-in-depth for native resolve ([e1222df](https://github.com/optave/codegraph/commit/e1222df))
* **registry:** auto-prune stale entries and skip temp dir registration ([d0f3e97](https://github.com/optave/codegraph/commit/d0f3e97))
* **tests:** isolate CLI tests from real registry via `CODEGRAPH_REGISTRY_PATH` env var ([dea0c3a](https://github.com/optave/codegraph/commit/dea0c3a))
* **ci:** prevent publish crash on pre-existing tags ([6906448](https://github.com/optave/codegraph/commit/6906448))
* **ci:** harden publish workflow version resolution ([1571f2a](https://github.com/optave/codegraph/commit/1571f2a))
* **ci:** use PR-based version bumps to avoid pushing directly to protected main branch ([3aab964](https://github.com/optave/codegraph/commit/3aab964))

### Refactoring

* **parser:** split monolithic `parser.js` extractors into per-language files under `src/extractors/` ([92b2d23](https://github.com/optave/codegraph/commit/92b2d23))
* **parser:** rename generic `walk` to language-specific names in all extractors ([6ed1f59](https://github.com/optave/codegraph/commit/6ed1f59))

### Documentation

* expand competitive analysis from 21 to 135+ tools ([0a679aa](https://github.com/optave/codegraph/commit/0a679aa))
* add competitive analysis and foundation principles ([21a6708](https://github.com/optave/codegraph/commit/21a6708))
* reposition around always-fresh graph + optional LLM enhancement ([a403acc](https://github.com/optave/codegraph/commit/a403acc))
* add parallel sessions rules to CLAUDE.md ([1435803](https://github.com/optave/codegraph/commit/1435803))

## [2.0.0](https://github.com/optave/codegraph/compare/v1.4.0...v2.0.0) (2026-02-22)

**Phase 2.5 — Multi-Repo MCP & Structural Analysis.** This release adds multi-repo support for AI agents, structural analysis with architectural metrics, and hardens security across the MCP server and SQL layers.

### ⚠ BREAKING CHANGES

* **parser:** Node kinds now use language-native types — Go structs → `struct`, Rust structs/enums/traits → `struct`/`enum`/`trait`, Java enums → `enum`, C# structs/records/enums → `struct`/`record`/`enum`, PHP traits/enums → `trait`/`enum`, Ruby modules → `module`. Rebuild required: `codegraph build --no-incremental`. ([72535fb](https://github.com/optave/codegraph/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Features

* **mcp:** add multi-repo MCP support with global registry at `~/.codegraph/registry.json` — optional `repo` param on all 11 tools, new `list_repos` tool, auto-register on build ([54ea9f6](https://github.com/optave/codegraph/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* **mcp:** default MCP server to single-repo mode for security isolation — multi-repo access requires explicit `--multi-repo` or `--repos` opt-in ([49c07ad](https://github.com/optave/codegraph/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* **registry:** harden multi-repo registry — `pruneRegistry()` removes stale entries, `--repos` allowlist for repo-level access control, auto-suffix name collisions ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **structure:** add structural analysis with directory nodes, containment edges, and metrics (symbol density, avg fan-out, cohesion scores) ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **cli:** add `codegraph structure [dir]`, `codegraph hotspots`, and `codegraph registry list|add|remove|prune` commands ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **export:** extend DOT/Mermaid export with directory clusters ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* **parser:** add `SYMBOL_KINDS` constant and granular node types across both WASM and native Rust extractors ([72535fb](https://github.com/optave/codegraph/commit/72535fba44e56312fb8d5b21e19bdcbec1ea9f5e))

### Bug Fixes

* **security:** eliminate SQL interpolation in `hotspotsData` — replace dynamic string interpolation with static map of pre-built prepared statements ([f8790d7](https://github.com/optave/codegraph/commit/f8790d772989070903adbeeb30720789890591d9))
* **parser:** break `parser.js` ↔ `constants.js` circular dependency by inlining path normalization ([36239e9](https://github.com/optave/codegraph/commit/36239e91de43a6c6747951a84072953ea05e2321))
* **structure:** add `NULLS LAST` to hotspots `ORDER BY` clause ([a41668f](https://github.com/optave/codegraph/commit/a41668f55ff8c18acb6dde883b9e98c3113abf7d))
* **ci:** add license scan allowlist for `@img/sharp-*` dual-licensed packages ([9fbb084](https://github.com/optave/codegraph/commit/9fbb0848b4523baca71b94e7bceeb569773c8b45))

### Testing

* add 18 unit tests for registry, 4 MCP integration tests, 4 CLI integration tests for multi-repo ([54ea9f6](https://github.com/optave/codegraph/commit/54ea9f6c497f1c7ad4c2f0199b4a951af0a51c62))
* add 277 unit tests and 182 integration tests for structural analysis ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))
* add MCP single-repo / multi-repo mode tests ([49c07ad](https://github.com/optave/codegraph/commit/49c07ad725421710af3dd3cce5b3fc7028ab94a8))
* add registry hardening tests (pruning, allowlist, name collision) ([a413ea7](https://github.com/optave/codegraph/commit/a413ea73ff2ab12b4d500d07bd7f71bc319c9f54))

### Documentation

* add dogfooding guide for self-analysis with codegraph ([36239e9](https://github.com/optave/codegraph/commit/36239e91de43a6c6747951a84072953ea05e2321))

## [1.4.0](https://github.com/optave/codegraph/compare/v1.3.0...v1.4.0) (2026-02-22)

**Phase 2 — Foundation Hardening** is complete. This release hardens the core infrastructure: a declarative parser registry, a full MCP server, significantly improved test coverage, and secure credential management.

### Features

* **mcp:** expand MCP server from 5 to 11 tools — `fn_deps`, `fn_impact`, `diff_impact`, `semantic_search`, `export_graph`, `list_functions` ([510dd74](https://github.com/optave/codegraph/commit/510dd74ed14d455e50aa3166fa28cf90d05925dd))
* **config:** add `apiKeyCommand` for secure credential resolution via external secret managers (1Password, Bitwarden, Vault, pass, macOS Keychain) ([f3ab237](https://github.com/optave/codegraph/commit/f3ab23790369df00b50c75ae7c3b6bba47fde2c6))
* **parser:** add `LANGUAGE_REGISTRY` for declarative parser dispatch — adding a new language is now a single registry entry + extractor function ([cb08bb5](https://github.com/optave/codegraph/commit/cb08bb58adac8d7aa4d5fb6ea463ce6d3dba8007))

### Testing

* add unit tests for 8 core modules, improve coverage from 62% to 75% ([62d2694](https://github.com/optave/codegraph/commit/62d2694))
* add end-to-end CLI smoke tests ([15211c0](https://github.com/optave/codegraph/commit/15211c0))
* add 11 tests for `resolveSecrets` and `apiKeyCommand` integration
* make normalizePath test cross-platform ([36fa9cf](https://github.com/optave/codegraph/commit/36fa9cf))
* skip native engine parity tests for known Rust gaps ([7d89cd9](https://github.com/optave/codegraph/commit/7d89cd9))

### Documentation

* add secure credential management guide with examples for 5 secret managers
* update ROADMAP marking Phase 2 complete
* add community health files (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY)

### CI/CD

* add license compliance workflow and CI testing pipeline ([eeeb68b](https://github.com/optave/codegraph/commit/eeeb68b))
* add OIDC trusted publishing with `--provenance` for npm packages ([bc595f7](https://github.com/optave/codegraph/commit/bc595f7))
* add automated semantic versioning and commit enforcement ([b8e5277](https://github.com/optave/codegraph/commit/b8e5277))
* add Biome linter and formatter ([a6e6bd4](https://github.com/optave/codegraph/commit/a6e6bd4))

### Bug Fixes

* handle null `baseUrl` in native alias conversion ([d0077e1](https://github.com/optave/codegraph/commit/d0077e1))
* align native platform package versions with root ([93c9c4b](https://github.com/optave/codegraph/commit/93c9c4b))
* reset lockfile before `npm version` to avoid dirty-tree error ([6f0a40a](https://github.com/optave/codegraph/commit/6f0a40a))
