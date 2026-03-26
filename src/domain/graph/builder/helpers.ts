/**
 * Builder helper functions — shared utilities used across pipeline stages.
 *
 * Extracted from the monolithic builder.js so stages can import individually.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { purgeFilesData } from '../../../db/index.js';
import { warn } from '../../../infrastructure/logger.js';
import { EXTENSIONS, IGNORE_DIRS } from '../../../shared/constants.js';
import type { BetterSqlite3Database, CodegraphConfig, PathAliases } from '../../../types.js';

export const BUILTIN_RECEIVERS: Set<string> = new Set([
  'console',
  'Math',
  'JSON',
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'Error',
  'TypeError',
  'RangeError',
  'Proxy',
  'Reflect',
  'Intl',
  'globalThis',
  'window',
  'document',
  'process',
  'Buffer',
  'require',
]);

/**
 * Recursively collect all source files under `dir`.
 * When `directories` is a Set, also tracks which directories contain files.
 */
export function collectFiles(
  dir: string,
  files: string[],
  config: Partial<CodegraphConfig>,
  directories: Set<string>,
  _visited?: Set<string>,
): { files: string[]; directories: Set<string> };
export function collectFiles(
  dir: string,
  files?: string[],
  config?: Partial<CodegraphConfig>,
  directories?: null,
  _visited?: Set<string>,
): string[];
export function collectFiles(
  dir: string,
  files: string[] = [],
  config: Partial<CodegraphConfig> = {},
  directories: Set<string> | null = null,
  _visited: Set<string> = new Set(),
): string[] | { files: string[]; directories: Set<string> } {
  const trackDirs = directories instanceof Set;
  let hasFiles = false;

  // Merge config ignoreDirs with defaults
  const extraIgnore = config.ignoreDirs ? new Set(config.ignoreDirs) : null;

  // Detect symlink loops (before I/O to avoid wasted readdirSync)
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return trackDirs ? { files, directories: directories as Set<string> } : files;
  }
  if (_visited.has(realDir)) {
    warn(`Symlink loop detected, skipping: ${dir}`);
    return trackDirs ? { files, directories: directories as Set<string> } : files;
  }
  _visited.add(realDir);

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    warn(`Cannot read directory ${dir}: ${(err as Error).message}`);
    return trackDirs ? { files, directories: directories as Set<string> } : files;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) continue;
    }
    if (IGNORE_DIRS.has(entry.name)) continue;
    if (extraIgnore?.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (trackDirs) {
        collectFiles(full, files, config, directories as Set<string>, _visited);
      } else {
        collectFiles(full, files, config, null, _visited);
      }
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
      hasFiles = true;
    }
  }
  if (trackDirs && hasFiles) {
    (directories as Set<string>).add(dir);
  }
  return trackDirs ? { files, directories: directories as Set<string> } : files;
}

/**
 * Load path aliases from tsconfig.json / jsconfig.json.
 */
export function loadPathAliases(rootDir: string): PathAliases {
  const aliases: PathAliases = { baseUrl: null, paths: {} };
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs
        .readFileSync(configPath, 'utf-8')
        .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\/|\/\/.*$/gm, (_, str) => str ?? '')
        .replace(/,\s*([\]}])/g, '$1');
      const config = JSON.parse(raw) as {
        compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
      };
      const opts = config.compilerOptions || {};
      if (opts.baseUrl) aliases.baseUrl = path.resolve(rootDir, opts.baseUrl);
      if (opts.paths) {
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          aliases.paths[pattern] = targets.map((t: string) =>
            path.resolve(aliases.baseUrl || rootDir, t),
          );
        }
      }
      break;
    } catch (err: unknown) {
      warn(`Failed to parse ${configName}: ${(err as Error).message}`);
    }
  }
  return aliases;
}

/**
 * Compute MD5 hash of file contents for incremental builds.
 */
