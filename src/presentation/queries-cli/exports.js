import { exportsData, kindIcon } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

function printExportHeader(data, opts) {
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

function printExportSymbols(results) {
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

function printReexportedSymbols(reexportedSymbols) {
  // Group by origin file
  const byOrigin = new Map();
  for (const sym of reexportedSymbols) {
    if (!byOrigin.has(sym.originFile)) byOrigin.set(sym.originFile, []);
    byOrigin.get(sym.originFile).push(sym);
  }

  for (const [originFile, syms] of byOrigin) {
    console.log(`\n  from ${originFile}:`);
    for (const sym of syms) {
      const icon = kindIcon(sym.kind);
      const sig = sym.signature?.params ? `(${sym.signature.params})` : '';
      const role = sym.role ? ` [${sym.role}]` : '';
      console.log(`    ${icon} ${sym.name}${sig}${role} :${sym.line}`);
      if (sym.consumers.length === 0) {
        console.log('      (no consumers)');
      } else {
        for (const c of sym.consumers) {
          console.log(`      <- ${c.name} (${c.file}:${c.line})`);
        }
      }
    }
  }
}

export function fileExports(file, customDbPath, opts = {}) {
  const data = exportsData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

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
    const totalReexported = opts.unused
      ? (data.totalReexportedUnused ?? data.reexportedSymbols.length)
      : (data.totalReexported ?? data.reexportedSymbols.length);
    if (data.results.length === 0) {
      if (opts.unused) {
        console.log(
          `\n# ${data.file} — barrel file (${totalReexported} unused re-exported symbol${totalReexported !== 1 ? 's' : ''} from sub-modules)\n`,
        );
      } else {
        console.log(
          `\n# ${data.file} — barrel file (${totalReexported} re-exported symbol${totalReexported !== 1 ? 's' : ''} from sub-modules)\n`,
        );
      }
    } else {
      console.log(`\n  Re-exported symbols (${totalReexported} from sub-modules):`);
    }
    printReexportedSymbols(data.reexportedSymbols);
  }

  if (data.reexports.length > 0) {
    console.log(`\n  Re-exported by: ${data.reexports.map((r) => r.file).join(', ')}`);
  }
  console.log();
}
