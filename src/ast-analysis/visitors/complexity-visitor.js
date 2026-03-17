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

// ── Halstead classification ─────────────────────────────────────────────

function classifyHalstead(node, hRules, acc) {
  const type = node.type;
  if (hRules.skipTypes.has(type)) acc.halsteadSkipDepth++;
  if (acc.halsteadSkipDepth > 0) return;

  if (hRules.compoundOperators.has(type)) {
    acc.operators.set(type, (acc.operators.get(type) || 0) + 1);
  }
  if (node.childCount === 0) {
    if (hRules.operatorLeafTypes.has(type)) {
      acc.operators.set(type, (acc.operators.get(type) || 0) + 1);
    } else if (hRules.operandLeafTypes.has(type)) {
      const text = node.text;
      acc.operands.set(text, (acc.operands.get(text) || 0) + 1);
    }
  }
}

// ── Branch complexity classification ────────────────────────────────────

function classifyBranchNode(node, type, nestingLevel, cRules, acc) {
  // Pattern A: else clause wraps if (JS/C#/Rust)
  if (cRules.elseNodeType && type === cRules.elseNodeType) {
    const firstChild = node.namedChild(0);
    if (firstChild && firstChild.type === cRules.ifNodeType) {
      // else-if: the if_statement child handles its own increment
      return;
    }
    acc.cognitive++;
    return;
  }

  // Pattern B: explicit elif node (Python/Ruby/PHP)
  if (cRules.elifNodeType && type === cRules.elifNodeType) {
    acc.cognitive++;
    acc.cyclomatic++;
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
    acc.cognitive++;
    acc.cyclomatic++;
    return;
  }

  // Regular branch node
  acc.cognitive += 1 + nestingLevel;
  acc.cyclomatic++;

  if (cRules.switchLikeNodes?.has(type)) {
    acc.cyclomatic--;
  }
}

// ── Plain-else detection (Pattern C: Go/Java) ──────────────────────────

function classifyPlainElse(node, type, cRules, acc) {
  if (
    cRules.elseViaAlternative &&
    type !== cRules.ifNodeType &&
    node.parent?.type === cRules.ifNodeType &&
    node.parent.childForFieldName('alternative')?.id === node.id
  ) {
    acc.cognitive++;
  }
}

// ── Result collection ───────────────────────────────────────────────────

function collectResult(funcNode, acc, hRules, langId) {
  const halstead =
    hRules && acc.operators && acc.operands
      ? computeHalsteadDerived(acc.operators, acc.operands)
      : null;
  const loc = computeLOCMetrics(funcNode, langId);
  const volume = halstead ? halstead.volume : 0;
  const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  const mi = computeMaintainabilityIndex(volume, acc.cyclomatic, loc.sloc, commentRatio);

  return {
    cognitive: acc.cognitive,
    cyclomatic: acc.cyclomatic,
    maxNesting: acc.maxNesting,
    halstead,
    loc,
    mi,
  };
}

function resetAccumulators(hRules) {
  return {
    cognitive: 0,
    cyclomatic: 1,
    maxNesting: 0,
    operators: hRules ? new Map() : null,
    operands: hRules ? new Map() : null,
    halsteadSkipDepth: 0,
  };
}

// ── Visitor factory ─────────────────────────────────────────────────────

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
  const { fileLevelWalk = false, langId = null } = options;

  let acc = resetAccumulators(hRules);
  let activeFuncNode = null;
  let activeFuncName = null;
  let funcDepth = 0;
  const results = [];

  return {
    name: 'complexity',
    functionNodeTypes: cRules.functionNodes,

    enterFunction(funcNode, funcName, _context) {
      if (fileLevelWalk) {
        if (!activeFuncNode) {
          acc = resetAccumulators(hRules);
          activeFuncNode = funcNode;
          activeFuncName = funcName;
          funcDepth = 0;
        } else {
          funcDepth++;
        }
      } else {
        funcDepth++;
      }
    },

    exitFunction(funcNode, _funcName, _context) {
      if (fileLevelWalk) {
        if (funcNode === activeFuncNode) {
          results.push({
            funcNode,
            funcName: activeFuncName,
            metrics: collectResult(funcNode, acc, hRules, langId),
          });
          activeFuncNode = null;
          activeFuncName = null;
        } else {
          funcDepth--;
        }
      } else {
        funcDepth--;
      }
    },

    enterNode(node, context) {
      if (fileLevelWalk && !activeFuncNode) return;

      const type = node.type;
      const nestingLevel = fileLevelWalk ? context.nestingLevel + funcDepth : context.nestingLevel;

      if (hRules) classifyHalstead(node, hRules, acc);

      if (nestingLevel > acc.maxNesting) acc.maxNesting = nestingLevel;

      // Logical operators in binary expressions
      if (type === cRules.logicalNodeType) {
        const op = node.child(1)?.type;
        if (op && cRules.logicalOperators.has(op)) {
          acc.cyclomatic++;
          const parent = node.parent;
          let sameSequence = false;
          if (parent && parent.type === cRules.logicalNodeType) {
            const parentOp = parent.child(1)?.type;
            if (parentOp === op) sameSequence = true;
          }
          if (!sameSequence) acc.cognitive++;
        }
      }

      // Optional chaining (cyclomatic only)
      if (type === cRules.optionalChainType) acc.cyclomatic++;

      // Branch/control flow nodes (skip keyword leaf tokens)
      if (cRules.branchNodes.has(type) && node.childCount > 0) {
        classifyBranchNode(node, type, nestingLevel, cRules, acc);
      }

      // Pattern C plain else (Go/Java)
      classifyPlainElse(node, type, cRules, acc);

      // Case nodes (cyclomatic only, skip keyword leaves)
      if (cRules.caseNodes.has(type) && node.childCount > 0) acc.cyclomatic++;
    },

    exitNode(node) {
      if (hRules?.skipTypes.has(node.type)) acc.halsteadSkipDepth--;
    },

    finish() {
      if (fileLevelWalk) return results;
      return collectResult({ text: '' }, acc, hRules, langId);
    },
  };
}
