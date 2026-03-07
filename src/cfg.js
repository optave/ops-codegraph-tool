/**
 * Intraprocedural Control Flow Graph (CFG) construction from tree-sitter AST.
 *
 * Builds basic-block CFGs for individual functions, stored in cfg_blocks + cfg_edges tables.
 * Opt-in via `build --cfg`. Supports JS/TS/TSX, Python, Go, Rust, Java, C#, Ruby, PHP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { COMPLEXITY_RULES } from './complexity.js';
import { openReadonlyOrFail } from './db.js';
import { info } from './logger.js';
import { paginateResult, printNdjson } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';
import { isTestFile } from './queries.js';

// ─── CFG Node Type Rules (extends COMPLEXITY_RULES) ──────────────────────

const CFG_DEFAULTS = {
  ifNode: null,
  ifNodes: null,
  elifNode: null,
  elseClause: null,
  elseViaAlternative: false,
  ifConsequentField: null,
  forNodes: new Set(),
  whileNode: null,
  whileNodes: null,
  doNode: null,
  infiniteLoopNode: null,
  unlessNode: null,
  untilNode: null,
  switchNode: null,
  switchNodes: null,
  caseNode: null,
  caseNodes: null,
  defaultNode: null,
  tryNode: null,
  catchNode: null,
  finallyNode: null,
  returnNode: null,
  throwNode: null,
  breakNode: null,
  continueNode: null,
  blockNode: null,
  blockNodes: null,
  labeledNode: null,
  functionNodes: new Set(),
};

const CFG_RULE_KEYS = new Set(Object.keys(CFG_DEFAULTS));

export function makeCfgRules(overrides) {
  for (const key of Object.keys(overrides)) {
    if (!CFG_RULE_KEYS.has(key)) {
      throw new Error(`CFG rules: unknown key "${key}"`);
    }
  }
  const rules = { ...CFG_DEFAULTS, ...overrides };
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new Error('CFG rules: functionNodes must be a non-empty Set');
  }
  if (!(rules.forNodes instanceof Set)) {
    throw new Error('CFG rules: forNodes must be a Set');
  }
  return rules;
}

const JS_TS_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elseClause: 'else_clause',
  forNodes: new Set(['for_statement', 'for_in_statement']),
  whileNode: 'while_statement',
  doNode: 'do_statement',
  switchNode: 'switch_statement',
  caseNode: 'switch_case',
  defaultNode: 'switch_default',
  tryNode: 'try_statement',
  catchNode: 'catch_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'throw_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'statement_block',
  labeledNode: 'labeled_statement',
  functionNodes: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function',
    'generator_function_declaration',
  ]),
});

const PYTHON_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elifNode: 'elif_clause',
  elseClause: 'else_clause',
  forNodes: new Set(['for_statement']),
  whileNode: 'while_statement',
  switchNode: 'match_statement',
  caseNode: 'case_clause',
  tryNode: 'try_statement',
  catchNode: 'except_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'raise_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  functionNodes: new Set(['function_definition']),
});

const GO_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elseViaAlternative: true,
  forNodes: new Set(['for_statement']),
  switchNodes: new Set([
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
  ]),
  caseNode: 'expression_case',
  caseNodes: new Set(['type_case', 'communication_case']),
  defaultNode: 'default_case',
  returnNode: 'return_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  labeledNode: 'labeled_statement',
  functionNodes: new Set(['function_declaration', 'method_declaration', 'func_literal']),
});

const RUST_CFG = makeCfgRules({
  ifNode: 'if_expression',
  ifNodes: new Set(['if_let_expression']),
  elseClause: 'else_clause',
  forNodes: new Set(['for_expression']),
  whileNode: 'while_expression',
  whileNodes: new Set(['while_let_expression']),
  infiniteLoopNode: 'loop_expression',
  switchNode: 'match_expression',
  caseNode: 'match_arm',
  returnNode: 'return_expression',
  breakNode: 'break_expression',
  continueNode: 'continue_expression',
  blockNode: 'block',
  functionNodes: new Set(['function_item', 'closure_expression']),
});

const JAVA_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elseViaAlternative: true,
  forNodes: new Set(['for_statement', 'enhanced_for_statement']),
  whileNode: 'while_statement',
  doNode: 'do_statement',
  switchNode: 'switch_expression',
  caseNode: 'switch_block_statement_group',
  caseNodes: new Set(['switch_rule']),
  tryNode: 'try_statement',
  catchNode: 'catch_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'throw_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  labeledNode: 'labeled_statement',
  functionNodes: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
});

const CSHARP_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elseViaAlternative: true,
  forNodes: new Set(['for_statement', 'foreach_statement']),
  whileNode: 'while_statement',
  doNode: 'do_statement',
  switchNode: 'switch_statement',
  caseNode: 'switch_section',
  tryNode: 'try_statement',
  catchNode: 'catch_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'throw_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  labeledNode: 'labeled_statement',
  functionNodes: new Set([
    'method_declaration',
    'constructor_declaration',
    'lambda_expression',
    'local_function_statement',
  ]),
});

const RUBY_CFG = makeCfgRules({
  ifNode: 'if',
  elifNode: 'elsif',
  elseClause: 'else',
  forNodes: new Set(['for']),
  whileNode: 'while',
  unlessNode: 'unless',
  untilNode: 'until',
  switchNode: 'case',
  caseNode: 'when',
  defaultNode: 'else',
  tryNode: 'begin',
  catchNode: 'rescue',
  finallyNode: 'ensure',
  returnNode: 'return',
  breakNode: 'break',
  continueNode: 'next',
  blockNodes: new Set(['then', 'do', 'body_statement']),
  functionNodes: new Set(['method', 'singleton_method']),
});

const PHP_CFG = makeCfgRules({
  ifNode: 'if_statement',
  elifNode: 'else_if_clause',
  elseClause: 'else_clause',
  ifConsequentField: 'body',
  forNodes: new Set(['for_statement', 'foreach_statement']),
  whileNode: 'while_statement',
  doNode: 'do_statement',
  switchNode: 'switch_statement',
  caseNode: 'case_statement',
  defaultNode: 'default_statement',
  tryNode: 'try_statement',
  catchNode: 'catch_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'throw_expression',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'compound_statement',
  functionNodes: new Set([
    'function_definition',
    'method_declaration',
    'anonymous_function_creation_expression',
    'arrow_function',
  ]),
});

export const CFG_RULES = new Map([
  ['javascript', JS_TS_CFG],
  ['typescript', JS_TS_CFG],
  ['tsx', JS_TS_CFG],
  ['python', PYTHON_CFG],
  ['go', GO_CFG],
  ['rust', RUST_CFG],
  ['java', JAVA_CFG],
  ['csharp', CSHARP_CFG],
  ['ruby', RUBY_CFG],
  ['php', PHP_CFG],
]);

const CFG_LANG_IDS = new Set(CFG_RULES.keys());

// JS/TS extensions
const CFG_EXTENSIONS = new Set();
for (const entry of LANGUAGE_REGISTRY) {
  if (CFG_LANG_IDS.has(entry.id)) {
    for (const ext of entry.extensions) CFG_EXTENSIONS.add(ext);
  }
}

// ─── Core Algorithm: AST → CFG ──────────────────────────────────────────

/**
 * Build a control flow graph for a single function AST node.
 *
 * @param {object} functionNode - tree-sitter function AST node
 * @param {string} langId - language identifier (javascript, typescript, tsx)
 * @returns {{ blocks: object[], edges: object[] }} - CFG blocks and edges
 */
