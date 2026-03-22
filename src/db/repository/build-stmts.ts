import type { BetterSqlite3Database, SqliteStatement } from '../../types.js';

interface PurgeStmts {
  embeddings: SqliteStatement | null;
  cfgEdges: SqliteStatement | null;
  cfgBlocks: SqliteStatement | null;
  dataflow: SqliteStatement | null;
  complexity: SqliteStatement | null;
  nodeMetrics: SqliteStatement | null;
  astNodes: SqliteStatement | null;
  edges: SqliteStatement;
  nodes: SqliteStatement;
  fileHashes: SqliteStatement | null;
}

interface PurgeOpts {
  purgeHashes?: boolean;
}

/**
 * Prepare all purge statements once, returning an object of runnable stmts.
 * Optional tables are wrapped in try/catch — if the table doesn't exist,
 * that slot is set to null.
 */
function preparePurgeStmts(db: BetterSqlite3Database): PurgeStmts {
  const tryPrepare = (sql: string): SqliteStatement | null => {
    try {
      return db.prepare(sql);
    } catch {
      return null;
    }
  };

  return {
    embeddings: tryPrepare(
      'DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    cfgEdges: tryPrepare(
      'DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    cfgBlocks: tryPrepare(
      'DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    dataflow: tryPrepare(
      'DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    complexity: tryPrepare(
      'DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    nodeMetrics: tryPrepare(
      'DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ),
    astNodes: tryPrepare('DELETE FROM ast_nodes WHERE file = ?'),
    // Core tables — always exist
    edges: db.prepare(
      'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)',
    ),
    nodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    fileHashes: tryPrepare('DELETE FROM file_hashes WHERE file = ?'),
  };
}

/**
 * Cascade-delete all graph data for a single file across all tables.
 * Order: dependent tables first, then edges, then nodes, then hashes.
 */
export function purgeFileData(db: BetterSqlite3Database, file: string, opts: PurgeOpts = {}): void {
  const stmts = preparePurgeStmts(db);
  runPurge(stmts, file, opts);
}

/**
 * Run purge using pre-prepared statements for a single file.
 */
function runPurge(stmts: PurgeStmts, file: string, opts: PurgeOpts = {}): void {
  const { purgeHashes = true } = opts;

  // Optional tables
  stmts.embeddings?.run(file);
  stmts.cfgEdges?.run(file);
  stmts.cfgBlocks?.run(file);
  stmts.dataflow?.run(file, file);
  stmts.complexity?.run(file);
  stmts.nodeMetrics?.run(file);
  stmts.astNodes?.run(file);

  // Core tables
  stmts.edges.run({ f: file });
  stmts.nodes.run(file);

  if (purgeHashes) {
    stmts.fileHashes?.run(file);
  }
}

/**
 * Purge all graph data for multiple files.
 * Prepares statements once and loops over files for efficiency.
 */
export function purgeFilesData(
  db: BetterSqlite3Database,
  files: string[],
  opts: PurgeOpts = {},
): void {
  if (!files || files.length === 0) return;
  const stmts = preparePurgeStmts(db);
  for (const file of files) {
    runPurge(stmts, file, opts);
  }
}
