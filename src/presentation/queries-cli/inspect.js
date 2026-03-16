import {
  childrenData,
  contextData,
  explainData,
  kindIcon,
  queryNameData,
  whereData,
} from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

export function where(target, customDbPath, opts = {}) {
  const data = whereData(target, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(
      data.mode === 'file'
        ? `No file matching "${target}" in graph`
        : `No symbol matching "${target}" in graph`,
    );
    return;
  }

  if (data.mode === 'symbol') {
    for (const r of data.results) {
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
    for (const r of data.results) {
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

export function queryName(name, customDbPath, opts = {}) {
  const data = queryNameData(name, customDbPath, {
    noTests: opts.noTests,
    limit: opts.limit,
    offset: opts.offset,
  });
  if (outputResult(data, 'results', opts)) return;

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

export function context(name, customDbPath, opts = {}) {
  const data = contextData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    return;
  }

  for (const r of data.results) {
    const lineRange = r.endLine ? `${r.line}-${r.endLine}` : `${r.line}`;
    const roleTag = r.role ? ` [${r.role}]` : '';
    console.log(`\n# ${r.name} (${r.kind})${roleTag} — ${r.file}:${lineRange}\n`);

    // Signature
    if (r.signature) {
      console.log('## Type/Shape Info');
      if (r.signature.params != null) console.log(`  Parameters: (${r.signature.params})`);
      if (r.signature.returnType) console.log(`  Returns: ${r.signature.returnType}`);
      console.log();
    }

    // Children
    if (r.children && r.children.length > 0) {
      console.log(`## Children (${r.children.length})`);
      for (const c of r.children) {
        console.log(`  ${kindIcon(c.kind)} ${c.name}  :${c.line}`);
      }
      console.log();
    }

    // Complexity
    if (r.complexity) {
      const cx = r.complexity;
      const miPart = cx.maintainabilityIndex ? ` | MI: ${cx.maintainabilityIndex}` : '';
      console.log('## Complexity');
      console.log(
        `  Cognitive: ${cx.cognitive} | Cyclomatic: ${cx.cyclomatic} | Max Nesting: ${cx.maxNesting}${miPart}`,
      );
      console.log();
    }

    // Source
    if (r.source) {
      console.log('## Source');
      for (const line of r.source.split('\n')) {
        console.log(`  ${line}`);
      }
      console.log();
    }

    // Callees
    if (r.callees.length > 0) {
      console.log(`## Direct Dependencies (${r.callees.length})`);
      for (const c of r.callees) {
        const summary = c.summary ? ` — ${c.summary}` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${summary}`);
        if (c.source) {
          for (const line of c.source.split('\n').slice(0, 10)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    // Callers
    if (r.callers.length > 0) {
      console.log(`## Callers (${r.callers.length})`);
      for (const c of r.callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`  ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
      console.log();
    }

    // Related tests
    if (r.relatedTests.length > 0) {
      console.log('## Related Tests');
      for (const t of r.relatedTests) {
        console.log(`  ${t.file} — ${t.testCount} tests`);
        for (const tn of t.testNames) {
          console.log(`    - ${tn}`);
        }
        if (t.source) {
          console.log('    Source:');
          for (const line of t.source.split('\n').slice(0, 20)) {
            console.log(`    | ${line}`);
          }
        }
      }
      console.log();
    }

    if (r.callees.length === 0 && r.callers.length === 0 && r.relatedTests.length === 0) {
      console.log(
        '  (no call edges or tests found — may be invoked dynamically or via re-exports)',
      );
      console.log();
    }
  }
}

export function children(name, customDbPath, opts = {}) {
  const data = childrenData(name, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

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

export function explain(target, customDbPath, opts = {}) {
  const data = explainData(target, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No ${data.kind === 'file' ? 'file' : 'function/symbol'} matching "${target}"`);
    return;
  }

  if (data.kind === 'file') {
    for (const r of data.results) {
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
  } else {
    function printFunctionExplain(r, indent = '') {
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
        if (r.signature.params != null)
          console.log(`${indent}  Parameters: (${r.signature.params})`);
        if (r.signature.returnType) console.log(`${indent}  Returns: ${r.signature.returnType}`);
      }

      if (r.complexity) {
        const cx = r.complexity;
        const miPart = cx.maintainabilityIndex ? ` MI=${cx.maintainabilityIndex}` : '';
        console.log(
          `${indent}  Complexity: cognitive=${cx.cognitive} cyclomatic=${cx.cyclomatic} nesting=${cx.maxNesting}${miPart}`,
        );
      }

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
        console.log(
          `${indent}  (no call edges found -- may be invoked dynamically or via re-exports)`,
        );
      }

      // Render recursive dependency details
      if (r.depDetails && r.depDetails.length > 0) {
        console.log(`\n${indent}  --- Dependencies (depth ${depthLevel + 1}) ---`);
        for (const dep of r.depDetails) {
          printFunctionExplain(dep, `${indent}  `);
        }
      }
      console.log();
    }

    for (const r of data.results) {
      printFunctionExplain(r);
    }
  }
}
