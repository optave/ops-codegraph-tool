/** Minimal DB handle — avoids importing better-sqlite3 types directly. */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

export function getFileHash(db: DbHandle, file: string): string | null {
  const row = db.prepare('SELECT hash FROM file_hashes WHERE file = ?').get(file) as
    | { hash: string }
    | undefined;
  return row ? row.hash : null;
}

export function kindIcon(kind: string): string {
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

export interface NormalizedSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number | null;
  role: string | null;
  fileHash: string | null;
}

interface RawSymbolRow {
  name: string;
  kind: string;
  file: string;
  line: number;
  end_line?: number | null;
  endLine?: number | null;
  role?: string | null;
}

/**
 * Normalize a raw DB/query row into the stable 7-field symbol shape.
 */
export function normalizeSymbol(
  row: RawSymbolRow,
  db?: DbHandle | null,
  hashCache?: Map<string, string | null>,
): NormalizedSymbol {
  let fileHash: string | null = null;
  if (db) {
    if (hashCache) {
      if (!hashCache.has(row.file)) {
        hashCache.set(row.file, getFileHash(db, row.file));
      }
      fileHash = hashCache.get(row.file) ?? null;
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
