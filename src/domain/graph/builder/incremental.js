/**
 * Incremental single-file rebuild — used by watch mode.
 *
 * Reuses pipeline helpers instead of duplicating node insertion and edge building
 * logic from the main builder. This eliminates the watcher.js divergence (ROADMAP 3.9).
 */
import fs from 'node:fs';
import path from 'node:path';
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
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }
}

// ── Import edge building ────────────────────────────────────────────────

function buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeId, aliases) {
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
export async function rebuildFile(_db, rootDir, filePath, stmts, engineOpts, cache, options = {}) {
  const { diffSymbols } = options;
  const relPath = normalizePath(path.relative(rootDir, filePath));
  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const oldSymbols = diffSymbols ? stmts.listSymbols.all(relPath) : [];

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

  let edgesAdded = buildImportEdges(stmts, relPath, symbols, rootDir, fileNodeRow.id, aliases);
  const importedNames = buildImportedNamesMap(symbols, rootDir, relPath, aliases);
  edgesAdded += buildCallEdges(stmts, relPath, symbols, fileNodeRow, importedNames);

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
