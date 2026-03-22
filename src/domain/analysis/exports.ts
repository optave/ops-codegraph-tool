import path from 'node:path';
import {
  findCrossFileCallTargets,
  findDbPath,
  findFileNodes,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
} from '../../shared/file-utils.js';
import { paginateResult } from '../../shared/paginate.js';

export function exportsData(
  file: string,
  customDbPath: string | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: config shape not yet typed
  opts: { noTests?: boolean; config?: any; unused?: boolean; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const config = opts.config || loadConfig();
    const displayOpts = config.display || {};

    const dbFilePath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbFilePath), '..');

    const getFileLines = createFileLinesReader(repoRoot);

    const unused = opts.unused || false;
    const fileResults = exportsFileImpl(db, file, noTests, getFileLines, unused, displayOpts);

    if (fileResults.length === 0) {
      return paginateResult(
        {
          file,
          results: [],
          reexports: [],
          reexportedSymbols: [],
          totalExported: 0,
          totalInternal: 0,
          totalUnused: 0,
          totalReexported: 0,
          totalReexportedUnused: 0,
        },
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
      reexportedSymbols: first.reexportedSymbols,
      totalExported: first.totalExported,
      totalInternal: first.totalInternal,
      totalUnused: first.totalUnused,
      totalReexported: first.totalReexported,
      totalReexportedUnused: first.totalReexportedUnused,
    };
    // biome-ignore lint/suspicious/noExplicitAny: dynamic pagination shape
    const paginated: any = paginateResult(base, 'results', {
      limit: opts.limit,
      offset: opts.offset,
    });
    // Paginate reexportedSymbols with the same limit/offset (match paginateResult behaviour)
    if (opts.limit != null) {
      const off = opts.offset || 0;
      paginated.reexportedSymbols = paginated.reexportedSymbols.slice(off, off + opts.limit);
      // Update _pagination.hasMore to account for reexportedSymbols (barrel-only files
      // have empty results[], so hasMore would always be false without this)
      if (paginated._pagination) {
        const reexTotal = opts.unused ? base.totalReexportedUnused : base.totalReexported;
        const resultsHasMore = paginated._pagination.hasMore;
        const reexHasMore = off + opts.limit < reexTotal;
        paginated._pagination.hasMore = resultsHasMore || reexHasMore;
      }
    }
    return paginated;
  } finally {
    db.close();
  }
}

function exportsFileImpl(
  // biome-ignore lint/suspicious/noExplicitAny: db handle from better-sqlite3
  db: any,
  target: string,
  noTests: boolean,
  getFileLines: (file: string) => string[] | null,
  unused: boolean,
  // biome-ignore lint/suspicious/noExplicitAny: display config shape not yet typed
  displayOpts: Record<string, any>,
  // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
): any[] {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  // Detect whether exported column exists
  let hasExportedCol = false;
  try {
    db.prepare('SELECT exported FROM nodes LIMIT 0').raw();
    hasExportedCol = true;
  } catch (e: unknown) {
    debug(`exported column not available, using fallback: ${e instanceof Error ? e.message : e}`);
  }

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file);

    // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
    let exported: any[];
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

    // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
    const buildSymbolResult = (s: any, fileLines: string[] | null) => {
      let consumers = db
        .prepare(
          `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
           WHERE e.target_id = ? AND e.kind = 'calls'`,
        )
        // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
        .all(s.id) as any[];
      if (noTests) consumers = consumers.filter((c) => !isTestFile(c.file));

      return {
        name: s.name,
        kind: s.kind,
        line: s.line,
        endLine: s.end_line ?? null,
        role: s.role || null,
        signature: fileLines ? extractSignature(fileLines, s.line, displayOpts) : null,
        summary: fileLines ? extractSummary(fileLines, s.line, displayOpts) : null,
        consumers: consumers.map((c) => ({ name: c.name, file: c.file, line: c.line })),
        consumerCount: consumers.length,
      };
    };

    const results = exported.map((s) => buildSymbolResult(s, getFileLines(fn.file)));

    const totalUnused = results.filter((r) => r.consumerCount === 0).length;

    // Files that re-export this file (barrel → this file)
    const reexports = (
      db
        .prepare(
          `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'reexports'`,
        )
        // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
        .all(fn.id) as any[]
    ).map((r) => ({ file: r.file }));

    // For barrel files: gather symbols re-exported from target modules
    const reexportTargets = db
      .prepare(
        `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.target_id = n.id
         WHERE e.source_id = ? AND e.kind = 'reexports'`,
      )
      .all(fn.id);

    // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
    const reexportedSymbols: any[] = [];
    for (const target of reexportTargets) {
      // biome-ignore lint/suspicious/noExplicitAny: DB row types not yet migrated
      let targetExported: any[];
      if (hasExportedCol) {
        targetExported = db
          .prepare(
            "SELECT * FROM nodes WHERE file = ? AND kind != 'file' AND exported = 1 ORDER BY line",
          )
          .all(target.file);
      } else {
        // Fallback: same heuristic as direct exports — symbols called from other files
        const targetSymbols = findNodesByFile(db, target.file);
        const exportedIds = findCrossFileCallTargets(db, target.file);
        targetExported = targetSymbols.filter((s) => exportedIds.has(s.id));
      }
      for (const s of targetExported) {
        const fileLines = getFileLines(target.file);
        reexportedSymbols.push({
          ...buildSymbolResult(s, fileLines),
          originFile: target.file,
        });
      }
    }

    let filteredResults = results;
    let filteredReexported = reexportedSymbols;
    if (unused) {
      filteredResults = results.filter((r) => r.consumerCount === 0);
      filteredReexported = reexportedSymbols.filter((r) => r.consumerCount === 0);
    }

    const totalReexported = reexportedSymbols.length;
    const totalReexportedUnused = reexportedSymbols.filter((r) => r.consumerCount === 0).length;

    return {
      file: fn.file,
      results: filteredResults,
      reexports,
      reexportedSymbols: filteredReexported,
      totalExported: exported.length,
      totalInternal: internalCount,
      totalUnused,
      totalReexported,
      totalReexportedUnused,
    };
  });
}
