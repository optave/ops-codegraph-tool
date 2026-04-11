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

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { bulkNodeIdsByFile } from '../db/index.js';
import { debug } from '../infrastructure/logger.js';
import { loadNative } from '../infrastructure/native.js';
import { toErrorMessage } from '../shared/errors.js';
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
  NativeAddon,
  NativeFunctionCfgResult,
  NativeFunctionComplexityResult,
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

// ─── Native standalone analysis ─────────────────────────────────────────

interface NativeAnalysisNeeds {
  complexity: boolean;
  cfg: boolean;
  dataflow: boolean;
}

/**
 * Try native Rust analysis for files missing complexity/CFG/dataflow data.
 * Reads source from disk, calls the native standalone functions, and stores
 * results directly on definitions/symbols.
 */

/** Determine which native analyses a file still needs. */
function detectNativeNeeds(
  symbols: ExtractorOutput,
  ext: string,
  langId: string,
  opts: { doComplexity: boolean; doCfg: boolean; doDataflow: boolean },
): NativeAnalysisNeeds {
  const defs = symbols.definitions || [];
  const langSupportsComplexity = COMPLEXITY_EXTENSIONS.has(ext) || COMPLEXITY_RULES.has(langId);
  const langSupportsCfg = CFG_EXTENSIONS.has(ext) || CFG_RULES.has(langId);
  const langSupportsDataflow = DATAFLOW_EXTENSIONS.has(ext) || DATAFLOW_RULES.has(langId);

  return {
    complexity:
      opts.doComplexity &&
      langSupportsComplexity &&
      defs.some((d) => hasFuncBody(d) && !d.complexity),
    cfg:
      opts.doCfg &&
      langSupportsCfg &&
      defs.some((d) => hasFuncBody(d) && d.cfg !== null && !Array.isArray(d.cfg?.blocks)),
    dataflow: opts.doDataflow && !symbols.dataflow && langSupportsDataflow,
  };
}

/** Run native analysis passes for a single file. */
function runNativeFileAnalysis(
  native: NativeAddon,
  source: string,
  absPath: string,
  relPath: string,
  langId: string,
  symbols: ExtractorOutput,
  needs: NativeAnalysisNeeds,
): void {
  const defs = symbols.definitions || [];

  if (needs.complexity && native.analyzeComplexity) {
    try {
      const results = native.analyzeComplexity(source, absPath, langId);
      storeNativeComplexityResults(results, defs);
    } catch (err: unknown) {
      debug(`native analyzeComplexity failed for ${relPath}: ${toErrorMessage(err)}`);
    }
  }

  if (needs.cfg && native.buildCfgAnalysis) {
    try {
      const results = native.buildCfgAnalysis(source, absPath, langId);
      storeNativeCfgResults(results, defs);
    } catch (err: unknown) {
      debug(`native buildCfgAnalysis failed for ${relPath}: ${toErrorMessage(err)}`);
    }
  }

  if (needs.dataflow && native.extractDataflowAnalysis) {
    try {
      const result = native.extractDataflowAnalysis(source, absPath, langId);
      if (result) symbols.dataflow = result;
    } catch (err: unknown) {
      debug(`native extractDataflowAnalysis failed for ${relPath}: ${toErrorMessage(err)}`);
    }
  }
}

function runNativeAnalysis(
  native: NativeAddon,
  fileSymbols: Map<string, ExtractorOutput>,
  rootDir: string,
  opts: AnalysisOpts,
  extToLang: Map<string, string>,
): void {
  const optsFlags = {
    doComplexity: opts.complexity !== false,
    doCfg: opts.cfg !== false,
    doDataflow: opts.dataflow !== false,
  };

  for (const [relPath, symbols] of fileSymbols) {
    if (symbols._tree) continue;
    const ext = path.extname(relPath).toLowerCase();
    const langId = symbols._langId || extToLang.get(ext);
    if (!langId) continue;

    const needs = detectNativeNeeds(symbols, ext, langId, optsFlags);
    if (!needs.complexity && !needs.cfg && !needs.dataflow) continue;

    const absPath = path.join(rootDir, relPath);
    let source: string;
    try {
      source = fs.readFileSync(absPath, 'utf-8');
    } catch (e) {
      debug(`runNativeAnalysis: failed to read ${relPath}: ${toErrorMessage(e)}`);
      continue;
    }

    runNativeFileAnalysis(native, source, absPath, relPath, langId, symbols, needs);
  }
}

