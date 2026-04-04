import fs from 'node:fs';
import path from 'node:path';
import { closeDb, getNodeId as getNodeIdQuery, initSchema, openDb } from '../../db/index.js';
import { debug, info } from '../../infrastructure/logger.js';
import { EXTENSIONS, IGNORE_DIRS, normalizePath } from '../../shared/constants.js';
import { DbError } from '../../shared/errors.js';
import { createParseTreeCache, getActiveEngine } from '../parser.js';
import { type IncrementalStmts, rebuildFile } from './builder/incremental.js';
import { appendChangeEvents, buildChangeEvent, diffSymbols } from './change-journal.js';
import { appendJournalEntries } from './journal.js';

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

function isTrackedExt(filePath: string): boolean {
  return EXTENSIONS.has(path.extname(filePath));
}

/** Prepare all SQL statements needed by the watcher's incremental rebuild. */
function prepareWatcherStatements(db: ReturnType<typeof openDb>): IncrementalStmts {
  const stmts = {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name: string, kind: string, file: string, line: number) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    deleteEdgesForFile: null as { run: (f: string) => void } | null,
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdgesForFile: null as { get: (f: string) => { c: number } | undefined } | null,
    findNodeInFile: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module', 'constant')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };

  const origDeleteEdges = db.prepare(
    `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  const origCountEdges = db.prepare(
    `SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  stmts.deleteEdgesForFile = { run: (f: string) => origDeleteEdges.run({ f }) };
  stmts.countEdgesForFile = {
    get: (f: string) => origCountEdges.get({ f }) as { c: number } | undefined,
  };

  return stmts as IncrementalStmts;
}

/** Rebuild result shape from rebuildFile. */
interface RebuildResult {
  file: string;
  deleted?: boolean;
  event: string;
  symbolDiff: unknown;
  nodesBefore: number;
  nodesAfter: number;
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
}

/** Process a batch of pending file changes: rebuild, journal, and log. */
async function processPendingFiles(
  files: string[],
  db: ReturnType<typeof openDb>,
  rootDir: string,
  stmts: IncrementalStmts,
  engineOpts: import('../../types.js').EngineOpts,
  cache: ReturnType<typeof createParseTreeCache>,
): Promise<void> {
  const results: RebuildResult[] = [];
  for (const filePath of files) {
    const result = (await rebuildFile(db, rootDir, filePath, stmts, engineOpts, cache, {
      diffSymbols: diffSymbols as (old: unknown[], new_: unknown[]) => unknown,
    })) as RebuildResult | null;
    if (result) results.push(result);
  }

  if (results.length > 0) {
    writeJournalAndChangeEvents(rootDir, results);
  }

  logRebuildResults(results);
}

/** Write journal entries and change events for processed files. */
function writeJournalAndChangeEvents(rootDir: string, updates: RebuildResult[]): void {
  const entries = updates.map((r) => ({
    file: r.file,
    deleted: r.deleted || false,
  }));
  try {
    appendJournalEntries(rootDir, entries);
  } catch (e: unknown) {
    debug(`Journal write failed (non-fatal): ${(e as Error).message}`);
  }

  const changeEvents = updates.map((r) =>
    buildChangeEvent(r.file, r.event, r.symbolDiff, {
      nodesBefore: r.nodesBefore,
      nodesAfter: r.nodesAfter,
      edgesAdded: r.edgesAdded,
    }),
  );
  try {
    appendChangeEvents(rootDir, changeEvents);
  } catch (e: unknown) {
    debug(`Change event write failed (non-fatal): ${(e as Error).message}`);
  }
}

/** Log rebuild results to the user. */
function logRebuildResults(updates: RebuildResult[]): void {
  for (const r of updates) {
    const nodeDelta = r.nodesAdded - r.nodesRemoved;
    const nodeStr = nodeDelta >= 0 ? `+${nodeDelta}` : `${nodeDelta}`;
    if (r.deleted) {
      info(`Removed: ${r.file} (-${r.nodesRemoved} nodes)`);
    } else {
      info(`Updated: ${r.file} (${nodeStr} nodes, +${r.edgesAdded} edges)`);
    }
  }
}

/** Recursively collect tracked source files for stat-based polling. */
function collectTrackedFiles(dir: string, result: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e: unknown) {
    debug(`collectTrackedFiles: cannot read ${dir}: ${(e as Error).message}`);
    return;
  }
  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTrackedFiles(full, result);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      result.push(full);
    }
  }
}

/** Shared watcher state passed between setup and watcher sub-functions. */
interface WatcherContext {
  rootDir: string;
  db: ReturnType<typeof openDb>;
  stmts: IncrementalStmts;
  engineOpts: import('../../types.js').EngineOpts;
  cache: ReturnType<typeof createParseTreeCache>;
  pending: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
}

