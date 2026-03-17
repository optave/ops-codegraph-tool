import path from 'node:path';
import {
  findCrossFileCallTargets,
  findDbPath,
  findFileNodes,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
} from '../../shared/file-utils.js';
import { paginateResult } from '../../shared/paginate.js';

export function exportsData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const dbFilePath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbFilePath), '..');

    const getFileLines = createFileLinesReader(repoRoot);

    const unused = opts.unused || false;
    const fileResults = exportsFileImpl(db, file, noTests, getFileLines, unused);

    if (fileResults.length === 0) {
      return paginateResult(
        { file, results: [], reexports: [], totalExported: 0, totalInternal: 0, totalUnused: 0 },
        'results',
        { limit: opts.limit, offset: opts.offset },
      );
    }

    // For single-file match return flat; for multi-match return first (like explainData)
    const first = fileResults[0];
    const base = {
      file: first.file,
      results: first.results,
      reexports: first.reexports,
      totalExported: first.totalExported,
      totalInternal: first.totalInternal,
      totalUnused: first.totalUnused,
    };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

function exportsFileImpl(db, target, noTests, getFileLines, unused) {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  // Detect whether exported column exists
  let hasExportedCol = false;
  try {
    db.prepare('SELECT exported FROM nodes LIMIT 0').raw();
    hasExportedCol = true;
  } catch (e) {
    debug(`exported column not available, using fallback: ${e.message}`);
  }

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file);

    let exported;
    if (hasExportedCol) {
      // Use the exported column populated during build
      exported = db
        .prepare(
          "SELECT * FROM nodes WHERE file = ? AND kind != 'file' AND exported = 1 ORDER BY line",
        )
        .all(fn.file);
    } else {
      // Fallback: symbols that have incoming calls from other files
      const exportedIds = findCrossFileCallTargets(db, fn.file);
      exported = symbols.filter((s) => exportedIds.has(s.id));
    }
    const internalCount = symbols.length - exported.length;

    const results = exported.map((s) => {
      const fileLines = getFileLines(fn.file);

      let consumers = db
        .prepare(
          `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls'`,
        )
        .all(s.id);
      if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));

      return {
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.end_line ?? null,
        role: s.role || null,
        signature: fileLines ? extractSignature(fileLines, s.line) : null,
        summary: fileLines ? extractSummary(fileLines, s.line) : null,
        consumers: consumers.map((c) => ({ name: c.name, file: c.file, line: c.line })),
        consumerCount: consumers.length,
      };
    });

    const totalUnused = results.filter((r) => r.consumerCount === 0).length;

    // Files that re-export this file (barrel → this file)
    const reexports = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'reexports'`,
      )
      .all(fn.id)
      .map((r) => ({ file: r.file }));

    let filteredResults = results;
    if (unused) {
      filteredResults = results.filter((r) => r.consumerCount === 0);
    }

    return {
      file: fn.file,
      results: filteredResults,
      reexports,
      totalExported: exported.length,
      totalInternal: internalCount,
      totalUnused,
    };
  });
}
