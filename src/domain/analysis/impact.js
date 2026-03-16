import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../infrastructure/config.js';
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
import { isTestFile } from '../../infrastructure/test-filter.js';
import { paginateResult } from '../../shared/paginate.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { findMatchingNodes } from './symbol-lookup.js';

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
    const maxDepth = opts.depth || 5;
    const noTests = opts.noTests || false;
    const hc = new Map();

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const results = nodes.map((node) => {
      const visited = new Set([node.id]);
      const levels = {};
      let frontier = [node.id];

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
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }

      return {
        ...normalizeSymbol(node, db, hc),
        levels,
        totalDependents: visited.size - 1,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

/**
 * Fix #2: Shell injection vulnerability.
 * Uses execFileSync instead of execSync to prevent shell interpretation of user input.
 */
export function diffImpactData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.depth || 3;

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    // Verify we're in a git repository before running git diff
    let checkDir = repoRoot;
    let isGitRepo = false;
    while (checkDir) {
      if (fs.existsSync(path.join(checkDir, '.git'))) {
        isGitRepo = true;
        break;
      }
      const parent = path.dirname(checkDir);
      if (parent === checkDir) break;
      checkDir = parent;
    }
    if (!isGitRepo) {
      return { error: `Not a git repository: ${repoRoot}` };
    }

    let diffOutput;
    try {
      const args = opts.staged
        ? ['diff', '--cached', '--unified=0', '--no-color']
        : ['diff', opts.ref || 'HEAD', '--unified=0', '--no-color'];
      diffOutput = execFileSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { error: `Failed to run git diff: ${e.message}` };
    }

    if (!diffOutput.trim()) {
      return {
        changedFiles: 0,
        newFiles: [],
        affectedFunctions: [],
        affectedFiles: [],
        summary: null,
      };
    }

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

    if (changedRanges.size === 0) {
      return {
        changedFiles: 0,
        newFiles: [],
        affectedFunctions: [],
        affectedFiles: [],
        summary: null,
      };
    }

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

    const allAffected = new Set();
    const functionResults = affectedFunctions.map((fn) => {
      const visited = new Set([fn.id]);
      let frontier = [fn.id];
      let totalCallers = 0;
      const levels = {};
      const edges = [];
      const idToKey = new Map();
      idToKey.set(fn.id, `${fn.file}::${fn.name}:${fn.line}`);
      for (let d = 1; d <= maxDepth; d++) {
        const nextFrontier = [];
        for (const fid of frontier) {
          const callers = findDistinctCallers(db, fid);
          for (const c of callers) {
            if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
              visited.add(c.id);
              nextFrontier.push(c.id);
              allAffected.add(`${c.file}:${c.name}`);
              const callerKey = `${c.file}::${c.name}:${c.line}`;
              idToKey.set(c.id, callerKey);
              if (!levels[d]) levels[d] = [];
              levels[d].push({ name: c.name, kind: c.kind, file: c.file, line: c.line });
              edges.push({ from: idToKey.get(fid), to: callerKey });
              totalCallers++;
            }
          }
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
      return {
        name: fn.name,
        kind: fn.kind,
        file: fn.file,
        line: fn.line,
        transitiveCallers: totalCallers,
        levels,
        edges,
      };
    });

    const affectedFiles = new Set();
    for (const key of allAffected) affectedFiles.add(key.split(':')[0]);

    // Look up historically coupled files from co-change data
    let historicallyCoupled = [];
    try {
      db.prepare('SELECT 1 FROM co_changes LIMIT 1').get();
      const changedFilesList = [...changedRanges.keys()];
      const coResults = coChangeForFiles(changedFilesList, db, {
        minJaccard: 0.3,
        limit: 20,
        noTests,
      });
      // Exclude files already found via static analysis
      historicallyCoupled = coResults.filter((r) => !affectedFiles.has(r.file));
    } catch {
      /* co_changes table doesn't exist — skip silently */
    }

    // Look up CODEOWNERS for changed + affected files
    let ownership = null;
    try {
      const allFilePaths = [...new Set([...changedRanges.keys(), ...affectedFiles])];
      const ownerResult = ownersForFiles(allFilePaths, repoRoot);
      if (ownerResult.affectedOwners.length > 0) {
        ownership = {
          owners: Object.fromEntries(ownerResult.owners),
          affectedOwners: ownerResult.affectedOwners,
          suggestedReviewers: ownerResult.suggestedReviewers,
        };
      }
    } catch {
      /* CODEOWNERS missing or unreadable — skip silently */
    }

    // Check boundary violations scoped to changed files
    let boundaryViolations = [];
    let boundaryViolationCount = 0;
    try {
      const config = loadConfig(repoRoot);
      const boundaryConfig = config.manifesto?.boundaries;
      if (boundaryConfig) {
        const result = evaluateBoundaries(db, boundaryConfig, {
          scopeFiles: [...changedRanges.keys()],
          noTests,
        });
        boundaryViolations = result.violations;
        boundaryViolationCount = result.violationCount;
      }
    } catch {
      /* boundary check failed — skip silently */
    }

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
