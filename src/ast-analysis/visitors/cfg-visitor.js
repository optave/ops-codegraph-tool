/**
 * Visitor: Build intraprocedural Control Flow Graphs (CFGs) from tree-sitter AST.
 *
 * Replaces the statement-level traversal in cfg.js (buildFunctionCFG) with a
 * node-level visitor that plugs into the unified walkWithVisitors framework.
 * This eliminates the last redundant tree traversal (Mode B) in engine.js,
 * unifying all 4 analyses into a single DFS walk.
 *
 * The visitor builds basic blocks and edges incrementally via enterNode/exitNode
 * hooks, using a control-flow frame stack to track branch/loop/switch context.
 */

// ── Node-type predicates ────────────────────────────────────────────────

function isIfNode(type, cfgRules) {
  return type === cfgRules.ifNode || cfgRules.ifNodes?.has(type);
}

function isForNode(type, cfgRules) {
  return cfgRules.forNodes.has(type);
}

function isWhileNode(type, cfgRules) {
  return type === cfgRules.whileNode || cfgRules.whileNodes?.has(type);
}

function isSwitchNode(type, cfgRules) {
  return type === cfgRules.switchNode || cfgRules.switchNodes?.has(type);
}

function isCaseNode(type, cfgRules) {
  return (
    type === cfgRules.caseNode || type === cfgRules.defaultNode || cfgRules.caseNodes?.has(type)
  );
}

function isBlockNode(type, cfgRules) {
  return type === 'statement_list' || type === cfgRules.blockNode || cfgRules.blockNodes?.has(type);
}

/** Check if a node is a control-flow statement that we handle specially */
function isControlFlow(type, cfgRules) {
  return (
    isIfNode(type, cfgRules) ||
    (cfgRules.unlessNode && type === cfgRules.unlessNode) ||
    isForNode(type, cfgRules) ||
    isWhileNode(type, cfgRules) ||
    (cfgRules.untilNode && type === cfgRules.untilNode) ||
    (cfgRules.doNode && type === cfgRules.doNode) ||
    (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) ||
    isSwitchNode(type, cfgRules) ||
    (cfgRules.tryNode && type === cfgRules.tryNode) ||
    type === cfgRules.returnNode ||
    type === cfgRules.throwNode ||
    type === cfgRules.breakNode ||
    type === cfgRules.continueNode ||
    type === cfgRules.labeledNode
  );
}

// ── Utility functions ───────────────────────────────────────────────────

/**
 * Get the actual control-flow node (unwrapping expression_statement if needed).
 */
function effectiveNode(node, cfgRules) {
  if (node.type === 'expression_statement' && node.namedChildCount === 1) {
    const inner = node.namedChild(0);
    if (isControlFlow(inner.type, cfgRules)) return inner;
  }
  return node;
}

/**
 * Register a loop/switch in label map for labeled break/continue.
 */
function registerLabelCtx(S, headerBlock, exitBlock) {
  for (const [, ctx] of S.labelMap) {
    if (!ctx.headerBlock) {
      ctx.headerBlock = headerBlock;
      ctx.exitBlock = exitBlock;
    }
  }
}

/**
 * Get statements from a body node (block or single statement).
 * Returns effective (unwrapped) nodes.
 */
function getBodyStatements(bodyNode, cfgRules) {
  if (!bodyNode) return [];
  if (isBlockNode(bodyNode.type, cfgRules)) {
    const stmts = [];
    for (let i = 0; i < bodyNode.namedChildCount; i++) {
      const child = bodyNode.namedChild(i);
      if (child.type === 'statement_list') {
        for (let j = 0; j < child.namedChildCount; j++) {
          stmts.push(child.namedChild(j));
        }
      } else {
        stmts.push(child);
      }
    }
    return stmts;
  }
  return [bodyNode];
}

