import {
  childrenData,
  contextData,
  explainData,
  implementationsData,
  interfacesData,
  kindIcon,
  queryNameData,
  whereData,
} from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

interface SymbolRef {
  kind: string;
  name: string;
  file: string;
  line: number;
}

interface OutputOpts {
  json?: boolean;
  ndjson?: boolean;
  csv?: boolean;
  table?: boolean;
  noTests?: boolean;
  limit?: number;
  offset?: number;
  depth?: number;
  noSource?: boolean;
  file?: string | boolean;
  kind?: string;
  [key: string]: unknown;
}

interface WhereSymbolResult {
  kind: string;
  name: string;
  file: string;
  line: number;
  role?: string;
  exported?: boolean;
  uses: { file: string; line: number }[];
}

interface WhereFileResult {
  file: string;
  symbols: { name: string; line: number }[];
  imports: string[];
  importedBy: string[];
  exported: string[];
}

interface WhereData {
  mode: 'symbol' | 'file';
  results: (WhereSymbolResult | WhereFileResult)[];
}

interface QueryNameCallee {
  name: string;
  edgeKind: string;
  file: string;
  line: number;
}

interface QueryNameResult extends SymbolRef {
  callees: QueryNameCallee[];
  callers: QueryNameCallee[];
}

interface QueryNameData {
  results: QueryNameResult[];
}

interface ChildRef {
  kind: string;
  name: string;
  line: number;
}

interface CallerRef extends SymbolRef {
  viaHierarchy?: string;
}

interface CalleeRef extends SymbolRef {
  summary?: string;
  source?: string;
}

interface ContextResult extends SymbolRef {
  endLine?: number;
  role?: string;
  signature?: { params?: string; returnType?: string };
  children: ChildRef[];
  complexity?: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    maintainabilityIndex?: number;
  };
  source?: string;
  callees: CalleeRef[];
  callers: CallerRef[];
  implementors?: SymbolRef[];
  implements?: SymbolRef[];
  relatedTests: {
    file: string;
    testCount: number;
    testNames: string[];
    source?: string;
  }[];
}

interface ContextData {
  results: ContextResult[];
}

interface ChildrenResult extends SymbolRef {
  children: ChildRef[];
}

interface ChildrenData {
  results: ChildrenResult[];
}

interface ExplainSymbol {
  kind: string;
  name: string;
  line: number;
  role?: string;
  signature?: { params?: string; returnType?: string };
  summary?: string;
}

interface FileExplainResult {
  file: string;
  lineCount?: number;
  symbolCount: number;
  publicApi: ExplainSymbol[];
  internal: ExplainSymbol[];
  imports: { file: string }[];
  importedBy: { file: string }[];
  dataFlow: { caller: string; callees: string[] }[];
}

interface FunctionExplainResult extends SymbolRef {
  endLine?: number;
  lineCount?: number;
  summary?: string;
  role?: string;
  _depth?: number;
  signature?: { params?: string; returnType?: string };
  complexity?: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    maintainabilityIndex?: number;
  };
  callees: SymbolRef[];
  callers: SymbolRef[];
  relatedTests: { file: string }[];
  depDetails?: FunctionExplainResult[];
}

interface ExplainData {
  kind: 'file' | 'function';
  results: any[];
}

interface ImplementationsResult extends SymbolRef {
  implementors: SymbolRef[];
}

interface ImplementationsData {
  results: ImplementationsResult[];
}

interface InterfacesResult extends SymbolRef {
  interfaces: SymbolRef[];
}

interface InterfacesData {
  results: InterfacesResult[];
}

