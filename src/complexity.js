import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openReadonlyOrFail } from './db.js';
import { info } from './logger.js';
import { isTestFile } from './queries.js';

// ─── Language-Specific Node Type Registry ─────────────────────────────────

const JS_TS_RULES = {
  // Structural increments (cognitive +1, cyclomatic varies)
  branchNodes: new Set([
    'if_statement',
    'else_clause',
    'switch_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
  ]),
  // Cyclomatic-only: each case adds a path
  caseNodes: new Set(['switch_case']),
  // Logical operators: cognitive +1 per sequence change, cyclomatic +1 each
  logicalOperators: new Set(['&&', '||', '??']),
  logicalNodeType: 'binary_expression',
  // Optional chaining: cyclomatic only
  optionalChainType: 'optional_chain_expression',
  // Nesting-sensitive: these increment nesting depth
  nestingNodes: new Set([
    'if_statement',
    'switch_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
  ]),
  // Function-like nodes (increase nesting when nested)
  functionNodes: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function',
    'generator_function_declaration',
  ]),
};

export const COMPLEXITY_RULES = new Map([
  ['javascript', JS_TS_RULES],
  ['typescript', JS_TS_RULES],
  ['tsx', JS_TS_RULES],
]);

// ─── Algorithm: Single-Traversal DFS ──────────────────────────────────────

/**
 * Compute cognitive complexity, cyclomatic complexity, and max nesting depth
 * for a function's AST subtree in a single DFS walk.
 *
 * @param {object} functionNode - tree-sitter node for the function body
 * @param {string} language - Language ID (e.g. 'javascript', 'typescript')
 * @returns {{ cognitive: number, cyclomatic: number, maxNesting: number } | null}
 */
export function computeFunctionComplexity(functionNode, language) {
  const rules = COMPLEXITY_RULES.get(language);
  if (!rules) return null;

  let cognitive = 0;
  let cyclomatic = 1; // McCabe starts at 1
  let maxNesting = 0;

  function walk(node, nestingLevel, isTopFunction) {
    if (!node) return;

    const type = node.type;

    // Track nesting depth
    if (nestingLevel > maxNesting) maxNesting = nestingLevel;

    // Handle logical operators in binary expressions
    if (type === rules.logicalNodeType) {
      const op = node.child(1)?.type;
      if (op && rules.logicalOperators.has(op)) {
        // Cyclomatic: +1 for every logical operator
        cyclomatic++;

        // Cognitive: +1 only when operator changes from the previous sibling sequence
        // Walk up to check if parent is same type with same operator
        const parent = node.parent;
        let sameSequence = false;
        if (parent && parent.type === rules.logicalNodeType) {
          const parentOp = parent.child(1)?.type;
          if (parentOp === op) {
            sameSequence = true;
          }
        }
        if (!sameSequence) {
          cognitive++;
        }

        // Walk children manually to avoid double-counting
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }
    }

    // Handle optional chaining (cyclomatic only)
    if (type === rules.optionalChainType) {
      cyclomatic++;
    }

    // Handle branch/control flow nodes
    if (rules.branchNodes.has(type)) {
      const isElseIf = type === 'if_statement' && node.parent && node.parent.type === 'else_clause';

      if (type === 'else_clause') {
        // else: +1 cognitive structural, no nesting increment, no cyclomatic
        // But only if it's a plain else (not else-if)
        const firstChild = node.namedChild(0);
        if (firstChild && firstChild.type === 'if_statement') {
          // This is else-if: the if_statement child will handle its own increment
          // Just walk children without additional increment
          for (let i = 0; i < node.childCount; i++) {
            walk(node.child(i), nestingLevel, false);
          }
          return;
        }
        // Plain else
        cognitive++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      if (isElseIf) {
        // else-if: +1 structural cognitive, +1 cyclomatic, NO nesting increment
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      // Regular branch node
      cognitive += 1 + nestingLevel; // structural + nesting
      cyclomatic++;

      // switch_statement doesn't add cyclomatic itself (cases do), but adds cognitive
      if (type === 'switch_statement') {
        cyclomatic--; // Undo the ++ above; cases handle cyclomatic
      }

      if (rules.nestingNodes.has(type)) {
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel + 1, false);
        }
        return;
      }
    }

    // Handle case nodes (cyclomatic only)
    if (rules.caseNodes.has(type)) {
      cyclomatic++;
    }

    // Handle nested function definitions (increase nesting)
    if (!isTopFunction && rules.functionNodes.has(type)) {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel + 1, false);
      }
      return;
    }

    // Walk children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), nestingLevel, false);
    }
  }

  walk(functionNode, 0, true);

  return { cognitive, cyclomatic, maxNesting };
}

// ─── Build-Time: Compute Metrics for Changed Files ────────────────────────

/**
 * Find the function body node in a parse tree that matches a given line range.
 */