/** Initialize DB, engine, cache, and statements for watch mode. */
function setupWatcher(rootDir: string, opts: { engine?: string }): WatcherContext {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    throw new DbError('No graph.db found. Run `codegraph build` first.', { file: dbPath });
  }

  const db = openDb(dbPath);
  initSchema(db);
  const engineOpts: import('../../types.js').EngineOpts = {
    engine: (opts.engine || 'auto') as import('../../types.js').EngineMode,
    dataflow: false,
    ast: false,
  };
  const { name: engineName, version: engineVersion } = getActiveEngine(engineOpts);
  info(`Watch mode using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`);

  const cache = createParseTreeCache();
  info(
    cache
      ? 'Incremental parsing enabled (native tree cache)'
      : 'Incremental parsing unavailable (full re-parse)',
  );

  const stmts = prepareWatcherStatements(db);

  return {
    rootDir,
    db,
    stmts,
    engineOpts,
    cache,
    pending: new Set<string>(),
    timer: null,
    debounceMs: 300,
  };
}

/** Schedule debounced processing of pending files. */
function scheduleDebouncedProcess(ctx: WatcherContext): void {
  if (ctx.timer) clearTimeout(ctx.timer);
  ctx.timer = setTimeout(async () => {
    const files = [...ctx.pending];
    ctx.pending.clear();
    await processPendingFiles(files, ctx.db, ctx.rootDir, ctx.stmts, ctx.engineOpts, ctx.cache);
  }, ctx.debounceMs);
}

/** Start polling-based file watcher. Returns cleanup function. */
function startPollingWatcher(ctx: WatcherContext, pollIntervalMs: number): () => void {
  const mtimeMap = new Map<string, number>();

  const initial: string[] = [];
  collectTrackedFiles(ctx.rootDir, initial);
  for (const f of initial) {
    try {
      mtimeMap.set(f, fs.statSync(f).mtimeMs);
    } catch {
      /* deleted between collect and stat */
    }
  }
  info(`Polling ${initial.length} tracked files every ${pollIntervalMs}ms`);

  const pollTimer = setInterval(() => {
    const current: string[] = [];
    collectTrackedFiles(ctx.rootDir, current);
    const currentSet = new Set(current);

    for (const f of current) {
      try {
        const mtime = fs.statSync(f).mtimeMs;
        const prev = mtimeMap.get(f);
        if (prev === undefined || mtime !== prev) {
          mtimeMap.set(f, mtime);
          ctx.pending.add(f);
        }
      } catch {
        /* deleted between collect and stat */
      }
    }

    for (const f of mtimeMap.keys()) {
      if (!currentSet.has(f)) {
        mtimeMap.delete(f);
        ctx.pending.add(f);
      }
    }

    if (ctx.pending.size > 0) {
      scheduleDebouncedProcess(ctx);
    }
  }, pollIntervalMs);

  return () => clearInterval(pollTimer);
}

/** Start native OS file watcher. Returns cleanup function. */
function startNativeWatcher(ctx: WatcherContext): () => void {
  const watcher = fs.watch(ctx.rootDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (shouldIgnore(filename)) return;
    if (!isTrackedExt(filename)) return;

    ctx.pending.add(path.join(ctx.rootDir, filename));
    scheduleDebouncedProcess(ctx);
  });

  return () => watcher.close();
}

/** Register SIGINT handler to flush journal and clean up. */
function setupShutdownHandler(ctx: WatcherContext, cleanup: () => void): void {
  process.on('SIGINT', () => {
    info('Stopping watcher...');
    cleanup();
    if (ctx.pending.size > 0) {
      const entries = [...ctx.pending].map((filePath) => ({
        file: normalizePath(path.relative(ctx.rootDir, filePath)),
      }));
      try {
        appendJournalEntries(ctx.rootDir, entries);
      } catch (e: unknown) {
        debug(`Journal flush on exit failed (non-fatal): ${(e as Error).message}`);
      }
    }
    if (ctx.cache) ctx.cache.clear();
    closeDb(ctx.db);
    process.exit(0);
  });
}

export async function watchProject(
  rootDir: string,
  opts: { engine?: string; poll?: boolean; pollInterval?: number } = {},
): Promise<void> {
  const ctx = setupWatcher(rootDir, opts);

  const usePoll = opts.poll ?? process.platform === 'win32';
  const pollIntervalMs = opts.pollInterval ?? 2000;

  info(`Watching ${rootDir} for changes${usePoll ? ' (polling mode)' : ''}...`);
  info('Press Ctrl+C to stop.');

  const cleanup = usePoll ? startPollingWatcher(ctx, pollIntervalMs) : startNativeWatcher(ctx);

  setupShutdownHandler(ctx, cleanup);
}
