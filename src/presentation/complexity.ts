import { complexityData } from '../features/complexity.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface ComplexityCliOpts {
  json?: boolean;
  ndjson?: boolean;
  noTests?: boolean;
  target?: string;
  limit?: number;
  sort?: string;
  aboveThreshold?: boolean;
  health?: boolean;
  file?: string;
  kind?: string;
  offset?: number;
  config?: unknown;
}

interface ComplexityFunction {
  name: string;
  file: string;
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  maintainabilityIndex: number;
  loc: number;
  sloc: number;
  exceeds?: string[];
  halstead: {
    volume: number;
    difficulty: number;
    effort: number;
    bugs: number;
  };
}

interface ComplexitySummary {
  analyzed: number;
  avgCognitive: number;
  avgCyclomatic: number;
  avgMI?: number;
  aboveWarn: number;
}

interface ComplexityResult {
  functions: ComplexityFunction[];
  summary: ComplexitySummary | null;
  hasGraph: boolean;
}

export function complexity(customDbPath: string | undefined, opts: ComplexityCliOpts = {}): void {
  const data = complexityData(customDbPath, opts as any) as unknown as ComplexityResult;

  if (outputResult(data, 'functions', opts)) return;

  if (data.functions.length === 0) {
    if (data.summary === null) {
      if (data.hasGraph) {
        console.log(
          '\nNo complexity data found, but a graph exists. Run "codegraph build --no-incremental" to populate complexity metrics.\n',
        );
      } else {
        console.log(
          '\nNo complexity data found. Run "codegraph build" first to analyze your codebase.\n',
        );
      }
    } else {
      console.log('\nNo functions match the given filters.\n');
    }
    return;
  }

  const header = opts.aboveThreshold ? 'Functions Above Threshold' : 'Function Complexity';
  console.log(`\n# ${header}\n`);

  if (opts.health) {
    // Health-focused view with Halstead + MI columns
    console.log(
      `  ${'Function'.padEnd(35)} ${'File'.padEnd(25)} ${'MI'.padStart(5)} ${'Vol'.padStart(7)} ${'Diff'.padStart(6)} ${'Effort'.padStart(9)} ${'Bugs'.padStart(6)} ${'LOC'.padStart(5)} ${'SLOC'.padStart(5)}`,
    );
    console.log(
      `  ${'─'.repeat(35)} ${'─'.repeat(25)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)}`,
    );

    for (const fn of data.functions) {
      const name = fn.name.length > 33 ? `${fn.name.slice(0, 32)}…` : fn.name;
      const file = fn.file.length > 23 ? `…${fn.file.slice(-22)}` : fn.file;
      const miWarn = fn.exceeds?.includes('maintainabilityIndex') ? '!' : ' ';
      console.log(
        `  ${name.padEnd(35)} ${file.padEnd(25)} ${String(fn.maintainabilityIndex).padStart(5)}${miWarn}${String(fn.halstead.volume).padStart(7)} ${String(fn.halstead.difficulty).padStart(6)} ${String(fn.halstead.effort).padStart(9)} ${String(fn.halstead.bugs).padStart(6)} ${String(fn.loc).padStart(5)} ${String(fn.sloc).padStart(5)}`,
      );
    }
  } else {
    // Default view with MI column appended
    console.log(
      `  ${'Function'.padEnd(40)} ${'File'.padEnd(30)} ${'Cog'.padStart(4)} ${'Cyc'.padStart(4)} ${'Nest'.padStart(5)} ${'MI'.padStart(5)}`,
    );
    console.log(
      `  ${'─'.repeat(40)} ${'─'.repeat(30)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(5)}`,
    );

    for (const fn of data.functions) {
      const name = fn.name.length > 38 ? `${fn.name.slice(0, 37)}…` : fn.name;
      const file = fn.file.length > 28 ? `…${fn.file.slice(-27)}` : fn.file;
      const warn = fn.exceeds ? ' !' : '';
      const mi = fn.maintainabilityIndex > 0 ? String(fn.maintainabilityIndex) : '-';
      console.log(
        `  ${name.padEnd(40)} ${file.padEnd(30)} ${String(fn.cognitive).padStart(4)} ${String(fn.cyclomatic).padStart(4)} ${String(fn.maxNesting).padStart(5)} ${mi.padStart(5)}${warn}`,
      );
    }
  }

  if (data.summary) {
    const s = data.summary;
    const miPart = s.avgMI != null ? ` | avg MI: ${s.avgMI}` : '';
    console.log(
      `\n  ${s.analyzed} functions analyzed | avg cognitive: ${s.avgCognitive} | avg cyclomatic: ${s.avgCyclomatic}${miPart} | ${s.aboveWarn} above threshold`,
    );
  }
  console.log();
}
