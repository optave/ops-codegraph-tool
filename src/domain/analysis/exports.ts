import path from 'node:path';
import {
  findDbPath,
  findExportedNodesByFile,
  findFileNodes,
  findNodesByFile,
} from '../../db/index.js';
import { cachedStmt } from '../../db/repository/cached-stmt.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
} from '../../shared/file-utils.js';
import { paginateResult } from '../../shared/paginate.js';
import type { BetterSqlite3Database, NodeRow, StmtCache } from '../../types.js';
import { resolveAnalysisOpts, withReadonlyDb } from './query-helpers.js';

const _consumersStmtCache: StmtCache<{ name: string; file: string; line: number }> = new WeakMap();
const _reexportsFromStmtCache: StmtCache<{ file: string }> = new WeakMap();
const _reexportsToStmtCache: StmtCache<{ file: string }> = new WeakMap();
const _reexportSymbolsStmtCache: StmtCache<NodeRow> = new WeakMap();

export function exportsData(
  file: string,
  customDbPath: string,
  opts: {
    noTests?: boolean;
    unused?: boolean;
    limit?: number;
    offset?: number;
    config?: any;
  } = {},
) {
  return withReadonlyDb(customDbPath, (db, config) => {
    const { noTests, displayOpts } = resolveAnalysisOpts({
      ...opts,
      config: opts.config ?? config,
    });

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
  });
}

/**
 * Collect symbols re-exported through barrel files.
 *
 * `export { X } from 'Y'` records a symbol-level `reexports` edge straight to
 * `X`'s own node (emitted by `emitNamedSymbolEdges` in build-edges.ts /
 * incremental.ts, and the mirrored Rust extractors) — so for any target file
 * reached with at least one such edge, only those specifically-named symbols
 * are reported. `export * from 'Y'` (and any other reexport whose specific
 * symbol couldn't be resolved) carries no symbol-level edge, so it falls
 * back to the target's full export list — a wildcard genuinely does
 * re-export everything, unlike a named specifier (#1742).
 */
function collectReexportedSymbols(
  db: BetterSqlite3Database,
  fileNodeId: number,
  reexportsToStmt: ReturnType<BetterSqlite3Database['prepare']>,
  reexportSymbolsStmt: ReturnType<BetterSqlite3Database['prepare']>,
  getFileLines: (file: string) => string[] | null,
  buildSymbolResult: (s: NodeRow, fileLines: string[] | null) => any,
) {
  const reexportTargets = reexportsToStmt.all(fileNodeId) as Array<{ file: string }>;
  const namedSymbols = reexportSymbolsStmt.all(fileNodeId) as NodeRow[];
  const namedByFile = new Map<string, NodeRow[]>();
  for (const s of namedSymbols) {
    if (!namedByFile.has(s.file)) namedByFile.set(s.file, []);
    namedByFile.get(s.file)!.push(s);
  }

  const reexportedSymbols: Array<ReturnType<typeof buildSymbolResult> & { originFile: string }> =
    [];
  for (const reexTarget of reexportTargets) {
    const targetExported =
      namedByFile.get(reexTarget.file) ?? findExportedNodesByFile(db, reexTarget.file);
    for (const s of targetExported) {
      reexportedSymbols.push({
        ...buildSymbolResult(s, getFileLines(reexTarget.file)),
        originFile: reexTarget.file,
      });
    }
  }
  return reexportedSymbols;
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

  // Consumers include real call/construct edges plus `imports-type` edges —
  // the symbol-level edge emitted for `import type { X }` statements (source
  // is the importing *file* node, since the import statement references the
  // type rather than a specific function). Without this, interfaces/types
  // that are only ever used as type annotations are misclassified as dead
  // exports even though `codegraph deps` already reports the importing file
  // via this same edge (#1724).
  //
  // `extends`/`implements` edges are deliberately NOT included here: they are
  // resolved by symbol name only, with no file/import scoping (see
  // buildClassHierarchyEdges), so they can link same-named declarations
  // across unrelated files — crediting them as consumers would surface false
  // positives instead of fixing false negatives.
  const consumersStmt = cachedStmt(
    _consumersStmtCache,
    db,
    `SELECT n.name, n.file, n.line FROM edges e JOIN nodes n ON e.source_id = n.id
         WHERE e.target_id = ? AND e.kind IN ('calls', 'imports-type')`,
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
  // Symbol-level `reexports` edges — the specific symbols named in
  // `export { X } from 'Y'` clauses (target is the symbol node itself, not
  // a file node). Distinct from reexportsToStmt above, which only proves a
  // reexport *relationship* exists with a target file (#1742).
  const reexportSymbolsStmt = cachedStmt(
    _reexportSymbolsStmtCache,
    db,
    `SELECT DISTINCT n.* FROM edges e JOIN nodes n ON e.target_id = n.id
       WHERE e.source_id = ? AND e.kind = 'reexports' AND n.kind != 'file'
       ORDER BY n.line`,
  );

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file) as NodeRow[];

    const exported = findExportedNodesByFile(db, fn.file);
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

    const reexports = (reexportsFromStmt.all(fn.id) as Array<{ file: string }>).map((r) => ({
      file: r.file,
    }));

    // Gather symbols re-exported from target modules (barrel file support)
    const reexportedSymbols = collectReexportedSymbols(
      db,
      fn.id,
      reexportsToStmt,
      reexportSymbolsStmt,
      getFileLines,
      buildSymbolResult,
    );

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
