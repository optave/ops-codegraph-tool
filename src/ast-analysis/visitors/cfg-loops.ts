import type { TreeSitterNode } from '../../types.js';
import type { AnyRules, CfgBlockInternal, FuncState, LoopCtx } from './cfg-shared.js';
import { getBodyStatements, registerLabelCtx } from './cfg-shared.js';

/** Callback type for the mutual recursion with processStatements in cfg-visitor. */
export type ProcessStatementsFn = (
  stmts: TreeSitterNode[],
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
) => CfgBlockInternal | null;

export function processForLoop(
  forStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  const headerBlock = S.makeBlock(
    'loop_header',
    forStmt.startPosition.row + 1,
    forStmt.startPosition.row + 1,
    'for',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx: LoopCtx = { headerBlock, exitBlock: loopExitBlock };
  S.loopStack.push(loopCtx);
  registerLabelCtx(S, headerBlock, loopExitBlock);

  const body = forStmt.childForFieldName('body');
  const bodyBlock = S.makeBlock('loop_body');
  S.addEdge(headerBlock, bodyBlock, 'branch_true');

  const bodyStmts = getBodyStatements(body, cfgRules);
  const bodyEnd = processStatements(bodyStmts, bodyBlock, S, cfgRules);
  if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

  S.addEdge(headerBlock, loopExitBlock, 'loop_exit');
  S.loopStack.pop();
  return loopExitBlock;
}

export function processWhileLoop(
  whileStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  const headerBlock = S.makeBlock(
    'loop_header',
    whileStmt.startPosition.row + 1,
    whileStmt.startPosition.row + 1,
    'while',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx: LoopCtx = { headerBlock, exitBlock: loopExitBlock };
  S.loopStack.push(loopCtx);
  registerLabelCtx(S, headerBlock, loopExitBlock);

  const body = whileStmt.childForFieldName('body');
  const bodyBlock = S.makeBlock('loop_body');
  S.addEdge(headerBlock, bodyBlock, 'branch_true');

  const bodyStmts = getBodyStatements(body, cfgRules);
  const bodyEnd = processStatements(bodyStmts, bodyBlock, S, cfgRules);
  if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

  S.addEdge(headerBlock, loopExitBlock, 'loop_exit');
  S.loopStack.pop();
  return loopExitBlock;
}

export function processDoWhileLoop(
  doStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  const bodyBlock = S.makeBlock('loop_body', doStmt.startPosition.row + 1, null, 'do');
  S.addEdge(currentBlock, bodyBlock, 'fallthrough');

  const condBlock = S.makeBlock('loop_header', null, null, 'do-while');
  const loopExitBlock = S.makeBlock('body');

  const loopCtx: LoopCtx = { headerBlock: condBlock, exitBlock: loopExitBlock };
  S.loopStack.push(loopCtx);
  registerLabelCtx(S, condBlock, loopExitBlock);

  const body = doStmt.childForFieldName('body');
  const bodyStmts = getBodyStatements(body, cfgRules);
  const bodyEnd = processStatements(bodyStmts, bodyBlock, S, cfgRules);
  if (bodyEnd) S.addEdge(bodyEnd, condBlock, 'fallthrough');

  S.addEdge(condBlock, bodyBlock, 'loop_back');
  S.addEdge(condBlock, loopExitBlock, 'loop_exit');

  S.loopStack.pop();
  return loopExitBlock;
}

export function processInfiniteLoop(
  loopStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  const headerBlock = S.makeBlock(
    'loop_header',
    loopStmt.startPosition.row + 1,
    loopStmt.startPosition.row + 1,
    'loop',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx: LoopCtx = { headerBlock, exitBlock: loopExitBlock };
  S.loopStack.push(loopCtx);
  registerLabelCtx(S, headerBlock, loopExitBlock);

  const body = loopStmt.childForFieldName('body');
  const bodyBlock = S.makeBlock('loop_body');
  S.addEdge(headerBlock, bodyBlock, 'branch_true');

  const bodyStmts = getBodyStatements(body, cfgRules);
  const bodyEnd = processStatements(bodyStmts, bodyBlock, S, cfgRules);
  if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

  S.loopStack.pop();
  return loopExitBlock;
}
