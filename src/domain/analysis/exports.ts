import path from 'node:path';
import {
  findCrossFileCallTargets,
  findDbPath,
  findFileNodes,
  findNodesByFile,
  openReadonlyOrFail,
} from '../../db/index.js';
import { cachedStmt } from '../../db/repository/cached-stmt.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
} from '../../shared/file-utils.js';
import { paginateResult } from '../../shared/paginate.js';
import type { BetterSqlite3Database, NodeRow, StmtCache } from '../../types.js';

/** Cache the schema probe for the `exported` column per db handle. */
const _hasExportedColCache: WeakMap<BetterSqlite3Database, boolean> = new WeakMap();

const _exportedNodesStmtCache: StmtCache<NodeRow> = new WeakMap();
const _consumersStmtCache: StmtCache<{ name: string; file: string; line: number }> = new WeakMap();
const _reexportsFromStmtCache: StmtCache<{ file: string }> = new WeakMap();
const _reexportsToStmtCache: StmtCache<{ file: string }> = new WeakMap();

export function exportsData(
  file: string,
  customDbPath: string,
  opts: {
    noTests?: boolean;
    unused?: boolean;
    limit?: number;
    offset?: number;
    // biome-ignore lint/suspicious/noExplicitAny: config shape is dynamic
    config?: any;
  } = {},
) {
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
    const first = fileResults[0]!;
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
    // biome-ignore lint/suspicious/noExplicitAny: paginateResult returns dynamic shape
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
  db: BetterSqlite3Database,
  target: string,
  noTests: boolean,
  getFileLines: (file: string) => string[] | null,
  unused: boolean,
  displayOpts: Record<string, unknown>,
) {
  const fileNodes = findFileNodes(db, `%${target}%`) as NodeRow[];
  if (fileNodes.length === 0) return [];

  // Detect whether exported column exists (cached per db handle)
  let hasExportedCol: boolean;
  if (_hasExportedColCache.has(db)) {
    hasExportedCol = _hasExportedColCache.get(db)!;
  } else {
    hasExportedCol = false;
    try {
      db.prepare('SELECT exported FROM nodes LIMIT 0').raw(true);
      hasExportedCol = true;
    } catch (e: unknown) {
      debug(`exported column not available, using fallback: ${(e as Error).message}`);
    }
    _hasExportedColCache.set(db, hasExportedCol);
  }

  const exportedNodesStmt = cachedStmt(
    _exportedNodesStmtCache,
    db,
    "SELECT * FROM nodes WHERE file = ? AND kind != 'file' AND exported = 1 ORDER BY line",
  );
  const consumersStmt = cachedStmt(
    _consumersStmtCache,
    db,
    `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind = 'calls'`,
  );
  const reexportsFromStmt = cachedStmt(
    _reexportsFromStmtCache,
    db,
    `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.target_id = ? AND e.kind = 'reexports'`,
  );
  const reexportsToStmt = cachedStmt(
    _reexportsToStmtCache,
    db,
    `SELECT DISTINCT n.file FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.kind = 'reexports'`,
  );

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file) as NodeRow[];

    let exported: NodeRow[];
    if (hasExportedCol) {
      // Use the exported column populated during build
      exported = exportedNodesStmt.all(fn.file) as NodeRow[];
    } else {
      // Fallback: symbols that have incoming calls from other files
      const exportedIds = findCrossFileCallTargets(db, fn.file) as Set<number>;
      exported = symbols.filter((s) => exportedIds.has(s.id));
    }
    const internalCount = symbols.length - exported.length;

    const buildSymbolResult = (s: NodeRow, fileLines: string[] | null) => {
      let consumers = consumersStmt.all(s.id) as Array<{
        name: string;
        file: string;
        line: number;
      }>;
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

    // Files that re-export this file (barrel -> this file)
    const reexports = (reexportsFromStmt.all(fn.id) as Array<{ file: string }>).map((r) => ({
      file: r.file,
    }));

    // For barrel files: gather symbols re-exported from target modules
    const reexportTargets = reexportsToStmt.all(fn.id) as Array<{ file: string }>;

    const reexportedSymbols: Array<ReturnType<typeof buildSymbolResult> & { originFile: string }> =
      [];
    for (const reexTarget of reexportTargets) {
      let targetExported: NodeRow[];
      if (hasExportedCol) {
        targetExported = exportedNodesStmt.all(reexTarget.file) as NodeRow[];
      } else {
        // Fallback: same heuristic as direct exports — symbols called from other files
        const targetSymbols = findNodesByFile(db, reexTarget.file) as NodeRow[];
        const exportedIds = findCrossFileCallTargets(db, reexTarget.file) as Set<number>;
        targetExported = targetSymbols.filter((s) => exportedIds.has(s.id));
      }
      for (const s of targetExported) {
        const fileLines = getFileLines(reexTarget.file);
        reexportedSymbols.push({
          ...buildSymbolResult(s, fileLines),
          originFile: reexTarget.file,
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
