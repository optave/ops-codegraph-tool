import fs from 'node:fs';
import path from 'node:path';
import {
  computeLOCMetrics as _computeLOCMetrics,
  computeMaintainabilityIndex as _computeMaintainabilityIndex,
} from '../ast-analysis/metrics.js';
import { COMPLEXITY_RULES, HALSTEAD_RULES } from '../ast-analysis/rules/index.js';
import {
  findFunctionNode as _findFunctionNode,
  buildExtensionSet,
  buildExtToLangMap,
} from '../ast-analysis/shared.js';
import { walkWithVisitors } from '../ast-analysis/visitor.js';
import { createComplexityVisitor } from '../ast-analysis/visitors/complexity-visitor.js';
import { getFunctionNodeId } from '../db/index.js';
import { debug, info } from '../infrastructure/logger.js';
import type {
  BetterSqlite3Database,
  ComplexityRules,
  HalsteadDerivedMetrics,
  HalsteadRules,
  LOCMetrics,
  TreeSitterNode,
} from '../types.js';

// Re-export rules for backward compatibility
export { COMPLEXITY_RULES, HALSTEAD_RULES };

// Extensions whose language has complexity rules — used to skip needless WASM init
const COMPLEXITY_EXTENSIONS = buildExtensionSet(COMPLEXITY_RULES);

// ─── Halstead Metrics Computation ─────────────────────────────────────────

export function computeHalsteadMetrics(
  functionNode: TreeSitterNode,
  language: string,
): HalsteadDerivedMetrics | null {
  const rules = HALSTEAD_RULES.get(language) as HalsteadRules | undefined;
  if (!rules) return null;

  const operators = new Map<string, number>(); // type -> count
  const operands = new Map<string, number>(); // text -> count

  function walk(node: TreeSitterNode | null): void {
    if (!node) return;

    // Skip type annotation subtrees
    if (rules?.skipTypes.has(node.type)) return;

    // Compound operators (non-leaf): count the node type as an operator
    if (rules?.compoundOperators.has(node.type)) {
      operators.set(node.type, (operators.get(node.type) || 0) + 1);
    }

    // Leaf nodes: classify as operator or operand
    if (node.childCount === 0) {
      if (rules?.operatorLeafTypes.has(node.type)) {
        operators.set(node.type, (operators.get(node.type) || 0) + 1);
      } else if (rules?.operandLeafTypes.has(node.type)) {
        const text = node.text;
        operands.set(text, (operands.get(text) || 0) + 1);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(functionNode);

  const n1 = operators.size; // distinct operators
  const n2 = operands.size; // distinct operands
  let bigN1 = 0; // total operators
  for (const c of operators.values()) bigN1 += c;
  let bigN2 = 0; // total operands
  for (const c of operands.values()) bigN2 += c;

  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;

  // Guard against zero
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (bigN2 / n2) : 0;
  const effort = difficulty * volume;
  const bugs = volume / 3000;

  return {
    n1,
    n2,
    bigN1,
    bigN2,
    vocabulary,
    length,
    volume: +volume.toFixed(2),
    difficulty: +difficulty.toFixed(2),
    effort: +effort.toFixed(2),
    bugs: +bugs.toFixed(4),
  };
}

// ─── LOC Metrics Computation ──────────────────────────────────────────────
// Delegated to ast-analysis/metrics.js; re-exported for backward compatibility.
export const computeLOCMetrics = _computeLOCMetrics;

// ─── Maintainability Index ────────────────────────────────────────────────
// Delegated to ast-analysis/metrics.js; re-exported for backward compatibility.
export const computeMaintainabilityIndex = _computeMaintainabilityIndex;

// ─── Algorithm: Single-Traversal DFS ──────────────────────────────────────

export function computeFunctionComplexity(
  functionNode: TreeSitterNode,
  language: string,
): { cognitive: number; cyclomatic: number; maxNesting: number } | null {
  const rules = COMPLEXITY_RULES.get(language) as ComplexityRules | undefined;
  if (!rules) return null;

  let cognitive = 0;
  let cyclomatic = 1; // McCabe starts at 1
  let maxNesting = 0;

  function walk(node: TreeSitterNode | null, nestingLevel: number, isTopFunction: boolean): void {
    if (!node) return;

    const type = node.type;

    // Track nesting depth
    if (nestingLevel > maxNesting) maxNesting = nestingLevel;

    // Handle logical operators in binary expressions
    if (type === rules?.logicalNodeType) {
      const op = node.child(1)?.type;
      if (op && rules?.logicalOperators.has(op)) {
        // Cyclomatic: +1 for every logical operator
        cyclomatic++;

        // Cognitive: +1 only when operator changes from the previous sibling sequence
        // Walk up to check if parent is same type with same operator
        const parent = node.parent;
        let sameSequence = false;
        if (parent && parent.type === rules?.logicalNodeType) {
          const parentOp = parent.child(1)?.type;
          if (parentOp === op) {
            sameSequence = true;
          }
        }
        if (!sameSequence) {
          cognitive++;
        }

        // Walk children manually to avoid double-counting
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }
    }

    // Handle optional chaining (cyclomatic only)
    if (type === rules?.optionalChainType) {
      cyclomatic++;
    }

    // Handle branch/control flow nodes (skip keyword leaf tokens like Ruby's `if`)
    if (rules?.branchNodes.has(type) && node.childCount > 0) {
      // Pattern A: else clause wraps if (JS/C#/Rust)
      if (rules?.elseNodeType && type === rules?.elseNodeType) {
        const firstChild = node.namedChild(0);
        if (firstChild && firstChild.type === rules?.ifNodeType) {
          // else-if: the if_statement child handles its own increment
          for (let i = 0; i < node.childCount; i++) {
            walk(node.child(i), nestingLevel, false);
          }
          return;
        }
        // Plain else
        cognitive++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      // Pattern B: explicit elif node (Python/Ruby/PHP)
      if (rules?.elifNodeType && type === rules?.elifNodeType) {
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      // Detect else-if via Pattern A or C
      let isElseIf = false;
      if (type === rules?.ifNodeType) {
        if (rules?.elseViaAlternative) {
          // Pattern C (Go/Java): if_statement is the alternative of parent if_statement
          isElseIf =
            node.parent?.type === rules?.ifNodeType &&
            node.parent.childForFieldName('alternative')?.id === node.id;
        } else if (rules?.elseNodeType) {
          // Pattern A (JS/C#/Rust): if_statement inside else_clause
          isElseIf = node.parent?.type === rules?.elseNodeType;
        }
      }

      if (isElseIf) {
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      // Regular branch node
      cognitive += 1 + nestingLevel; // structural + nesting
      cyclomatic++;

      // Switch-like nodes don't add cyclomatic themselves (cases do)
      if (rules?.switchLikeNodes?.has(type)) {
        cyclomatic--; // Undo the ++ above; cases handle cyclomatic
      }

      if (rules?.nestingNodes.has(type)) {
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel + 1, false);
        }
        return;
      }
    }

    // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
    if (
      rules?.elseViaAlternative &&
      type !== rules?.ifNodeType &&
      node.parent?.type === rules?.ifNodeType &&
      node.parent.childForFieldName('alternative')?.id === node.id
    ) {
      cognitive++;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel, false);
      }
      return;
    }

    // Handle case nodes (cyclomatic only, skip keyword leaves)
    if (rules?.caseNodes.has(type) && node.childCount > 0) {
      cyclomatic++;
    }

    // Handle nested function definitions (increase nesting)
    if (!isTopFunction && rules?.functionNodes.has(type)) {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel + 1, false);
      }
      return;
    }

    // Walk children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), nestingLevel, false);
    }
  }

  walk(functionNode, 0, true);

  return { cognitive, cyclomatic, maxNesting };
}

