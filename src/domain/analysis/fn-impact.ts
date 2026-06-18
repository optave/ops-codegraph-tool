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

/** Record a caller node at depth `d`, adding to frontier and levels. */
function recordCaller(
  caller: RelatedNodeRow,
  parentId: number,
  depth: number,
  visited: Set<number>,
  nextFrontier: number[],
  levels: BfsLevels,
  noTests: boolean,
  onVisit?: BfsOnVisit,
): void {
  if (visited.has(caller.id) || (noTests && isTestFile(caller.file))) return;
  visited.add(caller.id);
  nextFrontier.push(caller.id);
  if (!levels[depth]) levels[depth] = [];
  levels[depth]!.push(toSymbolRef(caller));
  if (onVisit) onVisit(caller, parentId, depth);
}

/** Process all callers of one frontier node, recording new nodes and expanding implementors. */
function processFrontierNode(
  repo: InstanceType<typeof Repository>,
  fid: number,
  depth: number,
  visited: Set<number>,
  nextFrontier: number[],
  levels: BfsLevels,
  noTests: boolean,
  resolveImplementors: boolean,
  onVisit?: BfsOnVisit,
): void {
  const callers = repo.findDistinctCallers(fid) as RelatedNodeRow[];
  for (const c of callers) {
    recordCaller(c, fid, depth, visited, nextFrontier, levels, noTests, onVisit);
    if (resolveImplementors && INTERFACE_LIKE_KINDS.has(c.kind)) {
      expandImplementors(repo, c.id, depth + 1, visited, nextFrontier, levels, noTests, onVisit);
    }
  }
}

/** Seed BFS with implementors of the start node when it is an interface/trait. */
function seedInterfaceImplementors(
  repo: InstanceType<typeof Repository>,
  startId: number,
  visited: Set<number>,
  levels: BfsLevels,
  noTests: boolean,
  onVisit?: BfsOnVisit,
): number[] {
  const implNextFrontier: number[] = [];
  const startNode = repo.findNodeById(startId) as NodeRow | undefined;
  if (startNode && INTERFACE_LIKE_KINDS.has(startNode.kind)) {
    expandImplementors(repo, startId, 1, visited, implNextFrontier, levels, noTests, onVisit);
  }
  return implNextFrontier;
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
  const implNextFrontier = resolveImplementors
    ? seedInterfaceImplementors(repo, startId, visited, levels, noTests, onVisit)
    : [];

  for (let d = 1; d <= maxDepth; d++) {
    if (d === 1 && implNextFrontier.length > 0) {
      frontier = [...frontier, ...implNextFrontier];
    }
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      processFrontierNode(
        repo,
        fid,
        d,
        visited,
        nextFrontier,
        levels,
        noTests,
        resolveImplementors,
        onVisit,
      );
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { totalDependents: visited.size - 1, levels };
}

/** BFS over import dependents, returning visited node IDs and depth-per-id map. */
function bfsImportDependents(
  repo: InstanceType<typeof Repository>,
  seedNodes: NodeRow[],
  noTests: boolean,
): { visited: Set<number>; levels: Map<number, number> } {
  const visited = new Set<number>();
  const queue: number[] = [];
  const levels = new Map<number, number>();

  for (const fn of seedNodes) {
    visited.add(fn.id);
    queue.push(fn.id);
    levels.set(fn.id, 0);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const level = levels.get(current)!;
    const dependents = repo.findImportDependents(current) as RelatedNodeRow[];
    for (const dep of dependents) {
      if (visited.has(dep.id)) continue;
      if (noTests && isTestFile(dep.file)) continue;
      visited.add(dep.id);
      queue.push(dep.id);
      levels.set(dep.id, level + 1);
    }
  }

  return { visited, levels };
}

/** Group visited dependents by depth (excluding seed depth 0). */
function groupDependentsByLevel(
  repo: InstanceType<typeof Repository>,
  levels: Map<number, number>,
): Record<number, Array<{ file: string }>> {
  const byLevel: Record<number, Array<{ file: string }>> = {};
  for (const [id, level] of levels) {
    if (level === 0) continue;
    if (!byLevel[level]) byLevel[level] = [];
    const node = repo.findNodeById(id) as NodeRow | undefined;
    if (node) byLevel[level].push({ file: node.file });
  }
  return byLevel;
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

    const { visited, levels } = bfsImportDependents(repo, fileNodes, noTests);
    const byLevel = groupDependentsByLevel(repo, levels);

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
      const direct = levels[1]?.length ?? 0;
      const transitive = totalDependents - direct;
      return {
        ...normalizeSymbol(node, repo, hc),
        levels,
        totalDependents,
        direct,
        transitive,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  });
}
