import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  findDbPath,
  findDistinctCallers,
  findFileNodes,
  findImplementors,
  findImportDependents,
  findNodeById,
  openReadonlyOrFail,
} from '../../db/index.js';
import { evaluateBoundaries } from '../../features/boundaries.js';
import { coChangeForFiles } from '../../features/cochange.js';
import { ownersForFiles } from '../../features/owners.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import { findMatchingNodes } from './symbol-lookup.js';

// ─── Shared BFS: transitive callers ────────────────────────────────────

const INTERFACE_LIKE_KINDS = new Set(['interface', 'trait']);

/**
 * Check whether the graph contains any 'implements' edges.
 * Cached per db handle so the query runs at most once per connection.
 */
const _hasImplementsCache = new WeakMap<object, boolean>();
function hasImplementsEdges(db: any): boolean {
  if (_hasImplementsCache.has(db)) return _hasImplementsCache.get(db)!;
  const row = db.prepare("SELECT 1 FROM edges WHERE kind = 'implements' LIMIT 1").get();
  const result = !!row;
  _hasImplementsCache.set(db, result);
  return result;
}

/**
 * BFS traversal to find transitive callers of a node.
 * When an interface/trait node is encountered (either as the start node or
 * during traversal), its concrete implementors are also added to the frontier
 * so that changes to an interface signature propagate to all implementors.
 */