export function buildFunctionCFG(functionNode, langId) {
  const rules = CFG_RULES.get(langId);
  if (!rules) return { blocks: [], edges: [] };

  const blocks = [];
  const edges = [];
  let nextIndex = 0;

  function makeBlock(type, startLine = null, endLine = null, label = null) {
    const block = {
      index: nextIndex++,
      type,
      startLine,
      endLine,
      label,
    };
    blocks.push(block);
    return block;
  }

  function addEdge(source, target, kind) {
    edges.push({
      sourceIndex: source.index,
      targetIndex: target.index,
      kind,
    });
  }

  const entryBlock = makeBlock('entry');
  const exitBlock = makeBlock('exit');

  // Loop context stack for break/continue resolution
  const loopStack = [];

  // Label map for labeled break/continue
  const labelMap = new Map();

  /**
   * Get the body node of a function (handles arrow functions with expression bodies).
   */
  function getFunctionBody(fnNode) {
    const body = fnNode.childForFieldName('body');
    if (!body) return null;
    return body;
  }

  /**
   * Get statement children from a block or statement list.
   */
  function getStatements(node) {
    if (!node) return [];
    // Block-like nodes: extract named children
    if (node.type === rules.blockNode || rules.blockNodes?.has(node.type)) {
      const stmts = [];
      for (let i = 0; i < node.namedChildCount; i++) {
        stmts.push(node.namedChild(i));
      }
      return stmts;
    }
    // Single statement (e.g., arrow fn with expression body, or unbraced if body)
    return [node];
  }

  /**
   * Process a list of statements, creating blocks and edges.
   * Returns the last "current" block after processing, or null if all paths terminated.
   */
  function processStatements(stmts, currentBlock) {
    let cur = currentBlock;

    for (const stmt of stmts) {
      if (!cur) {
        // Dead code after return/break/continue/throw — skip remaining
        break;
      }
      cur = processStatement(stmt, cur);
    }

    return cur;
  }

  /**
   * Process a single statement, returns the new current block or null if terminated.
   */
  function processStatement(stmt, currentBlock) {
    if (!stmt || !currentBlock) return currentBlock;

    // Unwrap expression_statement (Rust uses expressions for control flow)
    if (stmt.type === 'expression_statement' && stmt.namedChildCount === 1) {
      const inner = stmt.namedChild(0);
      const t = inner.type;
      if (
        t === rules.ifNode ||
        rules.ifNodes?.has(t) ||
        rules.forNodes?.has(t) ||
        t === rules.whileNode ||
        rules.whileNodes?.has(t) ||
        t === rules.doNode ||
        t === rules.infiniteLoopNode ||
        t === rules.switchNode ||
        rules.switchNodes?.has(t) ||
        t === rules.returnNode ||
        t === rules.throwNode ||
        t === rules.breakNode ||
        t === rules.continueNode ||
        t === rules.unlessNode ||
        t === rules.untilNode
      ) {
        return processStatement(inner, currentBlock);
      }
    }

    const type = stmt.type;

    // Labeled statement: register label then process inner statement
    if (type === rules.labeledNode) {
      const labelNode = stmt.childForFieldName('label');
      const labelName = labelNode ? labelNode.text : null;
      const body = stmt.childForFieldName('body');
      if (body && labelName) {
        // Will be filled when we encounter the loop
        const labelCtx = { headerBlock: null, exitBlock: null };
        labelMap.set(labelName, labelCtx);
        const result = processStatement(body, currentBlock);
        labelMap.delete(labelName);
        return result;
      }
      return currentBlock;
    }

    // If statement (including language variants like if_let_expression)
    if (type === rules.ifNode || rules.ifNodes?.has(type)) {
      return processIf(stmt, currentBlock);
    }

    // Unless (Ruby) — same CFG shape as if
    if (rules.unlessNode && type === rules.unlessNode) {
      return processIf(stmt, currentBlock);
    }

    // For / for-in loops
    if (rules.forNodes.has(type)) {
      return processForLoop(stmt, currentBlock);
    }

    // While loop (including language variants like while_let_expression)
    if (type === rules.whileNode || rules.whileNodes?.has(type)) {
      return processWhileLoop(stmt, currentBlock);
    }

    // Until (Ruby) — same CFG shape as while
    if (rules.untilNode && type === rules.untilNode) {
      return processWhileLoop(stmt, currentBlock);
    }

    // Do-while loop
    if (rules.doNode && type === rules.doNode) {
      return processDoWhileLoop(stmt, currentBlock);
    }

    // Infinite loop (Rust's loop {})
    if (rules.infiniteLoopNode && type === rules.infiniteLoopNode) {
      return processInfiniteLoop(stmt, currentBlock);
    }

    // Switch / match statement
    if (type === rules.switchNode || rules.switchNodes?.has(type)) {
      return processSwitch(stmt, currentBlock);
    }

    // Try/catch/finally
    if (rules.tryNode && type === rules.tryNode) {
      return processTryCatch(stmt, currentBlock);
    }

    // Return statement
    if (type === rules.returnNode) {
      currentBlock.endLine = stmt.startPosition.row + 1;
      addEdge(currentBlock, exitBlock, 'return');
      return null; // path terminated
    }

    // Throw statement
    if (type === rules.throwNode) {
      currentBlock.endLine = stmt.startPosition.row + 1;
      addEdge(currentBlock, exitBlock, 'exception');
      return null; // path terminated
    }

    // Break statement
    if (type === rules.breakNode) {
      const labelNode = stmt.childForFieldName('label');
      const labelName = labelNode ? labelNode.text : null;

      let target = null;
      if (labelName && labelMap.has(labelName)) {
        target = labelMap.get(labelName).exitBlock;
      } else if (loopStack.length > 0) {
        target = loopStack[loopStack.length - 1].exitBlock;
      }

      if (target) {
        currentBlock.endLine = stmt.startPosition.row + 1;
        addEdge(currentBlock, target, 'break');
        return null; // path terminated
      }
      // break with no enclosing loop/switch — treat as no-op
      return currentBlock;
    }

    // Continue statement
    if (type === rules.continueNode) {
      const labelNode = stmt.childForFieldName('label');
      const labelName = labelNode ? labelNode.text : null;

      let target = null;
      if (labelName && labelMap.has(labelName)) {
        target = labelMap.get(labelName).headerBlock;
      } else if (loopStack.length > 0) {
        target = loopStack[loopStack.length - 1].headerBlock;
      }

      if (target) {
        currentBlock.endLine = stmt.startPosition.row + 1;
        addEdge(currentBlock, target, 'continue');
        return null; // path terminated
      }
      return currentBlock;
    }

    // Regular statement — extend current block
    if (!currentBlock.startLine) {
      currentBlock.startLine = stmt.startPosition.row + 1;
    }
    currentBlock.endLine = stmt.endPosition.row + 1;
    return currentBlock;
  }

  /**
   * Process an if/else-if/else chain.
   * Handles three patterns:
   *   A) Wrapper: alternative → else_clause → nested if or block (JS/TS, Rust)
   *   B) Siblings: elif/elsif/else_if as sibling children (Python, Ruby, PHP)
   *   C) Direct: alternative → if_statement or block directly (Go, Java, C#)
   */
  function processIf(ifStmt, currentBlock) {
    // Terminate current block at condition
    currentBlock.endLine = ifStmt.startPosition.row + 1;

    const condBlock = makeBlock(
      'condition',
      ifStmt.startPosition.row + 1,
      ifStmt.startPosition.row + 1,
      'if',
    );
    addEdge(currentBlock, condBlock, 'fallthrough');

    const joinBlock = makeBlock('body');

    // True branch (consequent)
    const consequentField = rules.ifConsequentField || 'consequence';
    const consequent = ifStmt.childForFieldName(consequentField);
    const trueBlock = makeBlock('branch_true', null, null, 'then');
    addEdge(condBlock, trueBlock, 'branch_true');
    const trueStmts = getStatements(consequent);
    const trueEnd = processStatements(trueStmts, trueBlock);
    if (trueEnd) {
      addEdge(trueEnd, joinBlock, 'fallthrough');
    }

    // False branch — depends on language pattern
    if (rules.elifNode) {
      // Pattern B: elif/else as siblings of the if node
      processElifSiblings(ifStmt, condBlock, joinBlock);
    } else {
      const alternative = ifStmt.childForFieldName('alternative');
      if (alternative) {
        if (rules.elseViaAlternative && alternative.type !== rules.elseClause) {
          // Pattern C: alternative points directly to if or block
          if (alternative.type === rules.ifNode || rules.ifNodes?.has(alternative.type)) {
            // else-if: recurse
            const falseBlock = makeBlock('branch_false', null, null, 'else-if');
            addEdge(condBlock, falseBlock, 'branch_false');
            const elseIfEnd = processIf(alternative, falseBlock);
            if (elseIfEnd) {
              addEdge(elseIfEnd, joinBlock, 'fallthrough');
            }
          } else {
            // else block
            const falseBlock = makeBlock('branch_false', null, null, 'else');
            addEdge(condBlock, falseBlock, 'branch_false');
            const falseStmts = getStatements(alternative);
            const falseEnd = processStatements(falseStmts, falseBlock);
            if (falseEnd) {
              addEdge(falseEnd, joinBlock, 'fallthrough');
            }
          }
        } else if (alternative.type === rules.elseClause) {
          // Pattern A: else_clause wrapper — may contain another if (else-if) or a block
          const elseChildren = [];
          for (let i = 0; i < alternative.namedChildCount; i++) {
            elseChildren.push(alternative.namedChild(i));
          }
          if (
            elseChildren.length === 1 &&
            (elseChildren[0].type === rules.ifNode || rules.ifNodes?.has(elseChildren[0].type))
          ) {
            // else-if: recurse
            const falseBlock = makeBlock('branch_false', null, null, 'else-if');
            addEdge(condBlock, falseBlock, 'branch_false');
            const elseIfEnd = processIf(elseChildren[0], falseBlock);
            if (elseIfEnd) {
              addEdge(elseIfEnd, joinBlock, 'fallthrough');
            }
          } else {
            // else block
            const falseBlock = makeBlock('branch_false', null, null, 'else');
            addEdge(condBlock, falseBlock, 'branch_false');
            const falseEnd = processStatements(elseChildren, falseBlock);
            if (falseEnd) {
              addEdge(falseEnd, joinBlock, 'fallthrough');
            }
          }
        }
      } else {
        // No else: condition-false goes directly to join
        addEdge(condBlock, joinBlock, 'branch_false');
      }
    }

    return joinBlock;
  }

  /**
   * Handle Pattern B: elif/elsif/else_if as sibling children of the if node.
   */
  function processElifSiblings(ifStmt, firstCondBlock, joinBlock) {
    let lastCondBlock = firstCondBlock;
    let foundElse = false;

    for (let i = 0; i < ifStmt.namedChildCount; i++) {
      const child = ifStmt.namedChild(i);

      if (child.type === rules.elifNode) {
        // Create condition block for elif
        const elifCondBlock = makeBlock(
          'condition',
          child.startPosition.row + 1,
          child.startPosition.row + 1,
          'else-if',
        );
        addEdge(lastCondBlock, elifCondBlock, 'branch_false');

        // True branch of elif
        const elifConsequentField = rules.ifConsequentField || 'consequence';
        const elifConsequent = child.childForFieldName(elifConsequentField);
        const elifTrueBlock = makeBlock('branch_true', null, null, 'then');
        addEdge(elifCondBlock, elifTrueBlock, 'branch_true');
        const elifTrueStmts = getStatements(elifConsequent);
        const elifTrueEnd = processStatements(elifTrueStmts, elifTrueBlock);
        if (elifTrueEnd) {
          addEdge(elifTrueEnd, joinBlock, 'fallthrough');
        }

        lastCondBlock = elifCondBlock;
      } else if (child.type === rules.elseClause) {
        // Else body
        const elseBlock = makeBlock('branch_false', null, null, 'else');
        addEdge(lastCondBlock, elseBlock, 'branch_false');

        // Try field access first, then collect children
        const elseBody = child.childForFieldName('body');
        let elseStmts;
        if (elseBody) {
          elseStmts = getStatements(elseBody);
        } else {
          elseStmts = [];
          for (let j = 0; j < child.namedChildCount; j++) {
            elseStmts.push(child.namedChild(j));
          }
        }
        const elseEnd = processStatements(elseStmts, elseBlock);
        if (elseEnd) {
          addEdge(elseEnd, joinBlock, 'fallthrough');
        }

        foundElse = true;
      }
    }

    // If no else clause, last condition's false goes to join
    if (!foundElse) {
      addEdge(lastCondBlock, joinBlock, 'branch_false');
    }
  }

  /**
   * Process a for/for-in loop.
   */
  function processForLoop(forStmt, currentBlock) {
    const headerBlock = makeBlock(
      'loop_header',
      forStmt.startPosition.row + 1,
      forStmt.startPosition.row + 1,
      'for',
    );
    addEdge(currentBlock, headerBlock, 'fallthrough');

    const loopExitBlock = makeBlock('body');

    // Register loop context
    const loopCtx = { headerBlock, exitBlock: loopExitBlock };
    loopStack.push(loopCtx);

    // Update label map if this is inside a labeled statement
    for (const [, ctx] of labelMap) {
      if (!ctx.headerBlock) {
        ctx.headerBlock = headerBlock;
        ctx.exitBlock = loopExitBlock;
      }
    }

    // Loop body
    const body = forStmt.childForFieldName('body');
    const bodyBlock = makeBlock('loop_body');
    addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);

    if (bodyEnd) {
      addEdge(bodyEnd, headerBlock, 'loop_back');
    }

    // Loop exit
    addEdge(headerBlock, loopExitBlock, 'loop_exit');

    loopStack.pop();
    return loopExitBlock;
  }

  /**
   * Process a while loop.
   */
  function processWhileLoop(whileStmt, currentBlock) {
    const headerBlock = makeBlock(
      'loop_header',
      whileStmt.startPosition.row + 1,
      whileStmt.startPosition.row + 1,
      'while',
    );
    addEdge(currentBlock, headerBlock, 'fallthrough');

    const loopExitBlock = makeBlock('body');

    const loopCtx = { headerBlock, exitBlock: loopExitBlock };
    loopStack.push(loopCtx);

    for (const [, ctx] of labelMap) {
      if (!ctx.headerBlock) {
        ctx.headerBlock = headerBlock;
        ctx.exitBlock = loopExitBlock;
      }
    }

    const body = whileStmt.childForFieldName('body');
    const bodyBlock = makeBlock('loop_body');
    addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);

    if (bodyEnd) {
      addEdge(bodyEnd, headerBlock, 'loop_back');
    }

    addEdge(headerBlock, loopExitBlock, 'loop_exit');

    loopStack.pop();
    return loopExitBlock;
  }

  /**
   * Process a do-while loop.
   */
  function processDoWhileLoop(doStmt, currentBlock) {
    const bodyBlock = makeBlock('loop_body', doStmt.startPosition.row + 1, null, 'do');
    addEdge(currentBlock, bodyBlock, 'fallthrough');

    const condBlock = makeBlock('loop_header', null, null, 'do-while');
    const loopExitBlock = makeBlock('body');

    const loopCtx = { headerBlock: condBlock, exitBlock: loopExitBlock };
    loopStack.push(loopCtx);

    for (const [, ctx] of labelMap) {
      if (!ctx.headerBlock) {
        ctx.headerBlock = condBlock;
        ctx.exitBlock = loopExitBlock;
      }
    }

    const body = doStmt.childForFieldName('body');
    const bodyStmts = getStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);

    if (bodyEnd) {
      addEdge(bodyEnd, condBlock, 'fallthrough');
    }

    // Condition: loop_back or exit
    addEdge(condBlock, bodyBlock, 'loop_back');
    addEdge(condBlock, loopExitBlock, 'loop_exit');

    loopStack.pop();
    return loopExitBlock;
  }

  /**
   * Process an infinite loop (Rust's `loop {}`).
   * No condition — body always executes. Exit only via break.
   */
  function processInfiniteLoop(loopStmt, currentBlock) {
    const headerBlock = makeBlock(
      'loop_header',
      loopStmt.startPosition.row + 1,
      loopStmt.startPosition.row + 1,
      'loop',
    );
    addEdge(currentBlock, headerBlock, 'fallthrough');

    const loopExitBlock = makeBlock('body');

    const loopCtx = { headerBlock, exitBlock: loopExitBlock };
    loopStack.push(loopCtx);

    for (const [, ctx] of labelMap) {
      if (!ctx.headerBlock) {
        ctx.headerBlock = headerBlock;
        ctx.exitBlock = loopExitBlock;
      }
    }

    const body = loopStmt.childForFieldName('body');
    const bodyBlock = makeBlock('loop_body');
    addEdge(headerBlock, bodyBlock, 'branch_true');

    const bodyStmts = getStatements(body);
    const bodyEnd = processStatements(bodyStmts, bodyBlock);

    if (bodyEnd) {
      addEdge(bodyEnd, headerBlock, 'loop_back');
    }

    // No loop_exit from header — can only exit via break

    loopStack.pop();
    return loopExitBlock;
  }

  /**
   * Process a switch statement.
   */
  function processSwitch(switchStmt, currentBlock) {
    currentBlock.endLine = switchStmt.startPosition.row + 1;

    const switchHeader = makeBlock(
      'condition',
      switchStmt.startPosition.row + 1,
      switchStmt.startPosition.row + 1,
      'switch',
    );
    addEdge(currentBlock, switchHeader, 'fallthrough');

    const joinBlock = makeBlock('body');

    // Switch acts like a break target for contained break statements
    const switchCtx = { headerBlock: switchHeader, exitBlock: joinBlock };
    loopStack.push(switchCtx);

    // Get case children from body field or direct children
    const switchBody = switchStmt.childForFieldName('body');
    const container = switchBody || switchStmt;

    let hasDefault = false;
    for (let i = 0; i < container.namedChildCount; i++) {
      const caseClause = container.namedChild(i);

      const isDefault = caseClause.type === rules.defaultNode;
      const isCase =
        isDefault || caseClause.type === rules.caseNode || rules.caseNodes?.has(caseClause.type);

      if (!isCase) continue;

      const caseLabel = isDefault ? 'default' : 'case';
      const caseBlock = makeBlock('case', caseClause.startPosition.row + 1, null, caseLabel);
      addEdge(switchHeader, caseBlock, isDefault ? 'branch_false' : 'branch_true');
      if (isDefault) hasDefault = true;

      // Extract case body: try field access, then collect non-header children
      const caseBodyNode =
        caseClause.childForFieldName('body') || caseClause.childForFieldName('consequence');
      let caseStmts;
      if (caseBodyNode) {
        caseStmts = getStatements(caseBodyNode);
      } else {
        caseStmts = [];
        const valueNode = caseClause.childForFieldName('value');
        const patternNode = caseClause.childForFieldName('pattern');
        for (let j = 0; j < caseClause.namedChildCount; j++) {
          const child = caseClause.namedChild(j);
          if (child !== valueNode && child !== patternNode && child.type !== 'switch_label') {
            caseStmts.push(child);
          }
        }
      }

      const caseEnd = processStatements(caseStmts, caseBlock);
      if (caseEnd) {
        addEdge(caseEnd, joinBlock, 'fallthrough');
      }
    }

    // If no default case, switch header can skip to join
    if (!hasDefault) {
      addEdge(switchHeader, joinBlock, 'branch_false');
    }

    loopStack.pop();
    return joinBlock;
  }

  /**
   * Process try/catch/finally.
   */
  function processTryCatch(tryStmt, currentBlock) {
    currentBlock.endLine = tryStmt.startPosition.row + 1;

    const joinBlock = makeBlock('body');

    // Try body — field access or collect non-handler children (e.g., Ruby's begin)
    const tryBody = tryStmt.childForFieldName('body');
    let tryBodyStart;
    let tryStmts;
    if (tryBody) {
      tryBodyStart = tryBody.startPosition.row + 1;
      tryStmts = getStatements(tryBody);
    } else {
      tryBodyStart = tryStmt.startPosition.row + 1;
      tryStmts = [];
      for (let i = 0; i < tryStmt.namedChildCount; i++) {
        const child = tryStmt.namedChild(i);
        if (rules.catchNode && child.type === rules.catchNode) continue;
        if (rules.finallyNode && child.type === rules.finallyNode) continue;
        tryStmts.push(child);
      }
    }

    const tryBlock = makeBlock('body', tryBodyStart, null, 'try');
    addEdge(currentBlock, tryBlock, 'fallthrough');
    const tryEnd = processStatements(tryStmts, tryBlock);

    // Catch handler
    let catchHandler = null;
    let finallyHandler = null;
    for (let i = 0; i < tryStmt.namedChildCount; i++) {
      const child = tryStmt.namedChild(i);
      if (rules.catchNode && child.type === rules.catchNode) catchHandler = child;
      if (rules.finallyNode && child.type === rules.finallyNode) finallyHandler = child;
    }

    if (catchHandler) {
      const catchBlock = makeBlock('catch', catchHandler.startPosition.row + 1, null, 'catch');
      // Exception edge from try to catch
      addEdge(tryBlock, catchBlock, 'exception');

      // Catch body — try field access, then collect children
      const catchBodyNode = catchHandler.childForFieldName('body');
      let catchStmts;
      if (catchBodyNode) {
        catchStmts = getStatements(catchBodyNode);
      } else {
        catchStmts = [];
        for (let i = 0; i < catchHandler.namedChildCount; i++) {
          catchStmts.push(catchHandler.namedChild(i));
        }
      }
      const catchEnd = processStatements(catchStmts, catchBlock);

      if (finallyHandler) {
        const finallyBlock = makeBlock(
          'finally',
          finallyHandler.startPosition.row + 1,
          null,
          'finally',
        );
        if (tryEnd) addEdge(tryEnd, finallyBlock, 'fallthrough');
        if (catchEnd) addEdge(catchEnd, finallyBlock, 'fallthrough');

        const finallyBodyNode = finallyHandler.childForFieldName('body');
        const finallyStmts = finallyBodyNode
          ? getStatements(finallyBodyNode)
          : getStatements(finallyHandler);
        const finallyEnd = processStatements(finallyStmts, finallyBlock);
        if (finallyEnd) addEdge(finallyEnd, joinBlock, 'fallthrough');
      } else {
        if (tryEnd) addEdge(tryEnd, joinBlock, 'fallthrough');
        if (catchEnd) addEdge(catchEnd, joinBlock, 'fallthrough');
      }
    } else if (finallyHandler) {
      const finallyBlock = makeBlock(
        'finally',
        finallyHandler.startPosition.row + 1,
        null,
        'finally',
      );
      if (tryEnd) addEdge(tryEnd, finallyBlock, 'fallthrough');

      const finallyBodyNode = finallyHandler.childForFieldName('body');
      const finallyStmts = finallyBodyNode
        ? getStatements(finallyBodyNode)
        : getStatements(finallyHandler);
      const finallyEnd = processStatements(finallyStmts, finallyBlock);
      if (finallyEnd) addEdge(finallyEnd, joinBlock, 'fallthrough');
    } else {
      if (tryEnd) addEdge(tryEnd, joinBlock, 'fallthrough');
    }

    return joinBlock;
  }

  // ── Main entry point ──────────────────────────────────────────────────

  const body = getFunctionBody(functionNode);
  if (!body) {
    // Empty function or expression body
    addEdge(entryBlock, exitBlock, 'fallthrough');
    return { blocks, edges };
  }

  const stmts = getStatements(body);
  if (stmts.length === 0) {
    addEdge(entryBlock, exitBlock, 'fallthrough');
    return { blocks, edges };
  }

  const firstBlock = makeBlock('body');
  addEdge(entryBlock, firstBlock, 'fallthrough');

  const lastBlock = processStatements(stmts, firstBlock);
  if (lastBlock) {
    addEdge(lastBlock, exitBlock, 'fallthrough');
  }

  return { blocks, edges };
}

