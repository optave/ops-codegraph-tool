# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

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
* add Claude Code review action for PRs ([eb5d9f2](https://github.com/optave/codegraph/commit/eb5d9f2))
* add Biome linter and formatter ([a6e6bd4](https://github.com/optave/codegraph/commit/a6e6bd4))

### Bug Fixes

* handle null `baseUrl` in native alias conversion ([d0077e1](https://github.com/optave/codegraph/commit/d0077e1))
* align native platform package versions with root ([93c9c4b](https://github.com/optave/codegraph/commit/93c9c4b))
* reset lockfile before `npm version` to avoid dirty-tree error ([6f0a40a](https://github.com/optave/codegraph/commit/6f0a40a))