function findFunctionNode(rootNode, startLine, _endLine, rules) {
  // tree-sitter lines are 0-indexed
  const targetStart = startLine - 1;

  let best = null;

  function search(node) {
    const nodeStart = node.startPosition.row;
    const nodeEnd = node.endPosition.row;

    // Prune branches outside range
    if (nodeEnd < targetStart || nodeStart > targetStart + 1) return;

    if (rules.functionNodes.has(node.type) && nodeStart === targetStart) {
      // Found a function node at the right position — pick it
      if (!best || nodeEnd - nodeStart < best.endPosition.row - best.startPosition.row) {
        best = node;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      search(node.child(i));
    }
  }

  search(rootNode);
  return best;
}

/**
 * Re-parse changed files with WASM tree-sitter, find function AST subtrees,
 * compute complexity, and upsert into function_complexity table.
 *
 * @param {object} db - open better-sqlite3 database (read-write)
 * @param {Map<string, object>} fileSymbols - Map<relPath, { definitions, ... }>
 * @param {string} rootDir - absolute project root path
 * @param {object} [engineOpts] - engine options (unused; always uses WASM for AST)
 */
export async function buildComplexityMetrics(db, fileSymbols, rootDir, _engineOpts) {
  const { createParsers, getParser } = await import('./parser.js');
  const parsers = await createParsers();

  // Map extensions to language IDs
  const { LANGUAGE_REGISTRY } = await import('./parser.js');
  const extToLang = new Map();
  for (const entry of LANGUAGE_REGISTRY) {
    for (const ext of entry.extensions) {
      extToLang.set(ext, entry.id);
    }
  }

  const upsert = db.prepare(
    'INSERT OR REPLACE INTO function_complexity (node_id, cognitive, cyclomatic, max_nesting) VALUES (?, ?, ?, ?)',
  );
  const getNodeId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind IN ('function','method') AND file = ? AND line = ?",
  );

  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      const langId = extToLang.get(ext);
      if (!langId) continue;

      const rules = COMPLEXITY_RULES.get(langId);
      if (!rules) continue;

      const absPath = path.join(rootDir, relPath);
      let code;
      try {
        code = fs.readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const parser = getParser(parsers, absPath);
      if (!parser) continue;

      let tree;
      try {
        tree = parser.parse(code);
      } catch {
        continue;
      }

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, rules);
        if (!funcNode) continue;

        const result = computeFunctionComplexity(funcNode, langId);
        if (!result) continue;

        const row = getNodeId.get(def.name, relPath, def.line);
        if (!row) continue;

        upsert.run(row.id, result.cognitive, result.cyclomatic, result.maxNesting);
        analyzed++;
      }
    }
  });

  tx();

  if (analyzed > 0) {
    info(`Complexity: ${analyzed} functions analyzed`);
  }
}

// ─── Query-Time Functions ─────────────────────────────────────────────────

/**
 * Return structured complexity data for querying.
 *
 * @param {string} [customDbPath] - Path to graph.db
 * @param {object} [opts] - Options
 * @param {string} [opts.target] - Function name filter (partial match)
 * @param {number} [opts.limit] - Max results (default: 20)
 * @param {string} [opts.sort] - Sort by: cognitive | cyclomatic | nesting (default: cognitive)
 * @param {boolean} [opts.aboveThreshold] - Only functions above warn thresholds
 * @param {string} [opts.file] - Filter by file (partial match)
 * @param {string} [opts.kind] - Filter by symbol kind
 * @param {boolean} [opts.noTests] - Exclude test files
 * @returns {{ functions: object[], summary: object, thresholds: object }}
 */
