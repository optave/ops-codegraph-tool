/**
 * Incremental single-file rebuild — used by watch mode.
 *
 * Reuses pipeline helpers instead of duplicating node insertion and edge building
 * logic from the main builder. This eliminates the watcher.js divergence (ROADMAP 3.9).
 *
 * Reverse-dep cascade: when a file changes, files that have edges targeting it
 * must have their outgoing edges rebuilt (since the changed file's node IDs change).
 */
import fs from 'node:fs';
import path from 'node:path';
import { bulkNodeIdsByFile } from '../../../db/index.js';
import { warn } from '../../../infrastructure/logger.js';
import { normalizePath } from '../../../shared/constants.js';
import { parseFileIncremental } from '../../parser.js';
import { computeConfidence, resolveImportPath } from '../resolve.js';
import { BUILTIN_RECEIVERS, readFileSafe } from './helpers.js';

// ── Node insertion ──────────────────────────────────────────────────────

function insertFileNodes(stmts, relPath, symbols) {
  stmts.insertNode.run(relPath, 'file', relPath, 0, null);
  for (const def of symbols.definitions) {
    stmts.insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
    if (def.children?.length) {
      for (const child of def.children) {
        stmts.insertNode.run(
          child.name,
          child.kind,
          relPath,
          child.line,
          child.endLine || null,
        );
      }
    }
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }
}

// ── Containment edges ──────────────────────────────────────────────────

function buildContainmentEdges(db, stmts, relPath, symbols) {
  const nodeIdMap = new Map();
  for (const row of bulkNodeIdsByFile(db, relPath)) {
    nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
  }
  const fileId = nodeIdMap.get(`${relPath}|file|0`);
  let edgesAdded = 0;
  for (const def of symbols.definitions) {
    const defId = nodeIdMap.get(`${def.name}|${def.kind}|${def.line}`);
    if (fileId && defId) {
      stmts.insertEdge.run(fileId, defId, 'contains', 1.0, 0);
      edgesAdded++;
    }
    if (def.children?.length && defId) {
      for (const child of def.children) {
        const childId = nodeIdMap.get(`${child.name}|${child.kind}|${child.line}`);
        if (childId) {
          stmts.insertEdge.run(defId, childId, 'contains', 1.0, 0);
          edgesAdded++;
          if (child.kind === 'parameter') {
            stmts.insertEdge.run(childId, defId, 'parameter_of', 1.0, 0);
            edgesAdded++;
          }
        }
      }
    }
  }
  return edgesAdded;
}

// ── Reverse-dep cascade ────────────────────────────────────────────────

function findReverseDeps(db, relPath) {
  return db
    .prepare(
      `SELECT DISTINCT n_src.file FROM edges e
       JOIN nodes n_src ON e.source_id = n_src.id
       JOIN nodes n_tgt ON e.target_id = n_tgt.id
       WHERE n_tgt.file = ? AND n_src.file != ? AND n_src.kind != 'directory'`,
    )
    .all(relPath, relPath)
    .map((r) => r.file);
}

function deleteOutgoingEdges(db, relPath) {
  db.prepare('DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)').run(
    relPath,
  );
}

async function parseReverseDep(rootDir, depRelPath, engineOpts, cache) {
  const absPath = path.join(rootDir, depRelPath);
  if (!fs.existsSync(absPath)) return null;

  let code;
  try {
    code = readFileSafe(absPath);
  } catch {
    return null;
  }

  return parseFileIncremental(cache, absPath, code, engineOpts);
}

function rebuildReverseDepEdges(db, rootDir, depRelPath, symbols, stmts, skipBarrel) {
  const fileNodeRow = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
  if (!fileNodeRow) return 0;

  const aliases = { baseUrl: null, paths: {} };
  let edgesAdded = buildContainmentEdges(db, stmts, depRelPath, symbols);
  // Don't rebuild dir→file containment for reverse-deps (it was never deleted)
  edgesAdded += buildImportEdges(
    stmts,
    depRelPath,
    symbols,
    rootDir,
    fileNodeRow.id,
    aliases,
    skipBarrel ? null : db,
  );
  const importedNames = buildImportedNamesMap(symbols, rootDir, depRelPath, aliases);
  edgesAdded += buildCallEdges(stmts, depRelPath, symbols, fileNodeRow, importedNames);
  return edgesAdded;
}

// ── Directory containment edges ────────────────────────────────────────

function rebuildDirContainment(db, stmts, relPath) {
  const dir = normalizePath(path.dirname(relPath));
  if (!dir || dir === '.') return 0;
  const dirRow = stmts.getNodeId.get(dir, 'directory', dir, 0);
  const fileRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (dirRow && fileRow) {
    stmts.insertEdge.run(dirRow.id, fileRow.id, 'contains', 1.0, 0);
    return 1;
  }
  return 0;
}

