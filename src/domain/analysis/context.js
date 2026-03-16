import path from 'node:path';
import {
  findCallees,
  findCallers,
  findCrossFileCallTargets,
  findDbPath,
  findFileNodes,
  findImportSources,
  findImportTargets,
  findIntraFileCallEdges,
  findNodeChildren,
  findNodesByFile,
  getComplexityForNode,
  openReadonlyOrFail,
} from '../../db/index.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import { paginateResult } from '../../shared/paginate.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
  isFileLikeTarget,
  readSourceRange,
} from '../../shared/file-utils.js';
import { resolveMethodViaHierarchy } from '../../shared/hierarchy.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { findMatchingNodes } from './symbol-lookup.js';

function explainFileImpl(db, target, getFileLines) {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn) => {
    const symbols = findNodesByFile(db, fn.file);

    // IDs of symbols that have incoming calls from other files (public)
    const publicIds = findCrossFileCallTargets(db, fn.file);

    const fileLines = getFileLines(fn.file);
    const mapSymbol = (s) => ({
      name: s.name,
      kind: s.kind,
      line: s.line,
      role: s.role || null,
      summary: fileLines ? extractSummary(fileLines, s.line) : null,
      signature: fileLines ? extractSignature(fileLines, s.line) : null,
    });

    const publicApi = symbols.filter((s) => publicIds.has(s.id)).map(mapSymbol);
    const internal = symbols.filter((s) => !publicIds.has(s.id)).map(mapSymbol);

    // Imports / importedBy
    const imports = findImportTargets(db, fn.id).map((r) => ({ file: r.file }));

    const importedBy = findImportSources(db, fn.id).map((r) => ({ file: r.file }));

    // Intra-file data flow
    const intraEdges = findIntraFileCallEdges(db, fn.file);

    const dataFlowMap = new Map();
    for (const edge of intraEdges) {
      if (!dataFlowMap.has(edge.caller_name)) dataFlowMap.set(edge.caller_name, []);
      dataFlowMap.get(edge.caller_name).push(edge.callee_name);
    }
    const dataFlow = [...dataFlowMap.entries()].map(([caller, callees]) => ({
      caller,
      callees,
    }));

    // Line count: prefer node_metrics (actual), fall back to MAX(end_line)
    const metric = db
      .prepare(`SELECT nm.line_count FROM node_metrics nm WHERE nm.node_id = ?`)
      .get(fn.id);
    let lineCount = metric?.line_count || null;
    if (!lineCount) {
      const maxLine = db
        .prepare(`SELECT MAX(end_line) as max_end FROM nodes WHERE file = ?`)
        .get(fn.file);
      lineCount = maxLine?.max_end || null;
    }

    return {
      file: fn.file,
      lineCount,
      symbolCount: symbols.length,
      publicApi,
      internal,
      imports,
      importedBy,
      dataFlow,
    };
  });
}

function explainFunctionImpl(db, target, noTests, getFileLines) {
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function','method','class','interface','type','struct','enum','trait','record','module') ORDER BY file, line`,
    )
    .all(`%${target}%`);
  if (noTests) nodes = nodes.filter((n) => !isTestFile(n.file));
  if (nodes.length === 0) return [];

  const hc = new Map();
  return nodes.slice(0, 10).map((node) => {
    const fileLines = getFileLines(node.file);
    const lineCount = node.end_line ? node.end_line - node.line + 1 : null;
    const summary = fileLines ? extractSummary(fileLines, node.line) : null;
    const signature = fileLines ? extractSignature(fileLines, node.line) : null;

    const callees = findCallees(db, node.id).map((c) => ({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.line,
    }));

    let callers = findCallers(db, node.id).map((c) => ({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.line,
    }));
    if (noTests) callers = callers.filter((c) => !isTestFile(c.file));

    const testCallerRows = findCallers(db, node.id);
    const seenFiles = new Set();
    const relatedTests = testCallerRows
      .filter((r) => isTestFile(r.file) && !seenFiles.has(r.file) && seenFiles.add(r.file))
      .map((r) => ({ file: r.file }));

    // Complexity metrics
    let complexityMetrics = null;
    try {
      const cRow = getComplexityForNode(db, node.id);
      if (cRow) {
        complexityMetrics = {
          cognitive: cRow.cognitive,
          cyclomatic: cRow.cyclomatic,
          maxNesting: cRow.max_nesting,
          maintainabilityIndex: cRow.maintainability_index || 0,
          halsteadVolume: cRow.halstead_volume || 0,
        };
      }
    } catch {
      /* table may not exist */
    }

    return {
      ...normalizeSymbol(node, db, hc),
      lineCount,
      summary,
      signature,
      complexity: complexityMetrics,
      callees,
      callers,
      relatedTests,
    };
  });
}

// ─── Exported functions ──────────────────────────────────────────────────

