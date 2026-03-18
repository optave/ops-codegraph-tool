import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  findDbPath,
  findDistinctCallers,
  findFileNodes,
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

/**
 * BFS traversal to find transitive callers of a node.
 *
 * @param {import('better-sqlite3').Database} db - Open read-only SQLite database handle (not a Repository)
 * @param {number} startId - Starting node ID
 * @param {{ noTests?: boolean, maxDepth?: number, onVisit?: (caller: object, parentId: number, depth: number) => void }} options
 * @returns {{ totalDependents: number, levels: Record<number, Array<{name:string, kind:string, file:string, line:number}>> }}
 */
export function bfsTransitiveCallers(db, startId, { noTests = false, maxDepth = 3, onVisit } = {}) {
  const visited = new Set([startId]);
  const levels = {};
  let frontier = [startId];

  for (let d = 1; d <= maxDepth; d++) {
    const nextFrontier = [];
    for (const fid of frontier) {
      const callers = findDistinctCallers(db, fid);
      for (const c of callers) {
        if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
          visited.add(c.id);
          nextFrontier.push(c.id);
          if (!levels[d]) levels[d] = [];
          levels[d].push({ name: c.name, kind: c.kind, file: c.file, line: c.line });
          if (onVisit) onVisit(c, fid, d);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.length === 0) break;
  }

  return { totalDependents: visited.size - 1, levels };
}

export function impactAnalysisData(file, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const fileNodes = findFileNodes(db, `%${file}%`);
    if (fileNodes.length === 0) {
      return { file, sources: [], levels: {}, totalDependents: 0 };
    }

    const visited = new Set();
    const queue = [];
    const levels = new Map();

    for (const fn of fileNodes) {
      visited.add(fn.id);
      queue.push(fn.id);
      levels.set(fn.id, 0);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      const level = levels.get(current);
      const dependents = findImportDependents(db, current);
      for (const dep of dependents) {
        if (!visited.has(dep.id) && (!noTests || !isTestFile(dep.file))) {
          visited.add(dep.id);
          queue.push(dep.id);
          levels.set(dep.id, level + 1);
        }
      }
    }

    const byLevel = {};
    for (const [id, level] of levels) {
      if (level === 0) continue;
      if (!byLevel[level]) byLevel[level] = [];
      const node = findNodeById(db, id);
      if (node) byLevel[level].push({ file: node.file });
    }

    return {
      file,
      sources: fileNodes.map((f) => f.file),
      levels: byLevel,
      totalDependents: visited.size - fileNodes.length,
    };
  } finally {
    db.close();
  }
}

export function fnImpactData(name, customDbPath, opts = {}) {
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

    const results = nodes.map((node) => {
      const { levels, totalDependents } = bfsTransitiveCallers(db, node.id, { noTests, maxDepth });
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
 *
 * @param {string} repoRoot
 * @returns {boolean}
 */
function findGitRoot(repoRoot) {
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
 *
 * @param {string} repoRoot
 * @param {{ staged?: boolean, ref?: string }} opts
 * @returns {{ output: string } | { error: string }}
 */
function runGitDiff(repoRoot, opts) {
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
  } catch (e) {
    return { error: `Failed to run git diff: ${e.message}` };
  }
}

/**
 * Parse raw git diff output into a changedRanges map and newFiles set.
 *
 * @param {string} diffOutput
 * @returns {{ changedRanges: Map<string, Array<{start: number, end: number}>>, newFiles: Set<string> }}
 */
function parseGitDiff(diffOutput) {
  const changedRanges = new Map();
  const newFiles = new Set();
  let currentFile = null;
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
      currentFile = fileMatch[1];
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (prevIsDevNull) newFiles.add(currentFile);
      prevIsDevNull = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1], 10);
      const count = parseInt(hunkMatch[2] || '1', 10);
      changedRanges.get(currentFile).push({ start, end: start + count - 1 });
    }
  }

  return { changedRanges, newFiles };
}

/**
 * Find all function/method/class nodes whose line ranges overlap any changed range.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, Array<{start: number, end: number}>} changedRanges
 * @param {boolean} noTests
 * @returns {Array<object>}
 */
