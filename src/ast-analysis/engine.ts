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
import type {
  AnalysisOpts,
  AnalysisTiming,
  ASTNodeRow,
  BetterSqlite3Database,
  CfgBlock,
  CfgEdge,
  DataflowResult,
  Definition,
  EngineOpts,
  ExtractorOutput,
  TreeSitterNode,
  Visitor,
  WalkOptions,
  WalkResults,
} from '../types.js';
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

// ─── Visitor result shapes (internal, not exported) ──────────────────────

interface ComplexityFuncResult {
  funcNode: TreeSitterNode;
  funcName: string | null;
  metrics: {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    halstead?: { volume: number; difficulty: number; effort: number; bugs: number };
  };
}

interface CfgFuncResult {
  funcNode: TreeSitterNode;
  blocks: CfgBlock[];
  edges: CfgEdge[];
  cyclomatic?: number;
}

interface SetupResult {
  visitors: Visitor[];
  walkerOpts: WalkOptions;
  astVisitor: Visitor | null;
  complexityVisitor: Visitor | null;
  cfgVisitor: Visitor | null;
  dataflowVisitor: Visitor | null;
}

// ─── Extension sets for quick language-support checks ────────────────────

const CFG_EXTENSIONS = buildExtensionSet(CFG_RULES);
const COMPLEXITY_EXTENSIONS = buildExtensionSet(COMPLEXITY_RULES);
const DATAFLOW_EXTENSIONS = buildExtensionSet(DATAFLOW_RULES);
const WALK_EXTENSIONS = buildExtensionSet(AST_TYPE_MAPS);

// ─── Lazy imports (heavy modules loaded only when needed) ────────────────

let _parserModule: Awaited<typeof import('../domain/parser.js')> | null = null;
async function getParserModule(): Promise<typeof import('../domain/parser.js')> {
  if (!_parserModule) _parserModule = await import('../domain/parser.js');
  return _parserModule;
}

// ─── WASM pre-parse ─────────────────────────────────────────────────────

async function ensureWasmTreesIfNeeded(
  fileSymbols: Map<string, ExtractorOutput>,
  opts: AnalysisOpts,
  rootDir: string,
): Promise<void> {
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
      await ensureWasmTrees(fileSymbols, rootDir);
    } catch (err: unknown) {
      debug(`ensureWasmTrees failed: ${(err as Error).message}`);
    }
  }
}

// ─── Per-file visitor setup ─────────────────────────────────────────────

function setupVisitors(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
  langId: string,
  opts: AnalysisOpts,
): SetupResult {
  const ext = path.extname(relPath).toLowerCase();
  const defs = symbols.definitions || [];
  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  const visitors: Visitor[] = [];
  const walkerOpts: WalkOptions = {
    functionNodeTypes: new Set<string>(),
    nestingNodeTypes: new Set<string>(),
    getFunctionName: (_node: TreeSitterNode) => null,
  };

  // AST-store visitor
  let astVisitor: Visitor | null = null;
  const astTypeMap = AST_TYPE_MAPS.get(langId);
  if (doAst && astTypeMap && WALK_EXTENSIONS.has(ext) && !symbols.astNodes?.length) {
    const nodeIdMap = new Map<string, number>();
    for (const row of bulkNodeIdsByFile(db, relPath)) {
      nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
    }
    astVisitor = createAstStoreVisitor(astTypeMap, defs, relPath, nodeIdMap);
    visitors.push(astVisitor);
  }

  // Complexity visitor (file-level mode)
  let complexityVisitor: Visitor | null = null;
  const cRules = COMPLEXITY_RULES.get(langId);
  const hRules = HALSTEAD_RULES.get(langId);
  if (doComplexity && cRules) {
    const needsWasmComplexity = defs.some(
      (d) => (d.kind === 'function' || d.kind === 'method') && d.line && !d.complexity,
    );
    if (needsWasmComplexity) {
      complexityVisitor = createComplexityVisitor(cRules, hRules, { fileLevelWalk: true, langId });
      visitors.push(complexityVisitor);

      for (const t of cRules.nestingNodes) walkerOpts.nestingNodeTypes?.add(t);

      const dfRules = DATAFLOW_RULES.get(langId);
      walkerOpts.getFunctionName = (node: TreeSitterNode): string | null => {
        const nameNode = node.childForFieldName('name');
        if (nameNode) return nameNode.text;
        // biome-ignore lint/suspicious/noExplicitAny: DataflowRulesConfig is structurally compatible at runtime
        if (dfRules) return getFuncName(node, dfRules as any);
        return null;
      };
    }
  }

  // CFG visitor
  let cfgVisitor: Visitor | null = null;
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
  let dataflowVisitor: Visitor | null = null;
  const dfRules = DATAFLOW_RULES.get(langId);
  if (doDataflow && dfRules && DATAFLOW_EXTENSIONS.has(ext) && !symbols.dataflow) {
    dataflowVisitor = createDataflowVisitor(dfRules);
    visitors.push(dataflowVisitor);
  }

  return { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor };
}