/** Index native results by line number and match to a definition by name. */
function indexNativeByLine<T extends { line: number; name: string }>(
  results: T[],
): Map<number, T[]> {
  const byLine = new Map<number, T[]>();
  for (const r of results) {
    if (!byLine.has(r.line)) byLine.set(r.line, []);
    byLine.get(r.line)!.push(r);
  }
  return byLine;
}

function matchNativeResult<T extends { name: string }>(
  candidates: T[] | undefined,
  defName: string,
): T | undefined {
  if (!candidates) return undefined;
  if (candidates.length === 1) return candidates[0];
  return candidates.find((r) => r.name === defName) ?? candidates[0];
}

/** Store native complexity results on definitions, matched by line number. */
function storeNativeComplexityResults(
  results: NativeFunctionComplexityResult[],
  defs: Definition[],
): void {
  const byLine = indexNativeByLine(results);

  for (const def of defs) {
    if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
      const match = matchNativeResult(byLine.get(def.line), def.name);
      if (!match) continue;
      const { complexity: c } = match;
      def.complexity = {
        cognitive: c.cognitive,
        cyclomatic: c.cyclomatic,
        maxNesting: c.maxNesting,
        halstead: c.halstead
          ? {
              n1: c.halstead.n1,
              n2: c.halstead.n2,
              bigN1: c.halstead.bigN1,
              bigN2: c.halstead.bigN2,
              vocabulary: c.halstead.vocabulary,
              length: c.halstead.length,
              volume: c.halstead.volume,
              difficulty: c.halstead.difficulty,
              effort: c.halstead.effort,
              bugs: c.halstead.bugs,
            }
          : undefined,
        loc: c.loc
          ? { loc: c.loc.loc, sloc: c.loc.sloc, commentLines: c.loc.commentLines }
          : undefined,
        maintainabilityIndex: c.maintainabilityIndex ?? undefined,
      };
    }
  }
}

/** Override a definition's cyclomatic complexity with a CFG-derived value and recompute MI. */
function overrideCyclomaticFromCfg(def: Definition, cfgCyclomatic: number): void {
  if (!def.complexity) return;
  if (cfgCyclomatic <= 0) {
    debug(`overrideCyclomaticFromCfg: skipping ${def.name} — cfgCyclomatic=${cfgCyclomatic}`);
    return;
  }
  def.complexity.cyclomatic = cfgCyclomatic;
  const { loc, halstead } = def.complexity;
  const volume = halstead ? halstead.volume : 0;
  const commentRatio = loc && loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  def.complexity.maintainabilityIndex = computeMaintainabilityIndex(
    volume,
    cfgCyclomatic,
    loc?.sloc ?? 0,
    commentRatio,
  );
}

/** Store native CFG results on definitions, matched by line number. */
function storeNativeCfgResults(results: NativeFunctionCfgResult[], defs: Definition[]): void {
  const byLine = indexNativeByLine(results);

  for (const def of defs) {
    if (
      (def.kind === 'function' || def.kind === 'method') &&
      def.line &&
      def.cfg !== null &&
      !def.cfg?.blocks?.length
    ) {
      const match = matchNativeResult(byLine.get(def.line), def.name);
      if (!match) continue;
      def.cfg = match.cfg;

      // Override complexity cyclomatic with CFG-derived value
      const { edges, blocks } = match.cfg;
      if (edges && blocks) {
        overrideCyclomaticFromCfg(def, edges.length - blocks.length + 2);
      }
    }
  }
}

// ─── CFG cyclomatic reconciliation ──────────────────────────────────────

/**
 * Apply CFG-derived cyclomatic override for definitions that already have both
 * `complexity` and `cfg` with blocks/edges but whose cyclomatic was never
 * overridden (e.g., native extractors provide both fields inline, so the
 * normal override path in storeNativeCfgResults / storeCfgResults is skipped).
 */
/** Type guard for cfg objects with blocks and edges arrays. */
function hasCfgBlocksAndEdges(cfg: unknown): cfg is { blocks: unknown[]; edges: unknown[] } {
  return (
    cfg != null &&
    typeof cfg === 'object' &&
    Array.isArray((cfg as { blocks?: unknown }).blocks) &&
    Array.isArray((cfg as { edges?: unknown }).edges)
  );
}