function makeFuncState() {
  const blocks = [];
  const edges = [];
  let nextIndex = 0;

  function makeBlock(type, startLine = null, endLine = null, label = null) {
    const block = { index: nextIndex++, type, startLine, endLine, label };
    blocks.push(block);
    return block;
  }

  function addEdge(source, target, kind) {
    edges.push({ sourceIndex: source.index, targetIndex: target.index, kind });
  }

  const entry = makeBlock('entry');
  const exit = makeBlock('exit');
  const firstBody = makeBlock('body');
  addEdge(entry, firstBody, 'fallthrough');

  return {
    blocks,
    edges,
    makeBlock,
    addEdge,
    entryBlock: entry,
    exitBlock: exit,
    currentBlock: firstBody,
    loopStack: [],
    labelMap: new Map(),
    cfgStack: [],
    funcNode: null,
  };
}

// ── Statement processors ────────────────────────────────────────────────

function processStatements(stmts, currentBlock, S, cfgRules) {
  let cur = currentBlock;
  for (const stmt of stmts) {
    if (!cur) break;
    cur = processStatement(stmt, cur, S, cfgRules);
  }
  return cur;
}

function processStatement(stmt, currentBlock, S, cfgRules) {
  if (!stmt || !currentBlock) return currentBlock;

  const effNode = effectiveNode(stmt, cfgRules);
  const type = effNode.type;

  if (type === cfgRules.labeledNode) {
    return processLabeled(effNode, currentBlock, S, cfgRules);
  }
  if (isIfNode(type, cfgRules) || (cfgRules.unlessNode && type === cfgRules.unlessNode)) {
    return processIf(effNode, currentBlock, S, cfgRules);
  }
  if (isForNode(type, cfgRules)) {
    return processForLoop(effNode, currentBlock, S, cfgRules);
  }
  if (isWhileNode(type, cfgRules) || (cfgRules.untilNode && type === cfgRules.untilNode)) {
    return processWhileLoop(effNode, currentBlock, S, cfgRules);
  }
  if (cfgRules.doNode && type === cfgRules.doNode) {
    return processDoWhileLoop(effNode, currentBlock, S, cfgRules);
  }
  if (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) {
    return processInfiniteLoop(effNode, currentBlock, S, cfgRules);
  }
  if (isSwitchNode(type, cfgRules)) {
    return processSwitch(effNode, currentBlock, S, cfgRules);
  }
  if (cfgRules.tryNode && type === cfgRules.tryNode) {
    return processTryCatch(effNode, currentBlock, S, cfgRules);
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

  // Regular statement — extend current block
  if (!currentBlock.startLine) {
    currentBlock.startLine = stmt.startPosition.row + 1;
  }
  currentBlock.endLine = stmt.endPosition.row + 1;
  return currentBlock;
}

// ── Labeled / break / continue ──────────────────────────────────────────

function processLabeled(node, currentBlock, S, cfgRules) {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;
  const body = node.childForFieldName('body');
  if (body && labelName) {
    const labelCtx = { headerBlock: null, exitBlock: null };
    S.labelMap.set(labelName, labelCtx);
    const result = processStatement(body, currentBlock, S, cfgRules);
    S.labelMap.delete(labelName);
    return result;
  }
  return currentBlock;
}

function processBreak(node, currentBlock, S) {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;

  let target = null;
  if (labelName && S.labelMap.has(labelName)) {
    target = S.labelMap.get(labelName).exitBlock;
  } else if (S.loopStack.length > 0) {
    target = S.loopStack[S.loopStack.length - 1].exitBlock;
  }

  if (target) {
    currentBlock.endLine = node.startPosition.row + 1;
    S.addEdge(currentBlock, target, 'break');
    return null;
  }
  return currentBlock;
}

function processContinue(node, currentBlock, S) {
  const labelNode = node.childForFieldName('label');
  const labelName = labelNode ? labelNode.text : null;

  let target = null;
  if (labelName && S.labelMap.has(labelName)) {
    target = S.labelMap.get(labelName).headerBlock;
  } else if (S.loopStack.length > 0) {
    target = S.loopStack[S.loopStack.length - 1].headerBlock;
  }

  if (target) {
    currentBlock.endLine = node.startPosition.row + 1;
    S.addEdge(currentBlock, target, 'continue');
    return null;
  }
  return currentBlock;
}

// ── If / else-if / else ─────────────────────────────────────────────────

function processIf(ifStmt, currentBlock, S, cfgRules) {
  currentBlock.endLine = ifStmt.startPosition.row + 1;

  const condBlock = S.makeBlock(
    'condition',
    ifStmt.startPosition.row + 1,
    ifStmt.startPosition.row + 1,
    'if',
  );
  S.addEdge(currentBlock, condBlock, 'fallthrough');

  const joinBlock = S.makeBlock('body');

  // True branch
  const consequentField = cfgRules.ifConsequentField || 'consequence';
  const consequent = ifStmt.childForFieldName(consequentField);
  const trueBlock = S.makeBlock('branch_true', null, null, 'then');
  S.addEdge(condBlock, trueBlock, 'branch_true');
  const trueStmts = getBodyStatements(consequent, cfgRules);
  const trueEnd = processStatements(trueStmts, trueBlock, S, cfgRules);
  if (trueEnd) {
    S.addEdge(trueEnd, joinBlock, 'fallthrough');
  }

  // False branch
  if (cfgRules.elifNode) {
    processElifSiblings(ifStmt, condBlock, joinBlock, S, cfgRules);
  } else {
    processAlternative(ifStmt, condBlock, joinBlock, S, cfgRules);
  }

  return joinBlock;
}

function processAlternative(ifStmt, condBlock, joinBlock, S, cfgRules) {
  const alternative = ifStmt.childForFieldName('alternative');
  if (!alternative) {
    S.addEdge(condBlock, joinBlock, 'branch_false');
    return;
  }

  if (cfgRules.elseViaAlternative && alternative.type !== cfgRules.elseClause) {
    // Pattern C: direct alternative (Go, Java, C#)
    if (isIfNode(alternative.type, cfgRules)) {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const elseIfEnd = processIf(alternative, falseBlock, S, cfgRules);
      if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
    } else {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const falseStmts = getBodyStatements(alternative, cfgRules);
      const falseEnd = processStatements(falseStmts, falseBlock, S, cfgRules);
      if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
    }
  } else if (alternative.type === cfgRules.elseClause) {
    // Pattern A: else_clause wrapper (JS/TS, Rust)
    const elseChildren = [];
    for (let i = 0; i < alternative.namedChildCount; i++) {
      elseChildren.push(alternative.namedChild(i));
    }
    if (elseChildren.length === 1 && isIfNode(elseChildren[0].type, cfgRules)) {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const elseIfEnd = processIf(elseChildren[0], falseBlock, S, cfgRules);
      if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
    } else {
      const falseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(condBlock, falseBlock, 'branch_false');
      const falseEnd = processStatements(elseChildren, falseBlock, S, cfgRules);
      if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
    }
  }
}

function processElifSiblings(ifStmt, firstCondBlock, joinBlock, S, cfgRules) {
  let lastCondBlock = firstCondBlock;
  let foundElse = false;

  for (let i = 0; i < ifStmt.namedChildCount; i++) {
    const child = ifStmt.namedChild(i);

    if (child.type === cfgRules.elifNode) {
      const elifCondBlock = S.makeBlock(
        'condition',
        child.startPosition.row + 1,
        child.startPosition.row + 1,
        'else-if',
      );
      S.addEdge(lastCondBlock, elifCondBlock, 'branch_false');

      const elifConsequentField = cfgRules.ifConsequentField || 'consequence';
      const elifConsequent = child.childForFieldName(elifConsequentField);
      const elifTrueBlock = S.makeBlock('branch_true', null, null, 'then');
      S.addEdge(elifCondBlock, elifTrueBlock, 'branch_true');
      const elifTrueStmts = getBodyStatements(elifConsequent, cfgRules);
      const elifTrueEnd = processStatements(elifTrueStmts, elifTrueBlock, S, cfgRules);
      if (elifTrueEnd) S.addEdge(elifTrueEnd, joinBlock, 'fallthrough');

      lastCondBlock = elifCondBlock;
    } else if (child.type === cfgRules.elseClause) {
      const elseBlock = S.makeBlock('branch_false', null, null, 'else');
      S.addEdge(lastCondBlock, elseBlock, 'branch_false');

      const elseBody = child.childForFieldName('body');
      let elseStmts;
      if (elseBody) {
        elseStmts = getBodyStatements(elseBody, cfgRules);
      } else {
        elseStmts = [];
        for (let j = 0; j < child.namedChildCount; j++) {
          elseStmts.push(child.namedChild(j));
        }
      }
      const elseEnd = processStatements(elseStmts, elseBlock, S, cfgRules);
      if (elseEnd) S.addEdge(elseEnd, joinBlock, 'fallthrough');

      foundElse = true;
    }
  }

  if (!foundElse) {
    S.addEdge(lastCondBlock, joinBlock, 'branch_false');
  }
}

// ── Loops ───────────────────────────────────────────────────────────────

function processForLoop(forStmt, currentBlock, S, cfgRules) {
  const headerBlock = S.makeBlock(
    'loop_header',
    forStmt.startPosition.row + 1,
    forStmt.startPosition.row + 1,
    'for',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx = { headerBlock, exitBlock: loopExitBlock };
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

function processWhileLoop(whileStmt, currentBlock, S, cfgRules) {
  const headerBlock = S.makeBlock(
    'loop_header',
    whileStmt.startPosition.row + 1,
    whileStmt.startPosition.row + 1,
    'while',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx = { headerBlock, exitBlock: loopExitBlock };
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

function processDoWhileLoop(doStmt, currentBlock, S, cfgRules) {
  const bodyBlock = S.makeBlock('loop_body', doStmt.startPosition.row + 1, null, 'do');
  S.addEdge(currentBlock, bodyBlock, 'fallthrough');

  const condBlock = S.makeBlock('loop_header', null, null, 'do-while');
  const loopExitBlock = S.makeBlock('body');

  const loopCtx = { headerBlock: condBlock, exitBlock: loopExitBlock };
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

function processInfiniteLoop(loopStmt, currentBlock, S, cfgRules) {
  const headerBlock = S.makeBlock(
    'loop_header',
    loopStmt.startPosition.row + 1,
    loopStmt.startPosition.row + 1,
    'loop',
  );
  S.addEdge(currentBlock, headerBlock, 'fallthrough');

  const loopExitBlock = S.makeBlock('body');
  const loopCtx = { headerBlock, exitBlock: loopExitBlock };
  S.loopStack.push(loopCtx);
  registerLabelCtx(S, headerBlock, loopExitBlock);

  const body = loopStmt.childForFieldName('body');
  const bodyBlock = S.makeBlock('loop_body');
  S.addEdge(headerBlock, bodyBlock, 'branch_true');

  const bodyStmts = getBodyStatements(body, cfgRules);
  const bodyEnd = processStatements(bodyStmts, bodyBlock, S, cfgRules);
  if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

  // No loop_exit from header — only via break
  S.loopStack.pop();
  return loopExitBlock;
}

// ── Switch / match ──────────────────────────────────────────────────────

function processSwitch(switchStmt, currentBlock, S, cfgRules) {
  currentBlock.endLine = switchStmt.startPosition.row + 1;

  const switchHeader = S.makeBlock(
    'condition',
    switchStmt.startPosition.row + 1,
    switchStmt.startPosition.row + 1,
    'switch',
  );
  S.addEdge(currentBlock, switchHeader, 'fallthrough');

  const joinBlock = S.makeBlock('body');
  const switchCtx = { headerBlock: switchHeader, exitBlock: joinBlock };
  S.loopStack.push(switchCtx);

  const switchBody = switchStmt.childForFieldName('body');
  const container = switchBody || switchStmt;

  let hasDefault = false;
  for (let i = 0; i < container.namedChildCount; i++) {
    const caseClause = container.namedChild(i);

    const isDefault = caseClause.type === cfgRules.defaultNode;
    const isCase = isDefault || isCaseNode(caseClause.type, cfgRules);
    if (!isCase) continue;

    const caseLabel = isDefault ? 'default' : 'case';
    const caseBlock = S.makeBlock('case', caseClause.startPosition.row + 1, null, caseLabel);
    S.addEdge(switchHeader, caseBlock, isDefault ? 'branch_false' : 'branch_true');
    if (isDefault) hasDefault = true;

    const caseStmts = extractCaseBody(caseClause, cfgRules);
    const caseEnd = processStatements(caseStmts, caseBlock, S, cfgRules);
    if (caseEnd) S.addEdge(caseEnd, joinBlock, 'fallthrough');
  }

  if (!hasDefault) {
    S.addEdge(switchHeader, joinBlock, 'branch_false');
  }

  S.loopStack.pop();
  return joinBlock;
}

function extractCaseBody(caseClause, cfgRules) {
  const caseBodyNode =
    caseClause.childForFieldName('body') || caseClause.childForFieldName('consequence');
  if (caseBodyNode) {
    return getBodyStatements(caseBodyNode, cfgRules);
  }

  const stmts = [];
  const valueNode = caseClause.childForFieldName('value');
  const patternNode = caseClause.childForFieldName('pattern');
  for (let j = 0; j < caseClause.namedChildCount; j++) {
    const child = caseClause.namedChild(j);
    if (child !== valueNode && child !== patternNode && child.type !== 'switch_label') {
      if (child.type === 'statement_list') {
        for (let k = 0; k < child.namedChildCount; k++) {
          stmts.push(child.namedChild(k));
        }
      } else {
        stmts.push(child);
      }
    }
  }
  return stmts;
}

// ── Try / catch / finally ───────────────────────────────────────────────

function processTryCatch(tryStmt, currentBlock, S, cfgRules) {
  currentBlock.endLine = tryStmt.startPosition.row + 1;

  const joinBlock = S.makeBlock('body');

  // Try body
  const tryBody = tryStmt.childForFieldName('body');
  let tryBodyStart;
  let tryStmts;
  if (tryBody) {
    tryBodyStart = tryBody.startPosition.row + 1;
    tryStmts = getBodyStatements(tryBody, cfgRules);
  } else {
    tryBodyStart = tryStmt.startPosition.row + 1;
    tryStmts = [];
    for (let i = 0; i < tryStmt.namedChildCount; i++) {
      const child = tryStmt.namedChild(i);
      if (cfgRules.catchNode && child.type === cfgRules.catchNode) continue;
      if (cfgRules.finallyNode && child.type === cfgRules.finallyNode) continue;
      tryStmts.push(child);
    }
  }

  const tryBlock = S.makeBlock('body', tryBodyStart, null, 'try');
  S.addEdge(currentBlock, tryBlock, 'fallthrough');
  const tryEnd = processStatements(tryStmts, tryBlock, S, cfgRules);

  // Find catch and finally handlers
  const { catchHandler, finallyHandler } = findTryHandlers(tryStmt, cfgRules);

  if (catchHandler) {
    processCatchHandler(catchHandler, tryBlock, tryEnd, finallyHandler, joinBlock, S, cfgRules);
  } else if (finallyHandler) {
    processFinallyOnly(finallyHandler, tryEnd, joinBlock, S, cfgRules);
  } else {
    if (tryEnd) S.addEdge(tryEnd, joinBlock, 'fallthrough');
  }

  return joinBlock;
}

function findTryHandlers(tryStmt, cfgRules) {
  let catchHandler = null;
  let finallyHandler = null;
  for (let i = 0; i < tryStmt.namedChildCount; i++) {
    const child = tryStmt.namedChild(i);
    if (cfgRules.catchNode && child.type === cfgRules.catchNode) catchHandler = child;
    if (cfgRules.finallyNode && child.type === cfgRules.finallyNode) finallyHandler = child;
  }
  return { catchHandler, finallyHandler };
}

function processCatchHandler(
  catchHandler,
  tryBlock,
  tryEnd,
  finallyHandler,
  joinBlock,
  S,
  cfgRules,
) {
  const catchBlock = S.makeBlock('catch', catchHandler.startPosition.row + 1, null, 'catch');
  S.addEdge(tryBlock, catchBlock, 'exception');

  const catchBodyNode = catchHandler.childForFieldName('body');
  let catchStmts;
  if (catchBodyNode) {
    catchStmts = getBodyStatements(catchBodyNode, cfgRules);
  } else {
    catchStmts = [];
    for (let i = 0; i < catchHandler.namedChildCount; i++) {
      catchStmts.push(catchHandler.namedChild(i));
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

function processFinallyOnly(finallyHandler, tryEnd, joinBlock, S, cfgRules) {
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

// ── Enter-function body processing ──────────────────────────────────────

function processFunctionBody(funcNode, S, cfgRules) {
  const body = funcNode.childForFieldName('body');
  if (!body) {
    // No body — entry → exit
    S.blocks.length = 2;
    S.edges.length = 0;
    S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  if (!isBlockNode(body.type, cfgRules)) {
    // Expression body (e.g., arrow function `(x) => x + 1`)
    const bodyBlock = S.blocks[2];
    bodyBlock.startLine = body.startPosition.row + 1;
    bodyBlock.endLine = body.endPosition.row + 1;
    S.addEdge(bodyBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  // Block body — process statements
  const stmts = getBodyStatements(body, cfgRules);
  if (stmts.length === 0) {
    S.blocks.length = 2;
    S.edges.length = 0;
    S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
    S.currentBlock = null;
    return;
  }

  const firstBody = S.blocks[2];
  const lastBlock = processStatements(stmts, firstBody, S, cfgRules);
  if (lastBlock) {
    S.addEdge(lastBlock, S.exitBlock, 'fallthrough');
  }
  S.currentBlock = null;
}

// ── Visitor factory ─────────────────────────────────────────────────────

/**
 * Create a CFG visitor for use with walkWithVisitors.
 *
 * @param {object} cfgRules - CFG_RULES for the language
 * @returns {Visitor}
 */
export function createCfgVisitor(cfgRules) {
  const funcStateStack = [];
  let S = null;
  const results = [];

  return {
    name: 'cfg',
    functionNodeTypes: cfgRules.functionNodes,

    enterFunction(funcNode, _funcName, _context) {
      if (S) funcStateStack.push(S);
      S = makeFuncState();
      S.funcNode = funcNode;
      processFunctionBody(funcNode, S, cfgRules);
    },

    exitFunction(funcNode, _funcName, _context) {
      if (S && S.funcNode === funcNode) {
        const cyclomatic = S.edges.length - S.blocks.length + 2;
        results.push({
          funcNode: S.funcNode,
          blocks: S.blocks,
          edges: S.edges,
          cyclomatic: Math.max(cyclomatic, 1),
        });
      }
      S = funcStateStack.length > 0 ? funcStateStack.pop() : null;
    },

    enterNode(_node, _context) {
      // No-op — all CFG construction is done in enterFunction via processStatements.
      // We intentionally do NOT return skipChildren so the walker recurses into
      // children, allowing nested functions to trigger enterFunction/exitFunction.
    },

    exitNode(_node, _context) {
      // No-op
    },

    finish() {
      return results;
    },
  };
}