// ─── Result storage helpers ─────────────────────────────────────────────

function storeComplexityResults(results: WalkResults, defs: Definition[], langId: string): void {
  // biome-ignore lint/complexity/useLiteralKeys: bracket notation required by noPropertyAccessFromIndexSignature
  const complexityResults = (results['complexity'] || []) as ComplexityFuncResult[];
  const resultByLine = new Map<number, ComplexityFuncResult[]>();
  for (const r of complexityResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!resultByLine.has(line)) resultByLine.set(line, []);
      resultByLine.get(line)?.push(r);
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

function storeCfgResults(results: WalkResults, defs: Definition[]): void {
  // biome-ignore lint/complexity/useLiteralKeys: bracket notation required by noPropertyAccessFromIndexSignature
  const cfgResults = (results['cfg'] || []) as CfgFuncResult[];
  const cfgByLine = new Map<number, CfgFuncResult[]>();
  for (const r of cfgResults) {
    if (r.funcNode) {
      const line = r.funcNode.startPosition.row + 1;
      if (!cfgByLine.has(line)) cfgByLine.set(line, []);
      cfgByLine.get(line)?.push(r);
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
          const commentRatio = loc && loc.loc > 0 ? loc.commentLines / loc.loc : 0;
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

async function delegateToBuildFunctions(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, ExtractorOutput>,
  rootDir: string,
  opts: AnalysisOpts,
  engineOpts: EngineOpts | undefined,
  timing: AnalysisTiming,
): Promise<void> {
  if (opts.ast !== false) {
    const t0 = performance.now();
    try {
      const { buildAstNodes } = await import('../features/ast.js');
      // biome-ignore lint/suspicious/noExplicitAny: ExtractorOutput is a superset of the local FileSymbols expected by buildAstNodes
      await buildAstNodes(db, fileSymbols as Map<string, any>, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildAstNodes failed: ${(err as Error).message}`);
    }
    timing.astMs = performance.now() - t0;
  }

  if (opts.complexity !== false) {
    const t0 = performance.now();
    try {
      const { buildComplexityMetrics } = await import('../features/complexity.js');
      // biome-ignore lint/suspicious/noExplicitAny: ExtractorOutput is a superset of the local FileSymbols expected by buildComplexityMetrics
      await buildComplexityMetrics(db, fileSymbols as Map<string, any>, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildComplexityMetrics failed: ${(err as Error).message}`);
    }
    timing.complexityMs = performance.now() - t0;
  }

  if (opts.cfg !== false) {
    const t0 = performance.now();
    try {
      const { buildCFGData } = await import('../features/cfg.js');
      await buildCFGData(db, fileSymbols, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildCFGData failed: ${(err as Error).message}`);
    }
    timing.cfgMs = performance.now() - t0;
  }

  if (opts.dataflow !== false) {
    const t0 = performance.now();
    try {
      const { buildDataflowEdges } = await import('../features/dataflow.js');
      await buildDataflowEdges(db, fileSymbols, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildDataflowEdges failed: ${(err as Error).message}`);
    }
    timing.dataflowMs = performance.now() - t0;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function runAnalyses(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, ExtractorOutput>,
  rootDir: string,
  opts: AnalysisOpts,
  engineOpts?: EngineOpts,
): Promise<AnalysisTiming> {
  const timing: AnalysisTiming = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };

  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  if (!doAst && !doComplexity && !doCfg && !doDataflow) return timing;

  const extToLang = buildExtToLangMap();

  // WASM pre-parse for files that need it
  await ensureWasmTreesIfNeeded(fileSymbols, opts, rootDir);

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
      const astRows = (results['ast-store'] || []) as ASTNodeRow[];
      if (astRows.length > 0) symbols.astNodes = astRows;
    }

    if (complexityVisitor) storeComplexityResults(results, defs, langId);
    if (cfgVisitor) storeCfgResults(results, defs);
    // biome-ignore lint/complexity/useLiteralKeys: bracket notation required by noPropertyAccessFromIndexSignature
    if (dataflowVisitor) symbols.dataflow = results['dataflow'] as DataflowResult;
  }

  timing._unifiedWalkMs = performance.now() - t0walk;

  // Delegate to buildXxx functions for DB writes + native fallback
  await delegateToBuildFunctions(db, fileSymbols, rootDir, opts, engineOpts, timing);

  return timing;
}