export function where(target: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = whereData(target, customDbPath, opts as Record<string, unknown>) as WhereData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(
      data.mode === 'file'
        ? `No file matching "${target}" in graph`
        : `No symbol matching "${target}" in graph`,
    );
    return;
  }

  if (data.mode === 'symbol') {
    for (const r of data.results as WhereSymbolResult[]) {
      const roleTag = r.role ? ` [${r.role}]` : '';
      const tag = r.exported ? '  (exported)' : '';
      console.log(`\n${kindIcon(r.kind)} ${r.name}${roleTag}  ${r.file}:${r.line}${tag}`);
      if (r.uses.length > 0) {
        const useStrs = r.uses.map((u) => `${u.file}:${u.line}`);
        console.log(`  Used in: ${useStrs.join(', ')}`);
      } else {
        console.log('  No uses found');
      }
    }
  } else {
    for (const r of data.results as WhereFileResult[]) {
      console.log(`\n# ${r.file}`);
      if (r.symbols.length > 0) {
        const symStrs = r.symbols.map((s) => `${s.name}:${s.line}`);
        console.log(`  Symbols: ${symStrs.join(', ')}`);
      }
      if (r.imports.length > 0) {
        console.log(`  Imports: ${r.imports.join(', ')}`);
      }
      if (r.importedBy.length > 0) {
        console.log(`  Imported by: ${r.importedBy.join(', ')}`);
      }
      if (r.exported.length > 0) {
        console.log(`  Exported: ${r.exported.join(', ')}`);
      }
    }
  }
  console.log();
}

export function queryName(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = queryNameData(name, customDbPath, {
    noTests: opts.noTests,
    limit: opts.limit,
    offset: opts.offset,
  }) as QueryNameData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No results for "${name}"`);
    return;
  }

  console.log(`\nResults for "${name}":\n`);
  for (const r of data.results) {
    console.log(`  ${kindIcon(r.kind)} ${r.name} (${r.kind}) -- ${r.file}:${r.line}`);
    if (r.callees.length > 0) {
      console.log(`    -> calls/uses:`);
      for (const c of r.callees.slice(0, 15))
        console.log(`      -> ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callees.length > 15) console.log(`      ... and ${r.callees.length - 15} more`);
    }
    if (r.callers.length > 0) {
      console.log(`    <- called by:`);
      for (const c of r.callers.slice(0, 15))
        console.log(`      <- ${c.name} (${c.edgeKind}) ${c.file}:${c.line}`);
      if (r.callers.length > 15) console.log(`      ... and ${r.callers.length - 15} more`);
    }
    console.log();
  }
}

export function context(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = contextData(name, customDbPath, opts as Record<string, unknown>) as ContextData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    renderContextResult(r);
  }
}

export function children(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = childrenData(name, customDbPath, opts as Record<string, unknown>) as ChildrenData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No symbol matching "${name}"`);
    return;
  }
  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name}  ${r.file}:${r.line}`);
    if (r.children.length === 0) {
      console.log('  (no children)');
    } else {
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
    }
  }
}

function renderSignature(sig: ContextResult['signature']): void {
  if (!sig) return;
  console.log('## Type/Shape Info');
  if (sig.params != null) console.log(`  Parameters: (${sig.params})`);
  if (sig.returnType) console.log(`  Returns: ${sig.returnType}`);
  console.log();
}

function renderComplexity(cx: NonNullable<ContextResult['complexity']>): void {
  const miPart = cx.maintainabilityIndex ? ` | MI: ${cx.maintainabilityIndex}` : '';
  console.log('## Complexity');
  console.log(
    `  Cognitive: ${cx.cognitive} | Cyclomatic: ${cx.cyclomatic} | Max Nesting: ${cx.maxNesting}${miPart}`,
  );
  console.log();
}

function renderSource(source: string, indent = '  '): void {
  console.log('## Source');
  for (const line of source.split('\n')) {
    console.log(`${indent}${line}`);
  }
  console.log();
}

