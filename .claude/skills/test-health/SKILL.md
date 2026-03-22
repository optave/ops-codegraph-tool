---
name: test-health
description: Audit test suite health — detect flaky tests, dead tests, coverage gaps, and missing assertions — produce a health report with fix suggestions
argument-hint: "[--flaky-runs 5 | --coverage | --quick]  (default: full audit)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent
---

# /test-health — Test Suite Health Audit

Audit the test suite for flaky tests, dead/trivial tests, coverage gaps on recent changes, missing assertions, and structural issues. Produce a health report with prioritized recommendations.

## Arguments

- `$ARGUMENTS` may contain:
  - `--flaky-runs N` — number of times to run the suite for flaky detection (default: 5)
  - `--coverage` — only run the coverage gap analysis (skip flaky/dead detection)
  - `--quick` — skip flaky detection (most time-consuming), run everything else
  - No arguments — full audit

## Phase 0 — Pre-flight

1. Confirm we're in the codegraph repo root
2. Verify vitest is available: `npx vitest --version`
3. Parse `$ARGUMENTS`:
   - `FLAKY_RUNS=N` from `--flaky-runs N` (default: 5)
   - `COVERAGE_ONLY=true` if `--coverage`
   - `QUICK=true` if `--quick`
4. Discover all test files:
   ```bash
   find tests/ -name '*.test.js' -o -name '*.test.ts' | sort
   ```
5. Count total test files and categorize by directory (integration, parsers, graph, search, unit)

## Phase 1 — Flaky Test Detection

**Skip if `COVERAGE_ONLY` or `QUICK` is set.**

Run the full test suite `FLAKY_RUNS` times and track per-test pass/fail:

```bash
for i in $(seq 1 $FLAKY_RUNS); do
  npx vitest run --reporter=json 2>&1
done
```

For each run, parse the JSON reporter output to get per-test results.

### Analysis

A test is **flaky** if it passes in some runs and fails in others.

For each flaky test found:
1. Record: test file, test name, pass count, fail count, failure messages
2. Categorize likely cause:
   - **Timing-dependent**: failure message mentions timeout, race condition, or test has `setTimeout`/`sleep`
   - **Order-dependent**: only fails when run with other tests (passes in isolation)
   - **Resource-dependent**: mentions file system, network, port, or temp directory
   - **Non-deterministic**: random/Date.now/Math.random in test or source

> **Timeout:** Each full suite run gets 3 minutes. If it times out, record partial results and continue.

## Phase 2 — Dead & Trivial Test Detection

Scan all test files for problematic patterns:

### 2a. Empty / no-assertion tests

Search for test bodies that:
- Have no `expect()`, `assert()`, `toBe()`, `toEqual()`, or similar assertion calls
- Only contain `console.log` or comments
- Are skipped: `it.skip(`, `test.skip(`, `xit(`, `xtest(`
- Are TODO: `it.todo(`, `test.todo(`

```
Pattern: test bodies with 0 assertions = dead tests
```

### 2b. Trivial / tautological tests

Detect tests that assert on constants or trivially true conditions:
- `expect(true).toBe(true)`
- `expect(1).toBe(1)`
- `expect(result).toBeDefined()` as the ONLY assertion (too weak)

### 2c. Commented-out tests

Search for commented-out test blocks:
- `// it(`, `// test(`, `/* it(`, `/* test(`
- Large commented blocks inside `describe` blocks

### 2d. Orphaned fixtures

Check if any files in `tests/fixtures/` are not referenced by any test file.

### 2e. Duplicate test names

Search for duplicate test descriptions within the same `describe` block — these indicate copy-paste errors.

## Phase 3 — Coverage Gap Analysis

Run vitest with coverage and analyze:

```bash
npx vitest run --coverage --coverage.reporter=json 2>&1
```

### 3a. Overall coverage

Parse `coverage/coverage-summary.json` and extract:
- Line coverage %
- Branch coverage %
- Function coverage %
- Statement coverage %

### 3b. Uncovered files

Find source files in `src/` with 0% coverage (no tests touch them at all).

### 3c. Low-coverage hotspots

