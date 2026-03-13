import fs from 'node:fs';
import path from 'node:path';
import { rebuildFile } from './builder/incremental.js';
import { appendChangeEvents, buildChangeEvent, diffSymbols } from './change-journal.js';
import { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';
import { closeDb, getNodeId as getNodeIdQuery, initSchema, openDb } from './db.js';
import { DbError } from './errors.js';
import { appendJournalEntries } from './journal.js';
import { info } from './logger.js';
import { createParseTreeCache, getActiveEngine } from './parser.js';

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

function isTrackedExt(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

export async function watchProject(rootDir, opts = {}) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    throw new DbError('No graph.db found. Run `codegraph build` first.', { file: dbPath });
  }

  const db = openDb(dbPath);
  initSchema(db);
  const engineOpts = { engine: opts.engine || 'auto' };
  const { name: engineName, version: engineVersion } = getActiveEngine(engineOpts);
  console.log(
    `Watch mode using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`,
  );

  const cache = createParseTreeCache();
  console.log(
    cache
      ? 'Incremental parsing enabled (native tree cache)'
      : 'Incremental parsing unavailable (full re-parse)',
  );

  const stmts = {
    insertNode: db.prepare(
      'INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)',
    ),
    getNodeId: {
      get: (name, kind, file, line) => {
        const id = getNodeIdQuery(db, name, kind, file, line);
        return id != null ? { id } : undefined;
      },
    },
    insertEdge: db.prepare(
      'INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)',
    ),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    deleteEdgesForFile: null,
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdgesForFile: null,
    findNodeInFile: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module') AND file = ?",
    ),
    findNodeByName: db.prepare(
      "SELECT id, file FROM nodes WHERE name = ? AND kind IN ('function', 'method', 'class', 'interface', 'type', 'struct', 'enum', 'trait', 'record', 'module')",
    ),
    listSymbols: db.prepare("SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file'"),
  };

  // Use named params for statements needing the same value twice
  const origDeleteEdges = db.prepare(
    `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  const origCountEdges = db.prepare(
    `SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`,
  );
  stmts.deleteEdgesForFile = { run: (f) => origDeleteEdges.run({ f }) };
  stmts.countEdgesForFile = { get: (f) => origCountEdges.get({ f }) };

  const pending = new Set();
  let timer = null;
  const DEBOUNCE_MS = 300;

  async function processPending() {
    const files = [...pending];
    pending.clear();

    const results = [];
    for (const filePath of files) {
      const result = await rebuildFile(db, rootDir, filePath, stmts, engineOpts, cache, {
        diffSymbols,
      });
      if (result) results.push(result);
    }
    const updates = results;

    // Append processed files to journal for Tier 0 detection on next build
    if (updates.length > 0) {
      const entries = updates.map((r) => ({
        file: r.file,
        deleted: r.deleted || false,
      }));
      try {
        appendJournalEntries(rootDir, entries);
      } catch {
        /* journal write failure is non-fatal */
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
      } catch {
        /* change event write failure is non-fatal */
      }
    }

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

  console.log(`Watching ${rootDir} for changes...`);
  console.log('Press Ctrl+C to stop.\n');

  const watcher = fs.watch(rootDir, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    if (shouldIgnore(filename)) return;
    if (!isTrackedExt(filename)) return;

    const fullPath = path.join(rootDir, filename);
    pending.add(fullPath);

    if (timer) clearTimeout(timer);
    timer = setTimeout(processPending, DEBOUNCE_MS);
  });

  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.close();
    // Flush any pending file paths to journal before exit
    if (pending.size > 0) {
      const entries = [...pending].map((filePath) => ({
        file: normalizePath(path.relative(rootDir, filePath)),
      }));
      try {
        appendJournalEntries(rootDir, entries);
      } catch {
        /* best-effort */
      }
    }
    if (cache) cache.clear();
    closeDb(db);
    process.exit(0);
  });
}
