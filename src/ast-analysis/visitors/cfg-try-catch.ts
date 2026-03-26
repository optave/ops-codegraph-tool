import type { TreeSitterNode } from '../../types.js';
import type { ProcessStatementsFn } from './cfg-loops.js';
import type { AnyRules, CfgBlockInternal, FuncState } from './cfg-shared.js';
import { getBodyStatements, nn } from './cfg-shared.js';

export function processTryCatch(
  tryStmt: TreeSitterNode,
  currentBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): CfgBlockInternal {
  currentBlock.endLine = tryStmt.startPosition.row + 1;

  const joinBlock = S.makeBlock('body');

  const tryBody = tryStmt.childForFieldName('body');
  let tryBodyStart: number;
  let tryStmts: TreeSitterNode[];
  if (tryBody) {
    tryBodyStart = tryBody.startPosition.row + 1;
    tryStmts = getBodyStatements(tryBody, cfgRules);
  } else {
    tryBodyStart = tryStmt.startPosition.row + 1;
    tryStmts = [];
    for (let i = 0; i < tryStmt.namedChildCount; i++) {
      const child = nn(tryStmt.namedChild(i));
      if (cfgRules.catchNode && child.type === cfgRules.catchNode) continue;
      if (cfgRules.finallyNode && child.type === cfgRules.finallyNode) continue;
      tryStmts.push(child);
    }
  }

  const tryBlock = S.makeBlock('body', tryBodyStart, null, 'try');
  S.addEdge(currentBlock, tryBlock, 'fallthrough');
  const tryEnd = processStatements(tryStmts, tryBlock, S, cfgRules);

  const { catchHandler, finallyHandler } = findTryHandlers(tryStmt, cfgRules);

  if (catchHandler) {
    processCatchHandler(
      catchHandler,
      tryBlock,
      tryEnd,
      finallyHandler,
      joinBlock,
      S,
      cfgRules,
      processStatements,
    );
  } else if (finallyHandler) {
    processFinallyOnly(finallyHandler, tryEnd, joinBlock, S, cfgRules, processStatements);
  } else {
    if (tryEnd) S.addEdge(tryEnd, joinBlock, 'fallthrough');
  }

  return joinBlock;
}

export function findTryHandlers(
  tryStmt: TreeSitterNode,
  cfgRules: AnyRules,
): { catchHandler: TreeSitterNode | null; finallyHandler: TreeSitterNode | null } {
  let catchHandler: TreeSitterNode | null = null;
  let finallyHandler: TreeSitterNode | null = null;
  for (let i = 0; i < tryStmt.namedChildCount; i++) {
    const child = nn(tryStmt.namedChild(i));
    if (cfgRules.catchNode && child.type === cfgRules.catchNode) catchHandler = child;
    if (cfgRules.finallyNode && child.type === cfgRules.finallyNode) finallyHandler = child;
  }
  return { catchHandler, finallyHandler };
}

export function processCatchHandler(
  catchHandler: TreeSitterNode,
  tryBlock: CfgBlockInternal,
  tryEnd: CfgBlockInternal | null,
  finallyHandler: TreeSitterNode | null,
  joinBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): void {
  const catchBlock = S.makeBlock('catch', catchHandler.startPosition.row + 1, null, 'catch');
  S.addEdge(tryBlock, catchBlock, 'exception');

  const catchBodyNode = catchHandler.childForFieldName('body');
  let catchStmts: TreeSitterNode[];
  if (catchBodyNode) {
    catchStmts = getBodyStatements(catchBodyNode, cfgRules);
  } else {
    catchStmts = [];
    for (let i = 0; i < catchHandler.namedChildCount; i++) {
      catchStmts.push(nn(catchHandler.namedChild(i)));
    }
  }
  const catchEnd = processStatements(catchStmts, catchBlock, S, cfgRules);

  if (finallyHandler) {
    const finallyBlock = S.makeBlock(
      'finally',
      finallyHandler.startPosition.row + 1,
      null,
      'finally',
    );
    if (tryEnd) S.addEdge(tryEnd, finallyBlock, 'fallthrough');
    if (catchEnd) S.addEdge(catchEnd, finallyBlock, 'fallthrough');

    const finallyBodyNode = finallyHandler.childForFieldName('body');
    const finallyStmts = finallyBodyNode
      ? getBodyStatements(finallyBodyNode, cfgRules)
      : getBodyStatements(finallyHandler, cfgRules);
    const finallyEnd = processStatements(finallyStmts, finallyBlock, S, cfgRules);
    if (finallyEnd) S.addEdge(finallyEnd, joinBlock, 'fallthrough');
  } else {
    if (tryEnd) S.addEdge(tryEnd, joinBlock, 'fallthrough');
    if (catchEnd) S.addEdge(catchEnd, joinBlock, 'fallthrough');
  }
}

export function processFinallyOnly(
  finallyHandler: TreeSitterNode,
  tryEnd: CfgBlockInternal | null,
  joinBlock: CfgBlockInternal,
  S: FuncState,
  cfgRules: AnyRules,
  processStatements: ProcessStatementsFn,
): void {
  const finallyBlock = S.makeBlock(
    'finally',
    finallyHandler.startPosition.row + 1,
    null,
    'finally',
  );
  if (tryEnd) S.addEdge(tryEnd, finallyBlock, 'fallthrough');

  const finallyBodyNode = finallyHandler.childForFieldName('body');
  const finallyStmts = finallyBodyNode
    ? getBodyStatements(finallyBodyNode, cfgRules)
    : getBodyStatements(finallyHandler, cfgRules);
  const finallyEnd = processStatements(finallyStmts, finallyBlock, S, cfgRules);
  if (finallyEnd) S.addEdge(finallyEnd, joinBlock, 'fallthrough');
}