Find files with < 50% line coverage. For each:
- List uncovered functions (from the detailed coverage data)
- Check if the file is in `domain/` or `features/` (core logic — coverage matters more)
- Check file's complexity with `codegraph complexity <file> -T` — high complexity + low coverage = high risk

### 3d. Recent changes without coverage

Compare against `main` branch to find recently changed files:

```bash
git diff --name-only main...HEAD -- src/
```

For each changed source file, check if:
1. It has corresponding test changes
2. Its coverage increased, decreased, or stayed the same
3. New functions/exports were added without test coverage

> **Note:** If the coverage tool is not configured or fails, skip this phase and note it in the report. Coverage is a vitest plugin — it may need `@vitest/coverage-v8` installed.

## Phase 4 — Test Structure Analysis

Analyze the test suite's structural health:

### 4a. Test-to-source mapping

For each directory in `src/`:
- Count source files
- Count corresponding test files
- Calculate test coverage ratio (files with tests / total files)
- Flag directories with < 30% test file coverage

### 4b. Test file size distribution

- Find oversized test files (> 500 lines) — may need splitting
- Find tiny test files (< 10 lines) — may be stubs or dead

### 4c. Setup/teardown hygiene

Check for:
- Tests that create temp files/dirs but don't clean up (`afterEach`/`afterAll` missing)
- Tests that mutate global state without restoration
- Missing `beforeEach` resets in `describe` blocks that share state

### 4d. Timeout analysis

- Find tests with custom timeouts: `{ timeout: ... }`
- Find tests that exceed the default 30s timeout in recent runs
- High timeouts often indicate tests that should be restructured or are testing too much

## Phase 5 — Report

Write report to `generated/test-health/TEST_HEALTH_<date>.md`:

```markdown
# Test Health Report — <date>

## Summary

| Metric | Value |
|--------|-------|
| Total test files | N |
| Total test cases | N |
| Flaky tests | N |
| Dead/trivial tests | N |
| Skipped tests | N |
| Coverage (lines) | X% |
| Coverage (branches) | X% |
| Uncovered source files | N |
| **Health score** | **X/100** |

## Health Score Calculation

- Start at 100
- -10 per flaky test
- -3 per dead/trivial test
- -2 per skipped test (without TODO explaining why)
- -1 per uncovered source file in `domain/` or `features/`
- -(100 - line_coverage) / 5 (coverage penalty)
- Floor at 0

## Flaky Tests
<!-- For each: file, name, pass/fail ratio, likely cause, suggested fix -->

## Dead & Trivial Tests
<!-- For each: file, line, issue, recommendation -->

## Coverage Gaps
<!-- Uncovered files, low-coverage hotspots with complexity -->

## Structural Issues
<!-- Oversized files, missing cleanup, timeout issues -->

## Recommended Actions

### Priority 1 — Fix flaky tests
<!-- List with specific suggestions -->

### Priority 2 — Remove or fix dead tests
<!-- List with specific suggestions -->

### Priority 3 — Add coverage for high-risk gaps
<!-- List uncovered functions in core modules, ordered by complexity -->

### Priority 4 — Structural improvements
<!-- Split large files, add cleanup, reduce timeouts -->
```

## Phase 6 — Quick Wins

After writing the report, identify tests that can be fixed immediately (< 5 min each):

1. Remove `.skip` from tests that now pass (run them to check)
2. Add missing assertions to empty test bodies (if the intent is clear)
3. Delete commented-out test blocks older than 6 months (check git blame)

**Do NOT auto-fix** — list these as suggestions in the report. The user decides.

## Rules

- **Never delete or modify test files** without explicit user approval — this is a read-only audit
- **Flaky detection is slow** — warn the user before running 5+ iterations
- **Coverage requires `@vitest/coverage-v8`** — if missing, skip coverage and note it
- **Order-dependent flakiness** requires running tests both in suite and in isolation — only do this for tests that flaked in Phase 1
- **Fixture files may be shared** across tests — don't flag as orphaned if used indirectly
- **Skipped tests aren't always bad** — only flag if there's no `TODO` or comment explaining why
- Generated files go in `generated/test-health/` — create the directory if needed
- **This is a diagnostic tool** — it reports problems, it doesn't fix them (unless the user opts in)
