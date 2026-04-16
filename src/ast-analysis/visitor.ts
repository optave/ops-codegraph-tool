/**
 * Shared DFS walker with pluggable visitors for AST analysis.
 *
 * Provides a single tree traversal that multiple analysis visitors can hook into,
 * avoiding redundant walks over the same AST. Two hook styles:
 *
 *  - Node-level: enterNode / exitNode (called for every node)
 *  - Function-level: enterFunction / exitFunction (called at function boundaries)
 *
 * The walker maintains shared context (nestingLevel, scopeStack, currentFunction)
 * so individual visitors don't need to track traversal state themselves.
 */

import { debug } from '../infrastructure/logger.js';
import type {
  ScopeEntry,
  TreeSitterNode,
  Visitor,
  VisitorContext,
  WalkOptions,
  WalkResults,
} from '../types.js';

/** Merge each visitor's custom functionNodeTypes into the master set. */
function mergeFunctionNodeTypes(visitors: Visitor[], base: Set<string>): Set<string> {
  const merged = new Set(base);
  for (const v of visitors) {
    if (v.functionNodeTypes) {
      for (const t of v.functionNodeTypes) merged.add(t);
    }
  }
  return merged;
}

/** Initialize all visitors for a given language. */
function initVisitors(visitors: Visitor[], langId: string): void {
  for (const v of visitors) {
    if (v.init) v.init(langId);
  }
}

/** Check whether a visitor should be skipped at the current depth. */
function isSkipped(
  skipDepths: Map<number, number>,
  visitorIndex: number,
  currentDepth: number,
): boolean {
  const skipAt = skipDepths.get(visitorIndex);
  // Skipped if skip was requested at a shallower (or equal) depth
  // We skip descendants, not the node itself, so skip when currentDepth > skipAt
  return skipAt !== undefined && currentDepth > skipAt;
}

/** Dispatch enterFunction hooks to all non-skipped visitors. */
function dispatchEnterFunction(
  visitors: Visitor[],
  skipDepths: Map<number, number>,
  node: TreeSitterNode,
  funcName: string | null,
  context: VisitorContext,
  depth: number,
): void {
  for (let i = 0; i < visitors.length; i++) {
    const v = visitors[i]!;
    if (v.enterFunction && !isSkipped(skipDepths, i, depth)) {
      v.enterFunction(node, funcName, context);
    }
  }
}

/** Dispatch enterNode hooks and track skipChildren requests. */
function dispatchEnterNode(
  visitors: Visitor[],
  skipDepths: Map<number, number>,
  node: TreeSitterNode,
  context: VisitorContext,
  depth: number,
): void {
  for (let i = 0; i < visitors.length; i++) {
    const v = visitors[i]!;
    if (v.enterNode && !isSkipped(skipDepths, i, depth)) {
      const result = v.enterNode(node, context);
      if (result?.skipChildren) {
        skipDepths.set(i, depth);
      }
    }
  }
}

/** Dispatch exitNode hooks to all non-skipped visitors. */
function dispatchExitNode(
  visitors: Visitor[],
  skipDepths: Map<number, number>,
  node: TreeSitterNode,
  context: VisitorContext,
  depth: number,
): void {
  for (let i = 0; i < visitors.length; i++) {
    const v = visitors[i]!;
    if (v.exitNode && !isSkipped(skipDepths, i, depth)) {
      v.exitNode(node, context);
    }
  }
}

/** Clear skip flags for visitors that started skipping at this depth. */
function clearSkipFlags(
  skipDepths: Map<number, number>,
  visitorCount: number,
  depth: number,
): void {
  for (let i = 0; i < visitorCount; i++) {
    if (skipDepths.get(i) === depth) {
      skipDepths.delete(i);
    }
  }
}

