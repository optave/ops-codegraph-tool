import { exportsData, kindIcon } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

export function fileExports(file, customDbPath, opts = {}) {
  const data = exportsData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    if (opts.unused) {
      console.log(`No unused exports found for "${file}".`);
    } else {
      console.log(`No exported symbols found for "${file}". Run "codegraph build" first.`);
    }
    return;
  }

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

  for (const sym of data.results) {
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

  if (data.reexports.length > 0) {
    console.log(`\n  Re-exports: ${data.reexports.map((r) => r.file).join(', ')}`);
  }
  console.log();
}
