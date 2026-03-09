/**
 * Visitor: Compute cognitive/cyclomatic complexity, max nesting, and Halstead metrics.
 *
 * Replaces the computeAllMetrics() DFS walk in complexity.js with a visitor that
 * plugs into the unified walkWithVisitors framework. Operates per-function:
 * resets accumulators on enterFunction, emits results on exitFunction.
 */

import {
  computeHalsteadDerived,
  computeLOCMetrics,
  computeMaintainabilityIndex,
} from '../metrics.js';

/**
 * Create a complexity visitor for use with walkWithVisitors.
 *
 * When used in file-level mode (walking an entire file), this visitor collects
 * per-function metrics using enterFunction/exitFunction hooks. When used in
 * function-level mode (walking a single function node), it collects one result.
 *
 * @param {object} cRules  - COMPLEXITY_RULES for the language
 * @param {object} [hRules] - HALSTEAD_RULES for the language (null if unavailable)
 * @param {object} [options]
 * @param {boolean} [options.fileLevelWalk=false] - true when walking an entire file
 * @returns {Visitor}
 */
export function createComplexityVisitor(cRules, hRules, options = {}) {
  const { fileLevelWalk = false } = options;

  // Per-function accumulators
  let cognitive = 0;
  let cyclomatic = 1;
  let maxNesting = 0;
  let operators = hRules ? new Map() : null;
  let operands = hRules ? new Map() : null;
  let halsteadSkip = false;

  // In file-level mode, we only count when inside a function
  let activeFuncNode = null;
  let activeFuncName = null;
  // Nesting depth relative to the active function (for nested functions)
  let funcDepth = 0;

  // Collected results (one per function)
  const results = [];

  function reset() {
    cognitive = 0;
    cyclomatic = 1;
    maxNesting = 0;
    operators = hRules ? new Map() : null;
    operands = hRules ? new Map() : null;
    halsteadSkip = false;
  }

  function collectResult(funcNode) {
    const halstead =
      hRules && operators && operands ? computeHalsteadDerived(operators, operands) : null;
    const loc = computeLOCMetrics(funcNode, null);
    const volume = halstead ? halstead.volume : 0;
    const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
    const mi = computeMaintainabilityIndex(volume, cyclomatic, loc.sloc, commentRatio);

    return { cognitive, cyclomatic, maxNesting, halstead, loc, mi };
  }

  return {
    name: 'complexity',
    functionNodeTypes: cRules.functionNodes,

    enterFunction(funcNode, funcName, _context) {
      if (fileLevelWalk) {
        if (!activeFuncNode) {
          // Top-level function: start fresh
          reset();
          activeFuncNode = funcNode;
          activeFuncName = funcName;
          funcDepth = 0;
        } else {
          // Nested function: increase nesting for complexity
          funcDepth++;
        }
      }
    },

    exitFunction(funcNode, _funcName, _context) {
      if (fileLevelWalk) {
        if (funcNode === activeFuncNode) {
          // Leaving the top-level function: emit result
          results.push({
            funcNode,
            funcName: activeFuncName,
            metrics: collectResult(funcNode),
          });
          activeFuncNode = null;
          activeFuncName = null;
        } else {
          funcDepth--;
        }
      }
    },

    enterNode(node, context) {
      // In file-level mode, skip nodes outside any function
      if (fileLevelWalk && !activeFuncNode) return;

      const type = node.type;
      const nestingLevel = fileLevelWalk ? context.nestingLevel + funcDepth : context.nestingLevel;

      // ── Halstead classification ──
      const _wasSkipping = halsteadSkip;
      if (hRules) {
        if (hRules.skipTypes.has(type)) halsteadSkip = true;
        if (!halsteadSkip) {
          if (hRules.compoundOperators.has(type)) {
            operators.set(type, (operators.get(type) || 0) + 1);
          }
          if (node.childCount === 0) {
            if (hRules.operatorLeafTypes.has(type)) {
              operators.set(type, (operators.get(type) || 0) + 1);
            } else if (hRules.operandLeafTypes.has(type)) {
              const text = node.text;
              operands.set(text, (operands.get(text) || 0) + 1);
            }
          }
        }
      }

      // ── Complexity: track nesting depth ──
      if (nestingLevel > maxNesting) maxNesting = nestingLevel;

      // Handle logical operators in binary expressions
      if (type === cRules.logicalNodeType) {
        const op = node.child(1)?.type;
        if (op && cRules.logicalOperators.has(op)) {
          cyclomatic++;
          const parent = node.parent;
          let sameSequence = false;
          if (parent && parent.type === cRules.logicalNodeType) {
            const parentOp = parent.child(1)?.type;
            if (parentOp === op) sameSequence = true;
          }
          if (!sameSequence) cognitive++;
          // Don't skip children — walker handles recursion
        }
      }

      // Handle optional chaining (cyclomatic only)
      if (type === cRules.optionalChainType) {
        cyclomatic++;
      }

      // Handle branch/control flow nodes (skip keyword leaf tokens)
      if (cRules.branchNodes.has(type) && node.childCount > 0) {
        // Pattern A: else clause wraps if (JS/C#/Rust)
        if (cRules.elseNodeType && type === cRules.elseNodeType) {
          const firstChild = node.namedChild(0);
          if (firstChild && firstChild.type === cRules.ifNodeType) {
            // else-if: the if_statement child handles its own increment
            return;
          }
          cognitive++;
          return;
        }

        // Pattern B: explicit elif node (Python/Ruby/PHP)
        if (cRules.elifNodeType && type === cRules.elifNodeType) {
          cognitive++;
          cyclomatic++;
          return;
        }

        // Detect else-if via Pattern A or C
        let isElseIf = false;
        if (type === cRules.ifNodeType) {
          if (cRules.elseViaAlternative) {
            isElseIf =
              node.parent?.type === cRules.ifNodeType &&
              node.parent.childForFieldName('alternative')?.id === node.id;
          } else if (cRules.elseNodeType) {
            isElseIf = node.parent?.type === cRules.elseNodeType;
          }
        }

        if (isElseIf) {
          cognitive++;
          cyclomatic++;
          return;
        }

        // Regular branch node
        cognitive += 1 + nestingLevel;
        cyclomatic++;

        if (cRules.switchLikeNodes?.has(type)) {
          cyclomatic--;
        }

        // Nesting nodes are handled by the walker's nestingNodeTypes option
        // But we still need them to count in complexity — they already do above
      }

      // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
      if (
        cRules.elseViaAlternative &&
        type !== cRules.ifNodeType &&
        node.parent?.type === cRules.ifNodeType &&
        node.parent.childForFieldName('alternative')?.id === node.id
      ) {
        cognitive++;
      }

      // Handle case nodes (cyclomatic only, skip keyword leaves)
      if (cRules.caseNodes.has(type) && node.childCount > 0) {
        cyclomatic++;
      }

      // Handle nested function definitions (increase nesting)
      // In file-level mode funcDepth handles this; in function-level mode the
      // nestingNodeTypes option should include function nodes
    },

    exitNode(node) {
      // Restore halsteadSkip when leaving a skip-type subtree
      if (hRules?.skipTypes.has(node.type)) {
        halsteadSkip = false;
      }
    },

    finish() {
      if (fileLevelWalk) {
        return results;
      }
      // Function-level mode: return single result (no funcNode reference needed)
      return collectResult({ text: '' });
    },
  };
}