// ─── Build-Time: Compute CFG for Changed Files ─────────────────────────

/**
 * Build CFG data for all function/method definitions and persist to DB.
 *
 * @param {object} db - open better-sqlite3 database (read-write)
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, _tree, _langId }>
 * @param {string} rootDir - absolute project root path
 * @param {object} [_engineOpts] - engine options (unused; always uses WASM for AST)
 */
export async function buildCFGData(db, fileSymbols, rootDir, _engineOpts) {
  // Lazily init WASM parsers if needed
  let parsers = null;
  let needsFallback = false;

  // Always build ext→langId map so native-only builds (where _langId is unset)
  // can still derive the language from the file extension.
  const extToLang = new Map();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const ext of entry.extensions) {
      extToLang.set(ext, entry.id);
    }
  }

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (CFG_EXTENSIONS.has(ext)) {
        // Check if all function/method defs already have native CFG data
        const hasNativeCfg = symbols.definitions
          .filter((d) => (d.kind === 'function' || d.kind === 'method') && d.line)
          .every((d) => d.cfg === null || d.cfg?.blocks?.length);
        if (!hasNativeCfg) {
          needsFallback = true;
          break;
        }
      }
    }
  }

  if (needsFallback) {
    const { createParsers } = await import('./parser.js');
    parsers = await createParsers();
  }

  let getParserFn = null;
  if (parsers) {
    const mod = await import('./parser.js');
    getParserFn = mod.getParser;
  }

  const { findFunctionNode } = await import('./complexity.js');

  const insertBlock = db.prepare(
    `INSERT INTO cfg_blocks (function_node_id, block_index, block_type, start_line, end_line, label)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertEdge = db.prepare(
    `INSERT INTO cfg_edges (function_node_id, source_block_id, target_block_id, kind)
     VALUES (?, ?, ?, ?)`,
  );
  const deleteBlocks = db.prepare('DELETE FROM cfg_blocks WHERE function_node_id = ?');
  const deleteEdges = db.prepare('DELETE FROM cfg_edges WHERE function_node_id = ?');
  const getNodeId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind IN ('function','method') AND file = ? AND line = ?",
  );

  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      if (!CFG_EXTENSIONS.has(ext)) continue;

      let tree = symbols._tree;
      let langId = symbols._langId;

      // Check if all defs already have native CFG — skip WASM parse if so
      const allNative = symbols.definitions
        .filter((d) => (d.kind === 'function' || d.kind === 'method') && d.line)
        .every((d) => d.cfg === null || d.cfg?.blocks?.length);

      // WASM fallback if no cached tree and not all native
      if (!tree && !allNative) {
        if (!extToLang || !getParserFn) continue;
        langId = extToLang.get(ext);
        if (!langId || !CFG_LANG_IDS.has(langId)) continue;

        const absPath = path.join(rootDir, relPath);
        let code;
        try {
          code = fs.readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }

        const parser = getParserFn(parsers, absPath);
        if (!parser) continue;

        try {
          tree = parser.parse(code);
        } catch {
          continue;
        }
      }

      if (!langId) {
        langId = extToLang ? extToLang.get(ext) : null;
        if (!langId) continue;
      }

      const cfgRules = CFG_RULES.get(langId);
      if (!cfgRules) continue;

      const complexityRules = COMPLEXITY_RULES.get(langId);
      // complexityRules only needed for WASM fallback path

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        const row = getNodeId.get(def.name, relPath, def.line);
        if (!row) continue;

        // Native path: use pre-computed CFG from Rust engine
        let cfg = null;
        if (def.cfg?.blocks?.length) {
          cfg = def.cfg;
        } else {
          // WASM fallback: compute CFG from tree-sitter AST
          if (!tree || !complexityRules) continue;
          const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, complexityRules);
          if (!funcNode) continue;
          cfg = buildFunctionCFG(funcNode, langId);
        }

        if (!cfg || cfg.blocks.length === 0) continue;

        // Clear old CFG data for this function
        deleteEdges.run(row.id);
        deleteBlocks.run(row.id);

        // Insert blocks and build index→dbId mapping
        const blockDbIds = new Map();
        for (const block of cfg.blocks) {
          const result = insertBlock.run(
            row.id,
            block.index,
            block.type,
            block.startLine,
            block.endLine,
            block.label,
          );
          blockDbIds.set(block.index, result.lastInsertRowid);
        }

        // Insert edges
        for (const edge of cfg.edges) {
          const sourceDbId = blockDbIds.get(edge.sourceIndex);
          const targetDbId = blockDbIds.get(edge.targetIndex);
          if (sourceDbId && targetDbId) {
            insertEdge.run(row.id, sourceDbId, targetDbId, edge.kind);
          }
        }

        analyzed++;
      }

      // Don't release _tree here — complexity/dataflow may still need it
    }
  });

  tx();

  if (analyzed > 0) {
    info(`CFG: ${analyzed} functions analyzed`);
  }
}

// ─── Query-Time Functions ───────────────────────────────────────────────

function hasCfgTables(db) {
  try {
    db.prepare('SELECT 1 FROM cfg_blocks LIMIT 0').get();
    return true;
  } catch {
    return false;
  }
}

function findNodes(db, name, opts = {}) {
  const kinds = opts.kind ? [opts.kind] : ['function', 'method'];
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND n.file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(
      `SELECT n.id, n.name, n.kind, n.file, n.line, n.end_line
       FROM nodes n
       WHERE n.name LIKE ? AND n.kind IN (${placeholders})${fileCondition}`,
    )
    .all(...params);

  return opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;
}

/**
 * Load CFG data for a function from the database.
 *
 * @param {string} name - Function name (partial match)
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts] - Options
 * @returns {{ function: object, blocks: object[], edges: object[], summary: object }}
 */
export function cfgData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  if (!hasCfgTables(db)) {
    db.close();
    return {
      name,
      results: [],
      warning:
        'No CFG data found. Rebuild with `codegraph build` (CFG is now included by default).',
    };
  }

  const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const blockStmt = db.prepare(
    `SELECT id, block_index, block_type, start_line, end_line, label
     FROM cfg_blocks WHERE function_node_id = ?
     ORDER BY block_index`,
  );
  const edgeStmt = db.prepare(
    `SELECT e.kind,
            sb.block_index AS source_index, sb.block_type AS source_type,
            tb.block_index AS target_index, tb.block_type AS target_type
     FROM cfg_edges e
     JOIN cfg_blocks sb ON e.source_block_id = sb.id
     JOIN cfg_blocks tb ON e.target_block_id = tb.id
     WHERE e.function_node_id = ?
     ORDER BY sb.block_index, tb.block_index`,
  );

  const results = nodes.map((node) => {
    const cfgBlocks = blockStmt.all(node.id);
    const cfgEdges = edgeStmt.all(node.id);

    return {
      name: node.name,
      kind: node.kind,
      file: node.file,
      line: node.line,
      blocks: cfgBlocks.map((b) => ({
        index: b.block_index,
        type: b.block_type,
        startLine: b.start_line,
        endLine: b.end_line,
        label: b.label,
      })),
      edges: cfgEdges.map((e) => ({
        source: e.source_index,
        sourceType: e.source_type,
        target: e.target_index,
        targetType: e.target_type,
        kind: e.kind,
      })),
      summary: {
        blockCount: cfgBlocks.length,
        edgeCount: cfgEdges.length,
      },
    };
  });

  db.close();
  return paginateResult({ name, results }, 'results', opts);
}

// ─── Export Formats ─────────────────────────────────────────────────────

/**
 * Convert CFG data to DOT format for Graphviz rendering.
 */
export function cfgToDOT(cfgResult) {
  const lines = [];

  for (const r of cfgResult.results) {
    lines.push(`digraph "${r.name}" {`);
    lines.push('  rankdir=TB;');
    lines.push('  node [shape=box, fontname="monospace", fontsize=10];');

    for (const block of r.blocks) {
      const label = blockLabel(block);
      const shape = block.type === 'entry' || block.type === 'exit' ? 'ellipse' : 'box';
      const style =
        block.type === 'condition' || block.type === 'loop_header'
          ? ', style=filled, fillcolor="#ffffcc"'
          : '';
      lines.push(`  B${block.index} [label="${label}", shape=${shape}${style}];`);
    }

    for (const edge of r.edges) {
      const style = edgeStyle(edge.kind);
      lines.push(`  B${edge.source} -> B${edge.target} [label="${edge.kind}"${style}];`);
    }

    lines.push('}');
  }

  return lines.join('\n');
}

/**
 * Convert CFG data to Mermaid format.
 */
export function cfgToMermaid(cfgResult) {
  const lines = [];

  for (const r of cfgResult.results) {
    lines.push(`graph TD`);
    lines.push(`  subgraph "${r.name}"`);

    for (const block of r.blocks) {
      const label = blockLabel(block);
      if (block.type === 'entry' || block.type === 'exit') {
        lines.push(`    B${block.index}(["${label}"])`);
      } else if (block.type === 'condition' || block.type === 'loop_header') {
        lines.push(`    B${block.index}{"${label}"}`);
      } else {
        lines.push(`    B${block.index}["${label}"]`);
      }
    }

    for (const edge of r.edges) {
      const label = edge.kind;
      lines.push(`    B${edge.source} -->|${label}| B${edge.target}`);
    }

    lines.push('  end');
  }

  return lines.join('\n');
}

function blockLabel(block) {
  const loc =
    block.startLine && block.endLine
      ? ` L${block.startLine}${block.endLine !== block.startLine ? `-${block.endLine}` : ''}`
      : '';
  const label = block.label ? ` (${block.label})` : '';
  return `${block.type}${label}${loc}`;
}

function edgeStyle(kind) {
  if (kind === 'exception') return ', color=red, fontcolor=red';
  if (kind === 'branch_true') return ', color=green, fontcolor=green';
  if (kind === 'branch_false') return ', color=red, fontcolor=red';
  if (kind === 'loop_back') return ', style=dashed, color=blue';
  if (kind === 'loop_exit') return ', color=orange';
  if (kind === 'return') return ', color=purple';
  if (kind === 'break') return ', color=orange, style=dashed';
  if (kind === 'continue') return ', color=blue, style=dashed';
  return '';
}

// ─── CLI Printer ────────────────────────────────────────────────────────

/**
 * CLI display for cfg command.
 */
export function cfg(name, customDbPath, opts = {}) {
  const data = cfgData(name, customDbPath, opts);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (opts.ndjson) {
    printNdjson(data.results);
    return;
  }

  if (data.warning) {
    console.log(`\u26A0  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  const format = opts.format || 'text';
  if (format === 'dot') {
    console.log(cfgToDOT(data));
    return;
  }
  if (format === 'mermaid') {
    console.log(cfgToMermaid(data));
    return;
  }

  // Text format
  for (const r of data.results) {
    console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
    console.log('\u2500'.repeat(60));
    console.log(`  Blocks: ${r.summary.blockCount}  Edges: ${r.summary.edgeCount}`);

    if (r.blocks.length > 0) {
      console.log('\n  Blocks:');
      for (const b of r.blocks) {
        const loc = b.startLine
          ? ` L${b.startLine}${b.endLine && b.endLine !== b.startLine ? `-${b.endLine}` : ''}`
          : '';
        const label = b.label ? ` (${b.label})` : '';
        console.log(`    [${b.index}] ${b.type}${label}${loc}`);
      }
    }

    if (r.edges.length > 0) {
      console.log('\n  Edges:');
      for (const e of r.edges) {
        console.log(`    B${e.source} \u2192 B${e.target}  [${e.kind}]`);
      }
    }
  }
}
