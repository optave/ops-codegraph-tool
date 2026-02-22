# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
