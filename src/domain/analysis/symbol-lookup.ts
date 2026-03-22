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
  Repository,
} from '../../db/index.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { EVERY_SYMBOL_KIND } from '../../shared/kinds.js';
import { getFileHash, normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import type { SymbolKind } from '../../types.js';

const FUNCTION_KINDS: SymbolKind[] = ['function', 'method', 'class', 'constant'];

/**
 * Find nodes matching a name query, ranked by relevance.
 * Scoring: exact=100, prefix=60, word-boundary=40, substring=10, plus fan-in tiebreaker.
 *
 * @param {object} dbOrRepo - A better-sqlite3 Database or a Repository instance
 */
export function findMatchingNodes(
  dbOrRepo: any,
  name: string,
  opts: { kind?: string; kinds?: string[]; noTests?: boolean; file?: string } = {},
): any[] {
  const kinds: SymbolKind[] = opts.kind
    ? [opts.kind as SymbolKind]
    : opts.kinds?.length
      ? (opts.kinds as SymbolKind[])
      : FUNCTION_KINDS;

  const isRepo = dbOrRepo instanceof Repository;
  const rows = isRepo
    ? dbOrRepo.findNodesWithFanIn(`%${name}%`, { kinds, file: opts.file })
    : findNodesWithFanIn(dbOrRepo, `%${name}%`, { kinds, file: opts.file });

  const nodes: any[] = opts.noTests ? rows.filter((n: any) => !isTestFile(n.file)) : rows;

  const lowerQuery = name.toLowerCase();
  for (const node of nodes) {
    const lowerName = node.name.toLowerCase();
    const bareName = lowerName.includes('.') ? lowerName.split('.').pop() : lowerName;

    let matchScore: number;
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

  nodes.sort((a: any, b: any) => b._relevance - a._relevance);
  return nodes;
}

export function queryNameData(
  name: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    let nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`) as any[];
    if (noTests) nodes = nodes.filter((n: any) => !isTestFile(n.file));
    if (nodes.length === 0) {
      return { query: name, results: [] };
    }

    const hc = new Map();
    const results = nodes.map((node: any) => {
      let callees = findAllOutgoingEdges(db, node.id);

      let callers = findAllIncomingEdges(db, node.id);

      if (noTests) {
        callees = callees.filter((c: any) => !isTestFile(c.file));
        callers = callers.filter((c: any) => !isTestFile(c.file));
      }

      return {
        ...normalizeSymbol(node, db, hc),
        callees: callees.map((c: any) => ({
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
          edgeKind: c.edge_kind,
        })),
        callers: callers.map((c: any) => ({
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

function whereSymbolImpl(db: any, target: string, noTests: boolean): any[] {
  const placeholders = EVERY_SYMBOL_KIND.map(() => '?').join(', ');
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    )
    .all(`%${target}%`, ...EVERY_SYMBOL_KIND) as any[];
  if (noTests) nodes = nodes.filter((n: any) => !isTestFile(n.file));

  const hc = new Map();
  return nodes.map((node: any) => {
    const crossCount = countCrossFileCallers(db, node.id, node.file);
    const exported = crossCount > 0;

    let uses = findCallers(db, node.id);
    if (noTests) uses = uses.filter((u: any) => !isTestFile(u.file));

    return {
      ...normalizeSymbol(node, db, hc),
      exported,
      uses: uses.map((u: any) => ({ name: u.name, file: u.file, line: u.line })),
    };
  });
}

function whereFileImpl(db: any, target: string): any[] {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn: any) => {
    const symbols = findNodesByFile(db, fn.file);

    const imports = findImportTargets(db, fn.id).map((r: any) => r.file);

    const importedBy = findImportSources(db, fn.id).map((r: any) => r.file);

    const exportedIds = findCrossFileCallTargets(db, fn.file);

    const exported = symbols.filter((s: any) => exportedIds.has(s.id)).map((s: any) => s.name);

    return {
      file: fn.file,
      fileHash: getFileHash(db, fn.file),
      symbols: symbols.map((s: any) => ({ name: s.name, kind: s.kind, line: s.line })),
      imports,
      importedBy,
      exported,
    };
  });
}

export function whereData(
  target: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; file?: boolean; limit?: number; offset?: number } = {},
): object {
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

export function listFunctionsData(
  customDbPath: string | undefined,
  opts: {
    noTests?: boolean;
    file?: string;
    pattern?: string;
    limit?: number;
    offset?: number;
  } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    let rows = listFunctionNodes(db, { file: opts.file, pattern: opts.pattern });

    if (noTests) rows = rows.filter((r: any) => !isTestFile(r.file));

    const hc = new Map();
    const functions = rows.map((r: any) => normalizeSymbol(r, db, hc));
    const base = { count: functions.length, functions };
    return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function childrenData(
  name: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node: any) => {
      let children: any[];
      try {
        children = findNodeChildren(db, node.id);
      } catch (e: any) {
        debug(`findNodeChildren failed for node ${node.id}: ${e.message}`);
        children = [];
      }
      if (noTests) children = children.filter((c: any) => !isTestFile(c.file || node.file));
      return {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        scope: node.scope || null,
        visibility: node.visibility || null,
        qualifiedName: node.qualified_name || null,
        children: children.map((c: any) => ({
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
