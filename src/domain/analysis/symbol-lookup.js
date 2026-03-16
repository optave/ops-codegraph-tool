import {
  countCrossFileCallers,
  findAllIncomingEdges,
  findAllOutgoingEdges,
  findCallers,
  findCrossFileCallTargets,
  findFileNodes,
  findImportSources,
  findImportTargets,
  findNodeChildren,
  findNodesByFile,
  findNodesWithFanIn,
  listFunctionNodes,
  openReadonlyOrFail,
} from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { ALL_SYMBOL_KINDS } from '../../kinds.js';
import { paginateResult } from '../../paginate.js';
import { getFileHash, normalizeSymbol } from '../../shared/normalize.js';

const FUNCTION_KINDS = ['function', 'method', 'class'];

/**
 * Find nodes matching a name query, ranked by relevance.
 * Scoring: exact=100, prefix=60, word-boundary=40, substring=10, plus fan-in tiebreaker.
 */
export function findMatchingNodes(db, name, opts = {}) {
  const kinds = opts.kind ? [opts.kind] : opts.kinds?.length ? opts.kinds : FUNCTION_KINDS;

  const rows = findNodesWithFanIn(db, `%${name}%`, { kinds, file: opts.file });

  const nodes = opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;

  const lowerQuery = name.toLowerCase();
  for (const node of nodes) {
    const lowerName = node.name.toLowerCase();
    const bareName = lowerName.includes('.') ? lowerName.split('.').pop() : lowerName;

    let matchScore;
    if (lowerName === lowerQuery || bareName === lowerQuery) {
      matchScore = 100;
    } else if (lowerName.startsWith(lowerQuery) || bareName.startsWith(lowerQuery)) {
      matchScore = 60;
    } else if (lowerName.includes(`.${lowerQuery}`) || lowerName.includes(`${lowerQuery}.`)) {
      matchScore = 40;
    } else {
      matchScore = 10;
    }

    const fanInBonus = Math.min(Math.log2(node.fan_in + 1) * 5, 25);
    node._relevance = matchScore + fanInBonus;
  }

  nodes.sort((a, b) => b._relevance - a._relevance);
  return nodes;
}

export function queryNameData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    let nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`);
    if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
    if (nodes.length === 0) {
      return { query: name, results: [] };
    }

    const hc = new Map();
    const results = nodes.map((node) => {
      let callees = findAllOutgoingEdges(db, node.id);

      let callers = findAllIncomingEdges(db, node.id);

      if (noTests) {
        callees = callees.filter((c) => !isTestFile(c.file));
        callers = callers.filter((c) => !isTestFile(c.file));
      }

      return {
        ...normalizeSymbol(node, db, hc),
        callees: callees.map((c) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
          edgeKind: c.edge_kind,
        })),
        callers: callers.map((c) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
          edgeKind: c.edge_kind,
        })),
      };
    });

    const base = { query: name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

function whereSymbolImpl(db, target, noTests) {
  const placeholders = ALL_SYMBOL_KINDS.map(() => '?').join(', ');
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    )
    .all(`%${target}%`, ...ALL_SYMBOL_KINDS);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const hc = new Map();
  return nodes.map((node) => {
    const crossCount = countCrossFileCallers(db, node.id, node.file);
    const exported = crossCount > 0;

    let uses = findCallers(db, node.id);
    if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

    return {
      ...normalizeSymbol(node, db, hc),
      exported,
      uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
    };
  });
}

function whereFileImpl(db, target) {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file);

    const imports = findImportTargets(db, fn.id).map((r) => r.file);

    const importedBy = findImportSources(db, fn.id).map((r) => r.file);

    const exportedIds = findCrossFileCallTargets(db, fn.file);

    const exported = symbols.filter((s) => exportedIds.has(s.id)).map((s) => s.name);

    return {
      file: fn.file,
      fileHash: getFileHash(db, fn.file),
      symbols: symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
      imports,
      importedBy,
      exported,
    };
  });
}

export function whereData(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileMode = opts.file || false;

    const results = fileMode ? whereFileImpl(db, target) : whereSymbolImpl(db, target, noTests);

    const base = { target, mode: fileMode ? 'file' : 'symbol', results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function listFunctionsData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    let rows = listFunctionNodes(db, { file: opts.file, pattern: opts.pattern });

    if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

    const hc = new Map();
    const functions = rows.map((r) => normalizeSymbol(r, db, hc));
    const base = { count: functions.length, functions };
    return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function childrenData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      let children;
      try {
        children = findNodeChildren(db, node.id);
      } catch {
        children = [];
      }
      if (noTests) children = children.filter((c) => !isTestFile(c.file || node.file));
      return {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        scope: node.scope || null,
        visibility: node.visibility || null,
        qualifiedName: node.qualified_name || null,
        children: children.map((c) => ({
          name: c.name,
          kind: c.kind,
          line: c.line,
          endLine: c.end_line || null,
          qualifiedName: c.qualified_name || null,
          scope: c.scope || null,
          visibility: c.visibility || null,
        })),
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
