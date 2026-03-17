/**
 * Unified AST analysis engine — orchestrates all analysis passes in one file-iteration loop.
 *
 * Replaces the 4 sequential buildXxx calls in builder.js with a single coordinated pass:
 *   - AST node extraction (calls, new, string, regex, throw, await)
 *   - Complexity metrics (cognitive, cyclomatic, nesting, Halstead, MI)
 *   - CFG construction (basic blocks + edges)
 *   - Dataflow analysis (define-use chains, arg flows, mutations)
 *
 * All 4 analyses run as visitors in a single DFS walk via walkWithVisitors.
 *
 * Optimization strategy: for files with WASM trees, run all applicable visitors
 * in a single walkWithVisitors call. Store results in the format that buildXxx
 * functions already expect as pre-computed data (same fields as native engine
 * output). This eliminates redundant tree traversals per file.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { bulkNodeIdsByFile } from '../db/index.js';
import { debug } from '../infrastructure/logger.js';
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
import { createCfgVisitor } from './visitors/cfg-visitor.js';
import { createComplexityVisitor } from './visitors/complexity-visitor.js';
import { createDataflowVisitor } from './visitors/dataflow-visitor.js';

// ─── Extension sets for quick language-support checks ────────────────────

const CFG_EXTENSIONS = buildExtensionSet(CFG_RULES);
const COMPLEXITY_EXTENSIONS = buildExtensionSet(COMPLEXITY_RULES);
const DATAFLOW_EXTENSIONS = buildExtensionSet(DATAFLOW_RULES);
const WALK_EXTENSIONS = buildExtensionSet(AST_TYPE_MAPS);

// ─── Lazy imports (heavy modules loaded only when needed) ────────────────

let _parserModule = null;
async function getParserModule() {
  if (!_parserModule) _parserModule = await import('../domain/parser.js');
  return _parserModule;
}

// ─── WASM pre-parse ─────────────────────────────────────────────────────

async function ensureWasmTreesIfNeeded(fileSymbols, opts) {
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  if (!doComplexity && !doCfg && !doDataflow) return;

  let needsWasmTrees = false;
  for (const [relPath, symbols] of fileSymbols) {
    if (symbols._tree) continue;
    const ext = path.extname(relPath).toLowerCase();
    const defs = symbols.definitions || [];

    const needsComplexity =
      doComplexity &&
      COMPLEXITY_EXTENSIONS.has(ext) &&
      defs.some((d) => (d.kind === 'function' || d.kind === 'method') && d.line && !d.complexity);
    const needsCfg =
      doCfg &&
      CFG_EXTENSIONS.has(ext) &&
      defs.some(
        (d) =>
          (d.kind === 'function' || d.kind === 'method') &&
          d.line &&
          d.cfg !== null &&
          !Array.isArray(d.cfg?.blocks),
      );
    const needsDataflow = doDataflow && !symbols.dataflow && DATAFLOW_EXTENSIONS.has(ext);

    if (needsComplexity || needsCfg || needsDataflow) {
      needsWasmTrees = true;
      break;
    }
  }

  if (needsWasmTrees) {
    try {
      const { ensureWasmTrees } = await getParserModule();
      await ensureWasmTrees(fileSymbols);
    } catch (err) {
      debug(`ensureWasmTrees failed: ${err.message}`);
    }
  }
}

// ─── Per-file visitor setup ─────────────────────────────────────────────

function setupVisitors(db, relPath, symbols, langId, opts) {
  const ext = path.extname(relPath).toLowerCase();
  const defs = symbols.definitions || [];
  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  const visitors = [];
  const walkerOpts = {
    functionNodeTypes: new Set(),
    nestingNodeTypes: new Set(),
    getFunctionName: (_node) => null,
  };

  // AST-store visitor
  let astVisitor = null;
  const astTypeMap = AST_TYPE_MAPS.get(langId);
  if (doAst && astTypeMap && WALK_EXTENSIONS.has(ext) && !symbols.astNodes?.length) {
    const nodeIdMap = new Map();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }
    astVisitor = createAstStoreVisitor(astTypeMap, defs, relPath, nodeIdMap);
    visitors.push(astVisitor);
  }

  // Complexity visitor (file-level mode)
  let complexityVisitor = null;
  const cRules = COMPLEXITY_RULES.get(langId);
  const hRules = HALSTEAD_RULES.get(langId);
  if (doComplexity && cRules) {
    const needsWasmComplexity = defs.some(
      (d) => (d.kind === 'function' || d.kind === 'method') && d.line && !d.complexity,
    );
    if (needsWasmComplexity) {
      complexityVisitor = createComplexityVisitor(cRules, hRules, { fileLevelWalk: true, langId });
      visitors.push(complexityVisitor);

      for (const t of cRules.nestingNodes) walkerOpts.nestingNodeTypes.add(t);

      const dfRules = DATAFLOW_RULES.get(langId);
      walkerOpts.getFunctionName = (node) => {
        const nameNode = node.childForFieldName('name');
        if (nameNode) return nameNode.text;
        if (dfRules) return getFuncName(node, dfRules);
        return null;
      };
    }
  }

  // CFG visitor
  let cfgVisitor = null;
  const cfgRulesForLang = CFG_RULES.get(langId);
  if (doCfg && cfgRulesForLang && CFG_EXTENSIONS.has(ext)) {
    const needsWasmCfg = defs.some(
      (d) =>
        (d.kind === 'function' || d.kind === 'method') &&
        d.line &&
        d.cfg !== null &&
        !Array.isArray(d.cfg?.blocks),
    );
    if (needsWasmCfg) {
      cfgVisitor = createCfgVisitor(cfgRulesForLang);
      visitors.push(cfgVisitor);
    }
  }

  // Dataflow visitor
  let dataflowVisitor = null;
  const dfRules = DATAFLOW_RULES.get(langId);
  if (doDataflow && dfRules && DATAFLOW_EXTENSIONS.has(ext) && !symbols.dataflow) {
    dataflowVisitor = createDataflowVisitor(dfRules);
    visitors.push(dataflowVisitor);
  }

  return { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor };
}

// ─── Result storage helpers ─────────────────────────────────────────────

function storeComplexityResults(results, defs, langId) {
  const complexityResults = results.complexity || [];
  const resultByLine = new Map();
  for (const r of complexityResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!resultByLine.has(line)) resultByLine.set(line, []);
      resultByLine.get(line).push(r);
    }
  }
  for (const def of defs) {
    if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
      const candidates = resultByLine.get(def.line);
      const funcResult = !candidates
        ? undefined
        : candidates.length === 1
          ? candidates[0]
          : (candidates.find((r) => {
              const n = r.funcNode.childForFieldName('name');
              return n && n.text === def.name;
            }) ?? candidates[0]);
      if (funcResult) {
        const { metrics } = funcResult;
        const loc = computeLOCMetrics(funcResult.funcNode, langId);
        const volume = metrics.halstead ? metrics.halstead.volume : 0;
        const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
        const mi = computeMaintainabilityIndex(volume, metrics.cyclomatic, loc.sloc, commentRatio);

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

function storeCfgResults(results, defs) {
  const cfgResults = results.cfg || [];
  const cfgByLine = new Map();
  for (const r of cfgResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!cfgByLine.has(line)) cfgByLine.set(line, []);
      cfgByLine.get(line).push(r);
    }
  }
  for (const def of defs) {
    if (
      (def.kind === 'function' || def.kind === 'method') &&
      def.line &&
      !def.cfg?.blocks?.length
    ) {
      const candidates = cfgByLine.get(def.line);
      const cfgResult = !candidates
        ? undefined
        : candidates.length === 1
          ? candidates[0]
          : (candidates.find((r) => {
              const n = r.funcNode.childForFieldName('name');
              return n && n.text === def.name;
            }) ?? candidates[0]);
      if (cfgResult) {
        def.cfg = { blocks: cfgResult.blocks, edges: cfgResult.edges };

        // Override complexity's cyclomatic with CFG-derived value (single source of truth)
        if (def.complexity && cfgResult.cyclomatic != null) {
          def.complexity.cyclomatic = cfgResult.cyclomatic;
          const { loc, halstead } = def.complexity;
          const volume = halstead ? halstead.volume : 0;
          const commentRatio = loc?.loc > 0 ? loc.commentLines / loc.loc : 0;
          def.complexity.maintainabilityIndex = computeMaintainabilityIndex(
            volume,
            cfgResult.cyclomatic,
            loc?.sloc ?? 0,
            commentRatio,
          );
        }
      }
    }
  }
}

// ─── Build delegation ───────────────────────────────────────────────────

async function delegateToBuildFunctions(db, fileSymbols, rootDir, opts, engineOpts, timing) {
  if (opts.ast !== false) {
    const t0 = performance.now();
    try {
      const { buildAstNodes } = await import('../features/ast.js');
      await buildAstNodes(db, fileSymbols, rootDir, engineOpts);
    } catch (err) {
      debug(`buildAstNodes failed: ${err.message}`);
    }
    timing.astMs = performance.now() - t0;
  }

  if (opts.complexity !== false) {
    const t0 = performance.now();
    try {
      const { buildComplexityMetrics } = await import('../features/complexity.js');
      await buildComplexityMetrics(db, fileSymbols, rootDir, engineOpts);
    } catch (err) {
      debug(`buildComplexityMetrics failed: ${err.message}`);
    }
    timing.complexityMs = performance.now() - t0;
  }

  if (opts.cfg !== false) {
    const t0 = performance.now();
    try {
      const { buildCFGData } = await import('../features/cfg.js');
      await buildCFGData(db, fileSymbols, rootDir, engineOpts);
    } catch (err) {
      debug(`buildCFGData failed: ${err.message}`);
    }
    timing.cfgMs = performance.now() - t0;
  }

  if (opts.dataflow !== false) {
    const t0 = performance.now();
    try {
      const { buildDataflowEdges } = await import('../features/dataflow.js');
      await buildDataflowEdges(db, fileSymbols, rootDir, engineOpts);
    } catch (err) {
      debug(`buildDataflowEdges failed: ${err.message}`);
    }
    timing.dataflowMs = performance.now() - t0;
  }
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
export async function runAnalyses(db, fileSymbols, rootDir, opts, engineOpts) {
  const timing = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };

  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  if (!doAst && !doComplexity && !doCfg && !doDataflow) return timing;

  const extToLang = buildExtToLangMap();

  // WASM pre-parse for files that need it
  await ensureWasmTreesIfNeeded(fileSymbols, opts);

  // Unified pre-walk: run all applicable visitors in a single DFS per file
  const t0walk = performance.now();

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) continue;

    const ext = path.extname(relPath).toLowerCase();
    const langId = symbols._langId || extToLang.get(ext);
    if (!langId) continue;

    const { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor } =
      setupVisitors(db, relPath, symbols, langId, opts);

    if (visitors.length === 0) continue;

    const results = walkWithVisitors(symbols._tree.rootNode, visitors, langId, walkerOpts);
    const defs = symbols.definitions || [];

    if (astVisitor) {
      const astRows = results['ast-store'] || [];
      if (astRows.length > 0) symbols.astNodes = astRows;
    }

    if (complexityVisitor) storeComplexityResults(results, defs, langId);
    if (cfgVisitor) storeCfgResults(results, defs);
    if (dataflowVisitor) symbols.dataflow = results.dataflow;
  }

  timing._unifiedWalkMs = performance.now() - t0walk;

  // Delegate to buildXxx functions for DB writes + native fallback
  await delegateToBuildFunctions(db, fileSymbols, rootDir, opts, engineOpts, timing);

  return timing;
}