function reconcileCfgCyclomatic(fileSymbols: Map<string, ExtractorOutput>): void {
  for (const [, symbols] of fileSymbols) {
    const defs = symbols.definitions || [];
    for (const def of defs) {
      if (
        (def.kind === 'function' || def.kind === 'method') &&
        def.complexity &&
        hasCfgBlocksAndEdges(def.cfg)
      ) {
        const cfgCyclomatic = Math.max(def.cfg.edges.length - def.cfg.blocks.length + 2, 1);
        if (cfgCyclomatic !== def.complexity.cyclomatic) {
          overrideCyclomaticFromCfg(def, cfgCyclomatic);
        }
      }
    }
  }
}

// ─── WASM pre-parse ─────────────────────────────────────────────────────

/** Check whether a single file needs a WASM tree for any enabled analysis pass. */
function fileNeedsWasmTree(
  relPath: string,
  symbols: ExtractorOutput,
  flags: { doAst: boolean; doComplexity: boolean; doCfg: boolean; doDataflow: boolean },
): boolean {
  if (symbols._tree) return false;
  const ext = path.extname(relPath).toLowerCase();
  const defs = symbols.definitions || [];
  const lid = symbols._langId || '';

  if (
    flags.doAst &&
    !Array.isArray(symbols.astNodes) &&
    (WALK_EXTENSIONS.has(ext) || AST_TYPE_MAPS.has(lid))
  )
    return true;
  if (
    flags.doComplexity &&
    (COMPLEXITY_EXTENSIONS.has(ext) || COMPLEXITY_RULES.has(lid)) &&
    defs.some((d) => hasFuncBody(d) && !d.complexity)
  )
    return true;
  if (
    flags.doCfg &&
    (CFG_EXTENSIONS.has(ext) || CFG_RULES.has(lid)) &&
    defs.some((d) => hasFuncBody(d) && d.cfg !== null && !Array.isArray(d.cfg?.blocks))
  )
    return true;
  if (
    flags.doDataflow &&
    !symbols.dataflow &&
    (DATAFLOW_EXTENSIONS.has(ext) || DATAFLOW_RULES.has(lid))
  )
    return true;
  return false;
}

async function ensureWasmTreesIfNeeded(
  fileSymbols: Map<string, ExtractorOutput>,
  opts: AnalysisOpts,
  rootDir: string,
): Promise<void> {
  const flags = {
    doAst: opts.ast !== false,
    doComplexity: opts.complexity !== false,
    doCfg: opts.cfg !== false,
    doDataflow: opts.dataflow !== false,
  };

  if (!flags.doAst && !flags.doComplexity && !flags.doCfg && !flags.doDataflow) return;

  let needsWasmTrees = false;
  for (const [relPath, symbols] of fileSymbols) {
    if (fileNeedsWasmTree(relPath, symbols, flags)) {
      needsWasmTrees = true;
      break;
    }
  }

  if (needsWasmTrees) {
    try {
      const { ensureWasmTrees } = await getParserModule();
      await ensureWasmTrees(fileSymbols, rootDir);
    } catch (err: unknown) {
      debug(`ensureWasmTrees failed: ${toErrorMessage(err)}`);
    }
  }
}

// ─── Per-file visitor setup ─────────────────────────────────────────────

/** Check if a definition has a real function body (not a type signature). */
function hasFuncBody(d: {
  name: string;
  kind: string;
  line: number;
  endLine?: number | null;
}): boolean {
  return (
    (d.kind === 'function' || d.kind === 'method') &&
    d.line > 0 &&
    d.endLine != null &&
    d.endLine > d.line &&
    !d.name.includes('.')
  );
}

/** Set up AST-store visitor if applicable. */
function setupAstVisitor(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
  langId: string,
  ext: string,
): Visitor | null {
  const astTypeMap = AST_TYPE_MAPS.get(langId);
  if (!astTypeMap || !WALK_EXTENSIONS.has(ext) || Array.isArray(symbols.astNodes)) return null;
  const nodeIdMap = new Map<string, number>();
  for (const row of bulkNodeIdsByFile(db, relPath)) {
    nodeIdMap.set(`${row.name}|${row.kind}|${row.line}`, row.id);
  }
  return createAstStoreVisitor(astTypeMap, symbols.definitions || [], relPath, nodeIdMap);
}