function renderCallees(callees: CalleeRef[]): void {
  if (callees.length === 0) return;
  console.log(`## Direct Dependencies (${callees.length})`);
  for (const c of callees) {
    const summary = c.summary ? ` — ${c.summary}` : '';
    console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${summary}`);
    if (c.source) {
      const maxSourceLines = 10;
      for (const line of c.source.split('\n').slice(0, maxSourceLines)) {
        console.log(`    | ${line}`);
      }
    }
  }
  console.log();
}

function renderCallers(callers: CallerRef[]): void {
  if (callers.length === 0) return;
  console.log(`## Callers (${callers.length})`);
  for (const c of callers) {
    const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
    console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
  }
  console.log();
}

function renderSymbolRefList(label: string, items: SymbolRef[]): void {
  if (items.length === 0) return;
  console.log(`## ${label} (${items.length})`);
  for (const s of items) {
    console.log(`  ${kindIcon(s.kind)} ${s.name}  ${s.file}:${s.line}`);
  }
  console.log();
}

function renderRelatedTests(tests: ContextResult['relatedTests']): void {
  if (tests.length === 0) return;
  console.log('## Related Tests');
  const maxTestSourceLines = 20;
  for (const t of tests) {
    console.log(`  ${t.file} — ${t.testCount} tests`);
    for (const tn of t.testNames) {
      console.log(`    - ${tn}`);
    }
    if (t.source) {
      console.log('    Source:');
      for (const line of t.source.split('\n').slice(0, maxTestSourceLines)) {
        console.log(`    | ${line}`);
      }
    }
  }
  console.log();
}

function renderContextResult(r: ContextResult): void {
  const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
  const roleTag = r.role ? ` [${r.role}]` : '';
  console.log(`\n# ${r.name} (${r.kind})${roleTag} — ${r.file}:${lineRange}\n`);

  renderSignature(r.signature);

  if (r.children && r.children.length > 0) {
    console.log(`## Children (${r.children.length})`);
    for (const c of r.children) {
      console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
    }
    console.log();
  }

  if (r.complexity) renderComplexity(r.complexity);
  if (r.source) renderSource(r.source);
  renderCallees(r.callees);
  renderCallers(r.callers);
  renderSymbolRefList('Implementors', r.implementors || []);
  renderSymbolRefList('Implements', r.implements || []);
  renderRelatedTests(r.relatedTests);

  if (r.callees.length === 0 && r.callers.length === 0 && r.relatedTests.length === 0) {
    console.log('  (no call edges or tests found — may be invoked dynamically or via re-exports)');
    console.log();
  }
}

function renderFileExplain(r: FileExplainResult): void {
  const publicCount = r.publicApi.length;
  const internalCount = r.internal.length;
  const lineInfo = r.lineCount ? `${r.lineCount} lines, ` : '';
  console.log(`\n# ${r.file}`);
  console.log(
    `  ${lineInfo}${r.symbolCount} symbols (${publicCount} exported, ${internalCount} internal)`,
  );

  if (r.imports.length > 0) {
    console.log(`  Imports: ${r.imports.map((i) => i.file).join(', ')}`);
  }
  if (r.importedBy.length > 0) {
    console.log(`  Imported by: ${r.importedBy.map((i) => i.file).join(', ')}`);
  }

  if (r.publicApi.length > 0) {
    console.log(`\n## Exported`);
    for (const s of r.publicApi) {
      const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
      const roleTag = s.role ? ` [${s.role}]` : '';
      const summary = s.summary ? `  -- ${s.summary}` : '';
      console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
    }
  }

  if (r.internal.length > 0) {
    console.log(`\n## Internal`);
    for (const s of r.internal) {
      const sig = s.signature?.params != null ? `(${s.signature.params})` : '';
      const roleTag = s.role ? ` [${s.role}]` : '';
      const summary = s.summary ? `  -- ${s.summary}` : '';
      console.log(`  ${kindIcon(s.kind)} ${s.name}${sig}${roleTag} :${s.line}${summary}`);
    }
  }

  if (r.dataFlow.length > 0) {
    console.log(`\n## Data Flow`);
    for (const df of r.dataFlow) {
      console.log(`  ${df.caller} -> ${df.callees.join(', ')}`);
    }
  }
  console.log();
}

function renderExplainHeader(r: FunctionExplainResult, indent: string): void {
  const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
  const lineInfo = r.lineCount ? `${r.lineCount} lines` : '';
  const summaryPart = r.summary ? ` | ${r.summary}` : '';
  const roleTag = r.role ? ` [${r.role}]` : '';
  const depthLevel = r._depth || 0;
  const heading = depthLevel === 0 ? '#' : '##'.padEnd(depthLevel + 2, '#');
  console.log(`\n${indent}${heading} ${r.name} (${r.kind})${roleTag}  ${r.file}:${lineRange}`);
  if (lineInfo || r.summary) {
    console.log(`${indent}  ${lineInfo}${summaryPart}`);
  }
  if (r.signature) {
    if (r.signature.params != null) console.log(`${indent}  Parameters: (${r.signature.params})`);
    if (r.signature.returnType) console.log(`${indent}  Returns: ${r.signature.returnType}`);
  }
}

function renderExplainComplexity(
  cx: NonNullable<FunctionExplainResult['complexity']>,
  indent: string,
): void {
  const miPart = cx.maintainabilityIndex ? ` MI=${cx.maintainabilityIndex}` : '';
  console.log(
    `${indent}  Complexity: cognitive=${cx.cognitive} cyclomatic=${cx.cyclomatic} nesting=${cx.maxNesting}${miPart}`,
  );
}

function renderExplainEdges(r: FunctionExplainResult, indent: string): void {
  if (r.callees.length > 0) {
    console.log(`\n${indent}  Calls (${r.callees.length}):`);
    for (const c of r.callees) {
      console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
  }

  if (r.callers.length > 0) {
    console.log(`\n${indent}  Called by (${r.callers.length}):`);
    for (const c of r.callers) {
      console.log(`${indent}    ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
    }
  }

  if (r.relatedTests.length > 0) {
    const label = r.relatedTests.length === 1 ? 'file' : 'files';
    console.log(`\n${indent}  Tests (${r.relatedTests.length} ${label}):`);
    for (const t of r.relatedTests) {
      console.log(`${indent}    ${t.file}`);
    }
  }

  if (r.callees.length === 0 && r.callers.length === 0) {
    console.log(`${indent}  (no call edges found -- may be invoked dynamically or via re-exports)`);
  }
}

function renderFunctionExplain(r: FunctionExplainResult, indent = ''): void {
  renderExplainHeader(r, indent);
  if (r.complexity) renderExplainComplexity(r.complexity, indent);
  renderExplainEdges(r, indent);

  if (r.depDetails && r.depDetails.length > 0) {
    const depthLevel = r._depth || 0;
    console.log(`\n${indent}  --- Dependencies (depth ${depthLevel + 1}) ---`);
    for (const dep of r.depDetails) {
      renderFunctionExplain(dep, `${indent}  `);
    }
  }
  console.log();
}

export function explain(target: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = explainData(target, customDbPath, opts as Record<string, unknown>) as ExplainData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  if (data.kind === 'file') {
    for (const r of data.results) {
      renderFileExplain(r as FileExplainResult);
    }
  } else {
    for (const r of data.results) {
      renderFunctionExplain(r as FunctionExplainResult);
    }
  }
}

export function implementations(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = implementationsData(
    name,
    customDbPath,
    opts as Record<string, unknown>,
  ) as ImplementationsData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No symbol matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name}  ${r.file}:${r.line}`);
    if (r.implementors.length === 0) {
      console.log('  (no implementors found)');
    } else {
      console.log(`  Implementors (${r.implementors.length}):`);
      for (const impl of r.implementors) {
        console.log(`    ${kindIcon(impl.kind)} ${impl.name}  ${impl.file}:${impl.line}`);
      }
    }
  }
  console.log();
}

export function interfaces(name: string, customDbPath: string, opts: OutputOpts = {}): void {
  const data = interfacesData(
    name,
    customDbPath,
    opts as Record<string, unknown>,
  ) as InterfacesData;
  if (outputResult(data as unknown as Record<string, unknown>, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No symbol matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${kindIcon(r.kind)} ${r.name}  ${r.file}:${r.line}`);
    if (r.interfaces.length === 0) {
      console.log('  (no interfaces/traits found)');
    } else {
      console.log(`  Implements (${r.interfaces.length}):`);
      for (const iface of r.interfaces) {
        console.log(`    ${kindIcon(iface.kind)} ${iface.name}  ${iface.file}:${iface.line}`);
      }
    }
  }
  console.log();
}
