import fs from 'node:fs';
import path from 'node:path';
import { readFileSafe } from './builder.js';
import { appendChangeEvents, buildChangeEvent, diffSymbols } from './change-journal.js';
import { EXTENSIONS, IGNORE_DIRS, normalizePath } from './constants.js';
import { closeDb, initSchema, openDb } from './db.js';
import { appendJournalEntries } from './journal.js';
import { info, warn } from './logger.js';
import { createParseTreeCache, getActiveEngine, parseFileIncremental } from './parser.js';
import { resolveImportPath } from './resolve.js';

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some((p) => IGNORE_DIRS.has(p));
}

function isTrackedExt(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

/**
 * Parse a single file and update the database incrementally.
 */
async function updateFile(_db, rootDir, filePath, stmts, engineOpts, cache) {
  const relPath = normalizePath(path.relative(rootDir, filePath));

  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const _oldEdges = stmts.countEdgesForFile.get(relPath)?.c || 0;
  const oldSymbols = stmts.listSymbols.all(relPath);

  stmts.deleteEdgesForFile.run(relPath);
  stmts.deleteNodes.run(relPath);

  if (!fs.existsSync(filePath)) {
    if (cache) cache.remove(filePath);
    const symbolDiff = diffSymbols(oldSymbols, []);
    return {
      file: relPath,
      nodesAdded: 0,
      nodesRemoved: oldNodes,
      edgesAdded: 0,
      deleted: true,
      event: 'deleted',
      symbolDiff,
      nodesBefore: oldNodes,
      nodesAfter: 0,
    };
  }

  let code;
  try {
    code = readFileSafe(filePath);
  } catch (err) {
    warn(`Cannot read ${relPath}: ${err.message}`);
    return null;
  }

  const symbols = await parseFileIncremental(cache, filePath, code, engineOpts);
  if (!symbols) return null;

  stmts.insertNode.run(relPath, 'file', relPath, 0, null);

  for (const def of symbols.definitions) {
    stmts.insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;
  const newSymbols = stmts.listSymbols.all(relPath);

  let edgesAdded = 0;
  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow)
    return { file: relPath, nodesAdded: newNodes, nodesRemoved: oldNodes, edgesAdded: 0 };
  const fileNodeId = fileNodeRow.id;

  // Load aliases for full import resolution
  const aliases = { baseUrl: null, paths: {} };

  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
    );
    const targetRow = stmts.getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
    if (targetRow) {
      const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
      stmts.insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
      edgesAdded++;
    }
  }

  const importedNames = new Map();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(
      path.join(rootDir, relPath),
      imp.source,
      rootDir,
      aliases,
    );
    for (const name of imp.names) {
      importedNames.set(name.replace(/^\*\s+as\s+/, ''), resolvedPath);
    }
  }

  for (const call of symbols.calls) {
    let caller = null;
    for (const def of symbols.definitions) {
      if (def.line <= call.line) {
        const row = stmts.getNodeId.get(def.name, def.kind, relPath, def.line);
        if (row) caller = row;
      }
    }
    if (!caller) caller = fileNodeRow;

    const importedFrom = importedNames.get(call.name);
    let targets;
    if (importedFrom) {
      targets = stmts.findNodeInFile.all(call.name, importedFrom);
    }
    if (!targets || targets.length === 0) {
      targets = stmts.findNodeInFile.all(call.name, relPath);
      if (targets.length === 0) {
        targets = stmts.findNodeByName.all(call.name);
      }
    }

    for (const t of targets) {
      if (t.id !== caller.id) {
        stmts.insertEdge.run(
          caller.id,
          t.id,
          'calls',
          importedFrom ? 1.0 : 0.5,
          call.dynamic ? 1 : 0,
        );
        edgesAdded++;
      }
    }
  }

  const symbolDiff = diffSymbols(oldSymbols, newSymbols);
  const event = oldNodes === 0 ? 'added' : 'modified';

  return {
    file: relPath,
    nodesAdded: newNodes,
    nodesRemoved: oldNodes,
    edgesAdded,
    deleted: false,
    event,
    symbolDiff,
    nodesBefore: oldNodes,
    nodesAfter: newNodes,
  };
}

export async function watchProject(rootDir, opts = {}) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No graph.db found. Run `codegraph build` first.');
    process.exit(1);
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
    getNodeId: db.prepare(
      'SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?',
    ),
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
      const result = await updateFile(db, rootDir, filePath, stmts, engineOpts, cache);
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