export function fileHash(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/**
 * Stat a file, returning { mtimeMs, size } or null on error.
 */
export function fileStat(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/**
 * Read a file with retry on transient errors (EBUSY/EACCES/EPERM).
 */
const TRANSIENT_CODES: Set<string> = new Set(['EBUSY', 'EACCES', 'EPERM']);
const RETRY_DELAY_MS = 50;

export function readFileSafe(filePath: string, retries: number = 2): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err: unknown) {
      if (attempt < retries && TRANSIENT_CODES.has((err as NodeJS.ErrnoException).code ?? '')) {
        const sharedBuf = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(sharedBuf), 0, 0, RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

/**
 * Purge all graph data for the specified files.
 */
export function purgeFilesFromGraph(
  db: BetterSqlite3.Database,
  files: string[],
  options: Record<string, unknown> = {},
): void {
  // Double-cast needed: better-sqlite3 types don't declare `open`/`name` properties
  purgeFilesData(db as unknown as BetterSqlite3Database, files, options);
}

/** Batch INSERT chunk size for multi-value INSERTs. */
const BATCH_CHUNK = 500;

// Statement caches keyed by chunk size — avoids recompiling for every batch.
const nodeStmtCache = new WeakMap<BetterSqlite3.Database, Map<number, BetterSqlite3.Statement>>();
const edgeStmtCache = new WeakMap<BetterSqlite3.Database, Map<number, BetterSqlite3.Statement>>();

function getNodeStmt(db: BetterSqlite3.Database, chunkSize: number): BetterSqlite3.Statement {
  let cache = nodeStmtCache.get(db);
  if (!cache) {
    cache = new Map();
    nodeStmtCache.set(db, cache);
  }
  let stmt = cache.get(chunkSize);
  if (!stmt) {
    const ph = '(?,?,?,?,?,?,?,?,?)';
    stmt = db.prepare(
      'INSERT OR IGNORE INTO nodes (name,kind,file,line,end_line,parent_id,qualified_name,scope,visibility) VALUES ' +
        Array.from({ length: chunkSize }, () => ph).join(','),
    );
    cache.set(chunkSize, stmt);
  }
  return stmt;
}

function getEdgeStmt(db: BetterSqlite3.Database, chunkSize: number): BetterSqlite3.Statement {
  let cache = edgeStmtCache.get(db);
  if (!cache) {
    cache = new Map();
    edgeStmtCache.set(db, cache);
  }
  let stmt = cache.get(chunkSize);
  if (!stmt) {
    const ph = '(?,?,?,?,?)';
    stmt = db.prepare(
      'INSERT INTO edges (source_id,target_id,kind,confidence,dynamic) VALUES ' +
        Array.from({ length: chunkSize }, () => ph).join(','),
    );
    cache.set(chunkSize, stmt);
  }
  return stmt;
}

/**
 * Batch-insert node rows via multi-value INSERT statements.
 * Each row: [name, kind, file, line, end_line, parent_id, qualified_name, scope, visibility]
 */
export function batchInsertNodes(db: BetterSqlite3.Database, rows: unknown[][]): void {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const end = Math.min(i + BATCH_CHUNK, rows.length);
    const chunkSize = end - i;
    const stmt = getNodeStmt(db, chunkSize);
    const vals: unknown[] = [];
    for (let j = i; j < end; j++) {
      const r = rows[j] as unknown[];
      vals.push(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]);
    }
    stmt.run(...vals);
  }
}

/**
 * Batch-insert edge rows via multi-value INSERT statements.
 * Each row: [source_id, target_id, kind, confidence, dynamic]
 */
export function batchInsertEdges(db: BetterSqlite3.Database, rows: unknown[][]): void {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const end = Math.min(i + BATCH_CHUNK, rows.length);
    const chunkSize = end - i;
    const stmt = getEdgeStmt(db, chunkSize);
    const vals: unknown[] = [];
    for (let j = i; j < end; j++) {
      const r = rows[j] as unknown[];
      vals.push(r[0], r[1], r[2], r[3], r[4]);
    }
    stmt.run(...vals);
  }
}