/** Set up complexity visitor if any definitions need WASM complexity analysis. */
function setupComplexityVisitorForFile(
  defs: Definition[],
  langId: string,
  walkerOpts: WalkOptions,
): Visitor | null {
  const cRules = COMPLEXITY_RULES.get(langId);
  if (!cRules) return null;

  const hRules = HALSTEAD_RULES.get(langId);
  const needsWasmComplexity = defs.some((d) => hasFuncBody(d) && !d.complexity);
  if (!needsWasmComplexity) return null;

  const visitor = createComplexityVisitor(cRules, hRules, { fileLevelWalk: true, langId });

  for (const t of cRules.nestingNodes) walkerOpts.nestingNodeTypes?.add(t);

  const dfRules = DATAFLOW_RULES.get(langId);
  walkerOpts.getFunctionName = (node: TreeSitterNode): string | null => {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return nameNode.text;
    if (dfRules) return getFuncName(node, dfRules as any);
    return null;
  };

  return visitor;
}

/** Set up CFG visitor if any definitions need WASM CFG analysis. */
function setupCfgVisitorForFile(defs: Definition[], langId: string): Visitor | null {
  const cfgRulesForLang = CFG_RULES.get(langId);
  if (!cfgRulesForLang) return null;

  const needsWasmCfg = defs.some(
    (d) => hasFuncBody(d) && d.cfg !== null && !Array.isArray(d.cfg?.blocks),
  );
  if (!needsWasmCfg) return null;

  return createCfgVisitor(cfgRulesForLang);
}

function setupVisitors(
  db: BetterSqlite3Database,
  relPath: string,
  symbols: ExtractorOutput,
  langId: string,
  opts: AnalysisOpts,
): SetupResult {
  const ext = path.extname(relPath).toLowerCase();
  const defs = symbols.definitions || [];

  const visitors: Visitor[] = [];
  const walkerOpts: WalkOptions = {
    functionNodeTypes: new Set<string>(),
    nestingNodeTypes: new Set<string>(),
    getFunctionName: (_node: TreeSitterNode) => null,
  };

  const astVisitor = opts.ast !== false ? setupAstVisitor(db, relPath, symbols, langId, ext) : null;
  if (astVisitor) visitors.push(astVisitor);

  const complexityVisitor =
    opts.complexity !== false ? setupComplexityVisitorForFile(defs, langId, walkerOpts) : null;
  if (complexityVisitor) visitors.push(complexityVisitor);

  const cfgVisitor = opts.cfg !== false ? setupCfgVisitorForFile(defs, langId) : null;
  if (cfgVisitor) visitors.push(cfgVisitor);

  let dataflowVisitor: Visitor | null = null;
  const dfRules = DATAFLOW_RULES.get(langId);
  if (opts.dataflow !== false && dfRules && !symbols.dataflow) {
    dataflowVisitor = createDataflowVisitor(dfRules);
    visitors.push(dataflowVisitor);
  }

  return { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor };
}

// ─── Result storage helpers ─────────────────────────────────────────────

/** Index per-function results by start line for O(1) lookup. */
function indexByLine<T extends { funcNode: TreeSitterNode }>(results: T[]): Map<number, T[]> {
  const byLine = new Map<number, T[]>();
  for (const r of results) {
    if (!r.funcNode) continue;
    const line = r.funcNode.startPosition.row + 1;
    if (!byLine.has(line)) byLine.set(line, []);
    byLine.get(line)?.push(r);
  }
  return byLine;
}

/** Find the best matching result for a definition by line + name. */
function matchResultToDef<T extends { funcNode: TreeSitterNode }>(
  candidates: T[] | undefined,
  defName: string,
): T | undefined {
  if (!candidates) return undefined;
  if (candidates.length === 1) return candidates[0];
  return (
    candidates.find((r) => {
      const n = r.funcNode.childForFieldName('name');
      return n && n.text === defName;
    }) ?? candidates[0]
  );
}

