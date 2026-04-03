/** Minimal DB handle — avoids importing better-sqlite3 types directly. */
interface DbHandle {
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** Anything that can look up a file hash — either a raw DB or a Repository. */
interface HashSource {
  getFileHash(file: string): string | null;
}

function isHashSource(x: unknown): x is HashSource {
  return typeof x === 'object' && x !== null && typeof (x as HashSource).getFileHash === 'function';
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
 * Accepts a raw DB handle (with .prepare), a Repository (with .getFileHash), or null.
 */
export function normalizeSymbol(
  row: RawSymbolRow,
  db?: DbHandle | HashSource | null,
  hashCache?: Map<string, string | null>,
): NormalizedSymbol {
  let fileHash: string | null = null;
  if (db) {
    const lookupHash = isHashSource(db)
      ? (f: string) => db.getFileHash(f)
      : (f: string) => getFileHash(db as DbHandle, f);
    if (hashCache) {
      if (!hashCache.has(row.file)) {
        hashCache.set(row.file, lookupHash(row.file));
      }
      fileHash = hashCache.get(row.file) ?? null;
    } else {
      fileHash = lookupHash(row.file);
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
