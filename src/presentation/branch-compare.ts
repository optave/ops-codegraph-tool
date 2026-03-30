import { kindIcon } from '../domain/queries.js';
import { branchCompareData, branchCompareMermaid } from '../features/branch-compare.js';
import { outputResult } from '../infrastructure/result-formatter.js';

// ─── Text Formatting ────────────────────────────────────────────────────

interface BranchCompareSymbol {
  kind: string;
  name: string;
  file: string;
  line: number;
  impact?: unknown[];
  changes?: { lineCount: number; fanIn: number; fanOut: number };
  base?: { lineCount: number; fanIn: number; fanOut: number; line: number };
  target?: { lineCount: number; fanIn: number; fanOut: number };
}

interface BranchCompareSummary {
  added: number;
  removed: number;
  changed: number;
  totalImpacted: number;
  filesAffected: number;
}

interface BranchCompareFormatData {
  error?: string;
  baseSha: string;
  targetSha: string;
  baseRef: string;
  targetRef: string;
  changedFiles: string[];
  added: BranchCompareSymbol[];
  removed: BranchCompareSymbol[];
  changed: BranchCompareSymbol[];
  summary: BranchCompareSummary;
}

/** Format impact annotation for a symbol. */
function formatImpactLine(impact: unknown[] | undefined): string | null {
  if (!impact || impact.length === 0) return null;
  return `      ^ ${impact.length} transitive caller${impact.length !== 1 ? 's' : ''} affected`;
}

/** Format added symbols section. */
function formatAddedSection(added: BranchCompareSymbol[]): string[] {
  if (added.length === 0) return [];
  const lines = ['', `  + Added (${added.length} symbol${added.length !== 1 ? 's' : ''}):`];
  for (const sym of added) {
    lines.push(`    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.line}`);
  }
  return lines;
}

/** Format removed symbols section. */
function formatRemovedSection(removed: BranchCompareSymbol[]): string[] {
  if (removed.length === 0) return [];
  const lines = ['', `  - Removed (${removed.length} symbol${removed.length !== 1 ? 's' : ''}):`];
  for (const sym of removed) {
    lines.push(`    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.line}`);
    const impact = formatImpactLine(sym.impact);
    if (impact) lines.push(impact);
  }
  return lines;
}

/** Format changed symbols section with delta details. */
function formatChangedSection(changed: BranchCompareSymbol[]): string[] {
  if (changed.length === 0) return [];
  const lines = ['', `  ~ Changed (${changed.length} symbol${changed.length !== 1 ? 's' : ''}):`];
  for (const sym of changed) {
    const parts: string[] = [];
    if (sym.changes?.lineCount !== 0) {
      parts.push(`lines: ${sym.base?.lineCount} -> ${sym.target?.lineCount}`);
    }
    if (sym.changes?.fanIn !== 0) {
      parts.push(`fan_in: ${sym.base?.fanIn} -> ${sym.target?.fanIn}`);
    }
    if (sym.changes?.fanOut !== 0) {
      parts.push(`fan_out: ${sym.base?.fanOut} -> ${sym.target?.fanOut}`);
    }
    const detail = parts.length > 0 ? `  (${parts.join(', ')})` : '';
    lines.push(`    [${kindIcon(sym.kind)}] ${sym.name} -- ${sym.file}:${sym.base?.line}${detail}`);
    const impact = formatImpactLine(sym.impact);
    if (impact) lines.push(impact);
  }
  return lines;
}

function formatText(data: BranchCompareFormatData): string {
  if (data.error) return `Error: ${data.error}`;

  const lines: string[] = [];
  const shortBase = data.baseSha.slice(0, 7);
  const shortTarget = data.targetSha.slice(0, 7);

  lines.push(`branch-compare: ${data.baseRef}..${data.targetRef}`);
  lines.push(`  Base:   ${data.baseRef} (${shortBase})`);
  lines.push(`  Target: ${data.targetRef} (${shortTarget})`);
  lines.push(`  Files changed: ${data.changedFiles.length}`);

  lines.push(...formatAddedSection(data.added));
  lines.push(...formatRemovedSection(data.removed));
  lines.push(...formatChangedSection(data.changed));

  const s = data.summary;
  lines.push('');
  lines.push(
    `  Summary: +${s.added} added, -${s.removed} removed, ~${s.changed} changed` +
      ` -> ${s.totalImpacted} caller${s.totalImpacted !== 1 ? 's' : ''} impacted` +
      (s.filesAffected > 0
        ? ` across ${s.filesAffected} file${s.filesAffected !== 1 ? 's' : ''}`
        : ''),
  );

  return lines.join('\n');
}

// ─── CLI Display Function ───────────────────────────────────────────────

interface BranchCompareCliOpts {
  json?: boolean;
  ndjson?: boolean;
  format?: string;
  repoRoot?: string;
  noTests?: boolean;
  dbPath?: string;
  engine?: string;
  depth?: number;
}

export async function branchCompare(
  baseRef: string,
  targetRef: string,
  opts: BranchCompareCliOpts = {},
): Promise<void> {
  const data = await branchCompareData(baseRef, targetRef, opts);

  if (opts.format === 'json') opts = { ...opts, json: true };
  if (outputResult(data, null, opts)) return;

  if (opts.format === 'mermaid') {
    console.log(branchCompareMermaid(data));
    return;
  }

  console.log(formatText(data as unknown as BranchCompareFormatData));
}