// ─── Merged Single-Pass Computation ───────────────────────────────────────

interface AllMetricsResult {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  halstead: HalsteadDerivedMetrics | null;
  loc: LOCMetrics;
  mi: number;
}

export function computeAllMetrics(
  functionNode: TreeSitterNode,
  langId: string,
): AllMetricsResult | null {
  const cRules = COMPLEXITY_RULES.get(langId);
  if (!cRules) return null;
  const hRules = HALSTEAD_RULES.get(langId);

  const visitor = createComplexityVisitor(cRules, hRules, { langId });

  const nestingNodes = new Set((cRules as ComplexityRules).nestingNodes);
  // NOTE: do NOT add functionNodes here — in function-level mode the walker
  // walks a single function node, and adding it to nestingNodeTypes would
  // inflate context.nestingLevel by +1 for the entire body.

  const results = walkWithVisitors(functionNode, [visitor], langId, {
    nestingNodeTypes: nestingNodes,
  });

  const rawResult = results.complexity as {
    cognitive: number;
    cyclomatic: number;
    maxNesting: number;
    halstead: HalsteadDerivedMetrics | null;
  };

  // The visitor's finish() in function-level mode returns the raw metrics
  // but without LOC (needs the functionNode text). Compute LOC + MI here.
  const loc = _computeLOCMetrics(functionNode, langId);
  const volume = rawResult.halstead ? rawResult.halstead.volume : 0;
  const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  const mi = _computeMaintainabilityIndex(volume, rawResult.cyclomatic, loc.sloc, commentRatio);

  return {
    cognitive: rawResult.cognitive,
    cyclomatic: rawResult.cyclomatic,
    maxNesting: rawResult.maxNesting,
    halstead: rawResult.halstead,
    loc,
    mi,
  };
}

