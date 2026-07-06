#!/usr/bin/env node
/**
 * codegraph environment doctor (issue #1733).
 *
 * Detects two classes of silent per-worktree environment drift: a stale
 * better-sqlite3 native binary (ABI mismatch after a Node upgrade) and an
 * incomplete grammars/ directory (interrupted or skipped `npm run build:wasm`).
 * Both are untracked, worktree-local state — see CLAUDE.md "Parallel
 * Sessions" — so every fresh `git worktree add` needs this checked at least
 * once, and a long-lived worktree needs it re-checked after a host Node
 * upgrade.
 *
 * Usage:
 *   npm run doctor            # report only; exits 1 only on a blocking ('fail') check
 *   npm run doctor -- --fix   # also run the scoped fix command(s), then re-check
 *
 * A missing *optional*-language grammar reports as a non-blocking WARN, not
 * FAIL — this repo's own parsers are designed to degrade gracefully when a
 * non-required grammar is unavailable (see CLAUDE.md), so `npm test` must
 * stay runnable in that case, just with narrower language coverage.
 *
 * Also wired as the `pretest` lifecycle script (report-only, no --fix) so
 * `npm test` fails fast with one actionable message instead of a wall of
 * unrelated-looking failures scattered across the suite — but only for a
 * genuinely blocking problem (stale native binary, missing required grammar).
 *
 * `--fix` is opt-in rather than automatic: the fixes themselves (`npm rebuild
 * better-sqlite3`, `npm run build:wasm`) can take anywhere from seconds to
 * over a minute, so running them unattended on every `npm test` would add
 * unpredictable latency to a hot dev-loop command. Detect-and-report is the
 * safe default; healing is one explicit flag away. Both fix commands always
 * run with cwd pinned to this script's own repo root (never process.cwd()),
 * so they can never touch a different worktree or a global install.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDoctorChecks } from '../src/infrastructure/doctor.ts';

// doctor.ts's DoctorCheck/DoctorReport interfaces are intentionally not
// exported (nothing outside that module constructs one independently), so
// this derives the shapes structurally rather than importing them by name.
type DoctorReport = ReturnType<typeof runDoctorChecks>;
type DoctorCheck = DoctorReport['checks'][number];

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// npm on Windows is npm.cmd; Node refuses to spawn .cmd/.bat without a shell.
const NPM_SHELL = os.platform() === 'win32';

const STATUS_MARK: Record<DoctorCheck['status'], string> = {
  ok: 'OK  ',
  warn: 'WARN',
  fail: 'FAIL',
};

function printReport(report: DoctorReport): void {
  for (const check of report.checks) {
    console.log(`[${STATUS_MARK[check.status]}] ${check.label}: ${check.detail}`);
    if (check.status !== 'ok' && check.fixCommand) {
      console.log(`       fix: ${check.fixCommand}`);
    }
  }
}

/** Run a non-ok check's fix command, scoped to this repo's own root. */
function runFix(check: DoctorCheck): void {
  if (!check.fixCommand) return;
  const [cmd, ...args] = check.fixCommand.split(' ');
  if (!cmd) return;
  console.log(`\n> ${check.fixCommand}`);
  try {
    execFileSync(cmd, args, { cwd: repoRoot, stdio: 'inherit', shell: NPM_SHELL });
  } catch (err) {
    console.error(`  fix command failed: ${(err as Error).message}`);
  }
}

const shouldFix = process.argv.includes('--fix');

let report = runDoctorChecks();
printReport(report);

// --fix repairs anything with something to fix — a non-blocking 'warn' (e.g.
// a missing optional grammar) is still worth fixing when explicitly asked,
// even though it wouldn't block pretest/npm test on its own.
const needsFix = report.checks.filter((c) => c.status !== 'ok');
if (shouldFix && needsFix.length > 0) {
  console.log(`\n--fix passed — attempting scoped repairs in ${repoRoot}`);
  for (const check of needsFix) runFix(check);

  console.log('\nRe-checking...');
  report = runDoctorChecks();
  printReport(report);
}

if (!report.ok) {
  console.error('\ncodegraph doctor: environment is NOT healthy — see fix command(s) above.');
  if (!shouldFix) {
    console.error('Re-run with --fix to attempt an automatic, worktree-scoped repair:');
    console.error('  npm run doctor -- --fix');
  }
  process.exit(1);
}

const hasWarnings = report.checks.some((c) => c.status === 'warn');
console.log(
  hasWarnings
    ? '\ncodegraph doctor: environment healthy (non-blocking warnings above).'
    : '\ncodegraph doctor: environment healthy.',
);