function findAffectedFunctions(db, changedRanges, noTests) {
  const affectedFunctions = [];
  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = db
      .prepare(
        `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
      )
      .all(file);
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
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Array<object>} affectedFunctions
 * @param {boolean} noTests
 * @param {number} maxDepth
 * @returns {{ functionResults: Array<object>, allAffected: Set<string> }}
 */
function buildFunctionImpactResults(db, affectedFunctions, noTests, maxDepth) {
  const allAffected = new Set();
  const functionResults = affectedFunctions.map((fn) => {
    const edges = [];
    const idToKey = new Map();
    idToKey.set(fn.id, `${fn.file}::${fn.name}:${fn.line}`);

    const { levels, totalDependents } = bfsTransitiveCallers(db, fn.id, {
      noTests,
      maxDepth,
      onVisit(c, parentId) {
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
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, any>} changedRanges
 * @param {Set<string>} affectedFiles
 * @param {boolean} noTests
 * @returns {Array<object>}
 */
function lookupCoChanges(db, changedRanges, affectedFiles, noTests) {
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
    const changedFilesList = [...changedRanges.keys()];
    const coResults = coChangeForFiles(changedFilesList, db, {
      minJaccard: 0.3,
      limit: 20,
      noTests,
    });
    return coResults.filter((r) => !affectedFiles.has(r.file));
  } catch (e) {
    debug(`co_changes lookup skipped: ${e.message}`);
    return [];
  }
}

/**
 * Look up CODEOWNERS for changed and affected files.
 * Returns null if no owners are found or lookup fails.
 *
 * @param {Map<string, any>} changedRanges
 * @param {Set<string>} affectedFiles
 * @param {string} repoRoot
 * @returns {{ owners: object, affectedOwners: Array<string>, suggestedReviewers: Array<string> } | null}
 */
function lookupOwnership(changedRanges, affectedFiles, repoRoot) {
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
  } catch (e) {
    debug(`CODEOWNERS lookup skipped: ${e.message}`);
    return null;
  }
}

/**
 * Check manifesto boundary violations scoped to the changed files.
 * Returns `{ boundaryViolations, boundaryViolationCount }`.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, any>} changedRanges
 * @param {boolean} noTests
 * @param {object} opts — full diffImpactData opts (may contain `opts.config`)
 * @param {string} repoRoot
 * @returns {{ boundaryViolations: Array<object>, boundaryViolationCount: number }}
 */
function checkBoundaryViolations(db, changedRanges, noTests, opts, repoRoot) {
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
  } catch (e) {
    debug(`boundary check skipped: ${e.message}`);
  }
  return { boundaryViolations: [], boundaryViolationCount: 0 };
}

// ─── diffImpactData ─────────────────────────────────────────────────────

/**
 * Fix #2: Shell injection vulnerability.
 * Uses execFileSync instead of execSync to prevent shell interpretation of user input.
 */
export function diffImpactData(customDbPath, opts = {}) {
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

    if (!gitResult.output.trim()) {
      return {
        changedFiles: 0,
        newFiles: [],
        affectedFunctions: [],
        affectedFiles: [],
        summary: null,
      };
    }

    const { changedRanges, newFiles } = parseGitDiff(gitResult.output);

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
    const { functionResults, allAffected } = buildFunctionImpactResults(
      db,
      affectedFunctions,
      noTests,
      maxDepth,
    );

    const affectedFiles = new Set();
    for (const key of allAffected) affectedFiles.add(key.split(':')[0]);

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

export function diffImpactMermaid(customDbPath, opts = {}) {
  const data = diffImpactData(customDbPath, opts);
  if (data.error) return data.error;
  if (data.changedFiles === 0 || data.affectedFunctions.length === 0) {
    return 'flowchart TB\n    none["No impacted functions detected"]';
  }

  const newFileSet = new Set(data.newFiles || []);
  const lines = ['flowchart TB'];

  // Assign stable Mermaid node IDs
  let nodeCounter = 0;
  const nodeIdMap = new Map();
  const nodeLabels = new Map();
  function nodeId(key, label) {
    if (!nodeIdMap.has(key)) {
      nodeIdMap.set(key, `n${nodeCounter++}`);
      if (label) nodeLabels.set(key, label);
    }
    return nodeIdMap.get(key);
  }

  // Register all nodes (changed functions + their callers)
  for (const fn of data.affectedFunctions) {
    nodeId(`${fn.file}::${fn.name}:${fn.line}`, fn.name);
    for (const callers of Object.values(fn.levels || {})) {
      for (const c of callers) {
        nodeId(`${c.file}::${c.name}:${c.line}`, c.name);
      }
    }
  }

  // Collect all edges and determine blast radius
  const allEdges = new Set();
  const edgeFromNodes = new Set();
  const edgeToNodes = new Set();
  const changedKeys = new Set();

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
  const blastRadiusKeys = new Set();
  for (const key of edgeToNodes) {
    if (!edgeFromNodes.has(key) && !changedKeys.has(key)) {
      blastRadiusKeys.add(key);
    }
  }

  // Intermediate callers: not changed, not blast radius
  const intermediateKeys = new Set();
  for (const key of edgeToNodes) {
    if (!changedKeys.has(key) && !blastRadiusKeys.has(key)) {
      intermediateKeys.add(key);
    }
  }

  // Group changed functions by file
  const fileGroups = new Map();
  for (const fn of data.affectedFunctions) {
    if (!fileGroups.has(fn.file)) fileGroups.set(fn.file, []);
    fileGroups.get(fn.file).push(fn);
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
    const [from, to] = edgeKey.split('|');
    lines.push(`    ${nodeIdMap.get(from)} --> ${nodeIdMap.get(to)}`);
  }

  return lines.join('\n');
}
