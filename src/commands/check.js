import { AnalysisError } from '../shared/errors.js';
import { checkData } from '../features/check.js';
import { outputResult } from '../infrastructure/result-formatter.js';

/**
 * CLI formatter — prints check results and sets exitCode 1 on failure.
 */
export function check(customDbPath, opts = {}) {
  const data = checkData(customDbPath, opts);

  if (data.error) {
    throw new AnalysisError(data.error);
  }

  if (outputResult(data, null, opts)) {
    if (!data.passed) process.exitCode = 1;
    return;
  }

  console.log('\n# Check Results\n');

  if (data.predicates.length === 0) {
    console.log('  No changes detected.\n');
    return;
  }

  console.log(
    `  Changed files: ${data.summary.changedFiles}  New files: ${data.summary.newFiles}\n`,
  );

  for (const pred of data.predicates) {
    const icon = pred.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${pred.name}`);

    if (!pred.passed) {
      if (pred.name === 'cycles' && pred.cycles) {
        for (const cycle of pred.cycles.slice(0, 10)) {
          console.log(`         ${cycle.join(' -> ')}`);
        }
        if (pred.cycles.length > 10) {
          console.log(`         ... and ${pred.cycles.length - 10} more`);
        }
      }
      if (pred.name === 'blast-radius' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(
            `         ${v.name} (${v.kind}) at ${v.file}:${v.line} — ${v.transitiveCallers} callers (max: ${pred.threshold})`,
          );
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
      if (pred.name === 'signatures' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(`         ${v.name} (${v.kind}) at ${v.file}:${v.line}`);
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
      if (pred.name === 'boundaries' && pred.violations) {
        for (const v of pred.violations.slice(0, 10)) {
          console.log(`         ${v.from} -> ${v.to} (${v.edgeKind})`);
        }
        if (pred.violations.length > 10) {
          console.log(`         ... and ${pred.violations.length - 10} more`);
        }
      }
    }
    if (pred.note) {
      console.log(`         ${pred.note}`);
    }
  }

  const s = data.summary;
  console.log(`\n  ${s.total} predicates | ${s.passed} passed | ${s.failed} failed\n`);

  if (!data.passed) {
    process.exitCode = 1;
  }
}
