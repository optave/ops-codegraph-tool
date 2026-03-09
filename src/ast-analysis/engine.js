/**
 * Unified AST analysis engine — orchestrates all analysis passes in one file-iteration loop.
 *
 * Replaces the 4 sequential buildXxx calls in builder.js with a single coordinated pass:
 *   - AST node extraction (calls, new, string, regex, throw, await)
 *   - Complexity metrics (cognitive, cyclomatic, nesting, Halstead, MI)
 *   - CFG construction (basic blocks + edges)
 *   - Dataflow analysis (define-use chains, arg flows, mutations)
 *
 * Two modes:
 *   Mode A (node-level visitor): AST + complexity + dataflow — single DFS per file
 *   Mode B (statement-level): CFG keeps its own traversal via buildFunctionCFG
 *
 * Optimization strategy: for files with WASM trees, run all applicable visitors
 * in a single walkWithVisitors call, then store results in the format that the
 * existing buildXxx functions expect as pre-computed data. This eliminates ~3
 * redundant tree traversals per file.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../logger.js';
import { computeLOCMetrics, computeMaintainabilityIndex } from './metrics.js';
import {
  AST_TYPE_MAPS,
  CFG_RULES,
  COMPLEXITY_RULES,
  DATAFLOW_RULES,
  HALSTEAD_RULES,
} from './rules/index.js';
import { buildExtensionSet, buildExtToLangMap } from './shared.js';
import { walkWithVisitors } from './visitor.js';
import { functionName as getFuncName } from './visitor-utils.js';
import { createAstStoreVisitor } from './visitors/ast-store-visitor.js';
import { createComplexityVisitor } from './visitors/complexity-visitor.js';
import { createDataflowVisitor } from './visitors/dataflow-visitor.js';

// ─── Extension sets for quick language-support checks ────────────────────

const CFG_EXTENSIONS = buildExtensionSet(CFG_RULES);
const DATAFLOW_EXTENSIONS = buildExtensionSet(DATAFLOW_RULES);
const WALK_EXTENSIONS = buildExtensionSet(AST_TYPE_MAPS);

// ─── Lazy imports (heavy modules loaded only when needed) ────────────────

let _parserModule = null;
async function getParserModule() {
  if (!_parserModule) _parserModule = await import('../parser.js');
  return _parserModule;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Run all enabled AST analyses in a coordinated pass.
 *
 * @param {object} db - open better-sqlite3 database (read-write)
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, calls, _tree, _langId, ... }>
 * @param {string} rootDir - absolute project root path
 * @param {object} opts - build options (ast, complexity, cfg, dataflow toggles)
 * @param {object} [engineOpts] - engine options
 * @returns {Promise<{ astMs: number, complexityMs: number, cfgMs: number, dataflowMs: number }>}
 */
