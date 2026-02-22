
import fs from 'fs';
import path from 'path';
import { openDb, initSchema } from './db.js';
import { createParsers, getParser, extractSymbols, extractHCLSymbols, extractPythonSymbols } from './parser.js';
import { IGNORE_DIRS, EXTENSIONS, normalizePath } from './constants.js';
import { resolveImportPath } from './builder.js';
import { warn, debug, info } from './logger.js';
import { loadNative } from './native.js';

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some(p => IGNORE_DIRS.has(p));
}

function isTrackedExt(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

/**
 * Parse a single file and update the database incrementally.
 */
function updateFile(db, rootDir, filePath, parsers, stmts, native) {
  const relPath = normalizePath(path.relative(rootDir, filePath));

  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const oldEdges = stmts.countEdgesForFile.get(relPath)?.c || 0;

  stmts.deleteEdgesForFile.run(relPath);
  stmts.deleteNodes.run(relPath);

  if (!fs.existsSync(filePath)) {
    return { file: relPath, nodesAdded: 0, nodesRemoved: oldNodes, edgesAdded: 0, deleted: true };
  }

  let code;
  try { code = fs.readFileSync(filePath, 'utf-8'); }
  catch (err) {
    warn(`Cannot read ${relPath}: ${err.message}`);
    return null;
  }

  let symbols;
  if (native) {
    // Use native engine for parsing
    const result = native.parseFile(filePath, code);
    if (!result) return null;
    symbols = {
      definitions: (result.definitions || []).map(d => ({
        name: d.name, kind: d.kind, line: d.line,
        endLine: d.endLine ?? d.end_line ?? null
      })),
      calls: (result.calls || []).map(c => ({
        name: c.name, line: c.line, dynamic: c.dynamic
      })),
      imports: (result.imports || []).map(i => ({
        source: i.source, names: i.names || [], line: i.line,
        typeOnly: i.typeOnly ?? i.type_only,
        reexport: i.reexport, wildcardReexport: i.wildcardReexport ?? i.wildcard_reexport
      })),
      classes: result.classes || [],
      exports: (result.exports || []).map(e => ({
        name: e.name, kind: e.kind, line: e.line
      }))
    };
  } else {
    const parser = getParser(parsers, filePath);
    if (!parser) return null;

    let tree;
    try { tree = parser.parse(code); }
    catch (err) {
      warn(`Parse error in ${relPath}: ${err.message}`);
      return null;
    }

    const isHCL = filePath.endsWith('.tf') || filePath.endsWith('.hcl');
    const isPython = filePath.endsWith('.py');
    symbols = isHCL ? extractHCLSymbols(tree, filePath)
      : isPython ? extractPythonSymbols(tree, filePath)
      : extractSymbols(tree, filePath);
  }

  stmts.insertNode.run(relPath, 'file', relPath, 0, null);

  for (const def of symbols.definitions) {
    stmts.insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;

  let edgesAdded = 0;
  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow) return { file: relPath, nodesAdded: newNodes, nodesRemoved: oldNodes, edgesAdded: 0 };
  const fileNodeId = fileNodeRow.id;

  // Load aliases for full import resolution
  const aliases = { baseUrl: null, paths: {} };

  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
    const targetRow = stmts.getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
    if (targetRow) {
      const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
      stmts.insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
      edgesAdded++;
    }
  }

  const importedNames = new Map();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
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
        stmts.insertEdge.run(caller.id, t.id, 'calls', importedFrom ? 1.0 : 0.5, call.dynamic ? 1 : 0);
        edgesAdded++;
      }
    }
  }

  return {
    file: relPath,
    nodesAdded: newNodes,
    nodesRemoved: oldNodes,
    edgesAdded,
    deleted: false
  };
}

export async function watchProject(rootDir) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No graph.db found. Run `codegraph build` first.');
    process.exit(1);
  }

  const db = openDb(dbPath);
  initSchema(db);
  const native = loadNative();
  const parsers = native ? null : await createParsers();
  if (native) {
    console.log(`Watch mode using native engine (v${native.engineVersion()})`);
  }

  const stmts = {
    insertNode: db.prepare('INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)'),
    getNodeId: db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?'),
    insertEdge: db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)'),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    deleteEdgesForFile: null,
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdgesForFile: null,
    findNodeInFile: db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (\'function\', \'method\', \'class\', \'interface\') AND file = ?'),
    findNodeByName: db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (\'function\', \'method\', \'class\', \'interface\')'),
  };

  // Use named params for statements needing the same value twice
  const origDeleteEdges = db.prepare(`DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`);
  const origCountEdges = db.prepare(`SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`);
  stmts.deleteEdgesForFile = { run: (f) => origDeleteEdges.run({ f }) };
  stmts.countEdgesForFile = { get: (f) => origCountEdges.get({ f }) };

  const pending = new Set();
  let timer = null;
  const DEBOUNCE_MS = 300;

  function processPending() {
    const files = [...pending];
    pending.clear();

    const updates = db.transaction(() => {
      const results = [];
      for (const filePath of files) {
        const result = updateFile(db, rootDir, filePath, parsers, stmts, native);
        if (result) results.push(result);
      }
      return results;
    })();

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

  const watcher = fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
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
    db.close();
    process.exit(0);
  });
}

