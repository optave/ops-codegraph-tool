/**
 * Prepare all purge statements once, returning an object of runnable stmts.
 * Optional tables are wrapped in try/catch — if the table doesn't exist,
 * that slot is set to null.
 *
 * @param {object} db - Open read-write database handle
 * @returns {object} prepared statements (some may be null)
 */
function preparePurgeStmts(db) {
  const tryPrepare = (sql) => {
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
 *
 * @param {object} db - Open read-write database handle
 * @param {string} file - Relative file path to purge
 * @param {object} [opts]
 * @param {boolean} [opts.purgeHashes=true] - Also delete file_hashes entry
 */
export function purgeFileData(db, file, opts = {}) {
  const stmts = preparePurgeStmts(db);
  runPurge(stmts, file, opts);
}

/**
 * Run purge using pre-prepared statements for a single file.
 * @param {object} stmts - Prepared statements from preparePurgeStmts
 * @param {string} file - Relative file path to purge
 * @param {object} [opts]
 * @param {boolean} [opts.purgeHashes=true]
 */
function runPurge(stmts, file, opts = {}) {
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
 *
 * @param {object} db - Open read-write database handle
 * @param {string[]} files - Relative file paths to purge
 * @param {object} [opts]
 * @param {boolean} [opts.purgeHashes=true]
 */
export function purgeFilesData(db, files, opts = {}) {
  if (!files || files.length === 0) return;
  const stmts = preparePurgeStmts(db);
  for (const file of files) {
    runPurge(stmts, file, opts);
  }
}
