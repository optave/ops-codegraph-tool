import { Repository, SqliteRepository } from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { normalizeSymbol, toSymbolRef } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import type { BetterSqlite3Database, NodeRow, RelatedNodeRow } from '../../types.js';
import { resolveAnalysisOpts, withRepo } from './query-helpers.js';
import { findMatchingNodes } from './symbol-lookup.js';

/** Cache so repeated raw-db calls reuse the same SqliteRepository (preserves per-instance memoization). */
const repoCache = new WeakMap<BetterSqlite3Database, InstanceType<typeof SqliteRepository>>();

/** Coerce a raw db handle or Repository into a Repository instance. */
function toRepo(
  dbOrRepo: BetterSqlite3Database | InstanceType<typeof Repository>,
): InstanceType<typeof Repository> {
  if (dbOrRepo instanceof Repository) return dbOrRepo;
  const db = dbOrRepo as BetterSqlite3Database;
  let repo = repoCache.get(db);
  if (!repo) {
    repo = new SqliteRepository(db);
    repoCache.set(db, repo);
  }
  return repo;
}

// --- Shared BFS: transitive callers ---

const INTERFACE_LIKE_KINDS = new Set(['interface', 'trait']);

type BfsLevel = Array<{
  name: string;
  kind: string;
  file: string;
  line: number;
  viaImplements?: boolean;
}>;
type BfsLevels = Record<number, BfsLevel>;
type BfsOnVisit = (
  caller: RelatedNodeRow & { viaImplements?: boolean },
  parentId: number,
  depth: number,
) => void;

/** Record an implementor node at the given depth, adding to frontier and levels. */
function recordImplementor(
  impl: RelatedNodeRow,
  parentId: number,
  depth: number,
  visited: Set<number>,
  frontier: number[],
  levels: BfsLevels,
  noTests: boolean,
  onVisit?: BfsOnVisit,
): void {
  if (visited.has(impl.id) || (noTests && isTestFile(impl.file))) return;
  visited.add(impl.id);
  frontier.push(impl.id);
  if (!levels[depth]) levels[depth] = [];
  levels[depth].push({
    name: impl.name,
    kind: impl.kind,
    file: impl.file,
    line: impl.line,
    viaImplements: true,
  });
  if (onVisit) onVisit({ ...impl, viaImplements: true }, parentId, depth);
}

/** Expand implementors for an interface/trait node into the BFS frontier. */
function expandImplementors(
  repo: InstanceType<typeof Repository>,
  nodeId: number,
  depth: number,
  visited: Set<number>,
  frontier: number[],
  levels: BfsLevels,
  noTests: boolean,
  onVisit?: BfsOnVisit,
): void {
  const impls = repo.findImplementors(nodeId) as RelatedNodeRow[];
  for (const impl of impls) {
    recordImplementor(impl, nodeId, depth, visited, frontier, levels, noTests, onVisit);
  }
}

export function bfsTransitiveCallers(
  dbOrRepo: BetterSqlite3Database | InstanceType<typeof Repository>,
  startId: number,
  {
    noTests = false,
    maxDepth = 3,
    includeImplementors = true,
    onVisit,
  }: {
    noTests?: boolean;
    maxDepth?: number;
    includeImplementors?: boolean;
    onVisit?: BfsOnVisit;
  } = {},
) {
  const repo = toRepo(dbOrRepo);
  const resolveImplementors = includeImplementors && repo.hasImplementsEdges();
  const visited = new Set([startId]);
  const levels: BfsLevels = {};
  let frontier = [startId];

  // Seed: if start node is an interface/trait, include its implementors at depth 1
  const implNextFrontier: number[] = [];
  if (resolveImplementors) {
    const startNode = repo.findNodeById(startId) as NodeRow | undefined;
    if (startNode && INTERFACE_LIKE_KINDS.has(startNode.kind)) {
      expandImplementors(repo, startId, 1, visited, implNextFrontier, levels, noTests, onVisit);
    }
  }

  for (let d = 1; d <= maxDepth; d++) {
    if (d === 1 && implNextFrontier.length > 0) {
      frontier = [...frontier, ...implNextFrontier];
    }
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const callers = repo.findDistinctCallers(fid) as RelatedNodeRow[];
      for (const c of callers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
          if (!levels[d]) levels[d] = [];
          levels[d]!.push(toSymbolRef(c));
          if (onVisit) onVisit(c, fid, d);
        }
        if (resolveImplementors && INTERFACE_LIKE_KINDS.has(c.kind)) {
          expandImplementors(repo, c.id, d + 1, visited, nextFrontier, levels, noTests, onVisit);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { totalDependents: visited.size - 1, levels };
}

export function impactAnalysisData(
  file: string,
  customDbPath: string,
  opts: { noTests?: boolean } = {},
) {
  return withRepo(customDbPath, (repo) => {
    const noTests = opts.noTests || false;
    const fileNodes = repo.findFileNodes(`%${file}%`) as NodeRow[];
    if (fileNodes.length === 0) {
      return { file, sources: [], levels: {}, totalDependents: 0 };
    }

    const visited = new Set<number>();
    const queue: number[] = [];
    const levels = new Map<number, number>();

    for (const fn of fileNodes) {
      visited.add(fn.id);
      queue.push(fn.id);
      levels.set(fn.id, 0);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const level = levels.get(current)!;
      const dependents = repo.findImportDependents(current) as RelatedNodeRow[];
      for (const dep of dependents) {
        if (!visited.has(dep.id) && (!noTests || !isTestFile(dep.file))) {
          visited.add(dep.id);
          queue.push(dep.id);
          levels.set(dep.id, level + 1);
        }
      }
    }

    const byLevel: Record<number, Array<{ file: string }>> = {};
    for (const [id, level] of levels) {
      if (level === 0) continue;
      if (!byLevel[level]) byLevel[level] = [];
      const node = repo.findNodeById(id) as NodeRow | undefined;
      if (node) byLevel[level].push({ file: node.file });
    }

    return {
      file,
      sources: fileNodes.map((f) => f.file),
      levels: byLevel,
      totalDependents: visited.size - fileNodes.length,
    };
  });
}

export function fnImpactData(
  name: string,
  customDbPath: string,
  opts: {
    depth?: number;
    noTests?: boolean;
    file?: string;
    kind?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
    config?: any;
  } = {},
) {
  return withRepo(customDbPath, (repo) => {
    const { noTests, config } = resolveAnalysisOpts(opts);
    const maxDepth = opts.depth || config.analysis?.fnImpactDepth || 5;
    const hc = new Map();

    const nodes = findMatchingNodes(repo, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const includeImplementors = opts.includeImplementors !== false;

    const results = nodes.map((node) => {
      const { levels, totalDependents } = bfsTransitiveCallers(repo, node.id, {
        noTests,
        maxDepth,
        includeImplementors,
      });
      return {
        ...normalizeSymbol(node, repo, hc),
        levels,
        totalDependents,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  });
}
