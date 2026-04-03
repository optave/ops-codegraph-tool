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

export async function watchProject(rootDir: string, opts: { engine?: string } = {}): Promise<void> {
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

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 300;

  info(`Watching ${rootDir} for changes...`);
  info('Press Ctrl+C to stop.');

  const watcher = fs.watch(rootDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (shouldIgnore(filename)) return;
    if (!isTrackedExt(filename)) return;

    const fullPath = path.join(rootDir, filename);
    pending.add(fullPath);

    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      const files = [...pending];
      pending.clear();
      await processPendingFiles(files, db, rootDir, stmts, engineOpts, cache);
    }, DEBOUNCE_MS);
  });

  process.on('SIGINT', () => {
    info('Stopping watcher...');
    watcher.close();
    // Flush any pending file paths to journal before exit
    if (pending.size > 0) {
      const entries = [...pending].map((filePath) => ({
        file: normalizePath(path.relative(rootDir, filePath)),
      }));
      try {
        appendJournalEntries(rootDir, entries);
      } catch (e: unknown) {
        debug(`Journal flush on exit failed (non-fatal): ${(e as Error).message}`);
      }
    }
    if (cache) cache.clear();
    closeDb(db);
    process.exit(0);
  });
}
