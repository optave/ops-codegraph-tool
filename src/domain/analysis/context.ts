import path from 'node:path';
import {
  findCallees,
  findCallers,
  findCrossFileCallTargets,
  findDbPath,
  findFileNodes,
  findImplementors,
  findImportSources,
  findImportTargets,
  findInterfaces,
  findIntraFileCallEdges,
  findNodeChildren,
  findNodesByFile,
  getComplexityForNode,
  openReadonlyOrFail,
} from '../../db/index.js';
import { loadConfig } from '../../infrastructure/config.js';
import { debug } from '../../infrastructure/logger.js';
import { isTestFile } from '../../infrastructure/test-filter.js';
import {
  createFileLinesReader,
  extractSignature,
  extractSummary,
  isFileLikeTarget,
  readSourceRange,
} from '../../shared/file-utils.js';
import { resolveMethodViaHierarchy } from '../../shared/hierarchy.js';
import { normalizeSymbol } from '../../shared/normalize.js';
import { paginateResult } from '../../shared/paginate.js';
import { findMatchingNodes } from './symbol-lookup.js';

function buildCallees(
  db: any,
  node: any,
  repoRoot: string,
  getFileLines: (file: string) => string[] | null,
  opts: { noTests: boolean; depth: number; displayOpts: Record<string, any> },
): any[] {
  const { noTests, depth, displayOpts } = opts;
  const calleeRows = findCallees(db, node.id);
  const filteredCallees = noTests ? calleeRows.filter((c: any) => !isTestFile(c.file)) : calleeRows;

  const callees = filteredCallees.map((c: any) => {
    const cLines = getFileLines(c.file);
    const summary = cLines ? extractSummary(cLines, c.line, displayOpts) : null;
    let calleeSource: string | null = null;
    if (depth >= 1) {
      calleeSource = readSourceRange(
        repoRoot,
        c.file,
        c.line,
        c.end_line ?? undefined,
        displayOpts,
      );
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

  if (depth > 1) {
    const visited = new Set(filteredCallees.map((c: any) => c.id));
    visited.add(node.id);
    let frontier = filteredCallees.map((c: any) => c.id);
    const maxDepth = Math.min(depth, 5);
    for (let d = 2; d <= maxDepth; d++) {
      const nextFrontier: number[] = [];
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
              summary: cLines ? extractSummary(cLines, c.line, displayOpts) : null,
              source: readSourceRange(
                repoRoot,
                c.file,
                c.line,
                c.end_line ?? undefined,
                displayOpts,
              ),
            });
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
  }

  return callees;
}

function buildCallers(db: any, node: any, noTests: boolean): any[] {
  let callerRows = findCallers(db, node.id);

  if (node.kind === 'method' && node.name.includes('.')) {
    const methodName = node.name.split('.').pop();
    const relatedMethods = resolveMethodViaHierarchy(db, methodName);
    for (const rm of relatedMethods) {
      if (rm.id === node.id) continue;
      const extraCallers = findCallers(db, rm.id);
      callerRows.push(...extraCallers.map((c: any) => ({ ...c, viaHierarchy: rm.name })));
    }
  }
  if (noTests) callerRows = callerRows.filter((c: any) => !isTestFile(c.file));

  return callerRows.map((c: any) => ({
    name: c.name,
    kind: c.kind,
    file: c.file,
    line: c.line,
    viaHierarchy: c.viaHierarchy || undefined,
  }));
}

const INTERFACE_LIKE_KINDS = new Set(['interface', 'trait']);
const IMPLEMENTOR_KINDS = new Set(['class', 'struct', 'record', 'enum']);

function buildImplementationInfo(db: any, node: any, noTests: boolean): object {
  // For interfaces/traits: show who implements them
  if (INTERFACE_LIKE_KINDS.has(node.kind)) {
    let impls = findImplementors(db, node.id);
    if (noTests) impls = impls.filter((n: any) => !isTestFile(n.file));
    return {
      implementors: impls.map((n: any) => ({
        name: n.name,
        kind: n.kind,
        file: n.file,
        line: n.line,
      })),
    };
  }
  // For classes/structs: show what they implement
  if (IMPLEMENTOR_KINDS.has(node.kind)) {
    let ifaces = findInterfaces(db, node.id);
    if (noTests) ifaces = ifaces.filter((n: any) => !isTestFile(n.file));
    if (ifaces.length > 0) {
      return {
        implements: ifaces.map((n: any) => ({
          name: n.name,
          kind: n.kind,
          file: n.file,
          line: n.line,
        })),
      };
    }
  }
  return {};
}

function buildRelatedTests(
  db: any,
  node: any,
  getFileLines: (file: string) => string[] | null,
  includeTests: boolean,
): any[] {
  const testCallerRows = findCallers(db, node.id);
  const testCallers = testCallerRows.filter((c: any) => isTestFile(c.file));

  const testsByFile = new Map<string, any[]>();
  for (const tc of testCallers) {
    if (!testsByFile.has(tc.file)) testsByFile.set(tc.file, []);
    testsByFile.get(tc.file)?.push(tc);
  }

  const relatedTests: any[] = [];
  for (const [file] of testsByFile) {
    const tLines = getFileLines(file);
    const testNames: string[] = [];
    if (tLines) {
      for (const tl of tLines) {
        const tm = tl.match(/(?:it|test|describe)\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (tm && tm[1]) testNames.push(tm[1]);
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

  return relatedTests;
}

function getComplexityMetrics(db: any, nodeId: number): object | null {
  try {
    const cRow = getComplexityForNode(db, nodeId);
    if (!cRow) return null;
    return {
      cognitive: cRow.cognitive,
      cyclomatic: cRow.cyclomatic,
      maxNesting: cRow.max_nesting,
      maintainabilityIndex: cRow.maintainability_index || 0,
      halsteadVolume: cRow.halstead_volume || 0,
    };
  } catch (e: any) {
    debug(`complexity lookup failed for node ${nodeId}: ${e.message}`);
    return null;
  }
}

function getNodeChildrenSafe(db: any, nodeId: number): any[] {
  try {
    return findNodeChildren(db, nodeId).map((c: any) => ({
      name: c.name,
      kind: c.kind,
      line: c.line,
      endLine: c.end_line || null,
    }));
  } catch (e: any) {
    debug(`findNodeChildren failed for node ${nodeId}: ${e.message}`);
    return [];
  }
}

function explainFileImpl(
  db: any,
  target: string,
  getFileLines: (file: string) => string[] | null,
  displayOpts: Record<string, any>,
): any[] {
  const fileNodes = findFileNodes(db, `%${target}%`);
  if (fileNodes.length === 0) return [];

  return fileNodes.map((fn: any) => {
    const symbols = findNodesByFile(db, fn.file);

    // IDs of symbols that have incoming calls from other files (public)
    const publicIds = findCrossFileCallTargets(db, fn.file);

    const fileLines = getFileLines(fn.file);
    const mapSymbol = (s: any) => ({
      name: s.name,
      kind: s.kind,
      line: s.line,
      role: s.role || null,
      summary: fileLines ? extractSummary(fileLines, s.line, displayOpts) : null,
      signature: fileLines ? extractSignature(fileLines, s.line, displayOpts) : null,
    });

    const publicApi = symbols.filter((s: any) => publicIds.has(s.id)).map(mapSymbol);
    const internal = symbols.filter((s: any) => !publicIds.has(s.id)).map(mapSymbol);

    const imports = findImportTargets(db, fn.id).map((r: any) => ({ file: r.file }));
    const importedBy = findImportSources(db, fn.id).map((r: any) => ({ file: r.file }));

    const intraEdges = findIntraFileCallEdges(db, fn.file);
    const dataFlowMap = new Map<string, string[]>();
    for (const edge of intraEdges) {
      if (!dataFlowMap.has(edge.caller_name)) dataFlowMap.set(edge.caller_name, []);
      dataFlowMap.get(edge.caller_name)?.push(edge.callee_name);
    }
    const dataFlow = [...dataFlowMap.entries()].map(([caller, callees]) => ({
      caller,
      callees,
    }));

    const metric = db
      .prepare(`SELECT nm.line_count FROM node_metrics nm WHERE nm.node_id = ?`)
      .get(fn.id) as any;
    let lineCount = metric?.line_count || null;
    if (!lineCount) {
      const maxLine = db
        .prepare(`SELECT MAX(end_line) as max_end FROM nodes WHERE file = ?`)
        .get(fn.file) as any;
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

function explainFunctionImpl(
  db: any,
  target: string,
  noTests: boolean,
  getFileLines: (file: string) => string[] | null,
  displayOpts: Record<string, any>,
): any[] {
  let nodes = db
    .prepare(
      `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function','method','class','interface','type','struct','enum','trait','record','module','constant') ORDER BY file, line`,
    )
    .all(`%${target}%`) as any[];
  if (noTests) nodes = nodes.filter((n: any) => !isTestFile(n.file));
  if (nodes.length === 0) return [];

  const hc = new Map();
  return nodes.slice(0, 10).map((node: any) => {
    const fileLines = getFileLines(node.file);
    const lineCount = node.end_line ? node.end_line - node.line + 1 : null;
    const summary = fileLines ? extractSummary(fileLines, node.line, displayOpts) : null;
    const signature = fileLines ? extractSignature(fileLines, node.line, displayOpts) : null;

    const callees = findCallees(db, node.id).map((c: any) => ({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.line,
    }));

    let callers = findCallers(db, node.id).map((c: any) => ({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.line,
    }));
    if (noTests) callers = callers.filter((c: any) => !isTestFile(c.file));

    const testCallerRows = findCallers(db, node.id);
    const seenFiles = new Set<string>();
    const relatedTests = testCallerRows
      .filter((r: any) => isTestFile(r.file) && !seenFiles.has(r.file) && seenFiles.add(r.file))
      .map((r: any) => ({ file: r.file }));

    return {
      ...normalizeSymbol(node, db, hc),
      lineCount,
      summary,
      signature,
      complexity: getComplexityMetrics(db, node.id),
      callees,
      callers,
      relatedTests,
    };
  });
}

function explainCallees(
  parentResults: any[],
  currentDepth: number,
  visited: Set<string>,
  db: any,
  noTests: boolean,
  getFileLines: (file: string) => string[] | null,
  displayOpts: Record<string, any>,
): void {
  if (currentDepth <= 0) return;
  for (const r of parentResults) {
    const newCallees: any[] = [];
    for (const callee of r.callees) {
      const key = `${callee.name}:${callee.file}:${callee.line}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const calleeResults = explainFunctionImpl(
        db,
        callee.name,
        noTests,
        getFileLines,
        displayOpts,
      );
      const exact = calleeResults.find(
        (cr: any) => cr.file === callee.file && cr.line === callee.line,
      );
      if (exact) {
        exact._depth = (r._depth || 0) + 1;
        newCallees.push(exact);
      }
    }
    if (newCallees.length > 0) {
      r.depDetails = newCallees;
      explainCallees(newCallees, currentDepth - 1, visited, db, noTests, getFileLines, displayOpts);
    }
  }
}

// ─── Exported functions ──────────────────────────────────────────────────

export function contextData(
  name: string,
  customDbPath: string | undefined,
  opts: {
    depth?: number;
    noSource?: boolean;
    noTests?: boolean;
    includeTests?: boolean;
    config?: any;
    file?: string;
    kind?: string;
    limit?: number;
    offset?: number;
  } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const depth = opts.depth || 0;
    const noSource = opts.noSource || false;
    const noTests = opts.noTests || false;
    const includeTests = opts.includeTests || false;

    const config = opts.config || loadConfig();
    const displayOpts = config.display || {};

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    const nodes = findMatchingNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
      return { name, results: [] };
    }

    const getFileLines = createFileLinesReader(repoRoot);

    const results = nodes.map((node: any) => {
      const fileLines = getFileLines(node.file);

      const source = noSource
        ? null
        : readSourceRange(repoRoot, node.file, node.line, node.end_line, displayOpts);

      const signature = fileLines ? extractSignature(fileLines, node.line, displayOpts) : null;

      const callees = buildCallees(db, node, repoRoot, getFileLines, {
        noTests,
        depth,
        displayOpts,
      });
      const callers = buildCallers(db, node, noTests);
      const relatedTests = buildRelatedTests(db, node, getFileLines, includeTests);
      const complexityMetrics = getComplexityMetrics(db, node.id);
      const nodeChildren = getNodeChildrenSafe(db, node.id);
      const implInfo = buildImplementationInfo(db, node, noTests);

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
        ...implInfo,
      };
    });

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

export function explainData(
  target: string,
  customDbPath: string | undefined,
  opts: { noTests?: boolean; depth?: number; config?: any; limit?: number; offset?: number } = {},
): object {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const depth = opts.depth || 0;
    const kind = isFileLikeTarget(target) ? 'file' : 'function';

    const config = opts.config || loadConfig();
    const displayOpts = config.display || {};

    const dbPath = findDbPath(customDbPath);
    const repoRoot = path.resolve(path.dirname(dbPath), '..');

    const getFileLines = createFileLinesReader(repoRoot);

    const results =
      kind === 'file'
        ? explainFileImpl(db, target, getFileLines, displayOpts)
        : explainFunctionImpl(db, target, noTests, getFileLines, displayOpts);

    if (kind === 'function' && depth > 0 && results.length > 0) {
      const visited = new Set(results.map((r: any) => `${r.name}:${r.file}:${r.line}`));
      explainCallees(results, depth, visited, db, noTests, getFileLines, displayOpts);
    }

    const base = { target, kind, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}
