import type { EnterNodeResult, TreeSitterNode, Visitor, VisitorContext } from '../../types.js';
import {
  computeHalsteadDerived,
  computeLOCMetrics,
  computeMaintainabilityIndex,
} from '../metrics.js';

type AnyRules = any;

interface ComplexityAcc {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  operators: Map<string, number> | null;
  operands: Map<string, number> | null;
  halsteadSkipDepth: number;
}

interface PerFunctionResult {
  funcNode: TreeSitterNode;
  funcName: string | null;
  metrics: ReturnType<typeof collectResult>;
}

function classifyHalstead(node: TreeSitterNode, hRules: AnyRules, acc: ComplexityAcc): void {
  const type = node.type;
  if (hRules.skipTypes.has(type)) acc.halsteadSkipDepth++;
  if (acc.halsteadSkipDepth > 0) return;

  if (hRules.compoundOperators.has(type) && acc.operators) {
    acc.operators.set(type, (acc.operators.get(type) || 0) + 1);
  }
  if (node.childCount === 0) {
    if (hRules.operatorLeafTypes.has(type) && acc.operators) {
      acc.operators.set(type, (acc.operators.get(type) || 0) + 1);
    } else if (hRules.operandLeafTypes.has(type) && acc.operands) {
      const text = node.text;
      acc.operands.set(text, (acc.operands.get(text) || 0) + 1);
    }
  }
}

function classifyBranchNode(
  node: TreeSitterNode,
  type: string,
  nestingLevel: number,
  cRules: AnyRules,
  acc: ComplexityAcc,
): void {
  if (cRules.elseNodeType && type === cRules.elseNodeType) {
    const firstChild = node.namedChild(0);
    if (firstChild && firstChild.type === cRules.ifNodeType) {
      return;
    }
    acc.cognitive++;
    return;
  }

  if (cRules.elifNodeType && type === cRules.elifNodeType) {
    acc.cognitive++;
    acc.cyclomatic++;
    return;
  }

  let isElseIf = false;
  if (type === cRules.ifNodeType) {
    if (cRules.elseViaAlternative) {
      isElseIf =
        node.parent?.type === cRules.ifNodeType &&
        node.parent?.childForFieldName('alternative')?.id === node.id;
    } else if (cRules.elseNodeType) {
      isElseIf = node.parent?.type === cRules.elseNodeType;
    }
  }

  if (isElseIf) {
    acc.cognitive++;
    acc.cyclomatic++;
    return;
  }

  acc.cognitive += 1 + nestingLevel;
  acc.cyclomatic++;

  if (cRules.switchLikeNodes?.has(type)) {
    acc.cyclomatic--;
  }
}

function classifyLogicalOp(node: TreeSitterNode, cRules: AnyRules, acc: ComplexityAcc): void {
  const op = node.child(1)?.type;
  if (!op || !cRules.logicalOperators.has(op)) return;
  acc.cyclomatic++;
  const parent = node.parent;
  const sameSequence =
    parent != null && parent.type === cRules.logicalNodeType && parent.child(1)?.type === op;
  if (!sameSequence) acc.cognitive++;
}

function classifyPlainElse(
  node: TreeSitterNode,
  type: string,
  cRules: AnyRules,
  acc: ComplexityAcc,
): void {
  if (
    cRules.elseViaAlternative &&
    type !== cRules.ifNodeType &&
    node.parent?.type === cRules.ifNodeType &&
    node.parent?.childForFieldName('alternative')?.id === node.id
  ) {
    acc.cognitive++;
  }
}

function collectResult(
  funcNode: TreeSitterNode | { text: string },
  acc: ComplexityAcc,
  hRules: AnyRules | null | undefined,
  langId: string | null,
): {
  cognitive: number;
  cyclomatic: number;
  maxNesting: number;
  halstead: ReturnType<typeof computeHalsteadDerived> | null;
  loc: ReturnType<typeof computeLOCMetrics>;
  mi: number;
} {
  const halstead =
    hRules && acc.operators && acc.operands
      ? computeHalsteadDerived(acc.operators, acc.operands)
      : null;
  const loc = computeLOCMetrics(funcNode as TreeSitterNode, langId ?? undefined);
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

function resetAccumulators(hRules: AnyRules | null | undefined): ComplexityAcc {
  return {
    cognitive: 0,
    cyclomatic: 1,
    maxNesting: 0,
    operators: hRules ? new Map() : null,
    operands: hRules ? new Map() : null,
    halsteadSkipDepth: 0,
  };
}

/** Classify a single node for all complexity metrics (Halstead, branching, logical ops, etc.). */
function classifyNode(
  node: TreeSitterNode,
  nestingLevel: number,
  cRules: AnyRules,
  hRules: AnyRules | null | undefined,
  acc: ComplexityAcc,
): void {
  const type = node.type;

  if (hRules) classifyHalstead(node, hRules, acc);
  if (nestingLevel > acc.maxNesting) acc.maxNesting = nestingLevel;
  if (type === cRules.logicalNodeType) classifyLogicalOp(node, cRules, acc);
  if (type === cRules.optionalChainType) acc.cyclomatic++;
  if (cRules.branchNodes.has(type) && node.childCount > 0) {
    classifyBranchNode(node, type, nestingLevel, cRules, acc);
  }
  classifyPlainElse(node, type, cRules, acc);
  if (cRules.caseNodes.has(type) && node.childCount > 0) acc.cyclomatic++;
}

export function createComplexityVisitor(
  cRules: AnyRules,
  hRules?: AnyRules | null,
  options: { fileLevelWalk?: boolean; langId?: string | null } = {},
): Visitor {
  const { fileLevelWalk = false, langId = null } = options;

  let acc = resetAccumulators(hRules);
  let activeFuncNode: TreeSitterNode | null = null;
  let activeFuncName: string | null = null;
  let funcDepth = 0;
  const results: PerFunctionResult[] = [];

  return {
    name: 'complexity',
    functionNodeTypes: cRules.functionNodes,

    enterFunction(
      funcNode: TreeSitterNode,
      funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (fileLevelWalk && !activeFuncNode) {
        acc = resetAccumulators(hRules);
        activeFuncNode = funcNode;
        activeFuncName = funcName;
        funcDepth = 0;
      } else {
        funcDepth++;
      }
    },

    exitFunction(
      funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (fileLevelWalk && funcNode === activeFuncNode) {
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
    },

    enterNode(node: TreeSitterNode, context: VisitorContext): EnterNodeResult | undefined {
      if (fileLevelWalk && !activeFuncNode) return;

      const nestingLevel = fileLevelWalk ? context.nestingLevel + funcDepth : context.nestingLevel;
      classifyNode(node, nestingLevel, cRules, hRules, acc);
    },

    exitNode(node: TreeSitterNode): void {
      if (hRules?.skipTypes.has(node.type)) acc.halsteadSkipDepth--;
    },

    finish(): PerFunctionResult[] | ReturnType<typeof collectResult> {
      if (fileLevelWalk) return results;
      return collectResult({ text: '' } as TreeSitterNode, acc, hRules, langId);
    },
  };
}