/** Dispatch exitFunction hooks to all non-skipped visitors. */
function dispatchExitFunction(
  visitors: Visitor[],
  skipDepths: Map<number, number>,
  node: TreeSitterNode,
  funcName: string | null,
  context: VisitorContext,
  depth: number,
): void {
  for (let i = 0; i < visitors.length; i++) {
    const v = visitors[i]!;
    if (v.exitFunction && !isSkipped(skipDepths, i, depth)) {
      v.exitFunction(node, funcName, context);
    }
  }
}

/**
 * Maximum AST depth before walk() bails out.  WASM-backed tree-sitter parsers
 * have a smaller stack than native V8 (~64-256 KB).  Deep recursion in
 * generated code, deeply nested object literals, or pathologically large
 * switch statements can exhaust that stack, causing a V8 fatal error /
 * segfault (#931).  500 levels is well beyond any realistic hand-written
 * code while staying safely inside the WASM stack budget.
 */
const MAX_WALK_DEPTH = 500;

/** Collect finish() results from all visitors into a name-keyed map. */
function collectResults(visitors: Visitor[]): WalkResults {
  const results: WalkResults = {};
  for (const v of visitors) {
    results[v.name] = v.finish ? v.finish() : undefined;
  }
  return results;
}

/**
 * Walk an AST root with multiple visitors in a single DFS pass.
 *
 * @param {object} rootNode   - tree-sitter root node to walk
 * @param {Visitor[]} visitors - array of visitor objects
 * @param {string} langId     - language identifier
 * @param {object} [options]
 * @param {Set}    [options.functionNodeTypes] - set of node types that are function boundaries
 * @param {Set}    [options.nestingNodeTypes]  - set of node types that increase nesting depth
 * @param {function} [options.getFunctionName] - (funcNode) => string|null
 * @returns {object} Map of visitor.name → finish() result
 */
export function walkWithVisitors(
  rootNode: TreeSitterNode,
  visitors: Visitor[],
  langId: string,
  options: WalkOptions = {},
): WalkResults {
  const {
    functionNodeTypes = new Set<string>(),
    nestingNodeTypes = new Set<string>(),
    getFunctionName = () => null,
  } = options;

  const allFuncTypes = mergeFunctionNodeTypes(visitors, functionNodeTypes);
  initVisitors(visitors, langId);

  // Shared context object (mutated during walk)
  const scopeStack: ScopeEntry[] = [];
  const context: VisitorContext = {
    nestingLevel: 0,
    currentFunction: null,
    langId,
    scopeStack,
  };

  const skipDepths = new Map<number, number>();

  function walk(node: TreeSitterNode | null, depth: number): void {
    if (!node) return;
    if (depth > MAX_WALK_DEPTH) {
      debug(`walkWithVisitors: AST depth limit (${MAX_WALK_DEPTH}) hit — subtree truncated`);
      return;
    }

    const type = node.type;
    const isFuncBoundary = allFuncTypes.has(type);
    let funcName: string | null = null;

    if (isFuncBoundary) {
      funcName = getFunctionName(node);
      context.currentFunction = node;
      scopeStack.push({ funcName, funcNode: node, params: new Map(), locals: new Map() });
      dispatchEnterFunction(visitors, skipDepths, node, funcName, context, depth);
    }

    dispatchEnterNode(visitors, skipDepths, node, context, depth);

    const addsNesting = nestingNodeTypes.has(type);
    if (addsNesting) context.nestingLevel++;

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1);
    }

    if (addsNesting) context.nestingLevel--;

    dispatchExitNode(visitors, skipDepths, node, context, depth);
    clearSkipFlags(skipDepths, visitors.length, depth);

    if (isFuncBoundary) {
      dispatchExitFunction(visitors, skipDepths, node, funcName, context, depth);
      scopeStack.pop();
      context.currentFunction =
        scopeStack.length > 0 ? scopeStack[scopeStack.length - 1]!.funcNode : null;
    }
  }

  walk(rootNode, 0);

  return collectResults(visitors);
}
