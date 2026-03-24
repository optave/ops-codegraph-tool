# Dependency Audit Report — 2026-03-24

> **Pre-fix snapshot.** This report was captured before applying `npm audit fix` and `npm update`. The vulnerability fixes and patch bumps are applied in the same PR that adds this report. See the post-fix summary below.

## Pre-Fix Summary

| Metric | Pre-Fix | Post-Fix |
|--------|---------|----------|
| Total dependencies (direct) | 23 (3 prod + 20 dev) | 23 (unchanged) |
| Total dependencies (transitive) | ~850 | ~850 |
| Security vulnerabilities | 5 high, 3 moderate | 0 high, 0 moderate |
| Outdated packages | 1 stale (major), 3 aging (patch) | 1 stale (major), 0 aging |
| Unused dependencies | 0 | 0 |
| License risks | 0 | 0 |
| Duplicates | 0 actionable | 0 actionable |
| **Health score** | **39/100** | **95/100** |

## Health Score Calculation

**Pre-fix (per-package):**
- 100 base
- 5 packages with high vulns × -10 = -50
- 1 stale dep × -5 = -5
- 3 aging deps × -2 = -6 (`@biomejs/biome`, `vitest`, `@vitest/coverage-v8`)
- **Score: 39/100**

**Post-fix:** All 5 high-severity vulnerabilities and aging patch deps resolved. Only the stale TypeScript major version remains.
- 100 base
- 1 stale dep × -5 = -5
- 3 aging deps resolved (`@biomejs/biome`, `vitest`, `@vitest/coverage-v8` patched) = 0
- **Score: 95/100** (estimated; TypeScript 6.0 evaluation deferred)

## Security Vulnerabilities

All vulnerabilities have fixes available via `npm audit fix`.

### High Severity (5 packages)

#### 1. `@hono/node-server` < 1.19.10 — HIGH
- **Advisory:** [GHSA-wc8c-qw6v-h7f6](https://github.com/advisories/GHSA-wc8c-qw6v-h7f6)
- **Issue:** Authorization bypass for protected static paths via encoded slashes in Serve Static Middleware
- **CVSS:** 7.5
- **Path:** transitive (via `@modelcontextprotocol/sdk`)
- **Fix:** Update to >= 1.19.10

#### 2. `express-rate-limit` 8.2.0–8.2.1 — HIGH
- **Advisory:** [GHSA-46wh-pxpv-q5gq](https://github.com/advisories/GHSA-46wh-pxpv-q5gq)
- **Issue:** IPv4-mapped IPv6 addresses bypass per-client rate limiting on dual-stack networks
- **CVSS:** 7.5
- **Path:** transitive (via `@modelcontextprotocol/sdk`)
- **Fix:** Update to >= 8.2.2

#### 3. `hono` <= 4.12.6 — HIGH (2 high advisories)
- [GHSA-xh87-mx6m-69f3](https://github.com/advisories/GHSA-xh87-mx6m-69f3) — Auth bypass via IP spoofing (CVSS 8.2)
- [GHSA-q5qw-h33p-qvwr](https://github.com/advisories/GHSA-q5qw-h33p-qvwr) — Arbitrary file access via serveStatic (CVSS 7.5)
- **Path:** transitive (via `@modelcontextprotocol/sdk`)
- **Fix:** Update to >= 4.12.7

#### 4. `minimatch` < 3.1.4 — HIGH
- **Advisory:** [GHSA-23c5-xmqv-rm74](https://github.com/advisories/GHSA-23c5-xmqv-rm74)
- **Issue:** ReDoS via nested extglobs generating catastrophic backtracking
- **CVSS:** 7.5
- **Path:** transitive (via `commit-and-tag-version` -> `dotgitignore`)
- **Fix:** Update to >= 3.1.4

#### 5. `tar` <= 7.5.10 — HIGH (2 advisories)
- [GHSA-qffp-2rhf-9h96](https://github.com/advisories/GHSA-qffp-2rhf-9h96) — Hardlink path traversal via drive-relative linkpath (CVSS 7.5)
- [GHSA-9ppj-qmqm-q256](https://github.com/advisories/GHSA-9ppj-qmqm-q256) — Symlink path traversal via drive-relative linkpath (CVSS 7.5)
- **Path:** transitive (via `@huggingface/transformers` -> `onnxruntime-node`)
- **Fix:** Update to > 7.5.10

### Moderate Severity (3 advisories, all in `hono` <= 4.12.6)

These are sub-advisories of `hono`, resolved by the same update to >= 4.12.7:

1. [GHSA-5pq2-9x2x-5p6w](https://github.com/advisories/GHSA-5pq2-9x2x-5p6w) — Cookie attribute injection (CVSS 5.4)
2. [GHSA-p6xx-57qc-3wxr](https://github.com/advisories/GHSA-p6xx-57qc-3wxr) — SSE control field injection (CVSS 6.5)
3. [GHSA-v8w9-8mx6-g223](https://github.com/advisories/GHSA-v8w9-8mx6-g223) — Prototype pollution via parseBody (CVSS 4.8)

- **Path:** transitive (via `@modelcontextprotocol/sdk`)
- **Fix:** Update `hono` to >= 4.12.7 (same fix as high-severity advisories above)

**Note:** 3 of 5 vulnerable packages (`@hono/node-server`, `express-rate-limit`, `hono`) are transitive deps of `@modelcontextprotocol/sdk`. Updating the MCP SDK should resolve them.

## Outdated Packages

| Package | Current | Wanted | Latest | Category | Notes |
|---------|---------|--------|--------|----------|-------|
| `@biomejs/biome` | 2.4.7 | 2.4.8 | 2.4.8 | Fresh (patch) | Safe to update |
| `@vitest/coverage-v8` | 4.1.0 | 4.1.1 | 4.1.1 | Fresh (patch) | Safe to update |
| `vitest` | 4.1.0 | 4.1.1 | 4.1.1 | Fresh (patch) | Safe to update |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.2 | **Stale (major)** | TS 6.0 is a major bump — review breaking changes before updating |

All packages are actively maintained (last published within the last week).

## Unused Dependencies

None found. All declared dependencies are imported or used as CLI tools:
- 3 production deps: `better-sqlite3`, `commander`, `web-tree-sitter` — all imported
- 20 dev deps: mix of tree-sitter grammars (WASM-loaded), tooling (`biome`, `vitest`, `husky`, `commitlint`), and build utilities

## License Flags

None. All direct dependencies use permissive licenses (MIT, ISC, Apache-2.0). `@biomejs/biome` uses `MIT OR Apache-2.0` (dual permissive).

## Duplicates

No actionable duplicates. Transitive deps are properly deduplicated by npm.

## Recommended Actions

**Resolved in this PR:**
1. ~~Fix all 5 high-severity vulnerabilities~~ — done via `npm audit fix`
2. ~~Update `@biomejs/biome` 2.4.7 → 2.4.8~~ — done via `npm update`
3. ~~Update `vitest` + `@vitest/coverage-v8` 4.1.0 → 4.1.1~~ — done via `npm update`

**Remaining:**
4. TypeScript 6.0 — review breaking changes and migration guide before upgrading. Current `^5.9.3` constraint in `package.json` already blocks TypeScript 6.x (caret allows `>=5.9.3 <6.0.0`), so no additional pinning is needed