export function contextData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const depth = opts.depth || 0;
    const noSource = opts.noSource || false;
    const noTests = opts.noTests || false;
    const includeTests = opts.includeTests || false;

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    // No hardcoded slice — pagination handles bounding via limit/offset

    const getFileLines = createFileLinesReader(repoRoot);

    const results = nodes.map((node) => {
      const fileLines = getFileLines(node.file);

      // Source
      const source = noSource
        ? null
        : readSourceRange(repoRoot, node.file, node.line, node.end_line);

      // Signature
      const signature = fileLines ? extractSignature(fileLines, node.line) : null;

      // Callees
      const calleeRows = findCallees(db, node.id);
      const filteredCallees = noTests ? calleeRows.filter((c) => !isTestFile(c.file)) : calleeRows;

      const callees = filteredCallees.map((c) => {
        const cLines = getFileLines(c.file);
        const summary = cLines ? extractSummary(cLines, c.line) : null;
        let calleeSource = null;
        if (depth >= 1) {
          calleeSource = readSourceRange(repoRoot, c.file, c.line, c.end_line);
        }
        return {
          name: c.name,
          kind: c.kind,
          file: c.file,
          line: c.line,
          endLine: c.end_line || null,
          summary,
          source: calleeSource,
        };
      });

      // Deep callee expansion via BFS (depth > 1, capped at 5)
      if (depth > 1) {
        const visited = new Set(filteredCallees.map((c) => c.id));
        visited.add(node.id);
        let frontier = filteredCallees.map((c) => c.id);
        const maxDepth = Math.min(depth, 5);
        for (let d = 2; d <= maxDepth; d++) {
          const nextFrontier = [];
          for (const fid of frontier) {
            const deeper = findCallees(db, fid);
            for (const c of deeper) {
              if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
                visited.add(c.id);
                nextFrontier.push(c.id);
                const cLines = getFileLines(c.file);
                callees.push({
                  name: c.name,
                  kind: c.kind,
                  file: c.file,
                  line: c.line,
                  endLine: c.end_line || null,
                  summary: cLines ? extractSummary(cLines, c.line) : null,
                  source: readSourceRange(repoRoot, c.file, c.line, c.end_line),
                });
              }
            }
          }
          frontier = nextFrontier;
          if (frontier.length === 0) break;
        }
      }

      // Callers
      let callerRows = findCallers(db, node.id);

      // Method hierarchy resolution
      if (node.kind === 'method' && node.name.includes('.')) {
        const methodName = node.name.split('.').pop();
        const relatedMethods = resolveMethodViaHierarchy(db, methodName);
        for (const rm of relatedMethods) {
          if (rm.id === node.id) continue;
          const extraCallers = findCallers(db, rm.id);
          callerRows.push(...extraCallers.map((c) => ({ ...c, viaHierarchy: rm.name })));
        }
      }
      if (noTests) callerRows = callerRows.filter((c) => !isTestFile(c.file));

      const callers = callerRows.map((c) => ({
        name: c.name,
        kind: c.kind,
        file: c.file,
        line: c.line,
        viaHierarchy: c.viaHierarchy || undefined,
      }));

      // Related tests: callers that live in test files
      const testCallerRows = findCallers(db, node.id);
      const testCallers = testCallerRows.filter((c) => isTestFile(c.file));

      const testsByFile = new Map();
      for (const tc of testCallers) {
        if (!testsByFile.has(tc.file)) testsByFile.set(tc.file, []);
        testsByFile.get(tc.file).push(tc);
      }

      const relatedTests = [];
      for (const [file] of testsByFile) {
        const tLines = getFileLines(file);
        const testNames = [];
        if (tLines) {
          for (const tl of tLines) {
            const tm = tl.match(/(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
            if (tm) testNames.push(tm[1]);
          }
        }
        const testSource = includeTests && tLines ? tLines.join('\n') : undefined;
        relatedTests.push({
          file,
          testCount: testNames.length,
          testNames,
          source: testSource,
        });
      }

      // Complexity metrics
      let complexityMetrics = null;
      try {
        const cRow = getComplexityForNode(db, node.id);
        if (cRow) {
          complexityMetrics = {
            cognitive: cRow.cognitive,
            cyclomatic: cRow.cyclomatic,
            maxNesting: cRow.max_nesting,
            maintainabilityIndex: cRow.maintainability_index || 0,
            halsteadVolume: cRow.halstead_volume || 0,
          };
        }
      } catch {
        /* table may not exist */
      }

      // Children (parameters, properties, constants)
      let nodeChildren = [];
      try {
        nodeChildren = findNodeChildren(db, node.id).map((c) => ({
          name: c.name,
          kind: c.kind,
          line: c.line,
          endLine: c.end_line || null,
        }));
      } catch {
        /* parent_id column may not exist */
      }

      return {
        name: node.name,
        kind: node.kind,
        file: node.file,
        line: node.line,
        role: node.role || null,
        endLine: node.end_line || null,
        source,
        signature,
        complexity: complexityMetrics,
        children: nodeChildren.length > 0 ? nodeChildren : undefined,
        callees,
        callers,
        relatedTests,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function explainData(target, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const depth = opts.depth || 0;
    const kind = isFileLikeTarget(target) ? 'file' : 'function';

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    const getFileLines = createFileLinesReader(repoRoot);

    const results =
      kind === 'file'
        ? explainFileImpl(db, target, getFileLines)
        : explainFunctionImpl(db, target, noTests, getFileLines);

    // Recursive dependency explanation for function targets
    if (kind === 'function' && depth > 0 && results.length > 0) {
      const visited = new Set(results.map((r) => `${r.name}:${r.file}:${r.line}`));

      function explainCallees(parentResults, currentDepth) {
        if (currentDepth <= 0) return;
        for (const r of parentResults) {
          const newCallees = [];
          for (const callee of r.callees) {
            const key = `${callee.name}:${callee.file}:${callee.line}`;
            if (visited.has(key)) continue;
            visited.add(key);
            const calleeResults = explainFunctionImpl(db, callee.name, noTests, getFileLines);
            const exact = calleeResults.find(
              (cr) => cr.file === callee.file && cr.line === callee.line,
            );
            if (exact) {
              exact._depth = (r._depth || 0) + 1;
              newCallees.push(exact);
            }
          }
          if (newCallees.length > 0) {
            r.depDetails = newCallees;
            explainCallees(newCallees, currentDepth - 1);
          }
        }
      }

      explainCallees(results, depth);
    }

    const base = { target, kind, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
