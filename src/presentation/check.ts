import { checkData } from '../features/check.js';
import { outputResult } from '../infrastructure/result-formatter.js';
import { AnalysisError } from '../shared/errors.js';

interface CheckCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  base?: string;
  ref?: string;
  staged?: boolean;
  cycles?: string;
  blastRadius?: number;
  depth?: number;
  maxCyclomatic?: number;
  maxBlastRadius?: number;
  boundaries?: boolean;
  signatures?: boolean;
  config?: unknown;
}

interface CheckViolation {
  name: string;
  kind: string;
  file: string;
  line: number;
  transitiveCallers?: number;
  from?: string;
  to?: string;
  edgeKind?: string;
}

interface CheckPredicate {
  passed: boolean;
  name: string;
  note?: string;
  cycles?: string[][];
  violations?: CheckViolation[];
  threshold?: number;
}

interface CheckDataResult {
  error?: string;
  passed: boolean;
  predicates: CheckPredicate[];
  summary: {
    changedFiles: number;
    newFiles: number;
    total: number;
    passed: number;
    failed: number;
  };
}

/** Print violation details for a failed predicate (max 10 items). */
function formatPredicateViolations(pred: CheckPredicate): void {
  const MAX_SHOWN = 10;

  if (pred.name === 'cycles' && pred.cycles) {
    for (const cycle of pred.cycles.slice(0, MAX_SHOWN)) {
      console.log(`         ${cycle.join(' -> ')}`);
    }
    if (pred.cycles.length > MAX_SHOWN) {
      console.log(`         ... and ${pred.cycles.length - MAX_SHOWN} more`);
    }
  }

  if (!pred.violations) return;

  const formatViolation = (v: CheckViolation): string => {
    if (pred.name === 'blast-radius') {
      return `${v.name} (${v.kind}) at ${v.file}:${v.line} — ${v.transitiveCallers} callers (max: ${pred.threshold})`;
    }
    if (pred.name === 'boundaries') {
      return `${v.from} -> ${v.to} (${v.edgeKind})`;
    }
    return `${v.name} (${v.kind}) at ${v.file}:${v.line}`;
  };

  for (const v of pred.violations.slice(0, MAX_SHOWN)) {
    console.log(`         ${formatViolation(v)}`);
  }
  if (pred.violations.length > MAX_SHOWN) {
    console.log(`         ... and ${pred.violations.length - MAX_SHOWN} more`);
  }
}

export function check(customDbPath: string | undefined, opts: CheckCliOpts = {}): void {
  const data = checkData(customDbPath, {
    ref: opts.ref,
    staged: opts.staged,
    cycles: opts.cycles !== undefined ? Boolean(opts.cycles) : undefined,
    blastRadius: opts.blastRadius,
    signatures: opts.signatures,
    boundaries: opts.boundaries,
    depth: opts.depth,
    noTests: opts.noTests,
  }) as CheckDataResult;

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
      formatPredicateViolations(pred);
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