function storeComplexityResults(results: WalkResults, defs: Definition[], langId: string): void {
  const byLine = indexByLine((results.complexity || []) as ComplexityFuncResult[]);
  for (const def of defs) {
    if ((def.kind === 'function' || def.kind === 'method') && def.line && !def.complexity) {
      const funcResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!funcResult) continue;
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

function storeCfgResults(results: WalkResults, defs: Definition[]): void {
  const byLine = indexByLine((results.cfg || []) as CfgFuncResult[]);
  for (const def of defs) {
    if (
      (def.kind === 'function' || def.kind === 'method') &&
      def.line &&
      !def.cfg?.blocks?.length
    ) {
      const cfgResult = matchResultToDef(byLine.get(def.line), def.name);
      if (!cfgResult) continue;
      def.cfg = { blocks: cfgResult.blocks, edges: cfgResult.edges };

      // Override complexity's cyclomatic with CFG-derived value (single source of truth)
      if (cfgResult.cyclomatic != null) {
        overrideCyclomaticFromCfg(def, cfgResult.cyclomatic);
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
      await buildAstNodes(db, fileSymbols as Map<string, any>, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildAstNodes failed: ${toErrorMessage(err)}`);
    }
    timing.astMs += performance.now() - t0;
  }

  if (opts.complexity !== false) {
    const t0 = performance.now();
    try {
      const { buildComplexityMetrics } = await import('../features/complexity.js');
      await buildComplexityMetrics(db, fileSymbols as Map<string, any>, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildComplexityMetrics failed: ${toErrorMessage(err)}`);
    }
    timing.complexityMs += performance.now() - t0;
  }

  if (opts.cfg !== false) {
    const t0 = performance.now();
    try {
      const { buildCFGData } = await import('../features/cfg.js');
      await buildCFGData(db, fileSymbols, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildCFGData failed: ${toErrorMessage(err)}`);
    }
    timing.cfgMs += performance.now() - t0;
  }

  if (opts.dataflow !== false) {
    const t0 = performance.now();
    try {
      const { buildDataflowEdges } = await import('../features/dataflow.js');
      await buildDataflowEdges(db, fileSymbols, rootDir, engineOpts);
    } catch (err: unknown) {
      debug(`buildDataflowEdges failed: ${toErrorMessage(err)}`);
    }
    timing.dataflowMs += performance.now() - t0;
  }
}

// ─── Native full-analysis fast path ────────────────────────────────────

/**
 * Check whether all files already have complete analysis data from the native
 * parse pass (parseFilesFull). When true, no WASM re-parse or JS visitor walk
 * is needed — the engine can skip directly to DB persistence.
 */
function allNativeDataComplete(
  fileSymbols: Map<string, ExtractorOutput>,
  opts: AnalysisOpts,
): boolean {
  const doAst = opts.ast !== false;
  const doComplexity = opts.complexity !== false;
  const doCfg = opts.cfg !== false;
  const doDataflow = opts.dataflow !== false;

  for (const [relPath, symbols] of fileSymbols) {
    // If any file has a WASM tree, it was parsed by WASM — not native full
    if (symbols._tree) return false;

    const ext = path.extname(relPath).toLowerCase();
    const langId = symbols._langId || '';

    // AST nodes: native must have produced them
    if (
      doAst &&
      !Array.isArray(symbols.astNodes) &&
      (WALK_EXTENSIONS.has(ext) || AST_TYPE_MAPS.has(langId))
    ) {
      debug(`allNativeDataComplete: ${relPath} missing astNodes`);
      return false;
    }

    // Dataflow: native must have produced it
    if (
      doDataflow &&
      !symbols.dataflow &&
      (DATAFLOW_EXTENSIONS.has(ext) || DATAFLOW_RULES.has(langId))
    ) {
      debug(`allNativeDataComplete: ${relPath} missing dataflow`);
      return false;
    }

    const defs = symbols.definitions || [];
    for (const def of defs) {
      if (!hasFuncBody(def)) continue;

      // Complexity: every function must already have it
      if (
        doComplexity &&
        !def.complexity &&
        (COMPLEXITY_EXTENSIONS.has(ext) || COMPLEXITY_RULES.has(langId))
      ) {
        debug(`allNativeDataComplete: ${relPath}:${def.name} missing complexity`);
        return false;
      }

      // CFG: every function must already have blocks
      if (
        doCfg &&
        def.cfg !== null &&
        !Array.isArray(def.cfg?.blocks) &&
        (CFG_EXTENSIONS.has(ext) || CFG_RULES.has(langId))
      ) {
        debug(`allNativeDataComplete: ${relPath}:${def.name} missing cfg blocks`);
        return false;
      }
    }
  }

  return fileSymbols.size > 0;
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

  // Fast path: when all files were parsed by the native engine with full analysis
  // (parseFilesFull), all data is already present — skip WASM re-parse and JS
  // visitor walks entirely, go straight to DB persistence.
  if (allNativeDataComplete(fileSymbols, opts)) {
    debug('native full-analysis fast path: all data present, skipping WASM/visitor passes');
    if (doComplexity && doCfg) reconcileCfgCyclomatic(fileSymbols);
    await delegateToBuildFunctions(db, fileSymbols, rootDir, opts, engineOpts, timing);
    return timing;
  }

  // Native analysis pass: try Rust standalone functions before WASM fallback.
  // This fills in complexity/CFG/dataflow for files that the native parse pipeline
  // missed, avoiding the need to parse with WASM + run JS visitors.
  const native = loadNative();
  if (native?.analyzeComplexity || native?.buildCfgAnalysis || native?.extractDataflowAnalysis) {
    const t0native = performance.now();
    runNativeAnalysis(native, fileSymbols, rootDir, opts, extToLang);
    debug(`native standalone analysis: ${(performance.now() - t0native).toFixed(1)}ms`);
  }

  // WASM pre-parse for files that still need it (AST store, or native gaps)
  await ensureWasmTreesIfNeeded(fileSymbols, opts, rootDir);

  // Unified pre-walk: run all applicable visitors in a single DFS per file.
  // Time each file's walk and distribute equally among active visitors
  // so that phase timers (astMs, complexityMs, etc.) reflect real work — not
  // just the DB-write tail in delegateToBuildFunctions.
  const t0walk = performance.now();

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) continue;

    const ext = path.extname(relPath).toLowerCase();
    const langId = symbols._langId || extToLang.get(ext);
    if (!langId) continue;

    const { visitors, walkerOpts, astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor } =
      setupVisitors(db, relPath, symbols, langId, opts);

    if (visitors.length === 0) continue;

    const walkStart = performance.now();
    const results = walkWithVisitors(symbols._tree.rootNode, visitors, langId, walkerOpts);
    const walkMs = performance.now() - walkStart;

    // Distribute walk time equally among active visitors
    const activeCount = [astVisitor, complexityVisitor, cfgVisitor, dataflowVisitor].filter(
      Boolean,
    ).length;
    if (activeCount > 0) {
      const share = walkMs / activeCount;
      if (astVisitor) timing.astMs += share;
      if (complexityVisitor) timing.complexityMs += share;
      if (cfgVisitor) timing.cfgMs += share;
      if (dataflowVisitor) timing.dataflowMs += share;
    }

    const defs = symbols.definitions || [];

    if (astVisitor) {
      const astRows = (results['ast-store'] || []) as ASTNodeRow[];
      if (astRows.length > 0) symbols.astNodes = astRows;
    }

    if (complexityVisitor) storeComplexityResults(results, defs, langId);
    if (cfgVisitor) storeCfgResults(results, defs);
    if (dataflowVisitor) symbols.dataflow = results.dataflow as DataflowResult;
  }

  // Total wall-clock time for the unified walk loop, including per-file
  // setupVisitors overhead. Walk time is already distributed into per-phase
  // timers above, so this field overlaps with (astMs + complexityMs + ...).
  // It is kept as a diagnostic cross-check, not an additive bucket.
  timing._unifiedWalkMs = performance.now() - t0walk;

  // Reconcile: apply CFG-derived cyclomatic override for any definitions that have
  // both precomputed complexity and CFG data but whose cyclomatic was never overridden.
  // This closes a parity gap where native extractors provide both fields inline but
  // the override step (storeNativeCfgResults / storeCfgResults) is skipped because
  // detectNativeNeeds sees both as already present.
  if (doComplexity && doCfg) {
    reconcileCfgCyclomatic(fileSymbols);
  }

  // Delegate to buildXxx functions for DB writes + native fallback
  await delegateToBuildFunctions(db, fileSymbols, rootDir, opts, engineOpts, timing);

  return timing;
}
