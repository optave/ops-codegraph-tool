import { briefData } from '../domain/analysis/brief.js';
import { outputResult } from './result-formatter.js';

/**
 * Format a compact brief for hook context injection.
 * Single-block, token-efficient output.
 *
 * Example:
 *   src/domain/graph/builder.js [HIGH RISK]
 *   Symbols: buildGraph [core, 12 callers], collectFiles [leaf, 2 callers]
 *   Imports: src/db/index.js, src/domain/parser.js
 *   Imported by: src/cli/commands/build.js (+8 transitive)
 */
export function brief(file, customDbPath, opts = {}) {
  const data = briefData(file, customDbPath, opts);
  if (outputResult(data, 'results', opts)) return;

  if (data.results.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    return;
  }

  for (const r of data.results) {
    console.log(`${r.file} [${r.risk.toUpperCase()} RISK]`);

    // Symbols line
    if (r.symbols.length > 0) {
      const parts = r.symbols.map((s) => {
        const tags = [];
        if (s.role) tags.push(s.role);
        tags.push(`${s.callerCount} caller${s.callerCount !== 1 ? 's' : ''}`);
        return `${s.name} [${tags.join(', ')}]`;
      });
      console.log(`  Symbols: ${parts.join(', ')}`);
    }

    // Imports line
    if (r.imports.length > 0) {
      console.log(`  Imports: ${r.imports.join(', ')}`);
    }

    // Imported by line with transitive count
    if (r.importedBy.length > 0) {
      const transitive = r.totalImporterCount - r.importedBy.length;
      const suffix = transitive > 0 ? ` (+${transitive} transitive)` : '';
      console.log(`  Imported by: ${r.importedBy.join(', ')}${suffix}`);
    } else if (r.totalImporterCount > 0) {
      console.log(`  Imported by: ${r.totalImporterCount} transitive importers`);
    }
  }
}
