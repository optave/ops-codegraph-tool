import type { TreeSitterNode, Visitor, VisitorContext } from '../../types.js';
import { processIf, processSwitch } from './cfg-conditionals.js';
import {
  processDoWhileLoop,
  processForLoop,
  processInfiniteLoop,
  processWhileLoop,
} from './cfg-loops.js';
import type {
  AnyRules,
  CFGResultInternal,
  CfgBlockInternal,
  FuncState,
  LabelCtx,
} from './cfg-shared.js';
import {
  effectiveNode,
  getBodyStatements,
  isBlockNode,
  isForNode,
  isIfNode,
  isSwitchNode,
  isWhileNode,
  makeFuncState,
} from './cfg-shared.js';
import { processTryCatch } from './cfg-try-catch.js';

export type { CfgBlockInternal } from './cfg-shared.js';

function processStatements(
  stmts: TreeSitterNode[],
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
): CfgBlockInternal | null {
  let cur: CfgBlockInternal | null = currentBlock;
  for (const stmt of stmts) {
    if (!cur) break;
    cur = processStatement(stmt, cur, S, cfgRules);
  }
  return cur;
}

function processStatement(
  stmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
): CfgBlockInternal | null {
  if (!stmt || !currentBlock) return currentBlock;

  const effNode = effectiveNode(stmt, cfgRules);
  const type = effNode.type;

  if (type === cfgRules.labeledNode) {
    return processLabeled(effNode, currentBlock, S, cfgRules);
  }
  if (isIfNode(type, cfgRules) || (cfgRules.unlessNode && type === cfgRules.unlessNode)) {
    return processIf(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (isForNode(type, cfgRules)) {
    return processForLoop(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (isWhileNode(type, cfgRules) || (cfgRules.untilNode && type === cfgRules.untilNode)) {
    return processWhileLoop(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (cfgRules.doNode && type === cfgRules.doNode) {
    return processDoWhileLoop(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) {
    return processInfiniteLoop(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (isSwitchNode(type, cfgRules)) {
    return processSwitch(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (cfgRules.tryNode && type === cfgRules.tryNode) {
    return processTryCatch(effNode, currentBlock, S, cfgRules, processStatements);
  }
  if (type === cfgRules.returnNode) {
    currentBlock.endLine = effNode.startPosition.row + 1;
    S.addEdge(currentBlock, S.exitBlock, 'return');
    return null;
  }
  if (type === cfgRules.throwNode) {
    currentBlock.endLine = effNode.startPosition.row + 1;
    S.addEdge(currentBlock, S.exitBlock, 'exception');
    return null;
  }
  if (type === cfgRules.breakNode) {
    return processBreak(effNode, currentBlock, S);
  }
  if (type === cfgRules.continueNode) {
    return processContinue(effNode, currentBlock, S);
  }

  if (!currentBlock.startLine) {
    currentBlock.startLine = stmt.startPosition.row + 1;
  }
  currentBlock.endLine = stmt.endPosition.row + 1;
  return currentBlock;
}

function processLabeled(
  node: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
): CfgBlockInternal | null {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;
  const body = node.childForFieldName('body');
  if (body && labelName) {
    const labelCtx: LabelCtx = { headerBlock: null, exitBlock: null };
    S.labelMap.set(labelName, labelCtx);
    const result = processStatement(body, currentBlock, S, cfgRules);
    S.labelMap.delete(labelName);
    return result;
  }
  return currentBlock;
}

function processBreak(
  node: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
): CfgBlockInternal | null {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;

  let target: CfgBlockInternal | null = null;
  if (labelName && S.labelMap.has(labelName)) {
    target = (S.labelMap.get(labelName) as LabelCtx).exitBlock;
  } else if (S.loopStack.length > 0) {
    target = S.loopStack[S.loopStack.length - 1]!.exitBlock;
  }

  if (target) {
    currentBlock.endLine = node.startPosition.row + 1;
    S.addEdge(currentBlock, target, 'break');
    return null;
  }
  return currentBlock;
}

function processContinue(
  node: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
): CfgBlockInternal | null {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;

  let target: CfgBlockInternal | null = null;
  if (labelName && S.labelMap.has(labelName)) {
    target = (S.labelMap.get(labelName) as LabelCtx).headerBlock;
  } else if (S.loopStack.length > 0) {
    target = S.loopStack[S.loopStack.length - 1]!.headerBlock;
  }

  if (target) {
    currentBlock.endLine = node.startPosition.row + 1;
    S.addEdge(currentBlock, target, 'continue');
    return null;
  }
  return currentBlock;
}

function processFunctionBody(funcNode: TreeSitterNode, S: FuncState, cfgRules: AnyRules): void {
  const body = funcNode.childForFieldName('body');
  if (!body) {
    S.blocks.length = 2;
    S.edges.length = 0;
    S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  if (!isBlockNode(body.type, cfgRules)) {
    const bodyBlock = S.blocks[2]!;
    bodyBlock.startLine = body.startPosition.row + 1;
    bodyBlock.endLine = body.endPosition.row + 1;
    S.addEdge(bodyBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  const stmts = getBodyStatements(body, cfgRules);
  if (stmts.length === 0) {
    S.blocks.length = 2;
    S.edges.length = 0;
    S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  const firstBody = S.blocks[2]!;
  const lastBlock = processStatements(stmts, firstBody, S, cfgRules);
  if (lastBlock) {
    S.addEdge(lastBlock, S.exitBlock, 'fallthrough');
  }
  S.currentBlock = null;
}

export function createCfgVisitor(cfgRules: AnyRules): Visitor {
  const funcStateStack: FuncState[] = [];
  let S: FuncState | null = null;
  const results: CFGResultInternal[] = [];

  return {
    name: 'cfg',
    functionNodeTypes: cfgRules.functionNodes,

    enterFunction(
      funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (S) funcStateStack.push(S);
      S = makeFuncState();
      S.funcNode = funcNode;
      processFunctionBody(funcNode, S, cfgRules);
    },

    exitFunction(
      funcNode: TreeSitterNode,
      _funcName: string | null,
      _context: VisitorContext,
    ): void {
      if (S && S.funcNode === funcNode) {
        const cyclomatic = S.edges.length - S.blocks.length + 2;
        results.push({
          funcNode: S.funcNode as TreeSitterNode,
          blocks: S.blocks,
          edges: S.edges,
          cyclomatic: Math.max(cyclomatic, 1),
        });
      }
      S = funcStateStack.length > 0 ? (funcStateStack.pop() as FuncState) : null;
    },

    enterNode(_node: TreeSitterNode, _context: VisitorContext): undefined {
      // No-op
    },

    exitNode(_node: TreeSitterNode, _context: VisitorContext): void {
      // No-op
    },

    finish(): CFGResultInternal[] {
      return results;
    },
  };
}