export function complexityData(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const limit = opts.limit || 20;
  const sort = opts.sort || 'cognitive';
  const noTests = opts.noTests || false;
  const aboveThreshold = opts.aboveThreshold || false;
  const target = opts.target || null;
  const fileFilter = opts.file || null;
  const kindFilter = opts.kind || null;

  // Load thresholds from config
  const config = loadConfig(process.cwd());
  const thresholds = config.manifesto?.rules || {
    cognitive: { warn: 15, fail: null },
    cyclomatic: { warn: 10, fail: null },
    maxNesting: { warn: 4, fail: null },
  };

  // Build query
  let where = "WHERE n.kind IN ('function','method')";
  const params = [];

  if (noTests) {
    where += ` AND n.file NOT LIKE '%.test.%'
       AND n.file NOT LIKE '%.spec.%'
       AND n.file NOT LIKE '%__test__%'
       AND n.file NOT LIKE '%__tests__%'
       AND n.file NOT LIKE '%.stories.%'`;
  }
  if (target) {
    where += ' AND n.name LIKE ?';
    params.push(`%${target}%`);
  }
  if (fileFilter) {
    where += ' AND n.file LIKE ?';
    params.push(`%${fileFilter}%`);
  }
  if (kindFilter) {
    where += ' AND n.kind = ?';
    params.push(kindFilter);
  }

  let having = '';
  if (aboveThreshold) {
    const conditions = [];
    if (thresholds.cognitive?.warn != null) {
      conditions.push(`fc.cognitive >= ${thresholds.cognitive.warn}`);
    }
    if (thresholds.cyclomatic?.warn != null) {
      conditions.push(`fc.cyclomatic >= ${thresholds.cyclomatic.warn}`);
    }
    if (thresholds.maxNesting?.warn != null) {
      conditions.push(`fc.max_nesting >= ${thresholds.maxNesting.warn}`);
    }
    if (conditions.length > 0) {
      having = `AND (${conditions.join(' OR ')})`;
    }
  }

  const orderMap = {
    cognitive: 'fc.cognitive DESC',
    cyclomatic: 'fc.cyclomatic DESC',
    nesting: 'fc.max_nesting DESC',
  };
  const orderBy = orderMap[sort] || 'fc.cognitive DESC';

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line, n.end_line,
              fc.cognitive, fc.cyclomatic, fc.max_nesting
       FROM function_complexity fc
       JOIN nodes n ON fc.node_id = n.id
       ${where} ${having}
       ORDER BY ${orderBy}
       LIMIT ?`,
      )
      .all(...params, limit);
  } catch {
    db.close();
    return { functions: [], summary: null, thresholds };
  }

  // Post-filter test files if needed (belt-and-suspenders for isTestFile)
  const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

  const functions = filtered.map((r) => {
    const exceeds = [];
    if (thresholds.cognitive?.warn != null && r.cognitive >= thresholds.cognitive.warn)
      exceeds.push('cognitive');
    if (thresholds.cyclomatic?.warn != null && r.cyclomatic >= thresholds.cyclomatic.warn)
      exceeds.push('cyclomatic');
    if (thresholds.maxNesting?.warn != null && r.max_nesting >= thresholds.maxNesting.warn)
      exceeds.push('maxNesting');

    return {
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      endLine: r.end_line || null,
      cognitive: r.cognitive,
      cyclomatic: r.cyclomatic,
      maxNesting: r.max_nesting,
      exceeds: exceeds.length > 0 ? exceeds : undefined,
    };
  });

  // Summary stats
  let summary = null;
  try {
    const allRows = db
      .prepare(
        `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting
       FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
       WHERE n.kind IN ('function','method')
       ${noTests ? `AND n.file NOT LIKE '%.test.%' AND n.file NOT LIKE '%.spec.%' AND n.file NOT LIKE '%__test__%' AND n.file NOT LIKE '%__tests__%' AND n.file NOT LIKE '%.stories.%'` : ''}`,
      )
      .all();

    if (allRows.length > 0) {
      summary = {
        analyzed: allRows.length,
        avgCognitive: +(allRows.reduce((s, r) => s + r.cognitive, 0) / allRows.length).toFixed(1),
        avgCyclomatic: +(allRows.reduce((s, r) => s + r.cyclomatic, 0) / allRows.length).toFixed(1),
        maxCognitive: Math.max(...allRows.map((r) => r.cognitive)),
        maxCyclomatic: Math.max(...allRows.map((r) => r.cyclomatic)),
        aboveWarn: allRows.filter(
          (r) =>
            (thresholds.cognitive?.warn != null && r.cognitive >= thresholds.cognitive.warn) ||
            (thresholds.cyclomatic?.warn != null && r.cyclomatic >= thresholds.cyclomatic.warn) ||
            (thresholds.maxNesting?.warn != null && r.max_nesting >= thresholds.maxNesting.warn),
        ).length,
      };
    }
  } catch {
    /* ignore */
  }

  db.close();
  return { functions, summary, thresholds };
}

/**
 * Format complexity output for CLI display.
 */
export function complexity(customDbPath, opts = {}) {
  const data = complexityData(customDbPath, opts);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.functions.length === 0) {
    if (data.summary === null) {
      console.log(
        '\nNo complexity data found. Run "codegraph build" first to analyze your codebase.\n',
      );
    } else {
      console.log('\nNo functions match the given filters.\n');
    }
    return;
  }

  const header = opts.aboveThreshold ? 'Functions Above Threshold' : 'Function Complexity';
  console.log(`\n# ${header}\n`);

  // Table header
  console.log(
    `  ${'Function'.padEnd(40)} ${'File'.padEnd(30)} ${'Cog'.padStart(4)} ${'Cyc'.padStart(4)} ${'Nest'.padStart(5)}`,
  );
  console.log(
    `  ${'─'.repeat(40)} ${'─'.repeat(30)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(5)}`,
  );

  for (const fn of data.functions) {
    const name = fn.name.length > 38 ? `${fn.name.slice(0, 37)}…` : fn.name;
    const file = fn.file.length > 28 ? `…${fn.file.slice(-27)}` : fn.file;
    const warn = fn.exceeds ? ' !' : '';
    console.log(
      `  ${name.padEnd(40)} ${file.padEnd(30)} ${String(fn.cognitive).padStart(4)} ${String(fn.cyclomatic).padStart(4)} ${String(fn.maxNesting).padStart(5)}${warn}`,
    );
  }

  if (data.summary) {
    const s = data.summary;
    console.log(
      `\n  ${s.analyzed} functions analyzed | avg cognitive: ${s.avgCognitive} | avg cyclomatic: ${s.avgCyclomatic} | ${s.aboveWarn} above threshold`,
    );
  }
  console.log();
}