// ── Ancillary table cleanup ────────────────────────────────────────────

function purgeAncillaryData(db, relPath) {
  const tryExec = (sql, ...args) => {
    try {
      db.prepare(sql).run(...args);
    } catch {
      /* table may not exist */
    }
  };
  tryExec(
    'DELETE FROM function_complexity WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM node_metrics WHERE node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM cfg_edges WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM cfg_blocks WHERE function_node_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
  );
  tryExec(
    'DELETE FROM dataflow WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)',
    relPath,
    relPath,
  );
  tryExec('DELETE FROM ast_nodes WHERE file = ?', relPath);
}

// ── Import edge building ────────────────────────────────────────────────

function isBarrelFile(db, relPath) {
  const reexportCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM edges e
       JOIN nodes n ON e.source_id = n.id
       WHERE e.kind = 'reexports' AND n.file = ? AND n.kind = 'file'`,
    )
    .get(relPath)?.c;
  return (reexportCount || 0) > 0;
}

function resolveBarrelTarget(db, barrelPath, symbolName, visited = new Set()) {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);

  // Find re-export targets from this barrel
  const reexportTargets = db
    .prepare(
      `SELECT DISTINCT n2.file FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE e.kind = 'reexports' AND n1.file = ? AND n1.kind = 'file'`,
    )
    .all(barrelPath);

  for (const { file: targetFile } of reexportTargets) {
    // Check if the symbol is defined in this target file
    const hasDef = db
      .prepare(
        `SELECT 1 FROM nodes WHERE name = ? AND file = ? AND kind != 'file' AND kind != 'directory' LIMIT 1`,
      )
      .get(symbolName, targetFile);
    if (hasDef) return targetFile;

    // Recurse through barrel chains
    if (isBarrelFile(db, targetFile)) {
      const deeper = resolveBarrelTarget(db, targetFile, symbolName, visited);
      if (deeper) return deeper;
    }
  }
  return null;
}

function buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeId, aliases, db) {
  let edgesAdded = 0;
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

      // Barrel resolution: create edges through re-export chains
      if (!imp.reexport && db && isBarrelFile(db, resolvedPath)) {
        const resolvedSources = new Set();
        for (const name of imp.names) {
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          const actualSource = resolveBarrelTarget(db, resolvedPath, cleanName);
          if (actualSource && actualSource !== resolvedPath && !resolvedSources.has(actualSource)) {
            resolvedSources.add(actualSource);
            const actualRow = stmts.getNodeId.get(actualSource, 'file', actualSource, 0);
            if (actualRow) {
              const kind = edgeKind === 'imports-type' ? 'imports-type' : 'imports';
              stmts.insertEdge.run(fileNodeId, actualRow.id, kind, 0.9, 0);
              edgesAdded++;
            }
          }
        }
      }
    }
  }
  return edgesAdded;
}

function buildImportedNamesMap(symbols, rootDir, relPath, aliases) {
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
  return importedNames;
}

// ── Call edge building ──────────────────────────────────────────────────

function findCaller(call, definitions, relPath, stmts) {
  let caller = null;
  let callerSpan = Infinity;
  for (const def of definitions) {
    if (def.line <= call.line) {
      const end = def.endLine || Infinity;
      if (call.line <= end) {
        const span = end - def.line;
        if (span < callerSpan) {
          const row = stmts.getNodeId.get(def.name, def.kind, relPath, def.line);
          if (row) {
            caller = row;
            callerSpan = span;
          }
        }
      } else if (!caller) {
        const row = stmts.getNodeId.get(def.name, def.kind, relPath, def.line);
        if (row) caller = row;
      }
    }
  }
  return caller;
}

function resolveCallTargets(stmts, call, relPath, importedNames, typeMap) {
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
  // Type-aware resolution: translate variable receiver to declared type
  if ((!targets || targets.length === 0) && call.receiver && typeMap) {
    const typeEntry = typeMap.get(call.receiver);
    const typeName = typeEntry
      ? typeof typeEntry === 'string'
        ? typeEntry
        : typeEntry.type
      : null;
    if (typeName) {
      const qualified = `${typeName}.${call.name}`;
      targets = stmts.findNodeByName.all(qualified);
    }
  }
  return { targets, importedFrom };
}

function buildCallEdges(stmts, relPath, symbols, fileNodeRow, importedNames) {
  const typeMap = symbols.typeMap || new Map();
  let edgesAdded = 0;
  for (const call of symbols.calls) {
    if (call.receiver && BUILTIN_RECEIVERS.has(call.receiver)) continue;

    const caller = findCaller(call, symbols.definitions, relPath, stmts) || fileNodeRow;
    const { targets, importedFrom } = resolveCallTargets(
      stmts,
      call,
      relPath,
      importedNames,
      typeMap,
    );

    for (const t of targets) {
      if (t.id !== caller.id) {
        const confidence = computeConfidence(relPath, t.file, importedFrom ?? null);
        stmts.insertEdge.run(caller.id, t.id, 'calls', confidence, call.dynamic ? 1 : 0);
        edgesAdded++;
      }
    }
  }
  return edgesAdded;
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Parse a single file and update the database incrementally.
 *
 * @param {import('better-sqlite3').Database} _db
 * @param {string} rootDir - Absolute root directory
 * @param {string} filePath - Absolute file path
 * @param {object} stmts - Prepared DB statements
 * @param {object} engineOpts - Engine options
 * @param {object|null} cache - Parse tree cache (native only)
 * @param {object} [options]
 * @param {Function} [options.diffSymbols] - Symbol diff function
 * @returns {Promise<object|null>} Update result or null on failure
 */
export async function rebuildFile(db, rootDir, filePath, stmts, engineOpts, cache, options = {}) {
  const { diffSymbols } = options;
  const relPath = normalizePath(path.relative(rootDir, filePath));
  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const oldSymbols = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  // Find reverse-deps BEFORE purging (edges still reference the old nodes)
  const reverseDeps = findReverseDeps(db, relPath);

  // Purge ancillary tables, then edges, then nodes
  purgeAncillaryData(db, relPath);
  stmts.deleteEdgesForFile.run(relPath);
  stmts.deleteNodes.run(relPath);

  if (!fs.existsSync(filePath)) {
    if (cache) cache.remove(filePath);
    const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, []) : null;
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

  insertFileNodes(stmts, relPath, symbols);

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;
  const newSymbols = diffSymbols ? stmts.listSymbols.all(relPath) : [];

  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow)
    return { file: relPath, nodesAdded: newNodes, nodesRemoved: oldNodes, edgesAdded: 0 };

  const aliases = { baseUrl: null, paths: {} };

  let edgesAdded = buildContainmentEdges(db, stmts, relPath, symbols);
  edgesAdded += rebuildDirContainment(db, stmts, relPath);
  edgesAdded += buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeRow.id, aliases, db);
  const importedNames = buildImportedNamesMap(symbols, rootDir, relPath, aliases);
  edgesAdded += buildCallEdges(stmts, relPath, symbols, fileNodeRow, importedNames);

  // Cascade: rebuild outgoing edges for reverse-dep files.
  // Two-pass approach: first rebuild direct edges (creating reexports edges for barrels),
  // then add barrel import edges (which need reexports edges to exist for resolution).
  const depSymbols = new Map();
  for (const depRelPath of reverseDeps) {
    deleteOutgoingEdges(db, depRelPath);
    const symbols_ = await parseReverseDep(rootDir, depRelPath, engineOpts, cache);
    if (symbols_) depSymbols.set(depRelPath, symbols_);
  }
  // Pass 1: direct edges only (no barrel resolution) — creates reexports edges
  for (const [depRelPath, symbols_] of depSymbols) {
    edgesAdded += rebuildReverseDepEdges(db, rootDir, depRelPath, symbols_, stmts, true);
  }
  // Pass 2: add barrel import edges (reexports edges now exist)
  for (const [depRelPath, symbols_] of depSymbols) {
    const fileNodeRow_ = stmts.getNodeId.get(depRelPath, 'file', depRelPath, 0);
    if (!fileNodeRow_) continue;
    const aliases_ = { baseUrl: null, paths: {} };
    for (const imp of symbols_.imports) {
      if (imp.reexport) continue;
      const resolvedPath = resolveImportPath(
        path.join(rootDir, depRelPath),
        imp.source,
        rootDir,
        aliases_,
      );
      if (db && isBarrelFile(db, resolvedPath)) {
        const resolvedSources = new Set();
        for (const name of imp.names) {
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          const actualSource = resolveBarrelTarget(db, resolvedPath, cleanName);
          if (
            actualSource &&
            actualSource !== resolvedPath &&
            !resolvedSources.has(actualSource)
          ) {
            resolvedSources.add(actualSource);
            const actualRow = stmts.getNodeId.get(actualSource, 'file', actualSource, 0);
            if (actualRow) {
              const kind = imp.typeOnly ? 'imports-type' : 'imports';
              stmts.insertEdge.run(fileNodeRow_.id, actualRow.id, kind, 0.9, 0);
              edgesAdded++;
            }
          }
        }
      }
    }
  }

  const symbolDiff = diffSymbols ? diffSymbols(oldSymbols, newSymbols) : null;
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
