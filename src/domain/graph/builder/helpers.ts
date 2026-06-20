/**
 * Builder helper functions — shared utilities used across pipeline stages.
 *
 * Extracted from the monolithic builder.js so stages can import individually.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { purgeFilesData } from '../../../db/index.js';
import { debug, warn } from '../../../infrastructure/logger.js';
import { EXTENSIONS, IGNORE_DIRS, normalizePath } from '../../../shared/constants.js';
import { compileGlobs, matchesAny } from '../../../shared/globs.js';
import type {
  BetterSqlite3Database,
  CodegraphConfig,
  PathAliases,
  SqliteStatement,
} from '../../../types.js';

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

/** Phase 8.6: confidence penalty applied to CHA-dispatch edges. */
export const CHA_DISPATCH_PENALTY = 0.1;
/** Phase 8.6: fixed confidence for typed-receiver (interface/CHA) dispatch edges.
 *  File proximity is not meaningful for virtual dispatch — all three engine paths
 *  (WASM inline, WASM post-pass, native post-pass) must agree on this value. */
export const CHA_TYPED_DISPATCH_CONFIDENCE = 0.8;

/** Check if a directory entry should be skipped (ignored dirs, dotfiles). */
function shouldSkipEntry(entry: fs.Dirent, extraIgnore: Set<string> | null): boolean {
  if (entry.name.startsWith('.') && entry.name !== '.') {
    if (IGNORE_DIRS.has(entry.name)) return true;
    if (entry.isDirectory()) return true;
  }
  if (IGNORE_DIRS.has(entry.name)) return true;
  if (extraIgnore?.has(entry.name)) return true;
  return false;
}

/**
 * Check whether a source file passes the configured include/exclude globs.
 *
 * Patterns are matched against the path relative to the project root,
 * normalized to forward slashes (e.g. `src/foo/bar.ts`). When both lists
 * are set, a file must match at least one include and no exclude.
 */
export function passesIncludeExclude(
  relPath: string,
  includeRegexes: readonly RegExp[],
  excludeRegexes: readonly RegExp[],
): boolean {
  if (includeRegexes.length > 0 && !matchesAny(includeRegexes, relPath)) return false;
  if (excludeRegexes.length > 0 && matchesAny(excludeRegexes, relPath)) return false;
  return true;
}

/** Per-walk state computed once at the top-level invocation. */
interface CollectContext {
  readonly rootDir: string;
  readonly includeRegexes: readonly RegExp[];
  readonly excludeRegexes: readonly RegExp[];
  readonly hasGlobFilters: boolean;
  readonly extraIgnore: Set<string> | null;
  readonly visited: Set<string>;
}

/** Detect a symlink loop for `dir`. Returns true if `dir` was already visited. */
function isSymlinkLoop(dir: string, visited: Set<string>): boolean {
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return true;
  }
  if (visited.has(realDir)) {
    warn(`Symlink loop detected, skipping: ${dir}`);
    return true;
  }
  visited.add(realDir);
  return false;
}

/** Read directory entries, returning null on error (already logged). */
function readDirSafe(dir: string): fs.Dirent[] | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: unknown) {
    warn(`Cannot read directory ${dir}: ${(err as Error).message}`);
    return null;
  }
}

/** True if `entry` is a source file we should collect under `ctx`. */
function isCollectableSourceFile(full: string, entry: fs.Dirent, ctx: CollectContext): boolean {
  if (!EXTENSIONS.has(path.extname(entry.name))) return false;
  if (!ctx.hasGlobFilters) return true;
  const rel = normalizePath(path.relative(ctx.rootDir, full));
  return passesIncludeExclude(rel, ctx.includeRegexes, ctx.excludeRegexes);
}

function walkCollect(
  dir: string,
  files: string[],
  directories: Set<string> | null,
  ctx: CollectContext,
): void {
  if (isSymlinkLoop(dir, ctx.visited)) return;

  const entries = readDirSafe(dir);
  if (!entries) return;

  let hasFiles = false;
  for (const entry of entries) {
    if (shouldSkipEntry(entry, ctx.extraIgnore)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkCollect(full, files, directories, ctx);
    } else if (isCollectableSourceFile(full, entry, ctx)) {
      files.push(full);
      hasFiles = true;
    }
  }
  if (directories && hasFiles) {
    directories.add(dir);
  }
}