export function bfsTransitiveCallers(
  db: any,
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
    onVisit?: (caller: any, parentId: number, depth: number) => void;
  } = {},
): { totalDependents: number; levels: Record<number, any[]> } {
  // Skip all implementor lookups when the graph has no implements edges
  const resolveImplementors = includeImplementors && hasImplementsEdges(db);

  const visited = new Set([startId]);
  const levels: Record<number, any[]> = {};
  let frontier = [startId];

  // Seed: if start node is an interface/trait, include its implementors at depth 1.
  // Implementors go into a separate list so their callers appear at depth 2, not depth 1.
  const implNextFrontier: number[] = [];
  if (resolveImplementors) {
    const startNode = findNodeById(db, startId);
    if (startNode && INTERFACE_LIKE_KINDS.has(startNode.kind)) {
      const impls = findImplementors(db, startId);
      for (const impl of impls) {
        if (!visited.has(impl.id) && (!noTests || !isTestFile(impl.file))) {
          visited.add(impl.id);
          implNextFrontier.push(impl.id);
          if (!levels[1]) levels[1] = [];
          levels[1].push({
            name: impl.name,
            kind: impl.kind,
            file: impl.file,
            line: impl.line,
            viaImplements: true,
          });
          if (onVisit) onVisit({ ...impl, viaImplements: true }, startId, 1);
        }
      }
    }
  }

  for (let d = 1; d <= maxDepth; d++) {
    // On the first wave, merge seeded implementors so their callers appear at d=2
    if (d === 1 && implNextFrontier.length > 0) {
      frontier = [...frontier, ...implNextFrontier];
    }
    const nextFrontier: number[] = [];
    for (const fid of frontier) {
      const callers = findDistinctCallers(db, fid);
      for (const c of callers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
          levels[d] = levels[d] || [];
          levels[d]!.push({ name: c.name, kind: c.kind, file: c.file, line: c.line });
          if (onVisit) onVisit(c, fid, d);
        }

        // If a caller is an interface/trait, also pull in its implementors
        // Implementors are one extra hop away, so record at d+1
        if (resolveImplementors && INTERFACE_LIKE_KINDS.has(c.kind)) {
          const impls = findImplementors(db, c.id);
          for (const impl of impls) {
            if (!visited.has(impl.id) && (!noTests || !isTestFile(impl.file))) {
              visited.add(impl.id);
              nextFrontier.push(impl.id);
              const implDepth = d + 1;
              if (!levels[implDepth]) levels[implDepth] = [];
              levels[implDepth].push({
                name: impl.name,
                kind: impl.kind,
                file: impl.file,
                line: impl.line,
                viaImplements: true,
              });
              if (onVisit) onVisit({ ...impl, viaImplements: true }, c.id, implDepth);
            }
          }
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
  customDbPath: string | undefined,
  opts: {
    noTests?: boolean;
    maxDepth?: number;
    config?: any;
    limit?: number;
    offset?: number;
  } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileNodes = findFileNodes(db, `%${file}%`);
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
      const dependents = findImportDependents(db, current);
      for (const dep of dependents) {
        if (!visited.has(dep.id) && (!noTests || !isTestFile(dep.file))) {
          visited.add(dep.id);
          queue.push(dep.id);
          levels.set(dep.id, level + 1);
        }
      }
    }

    const byLevel: Record<number, any[]> = {};
    for (const [id, level] of levels) {
      if (level === 0) continue;
      if (!byLevel[level]) byLevel[level] = [];
      const node = findNodeById(db, id);
      if (node) byLevel[level].push({ file: node.file });
    }

    return {
      file,
      sources: fileNodes.map((f: any) => f.file),
      levels: byLevel,
      totalDependents: visited.size - fileNodes.length,
    };
  } finally {
    db.close();
  }
}

export function fnImpactData(
  name: string,
  customDbPath: string | undefined,
  opts: {
    noTests?: boolean;
    depth?: number;
    config?: any;
    file?: string;
    kind?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const config = opts.config || loadConfig();
    const maxDepth = opts.depth || config.analysis?.fnImpactDepth || 5;
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const includeImplementors = opts.includeImplementors !== false;

    const results = nodes.map((node: any) => {
      const { levels, totalDependents } = bfsTransitiveCallers(db, node.id, {
        noTests,
        maxDepth,
        includeImplementors,
      });
      return {
        ...normalizeSymbol(node, db, hc),
        levels,
        totalDependents,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

// ─── diffImpactData helpers ─────────────────────────────────────────────

/**
 * Walk up from repoRoot until a .git directory is found.
 * Returns true if a git root exists, false otherwise.
 */
function findGitRoot(repoRoot: string): boolean {
  let checkDir = repoRoot;
  while (checkDir) {
    if (fs.existsSync(path.join(checkDir, '.git'))) {
      return true;
    }
    const parent = path.dirname(checkDir);
    if (parent === checkDir) break;
    checkDir = parent;
  }
  return false;
}

/**
 * Execute git diff and return the raw output string.
 * Returns `{ output: string }` on success or `{ error: string }` on failure.
 */
function runGitDiff(
  repoRoot: string,
  opts: { staged?: boolean; ref?: string },
): { output?: string; error?: string } {
  try {
    const args = opts.staged
      ? ['diff', '--cached', '--unified=0', '--no-color']
      : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
    const output = execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output };
  } catch (e: any) {
    return { error: `Failed to run git diff: ${e.message}` };
  }
}

/**
 * Parse raw git diff output into a changedRanges map and newFiles set.
 */
function parseGitDiff(diffOutput: string): {
  changedRanges: Map<string, Array<{ start: number; end: number }>>;
  newFiles: Set<string>;
} {
  const changedRanges = new Map<string, Array<{ start: number; end: number }>>();
  const newFiles = new Set<string>();
  let currentFile: string | null = null;
  let prevIsDevNull = false;

  for (const line of diffOutput.split('\n')) {
    if (line.startsWith('--- /dev/null')) {
      prevIsDevNull = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      prevIsDevNull = false;
      continue;
    }
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? null;
      if (currentFile && !changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (currentFile && prevIsDevNull) newFiles.add(currentFile);
      prevIsDevNull = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1]!, 10);
      const count = parseInt(hunkMatch[2] || '1', 10);
      changedRanges.get(currentFile)?.push({ start, end: start + count - 1 });
    }
  }

  return { changedRanges, newFiles };
}

/**
 * Find all function/method/class nodes whose line ranges overlap any changed range.
 */
function findAffectedFunctions(
  db: any,
  changedRanges: Map<string, Array<{ start: number; end: number }>>,
  noTests: boolean,
): any[] {
  const affectedFunctions: any[] = [];
  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = db
      .prepare(
        `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
      )
      .all(file) as any[];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const endLine = def.end_line || (defs[i + 1] ? defs[i + 1].line - 1 : 999999);
      for (const range of ranges) {
        if (range.start <= endLine && range.end >= def.line) {
          affectedFunctions.push(def);
          break;
        }
      }
    }
  }
  return affectedFunctions;
}

/**
 * Run BFS per affected function, collecting per-function results and the full affected set.
 */
function buildFunctionImpactResults(
  db: any,
  affectedFunctions: any[],
  noTests: boolean,
  maxDepth: number,
  includeImplementors = true,
): { functionResults: any[]; allAffected: Set<string> } {
  const allAffected = new Set<string>();
  const functionResults = affectedFunctions.map((fn: any) => {
    const edges: any[] = [];
    const idToKey = new Map<number, string>();
    idToKey.set(fn.id, `${fn.file}::${fn.name}:${fn.line}`);

    const { levels, totalDependents } = bfsTransitiveCallers(db, fn.id, {
      noTests,
      maxDepth,
      includeImplementors,
      onVisit(c: any, parentId: number) {
        allAffected.add(`${c.file}:${c.name}`);
        const callerKey = `${c.file}::${c.name}:${c.line}`;
        idToKey.set(c.id, callerKey);
        edges.push({ from: idToKey.get(parentId), to: callerKey });
      },
    });

    return {
      name: fn.name,
      kind: fn.kind,
      file: fn.file,
      line: fn.line,
      transitiveCallers: totalDependents,
      levels,
      edges,
    };
  });

  return { functionResults, allAffected };
}

/**
 * Look up historically co-changed files for the set of changed files.
 * Returns an empty array if the co_changes table is unavailable.
 */
function lookupCoChanges(
  db: any,
  changedRanges: Map<string, any>,
  affectedFiles: Set<string>,
  noTests: boolean,
): any[] {
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
    const changedFilesList = [...changedRanges.keys()];
    const coResults = coChangeForFiles(changedFilesList, db, {
      minJaccard: 0.3,
      limit: 20,
      noTests,
    });
    return coResults.filter((r: any) => !affectedFiles.has(r.file));
  } catch (e: any) {
    debug(`co_changes lookup skipped: ${e.message}`);
    return [];
  }
}

/**
 * Look up CODEOWNERS for changed and affected files.
 * Returns null if no owners are found or lookup fails.
 */
function lookupOwnership(
  changedRanges: Map<string, any>,
  affectedFiles: Set<string>,
  repoRoot: string,
): { owners: object; affectedOwners: string[]; suggestedReviewers: string[] } | null {
  try {
    const allFilePaths = [...new Set([...changedRanges.keys(), ...affectedFiles])];
    const ownerResult = ownersForFiles(allFilePaths, repoRoot);
    if (ownerResult.affectedOwners.length > 0) {
      return {
        owners: Object.fromEntries(ownerResult.owners),
        affectedOwners: ownerResult.affectedOwners,
        suggestedReviewers: ownerResult.suggestedReviewers,
      };
    }
    return null;
  } catch (e: any) {
    debug(`CODEOWNERS lookup skipped: ${e.message}`);
    return null;
  }
}

/**
 * Check manifesto boundary violations scoped to the changed files.
 * Returns `{ boundaryViolations, boundaryViolationCount }`.
 */
function checkBoundaryViolations(
  db: any,
  changedRanges: Map<string, any>,
  noTests: boolean,
  opts: any,
  repoRoot: string,
): { boundaryViolations: any[]; boundaryViolationCount: number } {
  try {
    const cfg = opts.config || loadConfig(repoRoot);
    const boundaryConfig = cfg.manifesto?.boundaries;
    if (boundaryConfig) {
      const result = evaluateBoundaries(db, boundaryConfig, {
        scopeFiles: [...changedRanges.keys()],
        noTests,
      });
      return {
        boundaryViolations: result.violations,
        boundaryViolationCount: result.violationCount,
      };
    }
  } catch (e: any) {
    debug(`boundary check skipped: ${e.message}`);
  }
  return { boundaryViolations: [], boundaryViolationCount: 0 };
}

// ─── diffImpactData ─────────────────────────────────────────────────────

/**
 * Fix #2: Shell injection vulnerability.
 * Uses execFileSync instead of execSync to prevent shell interpretation of user input.
 */
export function diffImpactData(
  customDbPath: string | undefined,
  opts: {
    noTests?: boolean;
    config?: any;
    depth?: number;
    staged?: boolean;
    ref?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const config = opts.config || loadConfig();
    const maxDepth = opts.depth || config.analysis?.impactDepth || 3;

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    if (!findGitRoot(repoRoot)) {
      return { error: `Not a git repository: ${repoRoot}` };
    }

    const gitResult = runGitDiff(repoRoot, opts);
    if (gitResult.error) return { error: gitResult.error };

    if (!gitResult.output?.trim()) {
      return {
        changedFiles: 0,
        newFiles: [],
        affectedFunctions: [],
        affectedFiles: [],
        summary: null,
      };
    }

    const { changedRanges, newFiles } = parseGitDiff(gitResult.output!);

    if (changedRanges.size === 0) {
      return {
        changedFiles: 0,
        newFiles: [],
        affectedFunctions: [],
        affectedFiles: [],
        summary: null,
      };
    }

    const affectedFunctions = findAffectedFunctions(db, changedRanges, noTests);
    const includeImplementors = opts.includeImplementors !== false;
    const { functionResults, allAffected } = buildFunctionImpactResults(
      db,
      affectedFunctions,
      noTests,
      maxDepth,
      includeImplementors,
    );

    const affectedFiles = new Set<string>();
    for (const key of allAffected) affectedFiles.add(key.split(':')[0]!);

    const historicallyCoupled = lookupCoChanges(db, changedRanges, affectedFiles, noTests);
    const ownership = lookupOwnership(changedRanges, affectedFiles, repoRoot);
    const { boundaryViolations, boundaryViolationCount } = checkBoundaryViolations(
      db,
      changedRanges,
      noTests,
      opts,
      repoRoot,
    );

    const base = {
      changedFiles: changedRanges.size,
      newFiles: [...newFiles],
      affectedFunctions: functionResults,
      affectedFiles: [...affectedFiles],
      historicallyCoupled,
      ownership,
      boundaryViolations,
      boundaryViolationCount,
      summary: {
        functionsChanged: affectedFunctions.length,
        callersAffected: allAffected.size,
        filesAffected: affectedFiles.size,
        historicallyCoupledCount: historicallyCoupled.length,
        ownersAffected: ownership ? ownership.affectedOwners.length : 0,
        boundaryViolationCount,
      },
    };
    return paginateResult(base, 'affectedFunctions', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function diffImpactMermaid(
  customDbPath: string | undefined,
  opts: {
    noTests?: boolean;
    config?: any;
    depth?: number;
    staged?: boolean;
    ref?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
  } = {},
): string | object {
  const data: any = diffImpactData(customDbPath, opts);
  if (data.error) return data.error;
  if (data.changedFiles === 0 || data.affectedFunctions.length === 0) {
    return 'flowchart TB\n    none["No impacted functions detected"]';
  }

  const newFileSet = new Set(data.newFiles || []);
  const lines: string[] = ['flowchart TB'];

  // Assign stable Mermaid node IDs
  let nodeCounter = 0;
  const nodeIdMap = new Map<string, string>();
  const nodeLabels = new Map<string, string>();
  function nodeId(key: string, label?: string): string {
    if (!nodeIdMap.has(key)) {
      nodeIdMap.set(key, `n${nodeCounter++}`);
      if (label) nodeLabels.set(key, label);
    }
    return nodeIdMap.get(key)!;
  }

  // Register all nodes (changed functions + their callers)
  for (const fn of data.affectedFunctions) {
    nodeId(`${fn.file}::${fn.name}:${fn.line}`, fn.name);
    for (const callers of Object.values(fn.levels || {}) as any[][]) {
      for (const c of callers) {
        nodeId(`${c.file}::${c.name}:${c.line}`, c.name);
      }
    }
  }

  // Collect all edges and determine blast radius
  const allEdges = new Set<string>();
  const edgeFromNodes = new Set<string>();
  const edgeToNodes = new Set<string>();
  const changedKeys = new Set<string>();

  for (const fn of data.affectedFunctions) {
    changedKeys.add(`${fn.file}::${fn.name}:${fn.line}`);
    for (const edge of fn.edges || []) {
      const edgeKey = `${edge.from}|${edge.to}`;
      if (!allEdges.has(edgeKey)) {
        allEdges.add(edgeKey);
        edgeFromNodes.add(edge.from);
        edgeToNodes.add(edge.to);
      }
    }
  }

  // Blast radius: caller nodes that are never a source (leaf nodes of the impact tree)
  const blastRadiusKeys = new Set<string>();
  for (const key of edgeToNodes) {
    if (!edgeFromNodes.has(key) && !changedKeys.has(key)) {
      blastRadiusKeys.add(key);
    }
  }

  // Intermediate callers: not changed, not blast radius
  const intermediateKeys = new Set<string>();
  for (const key of edgeToNodes) {
    if (!changedKeys.has(key) && !blastRadiusKeys.has(key)) {
      intermediateKeys.add(key);
    }
  }

  // Group changed functions by file
  const fileGroups = new Map<string, any[]>();
  for (const fn of data.affectedFunctions) {
    if (!fileGroups.has(fn.file)) fileGroups.set(fn.file, []);
    fileGroups.get(fn.file)?.push(fn);
  }

  // Emit changed-file subgraphs
  let sgCounter = 0;
  for (const [file, fns] of fileGroups) {
    const isNew = newFileSet.has(file);
    const tag = isNew ? 'new' : 'modified';
    const sgId = `sg${sgCounter++}`;
    lines.push(`    subgraph ${sgId}["${file} **(${tag})**"]`);
    for (const fn of fns) {
      const key = `${fn.file}::${fn.name}:${fn.line}`;
      lines.push(`        ${nodeIdMap.get(key)}["${fn.name}"]`);
    }
    lines.push('    end');
    const style = isNew ? 'fill:#e8f5e9,stroke:#4caf50' : 'fill:#fff3e0,stroke:#ff9800';
    lines.push(`    style ${sgId} ${style}`);
  }

  // Emit intermediate caller nodes (outside subgraphs)
  for (const key of intermediateKeys) {
    lines.push(`    ${nodeIdMap.get(key)}["${nodeLabels.get(key)}"]`);
  }

  // Emit blast radius subgraph
  if (blastRadiusKeys.size > 0) {
    const sgId = `sg${sgCounter++}`;
    lines.push(`    subgraph ${sgId}["Callers **(blast radius)**"]`);
    for (const key of blastRadiusKeys) {
      lines.push(`        ${nodeIdMap.get(key)}["${nodeLabels.get(key)}"]`);
    }
    lines.push('    end');
    lines.push(`    style ${sgId} fill:#f3e5f5,stroke:#9c27b0`);
  }

  // Emit edges (impact flows from changed fn toward callers)
  for (const edgeKey of allEdges) {
    const [from, to] = edgeKey.split('|') as [string, string];
    lines.push(`    ${nodeIdMap.get(from)} --> ${nodeIdMap.get(to)}`);
  }

  return lines.join('\n');
}
