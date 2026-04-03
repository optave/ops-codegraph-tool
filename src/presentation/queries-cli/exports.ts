import { exportsData, kindIcon } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

interface ExportConsumer {
  name: string;
  file: string;
  line: number;
}

interface ExportSymbol {
  kind: string;
  name: string;
  line: number;
  role?: string;
  signature?: { params?: string };
  consumers: ExportConsumer[];
}

interface ReexportedSymbol extends ExportSymbol {
  originFile: string;
}

interface ExportsDataResult {
  file: string;
  totalExported: number;
  totalInternal: number;
  totalUnused: number;
  totalReexported?: number;
  totalReexportedUnused?: number;
  results: ExportSymbol[];
  reexportedSymbols: ReexportedSymbol[];
  reexports: { file: string }[];
}

interface ExportsOpts {
  json?: boolean;
  ndjson?: boolean;
  csv?: boolean;
  table?: boolean;
  noTests?: boolean;
  unused?: boolean;
  [key: string]: unknown;
}

function printExportHeader(data: ExportsDataResult, opts: ExportsOpts): void {
  if (opts.unused) {
    console.log(
      `\n# ${data.file} — ${data.totalUnused} unused export${data.totalUnused !== 1 ? 's' : ''} (of ${data.totalExported} exported)\n`,
    );
  } else {
    const unusedNote = data.totalUnused > 0 ? ` (${data.totalUnused} unused)` : '';
    console.log(
      `\n# ${data.file} — ${data.totalExported} exported${unusedNote}, ${data.totalInternal} internal\n`,
    );
  }
}

function printExportSymbols(results: ExportSymbol[]): void {
  for (const sym of results) {
    const icon = kindIcon(sym.kind);
    const sig = sym.signature?.params ? `(${sym.signature.params})` : '';
    const role = sym.role ? ` [${sym.role}]` : '';
    console.log(`  ${icon} ${sym.name}${sig}${role} :${sym.line}`);
    if (sym.consumers.length === 0) {
      console.log('    (no consumers)');
    } else {
      for (const c of sym.consumers) {
        console.log(`    <- ${c.name} (${c.file}:${c.line})`);
      }
    }
  }
}

function groupByOriginFile(reexportedSymbols: ReexportedSymbol[]): Map<string, ReexportedSymbol[]> {
  const byOrigin = new Map<string, ReexportedSymbol[]>();
  for (const sym of reexportedSymbols) {
    if (!byOrigin.has(sym.originFile)) byOrigin.set(sym.originFile, []);
    byOrigin.get(sym.originFile)!.push(sym);
  }
  return byOrigin;
}

function printReexportSymbol(sym: ExportSymbol, indent: string): void {
  const icon = kindIcon(sym.kind);
  const sig = sym.signature?.params ? `(${sym.signature.params})` : '';
  const role = sym.role ? ` [${sym.role}]` : '';
  console.log(`${indent}${icon} ${sym.name}${sig}${role} :${sym.line}`);
  if (sym.consumers.length === 0) {
    console.log(`${indent}  (no consumers)`);
  } else {
    for (const c of sym.consumers) {
      console.log(`${indent}  <- ${c.name} (${c.file}:${c.line})`);
    }
  }
}

function printReexportedSymbols(reexportedSymbols: ReexportedSymbol[]): void {
  const byOrigin = groupByOriginFile(reexportedSymbols);

  for (const [originFile, syms] of byOrigin) {
    console.log(`\n  from ${originFile}:`);
    for (const sym of syms) {
      printReexportSymbol(sym, '    ');
    }
  }
}

function printReexportedSection(data: ExportsDataResult, opts: ExportsOpts): void {
  const totalReexported = opts.unused
    ? (data.totalReexportedUnused ?? data.reexportedSymbols.length)
    : (data.totalReexported ?? data.reexportedSymbols.length);
  const plural = totalReexported !== 1 ? 's' : '';
  if (data.results.length === 0) {
    const label = opts.unused ? 'unused re-exported' : 're-exported';
    console.log(
      `\n# ${data.file} — barrel file (${totalReexported} ${label} symbol${plural} from sub-modules)\n`,
    );
  } else {
    console.log(`\n  Re-exported symbols (${totalReexported} from sub-modules):`);
  }
  printReexportedSymbols(data.reexportedSymbols);
}

export function fileExports(file: string, customDbPath: string, opts: ExportsOpts = {}): void {
  const data = exportsData(file, customDbPath, opts) as ExportsDataResult;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  const hasReexported = data.reexportedSymbols && data.reexportedSymbols.length > 0;

  if (data.results.length === 0 && !hasReexported) {
    if (opts.unused) {
      console.log(`No unused exports found for "${file}".`);
    } else {
      console.log(`No exported symbols found for "${file}". Run "codegraph build" first.`);
    }
    return;
  }

  if (data.results.length > 0) {
    printExportHeader(data, opts);
    printExportSymbols(data.results);
  }

  if (hasReexported) {
    printReexportedSection(data, opts);
  }

  if (data.reexports.length > 0) {
    console.log(`\n  Re-exported by: ${data.reexports.map((r) => r.file).join(', ')}`);
  }
  console.log();
}
