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

/**
 * Create a CFG visitor for use with walkWithVisitors.
 *
 * @param {object} cfgRules - CFG_RULES for the language
 * @returns {Visitor}
 */
export function createCfgVisitor(cfgRules) {
  // ── Per-function state ──────────────────────────────────────────────
  // Pushed/popped on enterFunction/exitFunction for nested function support.

  /** @type {Array<object>} Stack of per-function CFG state */
  const funcStateStack = [];

  /** @type {object|null} Active per-function state */
  let S = null;

  // Collected results (one per top-level function)
  const results = [];

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
      /** Control-flow frame stack for nested if/switch/try/loop/labeled */
      cfgStack: [],
      funcNode: null,
    };
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  function isIfNode(type) {
    return type === cfgRules.ifNode || cfgRules.ifNodes?.has(type);
  }

  function isForNode(type) {
    return cfgRules.forNodes.has(type);
  }

  function isWhileNode(type) {
    return type === cfgRules.whileNode || cfgRules.whileNodes?.has(type);
  }

  function isSwitchNode(type) {
    return type === cfgRules.switchNode || cfgRules.switchNodes?.has(type);
  }

  function isCaseNode(type) {
    return (
      type === cfgRules.caseNode || type === cfgRules.defaultNode || cfgRules.caseNodes?.has(type)
    );
  }

  function isBlockNode(type) {
    return (
      type === 'statement_list' || type === cfgRules.blockNode || cfgRules.blockNodes?.has(type)
    );
  }

  /** Check if a node is a control-flow statement that we handle specially */
  function isControlFlow(type) {
    return (
      isIfNode(type) ||
      (cfgRules.unlessNode && type === cfgRules.unlessNode) ||
      isForNode(type) ||
      isWhileNode(type) ||
      (cfgRules.untilNode && type === cfgRules.untilNode) ||
      (cfgRules.doNode && type === cfgRules.doNode) ||
      (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) ||
      isSwitchNode(type) ||
      (cfgRules.tryNode && type === cfgRules.tryNode) ||
      type === cfgRules.returnNode ||
      type === cfgRules.throwNode ||
      type === cfgRules.breakNode ||
      type === cfgRules.continueNode ||
      type === cfgRules.labeledNode
    );
  }

  /**
   * Get the actual control-flow node (unwrapping expression_statement if needed).
   */
  function effectiveNode(node) {
    if (node.type === 'expression_statement' && node.namedChildCount === 1) {
      const inner = node.namedChild(0);
      if (isControlFlow(inner.type)) return inner;
    }
    return node;
  }

  /**
   * Register a loop/switch in label map for labeled break/continue.
   */
  function registerLabelCtx(headerBlock, exitBlock) {
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
  function getBodyStatements(bodyNode) {
    if (!bodyNode) return [];
    if (isBlockNode(bodyNode.type)) {
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

  // ── Statement-level processing (replicates buildFunctionCFG logic) ──
  // The visitor delegates to these for each control-flow construct,
  // processing the body statements sequentially just like the original.

  function processStatements(stmts, currentBlock) {
    let cur = currentBlock;
    for (const stmt of stmts) {
      if (!cur) break;
      cur = processStatement(stmt, cur);
    }
    return cur;
  }

  function processStatement(stmt, currentBlock) {
    if (!stmt || !currentBlock) return currentBlock;

    // Unwrap expression_statement for Rust-style control flow expressions
    const effNode = effectiveNode(stmt);
    const type = effNode.type;

    // Labeled statement
    if (type === cfgRules.labeledNode) {
      return processLabeled(effNode, currentBlock);
    }

    // If / unless
    if (isIfNode(type) || (cfgRules.unlessNode && type === cfgRules.unlessNode)) {
      return processIf(effNode, currentBlock);
    }

    // For loops
    if (isForNode(type)) {
      return processForLoop(effNode, currentBlock);
    }

    // While / until
    if (isWhileNode(type) || (cfgRules.untilNode && type === cfgRules.untilNode)) {
      return processWhileLoop(effNode, currentBlock);
    }

    // Do-while
    if (cfgRules.doNode && type === cfgRules.doNode) {
      return processDoWhileLoop(effNode, currentBlock);
    }

    // Infinite loop (Rust)
    if (cfgRules.infiniteLoopNode && type === cfgRules.infiniteLoopNode) {
      return processInfiniteLoop(effNode, currentBlock);
    }

    // Switch / match
    if (isSwitchNode(type)) {
      return processSwitch(effNode, currentBlock);
    }

    // Try/catch/finally
    if (cfgRules.tryNode && type === cfgRules.tryNode) {
      return processTryCatch(effNode, currentBlock);
    }

    // Return
    if (type === cfgRules.returnNode) {
      currentBlock.endLine = effNode.startPosition.row + 1;
      S.addEdge(currentBlock, S.exitBlock, 'return');
      return null;
    }

    // Throw
    if (type === cfgRules.throwNode) {
      currentBlock.endLine = effNode.startPosition.row + 1;
      S.addEdge(currentBlock, S.exitBlock, 'exception');
      return null;
    }

    // Break
    if (type === cfgRules.breakNode) {
      return processBreak(effNode, currentBlock);
    }

    // Continue
    if (type === cfgRules.continueNode) {
      return processContinue(effNode, currentBlock);
    }

    // Regular statement — extend current block
    if (!currentBlock.startLine) {
      currentBlock.startLine = stmt.startPosition.row + 1;
    }
    currentBlock.endLine = stmt.endPosition.row + 1;
    return currentBlock;
  }

  function processLabeled(node, currentBlock) {
    const labelNode = node.childForFieldName('label');
    const labelName = labelNode ? labelNode.text : null;
    const body = node.childForFieldName('body');
    if (body && labelName) {
      const labelCtx = { headerBlock: null, exitBlock: null };
      S.labelMap.set(labelName, labelCtx);
      const result = processStatement(body, currentBlock);
      S.labelMap.delete(labelName);
      return result;
    }
    return currentBlock;
  }

  function processBreak(node, currentBlock) {
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

  function processContinue(node, currentBlock) {
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

  // ── If/else-if/else ─────────────────────────────────────────────────

  function processIf(ifStmt, currentBlock) {
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
    const trueStmts = getBodyStatements(consequent);
    const trueEnd = processStatements(trueStmts, trueBlock);
    if (trueEnd) {
      S.addEdge(trueEnd, joinBlock, 'fallthrough');
    }

    // False branch
    if (cfgRules.elifNode) {
      processElifSiblings(ifStmt, condBlock, joinBlock);
    } else {
      const alternative = ifStmt.childForFieldName('alternative');
      if (alternative) {
        if (cfgRules.elseViaAlternative && alternative.type !== cfgRules.elseClause) {
          // Pattern C: direct alternative (Go, Java, C#)
          if (isIfNode(alternative.type)) {
            const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
            S.addEdge(condBlock, falseBlock, 'branch_false');
            const elseIfEnd = processIf(alternative, falseBlock);
            if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
          } else {
            const falseBlock = S.makeBlock('branch_false', null, null, 'else');
            S.addEdge(condBlock, falseBlock, 'branch_false');
            const falseStmts = getBodyStatements(alternative);
            const falseEnd = processStatements(falseStmts, falseBlock);
            if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
          }
        } else if (alternative.type === cfgRules.elseClause) {
          // Pattern A: else_clause wrapper (JS/TS, Rust)
          const elseChildren = [];
          for (let i = 0; i < alternative.namedChildCount; i++) {
            elseChildren.push(alternative.namedChild(i));
          }
          if (elseChildren.length === 1 && isIfNode(elseChildren[0].type)) {
            const falseBlock = S.makeBlock('branch_false', null, null, 'else-if');
            S.addEdge(condBlock, falseBlock, 'branch_false');
            const elseIfEnd = processIf(elseChildren[0], falseBlock);
            if (elseIfEnd) S.addEdge(elseIfEnd, joinBlock, 'fallthrough');
          } else {
            const falseBlock = S.makeBlock('branch_false', null, null, 'else');
            S.addEdge(condBlock, falseBlock, 'branch_false');
            const falseEnd = processStatements(elseChildren, falseBlock);
            if (falseEnd) S.addEdge(falseEnd, joinBlock, 'fallthrough');
          }
        }
      } else {
        // No else
        S.addEdge(condBlock, joinBlock, 'branch_false');
      }
    }

    return joinBlock;
  }

  function processElifSiblings(ifStmt, firstCondBlock, joinBlock) {
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
        const elifTrueStmts = getBodyStatements(elifConsequent);
        const elifTrueEnd = processStatements(elifTrueStmts, elifTrueBlock);
        if (elifTrueEnd) S.addEdge(elifTrueEnd, joinBlock, 'fallthrough');

        lastCondBlock = elifCondBlock;
      } else if (child.type === cfgRules.elseClause) {
        const elseBlock = S.makeBlock('branch_false', null, null, 'else');
        S.addEdge(lastCondBlock, elseBlock, 'branch_false');

        const elseBody = child.childForFieldName('body');
        let elseStmts;
        if (elseBody) {
          elseStmts = getBodyStatements(elseBody);
        } else {
          elseStmts = [];
          for (let j = 0; j < child.namedChildCount; j++) {
            elseStmts.push(child.namedChild(j));
          }
        }
        const elseEnd = processStatements(elseStmts, elseBlock);
        if (elseEnd) S.addEdge(elseEnd, joinBlock, 'fallthrough');

        foundElse = true;
      }
    }

    if (!foundElse) {
      S.addEdge(lastCondBlock, joinBlock, 'branch_false');
    }
  }

  // ── Loops ───────────────────────────────────────────────────────────

  function processForLoop(forStmt, currentBlock) {
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
    registerLabelCtx(headerBlock, loopExitBlock);

    const body = forStmt.childForFieldName('body');
    const bodyBlock = S.makeBlock('loop_body');
    S.addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getBodyStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);
    if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

    S.addEdge(headerBlock, loopExitBlock, 'loop_exit');
    S.loopStack.pop();
    return loopExitBlock;
  }

  function processWhileLoop(whileStmt, currentBlock) {
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
    registerLabelCtx(headerBlock, loopExitBlock);

    const body = whileStmt.childForFieldName('body');
    const bodyBlock = S.makeBlock('loop_body');
    S.addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getBodyStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);
    if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

    S.addEdge(headerBlock, loopExitBlock, 'loop_exit');
    S.loopStack.pop();
    return loopExitBlock;
  }

  function processDoWhileLoop(doStmt, currentBlock) {
    const bodyBlock = S.makeBlock('loop_body', doStmt.startPosition.row + 1, null, 'do');
    S.addEdge(currentBlock, bodyBlock, 'fallthrough');

    const condBlock = S.makeBlock('loop_header', null, null, 'do-while');
    const loopExitBlock = S.makeBlock('body');

    const loopCtx = { headerBlock: condBlock, exitBlock: loopExitBlock };
    S.loopStack.push(loopCtx);
    registerLabelCtx(condBlock, loopExitBlock);

    const body = doStmt.childForFieldName('body');
    const bodyStmts = getBodyStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);
    if (bodyEnd) S.addEdge(bodyEnd, condBlock, 'fallthrough');

    S.addEdge(condBlock, bodyBlock, 'loop_back');
    S.addEdge(condBlock, loopExitBlock, 'loop_exit');

    S.loopStack.pop();
    return loopExitBlock;
  }

  function processInfiniteLoop(loopStmt, currentBlock) {
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
    registerLabelCtx(headerBlock, loopExitBlock);

    const body = loopStmt.childForFieldName('body');
    const bodyBlock = S.makeBlock('loop_body');
    S.addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getBodyStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);
    if (bodyEnd) S.addEdge(bodyEnd, headerBlock, 'loop_back');

    // No loop_exit from header — only via break
    S.loopStack.pop();
    return loopExitBlock;
  }

  // ── Switch / match ──────────────────────────────────────────────────

  function processSwitch(switchStmt, currentBlock) {
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
      const isCase = isDefault || isCaseNode(caseClause.type);
      if (!isCase) continue;

      const caseLabel = isDefault ? 'default' : 'case';
      const caseBlock = S.makeBlock('case', caseClause.startPosition.row + 1, null, caseLabel);
      S.addEdge(switchHeader, caseBlock, isDefault ? 'branch_false' : 'branch_true');
      if (isDefault) hasDefault = true;

      // Extract case body
      const caseBodyNode =
        caseClause.childForFieldName('body') || caseClause.childForFieldName('consequence');
      let caseStmts;
      if (caseBodyNode) {
        caseStmts = getBodyStatements(caseBodyNode);
      } else {
        caseStmts = [];
        const valueNode = caseClause.childForFieldName('value');
        const patternNode = caseClause.childForFieldName('pattern');
        for (let j = 0; j < caseClause.namedChildCount; j++) {
          const child = caseClause.namedChild(j);
          if (child !== valueNode && child !== patternNode && child.type !== 'switch_label') {
            if (child.type === 'statement_list') {
              for (let k = 0; k < child.namedChildCount; k++) {
                caseStmts.push(child.namedChild(k));
              }
            } else {
              caseStmts.push(child);
            }
          }
        }
      }

      const caseEnd = processStatements(caseStmts, caseBlock);
      if (caseEnd) S.addEdge(caseEnd, joinBlock, 'fallthrough');
    }

    if (!hasDefault) {
      S.addEdge(switchHeader, joinBlock, 'branch_false');
    }

    S.loopStack.pop();
    return joinBlock;
  }

  // ── Try/catch/finally ───────────────────────────────────────────────

  function processTryCatch(tryStmt, currentBlock) {
    currentBlock.endLine = tryStmt.startPosition.row + 1;

    const joinBlock = S.makeBlock('body');

    // Try body
    const tryBody = tryStmt.childForFieldName('body');
    let tryBodyStart;
    let tryStmts;
    if (tryBody) {
      tryBodyStart = tryBody.startPosition.row + 1;
      tryStmts = getBodyStatements(tryBody);
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
    const tryEnd = processStatements(tryStmts, tryBlock);

    // Find catch and finally handlers
    let catchHandler = null;
    let finallyHandler = null;
    for (let i = 0; i < tryStmt.namedChildCount; i++) {
      const child = tryStmt.namedChild(i);
      if (cfgRules.catchNode && child.type === cfgRules.catchNode) catchHandler = child;
      if (cfgRules.finallyNode && child.type === cfgRules.finallyNode) finallyHandler = child;
    }

    if (catchHandler) {
      const catchBlock = S.makeBlock('catch', catchHandler.startPosition.row + 1, null, 'catch');
      S.addEdge(tryBlock, catchBlock, 'exception');

      const catchBodyNode = catchHandler.childForFieldName('body');
      let catchStmts;
      if (catchBodyNode) {
        catchStmts = getBodyStatements(catchBodyNode);
      } else {
        catchStmts = [];
        for (let i = 0; i < catchHandler.namedChildCount; i++) {
          catchStmts.push(catchHandler.namedChild(i));
        }
      }
      const catchEnd = processStatements(catchStmts, catchBlock);

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
          ? getBodyStatements(finallyBodyNode)
          : getBodyStatements(finallyHandler);
        const finallyEnd = processStatements(finallyStmts, finallyBlock);
        if (finallyEnd) S.addEdge(finallyEnd, joinBlock, 'fallthrough');
      } else {
        if (tryEnd) S.addEdge(tryEnd, joinBlock, 'fallthrough');
        if (catchEnd) S.addEdge(catchEnd, joinBlock, 'fallthrough');
      }
    } else if (finallyHandler) {
      const finallyBlock = S.makeBlock(
        'finally',
        finallyHandler.startPosition.row + 1,
        null,
        'finally',
      );
      if (tryEnd) S.addEdge(tryEnd, finallyBlock, 'fallthrough');

      const finallyBodyNode = finallyHandler.childForFieldName('body');
      const finallyStmts = finallyBodyNode
        ? getBodyStatements(finallyBodyNode)
        : getBodyStatements(finallyHandler);
      const finallyEnd = processStatements(finallyStmts, finallyBlock);
      if (finallyEnd) S.addEdge(finallyEnd, joinBlock, 'fallthrough');
    } else {
      if (tryEnd) S.addEdge(tryEnd, joinBlock, 'fallthrough');
    }

    return joinBlock;
  }

  // ── Visitor interface ───────────────────────────────────────────────

  return {
    name: 'cfg',
    functionNodeTypes: cfgRules.functionNodes,

    enterFunction(funcNode, _funcName, _context) {
      if (S) {
        // Nested function — push current state
        funcStateStack.push(S);
      }
      S = makeFuncState();
      S.funcNode = funcNode;

      // Check for expression body (arrow functions): no block body
      const body = funcNode.childForFieldName('body');
      if (!body) {
        // No body at all — entry → exit
        // Remove the firstBody block and its edge
        S.blocks.length = 2; // keep entry + exit
        S.edges.length = 0;
        S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
        S.currentBlock = null;
        return;
      }

      if (!isBlockNode(body.type)) {
        // Expression body (e.g., arrow function `(x) => x + 1`)
        // entry → body → exit (body is the expression)
        const bodyBlock = S.blocks[2]; // the firstBody we already created
        bodyBlock.startLine = body.startPosition.row + 1;
        bodyBlock.endLine = body.endPosition.row + 1;
        S.addEdge(bodyBlock, S.exitBlock, 'fallthrough');
        S.currentBlock = null; // no further processing needed
        return;
      }

      // Block body — process statements
      const stmts = getBodyStatements(body);
      if (stmts.length === 0) {
        // Empty function
        S.blocks.length = 2;
        S.edges.length = 0;
        S.addEdge(S.entryBlock, S.exitBlock, 'fallthrough');
        S.currentBlock = null;
        return;
      }

      // Process all body statements using the statement-level processor
      const firstBody = S.blocks[2]; // the firstBody block
      const lastBlock = processStatements(stmts, firstBody);
      if (lastBlock) {
        S.addEdge(lastBlock, S.exitBlock, 'fallthrough');
      }
      S.currentBlock = null; // done processing
    },

    exitFunction(funcNode, _funcName, _context) {
      if (S && S.funcNode === funcNode) {
        // Derive cyclomatic complexity from CFG: E - N + 2
        const cyclomatic = S.edges.length - S.blocks.length + 2;
        results.push({
          funcNode: S.funcNode,
          blocks: S.blocks,
          edges: S.edges,
          cyclomatic: Math.max(cyclomatic, 1),
        });
      }

      // Pop to parent function state (if nested)
      S = funcStateStack.length > 0 ? funcStateStack.pop() : null;
    },

    enterNode(_node, _context) {
      // No-op — all CFG construction is done in enterFunction via
      // processStatements.  We intentionally do NOT return skipChildren here
      // so that the walker still recurses into children, allowing nested
      // function definitions to trigger enterFunction/exitFunction and get
      // their own CFG computed via the funcStateStack.
    },

    exitNode(_node, _context) {
      // No-op — all work done in enterFunction/exitFunction
    },

    finish() {
      return results;
    },
  };
}
