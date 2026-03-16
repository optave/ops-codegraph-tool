export function getFileHash(db, file) {
  const row = db.prepare('SELECT hash FROM file_hashes WHERE file = ?').get(file);
  return row ? row.hash : null;
}

export function kindIcon(kind) {
  switch (kind) {
    case 'function':
      return 'f';
    case 'class':
      return '*';
    case 'method':
      return 'o';
    case 'file':
      return '#';
    case 'interface':
      return 'I';
    case 'type':
      return 'T';
    case 'parameter':
      return 'p';
    case 'property':
      return '.';
    case 'constant':
      return 'C';
    default:
      return '-';
  }
}

/**
 * Normalize a raw DB/query row into the stable 7-field symbol shape.
 * @param {object} row    - Raw row (from SELECT * or explicit columns)
 * @param {object} [db]   - Open DB handle; when null, fileHash will be null
 * @param {Map}    [hashCache] - Optional per-file cache to avoid repeated getFileHash calls
 * @returns {{ name: string, kind: string, file: string, line: number, endLine: number|null, role: string|null, fileHash: string|null }}
 */
export function normalizeSymbol(row, db, hashCache) {
  let fileHash = null;
  if (db) {
    if (hashCache) {
      if (!hashCache.has(row.file)) {
        hashCache.set(row.file, getFileHash(db, row.file));
      }
      fileHash = hashCache.get(row.file);
    } else {
      fileHash = getFileHash(db, row.file);
    }
  }
  return {
    name: row.name,
    kind: row.kind,
    file: row.file,
    line: row.line,
    endLine: row.end_line ?? row.endLine ?? null,
    role: row.role ?? null,
    fileHash,
  };
}
