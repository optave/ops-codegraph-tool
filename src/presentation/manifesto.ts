import { manifestoData } from '../features/manifesto.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface ManifestoOpts {
  json?: boolean;
  ndjson?: boolean;
  table?: boolean;
  csv?: boolean;
  config?: unknown;
  noTests?: boolean;
  limit?: number;
  offset?: number;
}

interface ManifestoViolationRow {
  rule: string;
  level: string;
  value: number;
  threshold: number;
  name?: string;
  file?: string;
  line?: number;
}

function renderRulesTable(data: any): void {
  console.log('\n# Manifesto Rules\n');

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

  const s = data.summary;
  console.log(
    `\n  ${s.total} rules | ${s.passed} passed | ${s.warned} warned | ${s.failed} failed | ${s.violationCount} violations`,
  );
}

function renderViolationList(
  label: string,
  violations: ManifestoViolationRow[],
  maxShown = 20,
): void {
  if (violations.length === 0) return;
  console.log(`\n## ${label} (${violations.length})\n`);
  for (const v of violations.slice(0, maxShown)) {
    const loc = v.line ? `${v.file}:${v.line}` : v.file;
    const tag = label === 'Failures' ? 'FAIL' : 'WARN';
    console.log(
      `  [${tag}] ${v.rule}: ${v.name} (${v.value}) at ${loc} — threshold ${v.threshold}`,
    );
  }
  if (violations.length > maxShown) {
    console.log(`  ... and ${violations.length - maxShown} more`);
  }
}

function renderViolations(violations: ManifestoViolationRow[]): void {
  if (violations.length === 0) return;
  const failViolations = violations.filter((v) => v.level === 'fail');
  const warnViolations = violations.filter((v) => v.level === 'warn');
  renderViolationList('Failures', failViolations);
  renderViolationList('Warnings', warnViolations);
}

export function manifesto(customDbPath: string | undefined, opts: ManifestoOpts = {}): void {
  const data = manifestoData(customDbPath, opts as any) as any;

  if (outputResult(data, 'violations', opts)) {
    if (!data.passed) process.exitCode = 1;
    return;
  }

  renderRulesTable(data);
  renderViolations(data.violations);
  console.log();

  if (!data.passed) {
    process.exitCode = 1;
  }
}