export async function runAnalyses(db, fileSymbols, rootDir, opts, _engineOpts) {
  const timing = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };

  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  if (!doAst && !doComplexity && !doCfg && !doDataflow) return timing;

  const extToLang = buildExtToLangMap();

  // ── WASM pre-parse for files that need it ───────────────────────────
  if (doCfg || doDataflow) {
    let needsWasmTrees = false;
    for (const [relPath, symbols] of fileSymbols) {
      if (symbols._tree) continue;
      const ext = path.extname(relPath).toLowerCase();

      if (doCfg && CFG_EXTENSIONS.has(ext)) {
        const fnDefs = (symbols.definitions || []).filter(
          (d) => (d.kind === 'function' || d.kind === 'method') && d.line,
        );
        if (
          fnDefs.length > 0 &&
          !fnDefs.every((d) => d.cfg === null || Array.isArray(d.cfg?.blocks))
        ) {
          needsWasmTrees = true;
          break;
        }
      }
      if (doDataflow && !symbols.dataflow && DATAFLOW_EXTENSIONS.has(ext)) {
        needsWasmTrees = true;
        break;
      }
    }

    if (needsWasmTrees) {
      try {
        const { ensureWasmTrees } = await getParserModule();
        await ensureWasmTrees(fileSymbols, rootDir);
      } catch (err) {
        debug(`ensureWasmTrees failed: ${err.message}`);
      }
    }
  }

  // ── Phase 7 Optimization: Unified pre-walk ─────────────────────────
  // For files with WASM trees, run all applicable visitors in a SINGLE
  // walkWithVisitors call. Store results in the format that buildXxx
  // functions already expect as pre-computed data (same fields as native
  // engine output). This eliminates ~3 redundant tree traversals per file.
  const t0walk = performance.now();

  // Pre-load node ID map for AST parent resolution
  const bulkGetNodeIds = doAst
    ? db.prepare('SELECT id, name, kind, line FROM nodes WHERE file = ?')
    : null;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) continue; // No WASM tree — native path handles it

    const ext = path.extname(relPath).toLowerCase();
    const langId = symbols._langId || extToLang.get(ext);
    if (!langId) continue;

    const defs = symbols.definitions || [];
    const visitors = [];
    const walkerOpts = {
      functionNodeTypes: new Set(),
      nestingNodeTypes: new Set(),
      getFunctionName: (_node) => null,
    };

    // ─ AST-store visitor ─
    const astTypeMap = AST_TYPE_MAPS.get(langId);
    let astVisitor = null;
    if (doAst && astTypeMap && WALK_EXTENSIONS.has(ext) && !symbols.astNodes?.length) {
      const nodeIdMap = new Map();
      if (bulkGetNodeIds) {
        for (const row of bulkGetNodeIds.all(relPath)) {
          nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
        }
      }
      astVisitor = createAstStoreVisitor(astTypeMap, defs, relPath, nodeIdMap);
      visitors.push(astVisitor);
    }

    // ─ Complexity visitor (file-level mode) ─
    const cRules = COMPLEXITY_RULES.get(langId);
    const hRules = HALSTEAD_RULES.get(langId);
    let complexityVisitor = null;
    if (doComplexity && cRules) {
      // Only use visitor if some functions lack pre-computed complexity
      const needsWasmComplexity = defs.some(
        (d) => (d.kind === 'function' || d.kind === 'method') && d.line && !d.complexity,
      );
      if (needsWasmComplexity) {
        complexityVisitor = createComplexityVisitor(cRules, hRules, { fileLevelWalk: true });
        visitors.push(complexityVisitor);

        // Merge nesting nodes for complexity tracking
        for (const t of cRules.nestingNodes) walkerOpts.nestingNodeTypes.add(t);
        for (const t of cRules.functionNodes) walkerOpts.nestingNodeTypes.add(t);

        // Provide getFunctionName for complexity visitor
        const dfRules = DATAFLOW_RULES.get(langId);
        walkerOpts.getFunctionName = (node) => {
          // Try complexity rules' function name field first
          const nameNode = node.childForFieldName('name');
          if (nameNode) return nameNode.text;
          // Fall back to dataflow rules' richer name extraction
          if (dfRules) return getFuncName(node, dfRules);
          return null;
        };
      }
    }

    // ─ Dataflow visitor ─
    const dfRules = DATAFLOW_RULES.get(langId);
    let dataflowVisitor = null;
    if (doDataflow && dfRules && DATAFLOW_EXTENSIONS.has(ext) && !symbols.dataflow) {
      dataflowVisitor = createDataflowVisitor(dfRules);
      visitors.push(dataflowVisitor);
    }

    // ─ Run unified walk if we have visitors ─
    if (visitors.length === 0) continue;

    const results = walkWithVisitors(symbols._tree.rootNode, visitors, langId, walkerOpts);

    // ─ Store AST results (buildAstNodes will find symbols.astNodes and skip its walk) ─
    if (astVisitor) {
      const astRows = results['ast-store'] || [];
      if (astRows.length > 0) {
        // Store in the format buildAstNodes expects for the native path
        symbols.astNodes = astRows;
      }
    }

    // ─ Store complexity results on definitions (buildComplexityMetrics will find def.complexity) ─
    if (complexityVisitor) {
      const complexityResults = results.complexity || [];
      // Match results back to definitions by function start line
      const resultByLine = new Map();
      for (const r of complexityResults) {
        if (r.funcNode) {
          const line = r.funcNode.startPosition.row + 1;
          resultByLine.set(line, r.metrics);
        }
      }
      for (const def of defs) {
        if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
          const metrics = resultByLine.get(def.line);
          if (metrics) {
            // Compute LOC + MI from the actual function node text
            const funcResult = complexityResults.find(
              (r) => r.funcNode && r.funcNode.startPosition.row + 1 === def.line,
            );
            const loc = funcResult ? computeLOCMetrics(funcResult.funcNode, langId) : metrics.loc;
            const volume = metrics.halstead ? metrics.halstead.volume : 0;
            const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
            const mi = computeMaintainabilityIndex(
              volume,
              metrics.cyclomatic,
              loc.sloc,
              commentRatio,
            );

            def.complexity = {
              cognitive: metrics.cognitive,
              cyclomatic: metrics.cyclomatic,
              maxNesting: metrics.maxNesting,
              halstead: metrics.halstead,
              loc,
              maintainabilityIndex: mi,
            };
          }
        }
      }
    }

    // ─ Store dataflow results (buildDataflowEdges will find symbols.dataflow and skip its walk) ─
    if (dataflowVisitor) {
      symbols.dataflow = results.dataflow;
    }
  }

  timing._unifiedWalkMs = performance.now() - t0walk;

  // ── Delegate to buildXxx functions ─────────────────────────────────
  // Each function finds pre-computed data from the unified walk above
  // (or from the native engine) and only does DB writes + native fallback.

  if (doAst) {
    const t0 = performance.now();
    try {
      const { buildAstNodes } = await import('../ast.js');
      await buildAstNodes(db, fileSymbols, rootDir, _engineOpts);
    } catch (err) {
      debug(`buildAstNodes failed: ${err.message}`);
    }
    timing.astMs = performance.now() - t0;
  }

  if (doComplexity) {
    const t0 = performance.now();
    try {
      const { buildComplexityMetrics } = await import('../complexity.js');
      await buildComplexityMetrics(db, fileSymbols, rootDir, _engineOpts);
    } catch (err) {
      debug(`buildComplexityMetrics failed: ${err.message}`);
    }
    timing.complexityMs = performance.now() - t0;
  }

  if (doCfg) {
    const t0 = performance.now();
    try {
      const { buildCFGData } = await import('../cfg.js');
      await buildCFGData(db, fileSymbols, rootDir, _engineOpts);
    } catch (err) {
      debug(`buildCFGData failed: ${err.message}`);
    }
    timing.cfgMs = performance.now() - t0;
  }

  if (doDataflow) {
    const t0 = performance.now();
    try {
      const { buildDataflowEdges } = await import('../dataflow.js');
      await buildDataflowEdges(db, fileSymbols, rootDir, _engineOpts);
    } catch (err) {
      debug(`buildDataflowEdges failed: ${err.message}`);
    }
    timing.dataflowMs = performance.now() - t0;
  }

  return timing;
}
