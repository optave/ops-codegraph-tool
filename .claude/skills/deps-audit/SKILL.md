---
name: deps-audit
description: Audit dependencies for vulnerabilities, staleness, unused packages, and license risks — produce a health report with actionable fixes
argument-hint: "[--fix]  (optional — auto-fix safe updates)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /deps-audit — Dependency Health Audit

Audit the project's dependency tree for security vulnerabilities, outdated packages, unused dependencies, and license compliance. Produce a structured report and optionally auto-fix safe updates.

## Arguments

- `$ARGUMENTS` may contain `--fix` to auto-apply safe updates (patch/minor only)

## Phase 0 — Pre-flight

1. Confirm we're in the codegraph repo root (check for `package.json` and `package-lock.json`)
2. Run `node --version` — must be >= 20
3. Run `npm --version` to capture toolchain info
4. Parse `$ARGUMENTS` — set `AUTO_FIX=true` if `--fix` is present
5. **If `AUTO_FIX` is set:** Save the original manifests now, before any npm commands run, so pre-existing unstaged changes are preserved:
   ```bash
   git stash push -m "deps-audit-backup" -- package.json package-lock.json
   ```

## Phase 1 — Security Vulnerabilities

Run `npm audit --json` and parse the output:

1. Count vulnerabilities by severity: `critical`, `high`, `moderate`, `low`, `info`
2. For each `critical` or `high` vulnerability:
   - Record: package name, severity, CVE/GHSA ID, vulnerable version range, patched version, dependency path (direct vs transitive)
   - Check if a fix is available (`npm audit fix --dry-run --json`)
3. Summarize: total vulns, fixable count, breaking-fix count

**If `AUTO_FIX` is set:** Run `npm audit fix` (non-breaking fixes only). Record what changed. Do NOT run `npm audit fix --force` — breaking changes require manual review.

## Phase 2 — Outdated Dependencies

Run `npm outdated --json` and categorize:

### 2a. Direct dependencies (`dependencies` + `devDependencies`)

For each outdated package, record:
- Package name
- Current version → Wanted (semver-compatible) → Latest
- Whether the update is patch, minor, or major
- If major: check the package's CHANGELOG/release notes for breaking changes relevant to our usage

### 2b. Staleness score

Classify each outdated dep:
| Category | Definition |
|----------|-----------|
| **Fresh** | On latest or within 1 patch |
| **Aging** | 1+ minor versions behind |
| **Stale** | 1+ major versions behind |
| **Abandoned** | No release in 12+ months (check npm registry publish date) |

For any package classified as **Abandoned**, check if there's a maintained fork or alternative.

**If `AUTO_FIX` is set:** Run `npm update` to apply semver-compatible updates. Record what changed.

## Phase 3 — Unused Dependencies

Detect dependencies declared in `package.json` but never imported:

1. Read `dependencies` and `devDependencies` from `package.json`
2. For each dependency, search for imports/requires across `src/`, `tests/`, `scripts/`, `cli.js`, `index.js`:
   - `require('<pkg>')` or `require('<pkg>/...')`
   - `import ... from '<pkg>'` or `import '<pkg>'`
   - `import('<pkg>')` (dynamic imports)
3. Skip known implicit dependencies that don't have direct imports:
   - `@anthropic-ai/tokenizer` — peer dependency of `@anthropic-ai/sdk`; the SDK may require it at runtime without an explicit import in our code (verify against package.json before removing)
   - `tree-sitter-*` and `web-tree-sitter` — loaded dynamically via WASM
   - `@biomejs/biome` — used as CLI tool only
   - `commit-and-tag-version` — used as npm script
   - `@optave/codegraph-*` — platform-specific optional binaries
   - `vitest` — test runner, invoked via CLI
   - Anything in `optionalDependencies`
4. For each truly unused dep: recommend removal with `npm uninstall <pkg>`

> **Important:** Some deps are used transitively or via CLI — don't blindly remove. Flag as "likely unused" and let the user decide.

## Phase 4 — License Compliance

Check licenses for all direct dependencies:

1. For each package in `dependencies`, read its `node_modules/<pkg>/package.json` → `license` field
2. Classify:
   - **Permissive** (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense): OK
   - **Weak copyleft** (LGPL-2.1, LGPL-3.0, MPL-2.0): Flag for review
   - **Strong copyleft** (GPL-2.0, GPL-3.0, AGPL-3.0): Flag as risk — may conflict with MIT license of codegraph
   - **Unknown/UNLICENSED/missing**: Flag for investigation
3. Only flag non-permissive licenses — don't list every MIT dep

## Phase 5 — Duplicate Packages

Check for duplicate versions of the same package in the dependency tree:

1. Run `npm ls --all --json` and look for packages that appear multiple times with different versions
2. Only flag duplicates that add significant bundle weight (> 100KB) or are security-sensitive (crypto, auth, etc.)
3. Suggest deduplication: `npm dedupe`

## Phase 6 — Report

Write a report to `generated/deps-audit/DEPS_AUDIT_<date>.md` with this structure:

```markdown
# Dependency Audit Report — <date>

## Summary

| Metric | Value |
|--------|-------|
| Total dependencies (direct) | N |
| Total dependencies (transitive) | N |
| Security vulnerabilities | N critical, N high, N moderate, N low |
| Outdated packages | N stale, N aging, N fresh |
| Unused dependencies | N |
| License risks | N |
| Duplicates | N |
| **Health score** | **X/100** |

## Health Score Calculation

- Start at 100
- -20 per critical vuln, -10 per high vuln, -3 per moderate vuln
- -5 per stale (major behind) dep, -2 per aging dep
- -5 per unused dep
- -10 per copyleft license risk
- Floor at 0

## Security Vulnerabilities
<!-- Detail each critical/high vuln with remediation -->

## Outdated Packages
<!-- Table: package, current, latest, category, notes -->

## Unused Dependencies
<!-- List with evidence (no imports found) -->

## License Flags
<!-- Only non-permissive licenses -->

## Duplicates
<!-- Only significant ones -->

## Recommended Actions
<!-- Prioritized list: fix vulns > remove unused > update stale > dedupe -->
```

## Phase 7 — Auto-fix Summary (if `--fix`)

If `AUTO_FIX` was set:

Summarize all changes made:
1. List each package updated/fixed
2. Run `npm test` to verify nothing broke
3. If tests pass: drop the saved state (`git stash drop`)
4. If tests fail:
   - Restore the saved manifests: `git stash pop`
   - Restore `node_modules/` to match the reverted lock file: `npm ci`
   - Report what failed

## Rules

- **Never run `npm audit fix --force`** — breaking changes need human review
- **Never remove a dependency** without asking the user, even if it appears unused — flag it in the report instead
- **Always run tests** after any auto-fix changes
- **If `--fix` causes test failures**, restore manifests from the saved state (`git stash pop`) then run `npm ci` to resync `node_modules/`, and report the failure
- Treat `optionalDependencies` separately — they're expected to fail on some platforms
- The report goes in `generated/deps-audit/` — create the directory if it doesn't exist
