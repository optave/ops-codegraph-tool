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

import type {
  ScopeEntry,
  TreeSitterNode,
  Visitor,
  VisitorContext,
  WalkOptions,
  WalkResults,
} from '../types.js';

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

  // Merge all visitors' functionNodeTypes into the master set
  const allFuncTypes = new Set(functionNodeTypes);
  for (const v of visitors) {
    if (v.functionNodeTypes) {
      for (const t of v.functionNodeTypes) allFuncTypes.add(t);
    }
  }

  // Initialize visitors
  for (const v of visitors) {
    if (v.init) v.init(langId);
  }

  // Shared context object (mutated during walk)
  const scopeStack: ScopeEntry[] = [];
  const context: VisitorContext = {
    nestingLevel: 0,
    currentFunction: null,
    langId,
    scopeStack,
  };

  // Track which visitors have requested skipChildren at each depth
  // Key: visitor index, Value: depth at which skip was requested
  const skipDepths = new Map<number, number>();

  function walk(node: TreeSitterNode | null, depth: number): void {
    if (!node) return;

    const type = node.type;
    const isFunction = allFuncTypes.has(type);
    let funcName: string | null = null;

    // Function boundary: enter
    if (isFunction) {
      funcName = getFunctionName(node);
      context.currentFunction = node;
      scopeStack.push({ funcName, funcNode: node, params: new Map(), locals: new Map() });
      for (let i = 0; i < visitors.length; i++) {
        const v = visitors[i]!;
        if (v.enterFunction && !isSkipped(i, depth)) {
          v.enterFunction(node, funcName, context);
        }
      }
    }

    // enterNode hooks
    for (let i = 0; i < visitors.length; i++) {
      const v = visitors[i]!;
      if (v.enterNode && !isSkipped(i, depth)) {
        const result = v.enterNode(node, context);
        if (result?.skipChildren) {
          skipDepths.set(i, depth);
        }
      }
    }

    // Nesting tracking
    const addsNesting = nestingNodeTypes.has(type);
    if (addsNesting) context.nestingLevel++;

    // Recurse children using node.child(i) (all children, not just named)
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), depth + 1);
    }

    // Undo nesting
    if (addsNesting) context.nestingLevel--;

    // exitNode hooks
    for (let i = 0; i < visitors.length; i++) {
      const v = visitors[i]!;
      if (v.exitNode && !isSkipped(i, depth)) {
        v.exitNode(node, context);
      }
    }

    // Clear skip for any visitor that started skipping at this depth
    for (let i = 0; i < visitors.length; i++) {
      if (skipDepths.get(i) === depth) {
        skipDepths.delete(i);
      }
    }

    // Function boundary: exit
    if (isFunction) {
      for (let i = 0; i < visitors.length; i++) {
        const v = visitors[i]!;
        if (v.exitFunction && !isSkipped(i, depth)) {
          v.exitFunction(node, funcName, context);
        }
      }
      scopeStack.pop();
      context.currentFunction =
        scopeStack.length > 0 ? scopeStack[scopeStack.length - 1]!.funcNode : null;
    }
  }

  function isSkipped(visitorIndex: number, currentDepth: number): boolean {
    const skipAt = skipDepths.get(visitorIndex);
    // Skipped if skip was requested at a shallower (or equal) depth
    // We skip descendants, not the node itself, so skip when currentDepth > skipAt
    return skipAt !== undefined && currentDepth > skipAt;
  }

  walk(rootNode, 0);

  // Collect results
  const results: WalkResults = {};
  for (const v of visitors) {
    results[v.name] = v.finish ? v.finish() : undefined;
  }
  return results;
}
