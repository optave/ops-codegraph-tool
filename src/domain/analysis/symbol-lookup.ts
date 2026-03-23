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
import type {
  AdjacentEdgeRow,
  BetterSqlite3Database,
  ChildNodeRow,
  ImportEdgeRow,
  NodeRow,
  NodeRowWithFanIn,
  SymbolKind,
} from '../../types.js';

const FUNCTION_KINDS: SymbolKind[] = ['function', 'method', 'class', 'constant'];

/**
 * Find nodes matching a name query, ranked by relevance.
 * Scoring: exact=100, prefix=60, word-boundary=40, substring=10, plus fan-in tiebreaker.
 */
export function findMatchingNodes(
  dbOrRepo: BetterSqlite3Database | InstanceType<typeof Repository>,
  name: string,
  opts: { noTests?: boolean; file?: string; kind?: string; kinds?: readonly string[] } = {},
): Array<NodeRowWithFanIn & { _relevance: number }> {
  const kinds = (
    opts.kind ? [opts.kind] : opts.kinds?.length ? [...opts.kinds] : FUNCTION_KINDS
  ) as SymbolKind[];

  const isRepo = dbOrRepo instanceof Repository;
  const rows = (
    isRepo
      ? (dbOrRepo as InstanceType<typeof Repository>).findNodesWithFanIn(`%${name}%`, {
          kinds,
          file: opts.file,
        })
      : findNodesWithFanIn(dbOrRepo as BetterSqlite3Database, `%${name}%`, {
          kinds,
          file: opts.file,
        })
  ) as NodeRowWithFanIn[];

  const nodes: Array<NodeRowWithFanIn & { _relevance: number }> = (
    opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows
  ) as Array<NodeRowWithFanIn & { _relevance: number }>;

  const lowerQuery = name.toLowerCase();
  for (const node of nodes) {
    const lowerName = node.name.toLowerCase();
    const bareName = lowerName.includes('.') ? lowerName.split('.').pop()! : lowerName;

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

  nodes.sort((a, b) => b._relevance - a._relevance);
  return nodes;
}

export function queryNameData(
  name: string,
  customDbPath: string,
  opts: { noTests?: boolean; limit?: number; offset?: number } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    let nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`) as NodeRow[];
    if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
    if (nodes.length === 0) {
      return { query: name, results: [] };
    }

    const hc = new Map();
    const results = nodes.map((node) => {
      let callees = findAllOutgoingEdges(db, node.id) as AdjacentEdgeRow[];

      let callers = findAllIncomingEdges(db, node.id) as AdjacentEdgeRow[];

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

function whereSymbolImpl(db: BetterSqlite3Database, target: string, noTests: boolean) {
  const placeholders = EVERY_SYMBOL_KIND.map(() => '?').join(', ');
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN (${placeholders}) ORDER BY file, line`,
    )
    .all(`%${target}%`, ...EVERY_SYMBOL_KIND) as NodeRow[];
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));

  const hc = new Map();
  return nodes.map((node) => {
    const crossCount = countCrossFileCallers(db, node.id, node.file);
    const exported = crossCount > 0;

    let uses = findCallers(db, node.id) as Array<{ name: string; file: string; line: number }>;
    if (noTests) uses = uses.filter((u) => !isTestFile(u.file));

    return {
      ...normalizeSymbol(node, db, hc),
      exported,
      uses: uses.map((u) => ({ name: u.name, file: u.file, line: u.line })),
    };
  });
}

function whereFileImpl(db: BetterSqlite3Database, target: string) {
  const fileNodes = findFileNodes(db, `%${target}%`) as NodeRow[];
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file) as NodeRow[];

    const imports = (findImportTargets(db, fn.id) as ImportEdgeRow[]).map((r) => r.file);

    const importedBy = (findImportSources(db, fn.id) as ImportEdgeRow[]).map((r) => r.file);

    const exportedIds = findCrossFileCallTargets(db, fn.file) as Set<number>;

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

export function whereData(
  target: string,
  customDbPath: string,
  opts: { noTests?: boolean; file?: boolean; limit?: number; offset?: number } = {},
) {
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
  customDbPath: string,
  opts: {
    noTests?: boolean;
    file?: string;
    pattern?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    let rows = listFunctionNodes(db, { file: opts.file, pattern: opts.pattern }) as NodeRow[];

    if (noTests) rows = rows.filter((r) => !isTestFile(r.file));

    const hc = new Map();
    const functions = rows.map((r) => normalizeSymbol(r, db, hc));
    const base = { count: functions.length, functions };
    return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function childrenData(
  name: string,
  customDbPath: string,
  opts: { noTests?: boolean; file?: string; kind?: string; limit?: number; offset?: number } = {},
) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      let children: ChildNodeRow[];
      try {
        children = findNodeChildren(db, node.id) as ChildNodeRow[];
      } catch (e: unknown) {
        debug(`findNodeChildren failed for node ${node.id}: ${(e as Error).message}`);
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
