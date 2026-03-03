/**
 * Intraprocedural Control Flow Graph (CFG) construction from tree-sitter AST.
 *
 * Builds basic-block CFGs for individual functions, stored in cfg_blocks + cfg_edges tables.
 * Opt-in via `build --cfg`. JS/TS/TSX only for Phase 1.
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

const JS_TS_CFG = {
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
};

export const CFG_RULES = new Map([
  ['javascript', JS_TS_CFG],
  ['typescript', JS_TS_CFG],
  ['tsx', JS_TS_CFG],
]);

// Language IDs that support CFG (Phase 1: JS/TS/TSX only)
const CFG_LANG_IDS = new Set(['javascript', 'typescript', 'tsx']);

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
    // statement_block: get named children
    if (node.type === rules.blockNode) {
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

    // If statement
    if (type === rules.ifNode) {
      return processIf(stmt, currentBlock);
    }

    // For / for-in loops
    if (rules.forNodes.has(type)) {
      return processForLoop(stmt, currentBlock);
    }

    // While loop
    if (type === rules.whileNode) {
      return processWhileLoop(stmt, currentBlock);
    }

    // Do-while loop
    if (type === rules.doNode) {
      return processDoWhileLoop(stmt, currentBlock);
    }

    // Switch statement
    if (type === rules.switchNode) {
      return processSwitch(stmt, currentBlock);
    }

    // Try/catch/finally
    if (type === rules.tryNode) {
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
    const consequent = ifStmt.childForFieldName('consequence');
    const trueBlock = makeBlock('branch_true', null, null, 'then');
    addEdge(condBlock, trueBlock, 'branch_true');
    const trueStmts = getStatements(consequent);
    const trueEnd = processStatements(trueStmts, trueBlock);
    if (trueEnd) {
      addEdge(trueEnd, joinBlock, 'fallthrough');
    }

    // False branch (alternative / else / else-if)
    const alternative = ifStmt.childForFieldName('alternative');
    if (alternative) {
      if (alternative.type === rules.elseClause) {
        // else clause — may contain another if (else-if) or a block
        const elseChildren = [];
        for (let i = 0; i < alternative.namedChildCount; i++) {
          elseChildren.push(alternative.namedChild(i));
        }
        if (elseChildren.length === 1 && elseChildren[0].type === rules.ifNode) {
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

    return joinBlock;
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

    // Collect case clauses from the switch body
    const switchBody = switchStmt.childForFieldName('body');
    if (switchBody) {
      let hasDefault = false;
      for (let i = 0; i < switchBody.namedChildCount; i++) {
        const caseClause = switchBody.namedChild(i);
        const isDefault =
          caseClause.type === rules.defaultNode ||
          (caseClause.type === rules.caseNode && !caseClause.childForFieldName('value'));

        const caseLabel = isDefault ? 'default' : 'case';
        const caseBlock = makeBlock(
          isDefault ? 'case' : 'case',
          caseClause.startPosition.row + 1,
          null,
          caseLabel,
        );
        addEdge(switchHeader, caseBlock, isDefault ? 'branch_false' : 'branch_true');
        if (isDefault) hasDefault = true;

        // Process case body statements
        const caseStmts = [];
        for (let j = 0; j < caseClause.namedChildCount; j++) {
          const child = caseClause.namedChild(j);
          // Skip the case value expression
          if (child.type !== 'identifier' && child.type !== 'string' && child.type !== 'number') {
            caseStmts.push(child);
          }
        }

        const caseEnd = processStatements(caseStmts, caseBlock);
        if (caseEnd) {
          // Fall-through to join (or next case, but we simplify to join)
          addEdge(caseEnd, joinBlock, 'fallthrough');
        }
      }

      // If no default case, switch header can skip to join
      if (!hasDefault) {
        addEdge(switchHeader, joinBlock, 'branch_false');
      }
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

    // Try body
    const tryBody = tryStmt.childForFieldName('body');
    const tryBlock = makeBlock('body', tryBody ? tryBody.startPosition.row + 1 : null, null, 'try');
    addEdge(currentBlock, tryBlock, 'fallthrough');

    const tryStmts = getStatements(tryBody);
    const tryEnd = processStatements(tryStmts, tryBlock);

    // Catch handler
    let catchHandler = null;
    let finallyHandler = null;
    for (let i = 0; i < tryStmt.namedChildCount; i++) {
      const child = tryStmt.namedChild(i);
      if (child.type === rules.catchNode) catchHandler = child;
      if (child.type === rules.finallyNode) finallyHandler = child;
    }

    if (catchHandler) {
      const catchBlock = makeBlock('catch', catchHandler.startPosition.row + 1, null, 'catch');
      // Exception edge from try to catch
      addEdge(tryBlock, catchBlock, 'exception');

      const catchBody = catchHandler.childForFieldName('body');
      const catchStmts = getStatements(catchBody);
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

        const finallyBody = finallyHandler.childForFieldName('body');
        const finallyStmts = getStatements(finallyBody);
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

      const finallyBody = finallyHandler.childForFieldName('body');
      const finallyStmts = getStatements(finallyBody);
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
  let extToLang = null;
  let needsFallback = false;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (CFG_EXTENSIONS.has(ext)) {
        needsFallback = true;
        break;
      }
    }
  }

  if (needsFallback) {
    const { createParsers } = await import('./parser.js');
    parsers = await createParsers();
    extToLang = new Map();
    for (const entry of LANGUAGE_REGISTRY) {
      for (const ext of entry.extensions) {
        extToLang.set(ext, entry.id);
      }
    }
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

      // WASM fallback if no cached tree
      if (!tree) {
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
      if (!complexityRules) continue;

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        const row = getNodeId.get(def.name, relPath, def.line);
        if (!row) continue;

        const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, complexityRules);
        if (!funcNode) continue;

        const cfg = buildFunctionCFG(funcNode, langId);
        if (cfg.blocks.length === 0) continue;

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
      warning: 'No CFG data found. Run `codegraph build --cfg` first.',
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
