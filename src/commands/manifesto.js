import { outputResult } from '../infrastructure/result-formatter.js';
import { manifestoData } from '../manifesto.js';

/**
 * CLI formatter — prints manifesto results and exits with code 1 on failure.
 */
export function manifesto(customDbPath, opts = {}) {
  const data = manifestoData(customDbPath, opts);

  if (outputResult(data, 'violations', opts)) {
    if (!data.passed) process.exit(1);
    return;
  }

  console.log('\n# Manifesto Rules\n');

  // Rules table
  console.log(
    `  ${'Rule'.padEnd(20)} ${'Level'.padEnd(10)} ${'Status'.padEnd(8)} ${'Warn'.padStart(6)} ${'Fail'.padStart(6)} ${'Violations'.padStart(11)}`,
  );
  console.log(
    `  ${'─'.repeat(20)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(11)}`,
  );

  for (const rule of data.rules) {
    const warn = rule.thresholds.warn != null ? String(rule.thresholds.warn) : '—';
    const fail = rule.thresholds.fail != null ? String(rule.thresholds.fail) : '—';
    const statusIcon = rule.status === 'pass' ? 'pass' : rule.status === 'warn' ? 'WARN' : 'FAIL';
    console.log(
      `  ${rule.name.padEnd(20)} ${rule.level.padEnd(10)} ${statusIcon.padEnd(8)} ${warn.padStart(6)} ${fail.padStart(6)} ${String(rule.violationCount).padStart(11)}`,
    );
  }

  // Summary
  const s = data.summary;
  console.log(
    `\n  ${s.total} rules | ${s.passed} passed | ${s.warned} warned | ${s.failed} failed | ${s.violationCount} violations`,
  );

  // Violations detail
  if (data.violations.length > 0) {
    const failViolations = data.violations.filter((v) => v.level === 'fail');
    const warnViolations = data.violations.filter((v) => v.level === 'warn');

    if (failViolations.length > 0) {
      console.log(`\n## Failures (${failViolations.length})\n`);
      for (const v of failViolations.slice(0, 20)) {
        const loc = v.line ? `${v.file}:${v.line}` : v.file;
        console.log(
          `  [FAIL] ${v.rule}: ${v.name} (${v.value}) at ${loc} — threshold ${v.threshold}`,
        );
      }
      if (failViolations.length > 20) {
        console.log(`  ... and ${failViolations.length - 20} more`);
      }
    }

    if (warnViolations.length > 0) {
      console.log(`\n## Warnings (${warnViolations.length})\n`);
      for (const v of warnViolations.slice(0, 20)) {
        const loc = v.line ? `${v.file}:${v.line}` : v.file;
        console.log(
          `  [WARN] ${v.rule}: ${v.name} (${v.value}) at ${loc} — threshold ${v.threshold}`,
        );
      }
      if (warnViolations.length > 20) {
        console.log(`  ... and ${warnViolations.length - 20} more`);
      }
    }
  }

  console.log();

  if (!data.passed) {
    process.exit(1);
  }
}