// ─── Build-Time: Compute Metrics for Changed Files ────────────────────────

export { _findFunctionNode as findFunctionNode };

interface FileSymbols {
  _tree?: { rootNode: TreeSitterNode } | null;
  _langId?: string | null;
  definitions: Array<{
    name: string;
    kind: string;
    line: number;
    endLine?: number;
    complexity?: {
      cognitive: number;
      cyclomatic: number;
      maxNesting?: number;
      maintainabilityIndex?: number;
      halstead?: HalsteadDerivedMetrics | null;
      loc?: LOCMetrics | null;
    };
  }>;
}

async function initWasmParsersIfNeeded(
  fileSymbols: Map<string, FileSymbols>,
): Promise<{ parsers: unknown; extToLang: Map<string, string> | null }> {
  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (!COMPLEXITY_EXTENSIONS.has(ext)) continue;
      // Only consider definitions with real function bodies (non-dotted names,
      // multi-line span). Interface/type property signatures are extracted as
      // methods but correctly lack complexity data from the native engine.
      const hasPrecomputed = symbols.definitions.every(
        (d) =>
          (d.kind !== 'function' && d.kind !== 'method') ||
          d.complexity ||
          d.name.includes('.') ||
          !d.endLine ||
          d.endLine <= d.line,
      );
      if (!hasPrecomputed) {
        const { createParsers } = await import('../domain/parser.js');
        const parsers = await createParsers();
        const extToLang = buildExtToLangMap();
        return { parsers, extToLang };
      }
    }
  }
  return { parsers: null, extToLang: null };
}

function getTreeForFile(
  symbols: FileSymbols,
  relPath: string,
  rootDir: string,
  parsers: unknown,
  extToLang: Map<string, string> | null,
  getParser: (parsers: any, absPath: string) => any,
): { tree: { rootNode: TreeSitterNode }; langId: string } | null {
  let tree = symbols._tree;
  let langId = symbols._langId;

  const allPrecomputed = symbols.definitions.every(
    (d) => (d.kind !== 'function' && d.kind !== 'method') || d.complexity,
  );

  if (!allPrecomputed && !tree) {
    const ext = path.extname(relPath).toLowerCase();
    if (!COMPLEXITY_EXTENSIONS.has(ext)) return null;
    if (!extToLang) return null;
    langId = extToLang.get(ext);
    if (!langId) return null;

    const absPath = path.join(rootDir, relPath);
    let code: string;
    try {
      code = fs.readFileSync(absPath, 'utf-8');
    } catch (e: unknown) {
      debug(`complexity: cannot read ${relPath}: ${(e as Error).message}`);
      return null;
    }

    const parser = getParser(parsers, absPath);
    if (!parser) return null;

    try {
      tree = parser.parse(code);
    } catch (e: unknown) {
      debug(`complexity: parse failed for ${relPath}: ${(e as Error).message}`);
      return null;
    }
  }

  return tree && langId ? { tree: tree as { rootNode: TreeSitterNode }, langId } : null;
}

function upsertPrecomputedComplexity(
  db: BetterSqlite3Database,
  upsert: { run(...params: unknown[]): unknown },
  def: FileSymbols['definitions'][0],
  relPath: string,
): number {
  const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
  if (!nodeId) return 0;
  const ch = def.complexity?.halstead;
  const cl = def.complexity?.loc;
  upsert.run(
    nodeId,
    def.complexity?.cognitive,
    def.complexity?.cyclomatic,
    def.complexity?.maxNesting ?? 0,
    cl ? cl.loc : 0,
    cl ? cl.sloc : 0,
    cl ? cl.commentLines : 0,
    ch ? ch.n1 : 0,
    ch ? ch.n2 : 0,
    ch ? ch.bigN1 : 0,
    ch ? ch.bigN2 : 0,
    ch ? ch.vocabulary : 0,
    ch ? ch.length : 0,
    ch ? ch.volume : 0,
    ch ? ch.difficulty : 0,
    ch ? ch.effort : 0,
    ch ? ch.bugs : 0,
    def.complexity?.maintainabilityIndex ?? 0,
  );
  return 1;
}