/**
 * Recursively collect all source files under `dir`.
 * When `directories` is a Set, also tracks which directories contain files.
 *
 * `dir` establishes the project root against which `config.include` /
 * `config.exclude` globs are matched.
 */
export function collectFiles(
  dir: string,
  files: string[],
  config: Partial<CodegraphConfig>,
  directories: Set<string>,
): { files: string[]; directories: Set<string> };
export function collectFiles(
  dir: string,
  files?: string[],
  config?: Partial<CodegraphConfig>,
  directories?: null,
): string[];
export function collectFiles(
  dir: string,
  files: string[] = [],
  config: Partial<CodegraphConfig> = {},
  directories: Set<string> | null = null,
): string[] | { files: string[]; directories: Set<string> } {
  const trackDirs = directories instanceof Set;
  const includeRegexes = compileGlobs(config.include);
  const excludeRegexes = compileGlobs(config.exclude);
  const ctx: CollectContext = {
    rootDir: dir,
    includeRegexes,
    excludeRegexes,
    hasGlobFilters: includeRegexes.length > 0 || excludeRegexes.length > 0,
    extraIgnore: config.ignoreDirs ? new Set(config.ignoreDirs) : null,
    visited: new Set(),
  };

  walkCollect(dir, files, trackDirs ? (directories as Set<string>) : null, ctx);

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
 * Stat a file, returning { mtime, size } or null on error.
 *
 * `mtime` is `Math.floor(stat.mtimeMs)` so it matches the integer column
 * stored in the DB. Floor-once-here keeps every consumer honest: storing or
 * comparing a non-floored `mtimeMs` against the integer DB column would cause
 * spurious fast-skip misses on the next build.
 */
export function fileStat(filePath: string): { mtime: number; size: number } | null {
  try {
    const s = fs.statSync(filePath);
    return { mtime: Math.floor(s.mtimeMs), size: s.size };
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
  db: BetterSqlite3Database,
  files: string[],
  options: Record<string, unknown> = {},
): void {
  // Double-cast needed: better-sqlite3 types don't declare `open`/`name` properties
  purgeFilesData(db as unknown as BetterSqlite3Database, files, options);
}

/** Batch INSERT chunk size for multi-value INSERTs. */
const BATCH_CHUNK = 500;

// Statement caches keyed by chunk size — avoids recompiling for every batch.
const nodeStmtCache = new WeakMap<BetterSqlite3Database, Map<number, SqliteStatement>>();
const edgeStmtCache = new WeakMap<BetterSqlite3Database, Map<number, SqliteStatement>>();

function getNodeStmt(db: BetterSqlite3Database, chunkSize: number): SqliteStatement {
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

function getEdgeStmt(db: BetterSqlite3Database, chunkSize: number): SqliteStatement {
  let cache = edgeStmtCache.get(db);
  if (!cache) {
    cache = new Map();
    edgeStmtCache.set(db, cache);
  }
  let stmt = cache.get(chunkSize);
  if (!stmt) {
    const ph = '(?,?,?,?,?,?,?)';
    stmt = db.prepare(
      'INSERT INTO edges (source_id,target_id,kind,confidence,dynamic,technique,dynamic_kind) VALUES ' +
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
export function batchInsertNodes(db: BetterSqlite3Database, rows: unknown[][]): void {
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
 * Each row: [source_id, target_id, kind, confidence, dynamic, technique, dynamic_kind]
 */
export function batchInsertEdges(db: BetterSqlite3Database, rows: unknown[][]): void {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += BATCH_CHUNK) {
    const end = Math.min(i + BATCH_CHUNK, rows.length);
    const chunkSize = end - i;
    const stmt = getEdgeStmt(db, chunkSize);
    const vals: unknown[] = [];
    for (let j = i; j < end; j++) {
      const r = rows[j] as unknown[];
      vals.push(r[0], r[1], r[2], r[3], r[4], r[5] ?? null, r[6] ?? null);
    }
    stmt.run(...vals);
  }
}

/** Confidence assigned to CHA-expanded interface/abstract dispatch edges. */
export const CHA_DISPATCH_CONFIDENCE = 0.8;

/**
 * Build the parent→children implementor map from `extends`/`implements` edges.
 * Returns null if no hierarchy edges exist.
 */
function buildImplementorMap(
  db: BetterSqlite3Database,
): { implementors: Map<string, string[]>; implementorSets: Map<string, Set<string>> } | null {
  const hasHierarchy = db
    .prepare(`SELECT 1 FROM edges WHERE kind IN ('extends', 'implements') LIMIT 1`)
    .get();
  if (!hasHierarchy) return null;

  const hierarchyRows = db
    .prepare(
      `SELECT src.name AS child_name, tgt.name AS parent_name
       FROM edges e
       JOIN nodes src ON e.source_id = src.id
       JOIN nodes tgt ON e.target_id = tgt.id
       WHERE e.kind IN ('extends', 'implements')`,
    )
    .all() as Array<{ child_name: string; parent_name: string }>;

  const implementorSets = new Map<string, Set<string>>();
  for (const row of hierarchyRows) {
    let set = implementorSets.get(row.parent_name);
    if (!set) {
      set = new Set<string>();
      implementorSets.set(row.parent_name, set);
    }
    set.add(row.child_name);
  }
  if (implementorSets.size === 0) return null;

  // Convert to arrays for iteration compatibility
  const implementors = new Map([...implementorSets.entries()].map(([k, v]) => [k, [...v]]));
  return { implementors, implementorSets };
}

/**
 * Collect RTA (Rapid Type Analysis) evidence: class names instantiated via
 * constructor calls (`new X()`). Falls back to constructor/function-kind nodes
 * for languages that record constructor calls differently (e.g. TS via WASM).
 */
function collectRtaInstantiated(
  db: BetterSqlite3Database,
  implementorSets: Map<string, Set<string>>,
): Set<string> {
  let rtaRows = db
    .prepare(
      `SELECT DISTINCT tgt.name
       FROM edges e
       JOIN nodes tgt ON e.target_id = tgt.id
       WHERE e.kind = 'calls' AND tgt.kind = 'class'`,
    )
    .all() as Array<{ name: string }>;

  if (rtaRows.length === 0) {
    // Fallback: some languages (e.g. TypeScript via WASM) record constructor calls as
    // 'function' or 'constructor' kind rather than 'class'. Restrict to names that are
    // actually known class names to avoid treating unrelated function calls like `logger()`
    // as class-instantiation evidence.
    // Include both parent/interface names AND implementor (child) names so that
    // `new UserRepository()` (a child class) is correctly detected as RTA evidence.
    const knownClassNames = [
      ...new Set([
        ...implementorSets.keys(),
        ...[...implementorSets.values()].flatMap((s) => [...s]),
      ]),
    ];
    if (knownClassNames.length > 0) {
      // Chunk to stay within SQLite SQLITE_MAX_VARIABLE_NUMBER (999 in many builds).
      const CHUNK = 999;
      for (let i = 0; i < knownClassNames.length; i += CHUNK) {
        const chunk = knownClassNames.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        const chunkRows = db
          .prepare(
            `SELECT DISTINCT tgt.name
             FROM edges e
             JOIN nodes tgt ON e.target_id = tgt.id
             WHERE e.kind = 'calls' AND tgt.kind IN ('constructor', 'function')
             AND tgt.name IN (${placeholders})`,
          )
          .all(...chunk) as Array<{ name: string }>;
        rtaRows = rtaRows.concat(chunkRows);
      }
    }
  }

  return new Set(rtaRows.map((r) => r.name));
}

/**
 * BFS-expand a single call-to-qualified-method into CHA dispatch edges.
 *
 * For `source_id` calling `typeName.methodSuffix`, walks the implementors
 * map (BFS) and emits an edge for each concrete override that passes the
 * RTA filter.  New edges are appended to `newEdges`; `seen` is updated in
 * place to prevent duplicate insertions within the same pass.
 */
function expandChaCall(
  sourceId: number,
  typeName: string,
  methodSuffix: string,
  implementors: Map<string, string[]>,
  instantiated: Set<string>,
  noRtaEvidence: boolean,
  findMethodStmt: { all(name: string): unknown[] },
  seen: Set<string>,
  newEdges: Array<[number, number, string, number, number, string]>,
): void {
  // BFS over the implementors map — handles multi-level hierarchies where
  // abstract/non-instantiated classes sit between the call-site type and
  // the concrete leaf implementations (matches runPostNativeCha, issue #1311).
  const bfsQueue: string[] = [typeName];
  const bfsVisited = new Set<string>([typeName]);
  while (bfsQueue.length > 0) {
    const current = bfsQueue.shift()!;
    const children = implementors.get(current);
    if (!children?.length) continue;

    for (const cls of children) {
      if (bfsVisited.has(cls)) continue;
      bfsVisited.add(cls);

      if (noRtaEvidence || instantiated.has(cls)) {
        const qualifiedName = `${cls}.${methodSuffix}`;
        const methodNodes = findMethodStmt.all(qualifiedName) as Array<{ id: number }>;
        for (const methodNode of methodNodes) {
          if (methodNode.id === sourceId) continue; // skip self-loops
          const key = `${sourceId}|${methodNode.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          newEdges.push([
            sourceId,
            methodNode.id,
            'calls',
            CHA_TYPED_DISPATCH_CONFIDENCE,
            0,
            'cha-expanded',
          ]);
        }
      }

      // Always traverse children — non-instantiated classes may have instantiated subclasses.
      bfsQueue.push(cls);
    }
  }
}

/**
 * CHA (Class Hierarchy Analysis) post-pass.
 *
 * Expands virtual-dispatch call edges for class hierarchies and interface
 * implementations already present in the DB:
 *
 *  1. Build implementors map: parent/interface → [child/implementing class] from
 *     `extends` and `implements` edges.
 *  2. Collect RTA evidence: class nodes that appear as `calls` targets (new X()).
 *  3. Find all `calls` edges to qualified method nodes (name contains '.').
 *  4. For each such call, expand to concrete overrides via the implementors map,
 *     filtered by RTA when evidence exists.
 *
 * Used by both the native orchestrator post-pass and the WASM build-edges pass.
 */
export function runChaPostPass(db: BetterSqlite3Database): number {
  const hierarchy = buildImplementorMap(db);
  if (!hierarchy) return 0;
  const { implementors, implementorSets } = hierarchy;

  const instantiated = collectRtaInstantiated(db, implementorSets);
  const noRtaEvidence = instantiated.size === 0;
  if (noRtaEvidence) {
    debug('runChaPostPass: no constructor-call evidence — proceeding without RTA filter');
  }

  const callToMethods = db
    .prepare(
      `SELECT e.source_id, src.name AS caller_name, tgt.name AS method_name
       FROM edges e
       JOIN nodes tgt ON e.target_id = tgt.id
       JOIN nodes src ON e.source_id = src.id
       WHERE e.kind = 'calls' AND tgt.kind = 'method'
       AND INSTR(tgt.name, '.') > 0
       AND (e.technique IS NULL OR e.technique != 'cha-expanded')`,
    )
    .all() as Array<{ source_id: number; caller_name: string; method_name: string }>;

  // Scope deduplication to only the source_ids we are about to expand, avoiding
  // a full-table scan. CHA only inserts edges FROM callers that already call a
  // qualified method (the source_ids in callToMethods), so we only need to
  // check existing edges for those specific callers.
  const seen = new Set<string>();
  const callerIds = [...new Set(callToMethods.map((r) => r.source_id))];
  if (callerIds.length > 0) {
    // Chunk to stay within SQLite SQLITE_MAX_VARIABLE_NUMBER (999 in many builds).
    const CHUNK = 999;
    for (let i = 0; i < callerIds.length; i += CHUNK) {
      const chunk = callerIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const existingPairs = db
        .prepare(
          `SELECT source_id, target_id FROM edges WHERE kind = 'calls' AND source_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ source_id: number; target_id: number }>;
      for (const e of existingPairs) seen.add(`${e.source_id}|${e.target_id}`);
    }
  }

  // No LIMIT: multiple files can define the same qualified name in a monorepo.
  const findMethodStmt = db.prepare(`SELECT id FROM nodes WHERE name = ? AND kind = 'method'`);
  const newEdges: Array<[number, number, string, number, number, string]> = [];

  for (const { source_id, method_name } of callToMethods) {
    const dotIdx = method_name.indexOf('.');
    if (dotIdx === -1) continue;
    const typeName = method_name.slice(0, dotIdx);
    const methodSuffix = method_name.slice(dotIdx + 1);
    expandChaCall(
      source_id,
      typeName,
      methodSuffix,
      implementors,
      instantiated,
      noRtaEvidence,
      findMethodStmt,
      seen,
      newEdges,
    );
  }

  if (newEdges.length > 0) {
    db.transaction(() => batchInsertEdges(db, newEdges))();
    debug(`runChaPostPass: inserted ${newEdges.length} CHA dispatch edge(s)`);
  }
  return newEdges.length;
}
