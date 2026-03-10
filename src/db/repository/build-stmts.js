/**
 * Cascade-delete all graph data for a single file across all tables.
 * Order: dependent tables first, then edges, then nodes, then hashes.
 * Tables that may not exist are wrapped in try/catch.
 *
 * @param {object} db - Open read-write database handle
 * @param {string} file - Relative file path to purge
 * @param {object} [opts]
 * @param {boolean} [opts.purgeHashes=true] - Also delete file_hashes entry
 */
export function purgeFileData(db, file, opts = {}) {
  const { purgeHashes = true } = opts;

  // Optional tables — may not exist in older DBs
  try {
    db.prepare('DELETE FROM embeddings WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)').run(
      file,
    );
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare(
      'DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run(file);
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare(
      'DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run(file);
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare(
      'DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run(file, file);
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare(
      'DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run(file);
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare(
      'DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    ).run(file);
  } catch {
    /* table may not exist */
  }
  try {
    db.prepare('DELETE FROM ast_nodes WHERE file = ?').run(file);
  } catch {
    /* table may not exist */
  }

  // Core tables — always exist
  db.prepare(
    'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)',
  ).run({ f: file });
  db.prepare('DELETE FROM nodes WHERE file = ?').run(file);

  if (purgeHashes) {
    try {
      db.prepare('DELETE FROM file_hashes WHERE file = ?').run(file);
    } catch {
      /* table may not exist */
    }
  }
}

/**
 * Purge all graph data for multiple files (transactional).
 *
 * @param {object} db - Open read-write database handle
 * @param {string[]} files - Relative file paths to purge
 * @param {object} [opts]
 * @param {boolean} [opts.purgeHashes=true]
 */
export function purgeFilesData(db, files, opts = {}) {
  if (!files || files.length === 0) return;
  for (const file of files) {
    purgeFileData(db, file, opts);
  }
}