function upsertAstComplexity(
  db: BetterSqlite3Database,
  upsert: { run(...params: unknown[]): unknown },
  def: FileSymbols['definitions'][0],
  relPath: string,
  tree: { rootNode: TreeSitterNode } | null,
  langId: string | null | undefined,
  rules: ComplexityRules | undefined,
): number {
  if (!tree || !rules || !langId) return 0;

  const funcNode = _findFunctionNode(tree.rootNode, def.line, def.endLine ?? def.line, rules);
  if (!funcNode) return 0;

  const metrics = computeAllMetrics(funcNode, langId);
  if (!metrics) return 0;

  const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
  if (!nodeId) return 0;

  const h = metrics.halstead;
  upsert.run(
    nodeId,
    metrics.cognitive,
    metrics.cyclomatic,
    metrics.maxNesting,
    metrics.loc.loc,
    metrics.loc.sloc,
    metrics.loc.commentLines,
    h ? h.n1 : 0,
    h ? h.n2 : 0,
    h ? h.bigN1 : 0,
    h ? h.bigN2 : 0,
    h ? h.vocabulary : 0,
    h ? h.length : 0,
    h ? h.volume : 0,
    h ? h.difficulty : 0,
    h ? h.effort : 0,
    h ? h.bugs : 0,
    metrics.mi,
  );
  return 1;
}

export async function buildComplexityMetrics(
  db: BetterSqlite3Database,
  fileSymbols: Map<string, FileSymbols>,
  rootDir: string,
  engineOpts?: {
    nativeDb?: { bulkInsertComplexity?(rows: Array<Record<string, unknown>>): number };
    suspendJsDb?: () => void;
    resumeJsDb?: () => void;
  },
): Promise<void> {
  // ── Native bulk-insert fast path ──────────────────────────────────────
  const nativeDb = engineOpts?.nativeDb;
  if (nativeDb?.bulkInsertComplexity) {
    const rows: Array<Record<string, unknown>> = [];
    let needsJsFallback = false;

    for (const [relPath, symbols] of fileSymbols) {
      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;
        if (!def.complexity) {
          needsJsFallback = true;
          break;
        }
        const nodeId = getFunctionNodeId(db, def.name, relPath, def.line);
        if (!nodeId) continue;
        const ch = def.complexity.halstead;
        const cl = def.complexity.loc;
        rows.push({
          nodeId,
          cognitive: def.complexity.cognitive ?? 0,
          cyclomatic: def.complexity.cyclomatic ?? 0,
          maxNesting: def.complexity.maxNesting ?? 0,
          loc: cl ? cl.loc : 0,
          sloc: cl ? cl.sloc : 0,
          commentLines: cl ? cl.commentLines : 0,
          halsteadN1: ch ? ch.n1 : 0,
          halsteadN2: ch ? ch.n2 : 0,
          halsteadBigN1: ch ? ch.bigN1 : 0,
          halsteadBigN2: ch ? ch.bigN2 : 0,
          halsteadVocabulary: ch ? ch.vocabulary : 0,
          halsteadLength: ch ? ch.length : 0,
          halsteadVolume: ch ? ch.volume : 0,
          halsteadDifficulty: ch ? ch.difficulty : 0,
          halsteadEffort: ch ? ch.effort : 0,
          halsteadBugs: ch ? ch.bugs : 0,
          maintainabilityIndex: def.complexity.maintainabilityIndex ?? 0,
        });
      }
      if (needsJsFallback) break;
    }

    if (!needsJsFallback && rows.length > 0) {
      let inserted: number;
      try {
        engineOpts?.suspendJsDb?.();
        inserted = nativeDb.bulkInsertComplexity(rows);
      } finally {
        engineOpts?.resumeJsDb?.();
      }
      if (inserted === rows.length) {
        info(`Complexity (native bulk): ${inserted} functions analyzed`);
        return;
      }
      debug(`Native bulkInsertComplexity partial: ${inserted}/${rows.length} — falling back to JS`);
    }
  }

  // ── JS fallback path ─────────────────────────────────────────────────
  const { parsers, extToLang } = await initWasmParsersIfNeeded(fileSymbols);
  const { getParser } = await import('../domain/parser.js');

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO function_complexity
     (node_id, cognitive, cyclomatic, max_nesting,
      loc, sloc, comment_lines,
      halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2,
      halstead_vocabulary, halstead_length, halstead_volume,
      halstead_difficulty, halstead_effort, halstead_bugs,
      maintainability_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const result = getTreeForFile(symbols, relPath, rootDir, parsers, extToLang, getParser);
      const tree = result ? result.tree : null;
      const langId = result ? result.langId : null;

      const rules = langId
        ? (COMPLEXITY_RULES.get(langId) as ComplexityRules | undefined)
        : undefined;

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        if (def.complexity) {
          analyzed += upsertPrecomputedComplexity(db, upsert, def, relPath);
        } else {
          analyzed += upsertAstComplexity(db, upsert, def, relPath, tree, langId, rules);
        }
      }
    }
  });

  tx();

  if (analyzed > 0) {
    info(`Complexity: ${analyzed} functions analyzed`);
  }
}

// ─── Query-Time Functions (re-exported from complexity-query.ts) ──────────
// Split to separate query-time concerns (DB reads, filtering, pagination)
// from compute-time concerns (AST traversal, metric algorithms).
export { complexityData, iterComplexity } from './complexity-query.js';
