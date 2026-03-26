import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findDbPath, openReadonlyOrFail } from '../../db/index.js';
import { cachedStmt } from '../../db/repository/cached-stmt.js';
import { evaluateBoundaries } from '../../features/boundaries.js';
import { coChangeForFiles } from '../../features/cochange.js';
import { ownersForFiles } from '../../features/owners.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { paginateResult } from '../../shared/paginate.js';
import type { BetterSqlite3Database, NodeRow, StmtCache } from '../../types.js';
import { bfsTransitiveCallers } from './fn-impact.js';

const _defsStmtCache: StmtCache<NodeRow> = new WeakMap();

// --- diffImpactData helpers ---

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
): { output: string; error?: never } | { error: string; output?: never } {
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
  } catch (e: unknown) {
    return { error: `Failed to run git diff: ${(e as Error).message}` };
  }
}

/**
 * Parse raw git diff output into a changedRanges map and newFiles set.
 */
function parseGitDiff(diffOutput: string) {
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
      currentFile = fileMatch[1]!;
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      if (prevIsDevNull) newFiles.add(currentFile!);
      prevIsDevNull = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1]!, 10);
      const count = parseInt(hunkMatch[2] || '1', 10);
      changedRanges.get(currentFile)!.push({ start, end: start + count - 1 });
    }
  }

  return { changedRanges, newFiles };
}

/**
 * Find all function/method/class nodes whose line ranges overlap any changed range.
 */
function findAffectedFunctions(
  db: BetterSqlite3Database,
  changedRanges: Map<string, Array<{ start: number; end: number }>>,
  noTests: boolean,
): NodeRow[] {
  const affectedFunctions: NodeRow[] = [];
  const defsStmt = cachedStmt(
    _defsStmtCache,
    db,
    `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`,
  );
  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;
    const defs = defsStmt.all(file) as NodeRow[];
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      const endLine = def.end_line || (defs[i + 1] ? defs[i + 1]!.line - 1 : 999999);
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
  db: BetterSqlite3Database,
  affectedFunctions: NodeRow[],
  noTests: boolean,
  maxDepth: number,
  includeImplementors = true,
) {
  const allAffected = new Set<string>();
  const functionResults = affectedFunctions.map((fn) => {
    const edges: Array<{ from: string; to: string }> = [];
    const idToKey = new Map<number, string>();
    idToKey.set(fn.id, `${fn.file}::${fn.name}:${fn.line}`);

    const { levels, totalDependents } = bfsTransitiveCallers(db, fn.id, {
      noTests,
      maxDepth,
      includeImplementors,
      onVisit(c, parentId) {
        allAffected.add(`${c.file}:${c.name}`);
        const callerKey = `${c.file}::${c.name}:${c.line}`;
        idToKey.set(c.id, callerKey);
        edges.push({ from: idToKey.get(parentId)!, to: callerKey });
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
  db: BetterSqlite3Database,
  changedRanges: Map<string, unknown>,
  affectedFiles: Set<string>,
  noTests: boolean,
) {
  try {
    db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
    const changedFilesList = [...changedRanges.keys()];
    const coResults = coChangeForFiles(changedFilesList, db, {
      minJaccard: 0.3,
      limit: 20,
      noTests,
    });
    return coResults.filter((r: { file: string }) => !affectedFiles.has(r.file));
  } catch (e: unknown) {
    debug(`co_changes lookup skipped: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Look up CODEOWNERS for changed and affected files.
 * Returns null if no owners are found or lookup fails.
 */
function lookupOwnership(
  changedRanges: Map<string, unknown>,
  affectedFiles: Set<string>,
  repoRoot: string,
) {
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
  } catch (e: unknown) {
    debug(`CODEOWNERS lookup skipped: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Check manifesto boundary violations scoped to the changed files.
 * Returns `{ boundaryViolations, boundaryViolationCount }`.
 */
function checkBoundaryViolations(
  db: BetterSqlite3Database,
  changedRanges: Map<string, unknown>,
  noTests: boolean,
  opts: any,
  repoRoot: string,
) {
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
  } catch (e: unknown) {
    debug(`boundary check skipped: ${(e as Error).message}`);
  }
  return { boundaryViolations: [], boundaryViolationCount: 0 };
}

// --- diffImpactData ---

/**
 * Compute diff-impact analysis between two git refs (or staged changes).
 * Uses execFileSync (via runGitDiff) to avoid shell injection.
 */
export function diffImpactData(
  customDbPath: string,
  opts: {
    noTests?: boolean;
    depth?: number;
    staged?: boolean;
    ref?: string;
    includeImplementors?: boolean;
    limit?: number;
    offset?: number;
    config?: any;
  } = {},
) {
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
    if ('error' in gitResult) return { error: gitResult.error };

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
