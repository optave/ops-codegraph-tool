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

// ─── Statement handler dispatch ─────────────────────────────────────────

type BoundProcessStatements = (
  stmts: TreeSitterNode[],
  currentBlock: CfgBlockInternal,
  S: FuncState,
) => CfgBlockInternal | null;

type StatementHandler = (
  node: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStmts: BoundProcessStatements,
) => CfgBlockInternal | null;

interface StatementEntry {
  match: (type: string) => boolean;
  handle: StatementHandler;
}

// ─── Helpers that do not depend on the dispatch closure ─────────────────

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

// ─── Dispatch table builder ──────────────────────────────────────────────

// ─── Terminal statement handlers (no processStatements dependency) ───────

function handleReturn(n: TreeSitterNode, b: CfgBlockInternal, S: FuncState): null {
  b.endLine = n.startPosition.row + 1;
  S.addEdge(b, S.exitBlock, 'return');
  return null;
}

function handleThrow(n: TreeSitterNode, b: CfgBlockInternal, S: FuncState): null {
  b.endLine = n.startPosition.row + 1;
  S.addEdge(b, S.exitBlock, 'exception');
  return null;
}

/**
 * Build a dispatch table for statement node types from cfgRules.
 * Built once per createCfgVisitor call; optional entries (doNode, infiniteLoopNode,
 * tryNode) are included only when the language rules define them.
 */
function buildStatementDispatch(
  cfgRules: AnyRules,
  processLabeledFn: (
    n: TreeSitterNode,
    b: CfgBlockInternal,
    S: FuncState,
  ) => CfgBlockInternal | null,
): StatementEntry[] {
  const required: StatementEntry[] = [
    { match: (t) => t === cfgRules.labeledNode, handle: (n, b, S) => processLabeledFn(n, b, S) },
    {
      match: (t) => isIfNode(t, cfgRules) || (!!cfgRules.unlessNode && t === cfgRules.unlessNode),
      handle: (n, b, S, r, ps) => processIf(n, b, S, r, ps),
    },
    {
      match: (t) => isForNode(t, cfgRules),
      handle: (n, b, S, r, ps) => processForLoop(n, b, S, r, ps),
    },
    {
      match: (t) => isWhileNode(t, cfgRules) || (!!cfgRules.untilNode && t === cfgRules.untilNode),
      handle: (n, b, S, r, ps) => processWhileLoop(n, b, S, r, ps),
    },
    {
      match: (t) => isSwitchNode(t, cfgRules),
      handle: (n, b, S, r, ps) => processSwitch(n, b, S, r, ps),
    },
    { match: (t) => t === cfgRules.returnNode, handle: handleReturn },
    { match: (t) => t === cfgRules.throwNode, handle: handleThrow },
    { match: (t) => t === cfgRules.breakNode, handle: (n, b, S) => processBreak(n, b, S) },
    { match: (t) => t === cfgRules.continueNode, handle: (n, b, S) => processContinue(n, b, S) },
  ];

  const optional: StatementEntry[] = [];
  if (cfgRules.doNode) {
    const doNode = cfgRules.doNode;
    optional.push({
      match: (t) => t === doNode,
      handle: (n, b, S, r, ps) => processDoWhileLoop(n, b, S, r, ps),
    });
  }
  if (cfgRules.infiniteLoopNode) {
    const loopNode = cfgRules.infiniteLoopNode;
    optional.push({
      match: (t) => t === loopNode,
      handle: (n, b, S, r, ps) => processInfiniteLoop(n, b, S, r, ps),
    });
  }
  if (cfgRules.tryNode) {
    const tryNode = cfgRules.tryNode;
    optional.push({
      match: (t) => t === tryNode,
      handle: (n, b, S, r, ps) => processTryCatch(n, b, S, r, ps),
    });
  }

  return [...required, ...optional];
}

// ─── Bound statement processors ──────────────────────────────────────────

/**
 * Build {processStatement, processStatements} bound to cfgRules and a
 * pre-built dispatch table. The two functions are mutually recursive via
 * the closure — no cfgRules arguments needed at call sites inside the visitor.
 */
function buildStatementProcessors(cfgRules: AnyRules): {
  processStatement: (
    stmt: TreeSitterNode,
    currentBlock: CfgBlockInternal,
    S: FuncState,
  ) => CfgBlockInternal | null;
  processStatements: BoundProcessStatements;
} {
  // processLabeled needs processStatement from this closure, so we forward-declare
  // it and patch it in after processStatement is defined.
  let processStatementRef: (
    stmt: TreeSitterNode,
    block: CfgBlockInternal,
    S: FuncState,
  ) => CfgBlockInternal | null;

  function processLabeled(
    node: TreeSitterNode,
    currentBlock: CfgBlockInternal,
    S: FuncState,
  ): CfgBlockInternal | null {
    const labelNode = node.childForFieldName('label');
    const labelName = labelNode ? labelNode.text : null;
    const body = node.childForFieldName('body');
    if (body && labelName) {
      const labelCtx: LabelCtx = { headerBlock: null, exitBlock: null };
      S.labelMap.set(labelName, labelCtx);
      const result = processStatementRef(body, currentBlock, S);
      S.labelMap.delete(labelName);
      return result;
    }
    return currentBlock;
  }

  const dispatch = buildStatementDispatch(cfgRules, processLabeled);

  function processStatement(
    stmt: TreeSitterNode,
    currentBlock: CfgBlockInternal,
    S: FuncState,
  ): CfgBlockInternal | null {
    if (!stmt || !currentBlock) return currentBlock;

    const effNode = effectiveNode(stmt, cfgRules);
    const type = effNode.type;

    const entry = dispatch.find((e) => e.match(type));
    if (entry) return entry.handle(effNode, currentBlock, S, cfgRules, processStatements);

    if (!currentBlock.startLine) {
      currentBlock.startLine = stmt.startPosition.row + 1;
    }
    currentBlock.endLine = stmt.endPosition.row + 1;
    return currentBlock;
  }

  // Wire the forward reference so processLabeled can call processStatement
  processStatementRef = processStatement;

  function processStatements(
    stmts: TreeSitterNode[],
    currentBlock: CfgBlockInternal,
    S: FuncState,
  ): CfgBlockInternal | null {
    let cur: CfgBlockInternal | null = currentBlock;
    for (const stmt of stmts) {
      if (!cur) break;
      cur = processStatement(stmt, cur, S);
    }
    return cur;
  }

  return { processStatement, processStatements };
}

// ─── Function body walker ────────────────────────────────────────────────

function processFunctionBody(
  funcNode: TreeSitterNode,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: BoundProcessStatements,
): void {
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
  const lastBlock = processStatements(stmts, firstBody, S);
  if (lastBlock) {
    S.addEdge(lastBlock, S.exitBlock, 'fallthrough');
  }
  S.currentBlock = null;
}

// ─── Public visitor factory ───────────────────────────────────────────────

export function createCfgVisitor(cfgRules: AnyRules): Visitor {
  const funcStateStack: FuncState[] = [];
  let S: FuncState | null = null;
  const results: CFGResultInternal[] = [];

  const { processStatements } = buildStatementProcessors(cfgRules);

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
      processFunctionBody(funcNode, S, cfgRules, processStatements);
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
