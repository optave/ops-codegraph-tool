# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [1.4.0](https://github.com/optave/codegraph/compare/v1.3.0...v1.4.0) (2026-02-22)


### Features

* **config:** add apiKeyCommand for secure credential resolution ([f3ab237](https://github.com/optave/codegraph/commit/f3ab23790369df00b50c75ae7c3b6bba47fde2c6))
* **mcp:** expand MCP server from 5 to 11 tools ([510dd74](https://github.com/optave/codegraph/commit/510dd74ed14d455e50aa3166fa28cf90d05925dd))


### Bug Fixes

* add napi-rs package.json for build-native workflow ([b9d7e0e](https://github.com/optave/codegraph/commit/b9d7e0e58dcf3e2a54645d87fdf1a5a90c7c7b98))
* align native platform package versions with root ([93c9c4b](https://github.com/optave/codegraph/commit/93c9c4b31c7c01471c37277067fd095214a643b1))
* **ci:** add --provenance to platform package publishes for OIDC auth ([bc595f7](https://github.com/optave/codegraph/commit/bc595f78ab35fe5db3a00711977ab2b963c4f3ef))
* **ci:** add allowed_tools to Claude Code review action ([eb5d9f2](https://github.com/optave/codegraph/commit/eb5d9f270b446c2d2c72bb2ee7ffd0433463c720))
* **ci:** grant write permissions to Claude workflows for PR comments ([aded63c](https://github.com/optave/codegraph/commit/aded63c19375ede0037ac62736c6049f6b77daba))
* **ci:** prefix platform package path with ./ for npm 10 compatibility ([06fa212](https://github.com/optave/codegraph/commit/06fa212bba55b11d77e689c8d5e91faca4eef5a4))
* **ci:** skip version bump when override matches current version ([df19486](https://github.com/optave/codegraph/commit/df19486ff30724791c71e49b130417e30281b659))
* handle null baseUrl in native alias conversion, skip flaky native cache tests ([d0077e1](https://github.com/optave/codegraph/commit/d0077e175446fc27619b767d8fcf06b91d3a042c))
* repair build-native workflow ([67d7650](https://github.com/optave/codegraph/commit/67d7650235e6291b002224a31dfc765df666a36a))
* reset lockfile before npm version to avoid dirty-tree error ([6f0a40a](https://github.com/optave/codegraph/commit/6f0a40a48cbb589e672ea149ee5f920fb258e697))
* **test:** make normalizePath test cross-platform ([36fa9cf](https://github.com/optave/codegraph/commit/36fa9cfa3a084af173c85fca47c5f5cd2ed3d700))
* **test:** skip native engine parity tests for known Rust gaps ([7d89cd9](https://github.com/optave/codegraph/commit/7d89cd957c7cda937c4bc8a1e9d389e76807ceb2))


### Refactoring

* add LANGUAGE_REGISTRY for declarative parser dispatch ([cb08bb5](https://github.com/optave/codegraph/commit/cb08bb58adac8d7aa4d5fb6ea463ce6d3dba8007))
