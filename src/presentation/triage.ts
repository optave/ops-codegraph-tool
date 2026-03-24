import { triageData } from '../features/triage.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface TriageOpts {
  json?: boolean;
  ndjson?: boolean;
  table?: boolean;
  csv?: boolean;
  noTests?: boolean;
  sort?: string;
  kind?: string;
  role?: string;
  file?: string;
  minScore?: number;
  limit?: number;
  offset?: number;
  config?: unknown;
  weights?: Record<string, number>;
}

interface TriageItem {
  name: string;
  file: string;
  role: string | null;
  riskScore: number;
  fanIn: number;
  cognitive: number;
  churn: number;
  maintainabilityIndex: number;
}

interface TriageSummary {
  total: number;
  analyzed: number;
  avgScore: number;
  maxScore: number;
}

export function triage(customDbPath: string | undefined, opts: TriageOpts = {}): void {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic shape from triageData
  const data = triageData(customDbPath, opts as any) as {
    items: TriageItem[];
    summary: TriageSummary;
  };

  if (outputResult(data as unknown as Record<string, unknown>, 'items', opts)) return;

  if (data.items.length === 0) {
    if (data.summary.total === 0) {
      console.log('\nNo symbols found. Run "codegraph build" first.\n');
    } else {
      console.log('\nNo symbols match the given filters.\n');
    }
    return;
  }

  console.log('\n# Risk Audit Queue\n');

  console.log(
    `  ${'Symbol'.padEnd(35)} ${'File'.padEnd(28)} ${'Role'.padEnd(8)} ${'Score'.padStart(6)} ${'Fan-In'.padStart(7)} ${'Cog'.padStart(4)} ${'Churn'.padStart(6)} ${'MI'.padStart(5)}`,
  );
  console.log(
    `  ${'─'.repeat(35)} ${'─'.repeat(28)} ${'─'.repeat(8)} ${'─'.repeat(6)} ${'─'.repeat(7)} ${'─'.repeat(4)} ${'─'.repeat(6)} ${'─'.repeat(5)}`,
  );

  for (const it of data.items) {
    const name = it.name.length > 33 ? `${it.name.slice(0, 32)}\u2026` : it.name;
    const file = it.file.length > 26 ? `\u2026${it.file.slice(-25)}` : it.file;
    const role = (it.role || '-').padEnd(8);
    const score = it.riskScore.toFixed(2).padStart(6);
    const fanIn = String(it.fanIn).padStart(7);
    const cog = String(it.cognitive).padStart(4);
    const churn = String(it.churn).padStart(6);
    const mi = it.maintainabilityIndex > 0 ? String(it.maintainabilityIndex).padStart(5) : '    -';
    console.log(
      `  ${name.padEnd(35)} ${file.padEnd(28)} ${role} ${score} ${fanIn} ${cog} ${churn} ${mi}`,
    );
  }

  const s = data.summary;
  console.log(
    `\n  ${s.analyzed} symbols scored (of ${s.total} total) | avg: ${s.avgScore.toFixed(2)} | max: ${s.maxScore.toFixed(2)} | sort: ${opts.sort || 'risk'}`,
  );
  console.log();
}
