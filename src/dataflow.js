/**
 * Dataflow analysis — define/use chains and data movement edges.
 *
 * Adds three edge types to track how data moves through functions:
 *   - flows_to:  parameter/variable flows into another function as an argument
 *   - returns:   a call's return value is captured and used in the caller
 *   - mutates:   a parameter-derived value is mutated (e.g. arr.push())
 *
 * Opt-in via `build --dataflow`. JS/TS only for MVP.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openReadonlyOrFail } from './db.js';
import { info } from './logger.js';
import { paginateResult } from './paginate.js';
import { ALL_SYMBOL_KINDS, isTestFile, normalizeSymbol } from './queries.js';

// Methods that mutate their receiver in-place
const MUTATING_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
  'reverse',
  'fill',
  'set',
  'delete',
  'add',
  'clear',
]);

// JS/TS language IDs that support dataflow extraction
const DATAFLOW_LANG_IDS = new Set(['javascript', 'typescript', 'tsx']);

// ── AST helpers ──────────────────────────────────────────────────────────────

function truncate(str, max = 120) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Get the name of a function node from the AST.
 */
function functionName(fnNode) {
  if (!fnNode) return null;
  const t = fnNode.type;
  if (t === 'function_declaration') {
    const nameNode = fnNode.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }
  if (t === 'method_definition') {
    const nameNode = fnNode.childForFieldName('name');
    return nameNode ? nameNode.text : null;
  }
  // arrow_function or function_expression assigned to a variable
  if (t === 'arrow_function' || t === 'function_expression') {
    const parent = fnNode.parent;
    if (parent?.type === 'variable_declarator') {
      const nameNode = parent.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    if (parent?.type === 'pair') {
      const keyNode = parent.childForFieldName('key');
      return keyNode ? keyNode.text : null;
    }
    if (parent?.type === 'assignment_expression') {
      const left = parent.childForFieldName('left');
      return left ? left.text : null;
    }
  }
  return null;
}

/**
 * Extract parameter names and indices from a formal_parameters node.
 * Handles: simple identifiers, destructured objects/arrays, defaults, rest, TS typed params.
 */
function extractParams(paramsNode) {
  if (!paramsNode) return [];
  const result = [];
  let index = 0;
  for (const child of paramsNode.namedChildren) {
    const names = extractParamNames(child);
    for (const name of names) {
      result.push({ name, index });
    }
    index++;
  }
  return result;
}

function extractParamNames(node) {
  if (!node) return [];
  const t = node.type;
  if (t === 'identifier') return [node.text];
  // TS: required_parameter, optional_parameter
  if (t === 'required_parameter' || t === 'optional_parameter') {
    const pattern = node.childForFieldName('pattern');
    return pattern ? extractParamNames(pattern) : [];
  }
  if (t === 'assignment_pattern') {
    const left = node.childForFieldName('left');
    return left ? extractParamNames(left) : [];
  }
  if (t === 'rest_pattern') {
    // rest_pattern → ...identifier
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') return [child.text];
    }
    return [];
  }
  if (t === 'object_pattern') {
    const names = [];
    for (const child of node.namedChildren) {
      if (child.type === 'shorthand_property_identifier_pattern') {
        names.push(child.text);
      } else if (child.type === 'pair_pattern') {
        const value = child.childForFieldName('value');
        if (value) names.push(...extractParamNames(value));
      } else if (child.type === 'rest_pattern') {
        names.push(...extractParamNames(child));
      }
    }
    return names;
  }
  if (t === 'array_pattern') {
    const names = [];
    for (const child of node.namedChildren) {
      names.push(...extractParamNames(child));
    }
    return names;
  }
  return [];
}

/**
 * Resolve the name a call expression is calling.
 * Handles: `foo()`, `obj.method()`, `obj.nested.method()`.
 */
function resolveCalleeName(callNode) {
  const fn = callNode.childForFieldName('function');
  if (!fn) return null;
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression' || fn.type === 'optional_chain_expression') {
    // Handle optional chaining: foo?.bar() or foo?.()
    const target = fn.type === 'optional_chain_expression' ? fn.namedChildren[0] : fn;
    if (!target) return null;
    if (target.type === 'member_expression') {
      const prop = target.childForFieldName('property');
      return prop ? prop.text : null;
    }
    if (target.type === 'identifier') return target.text;
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : null;
  }
  return null;
}

/**
 * Get the receiver (object) of a member expression.
 */
function memberReceiver(memberExpr) {
  const obj = memberExpr.childForFieldName('object');
  if (!obj) return null;
  if (obj.type === 'identifier') return obj.text;
  if (obj.type === 'member_expression') return memberReceiver(obj);
  return null;
}

// ── extractDataflow ──────────────────────────────────────────────────────────

/**
 * Extract dataflow information from a parsed AST.
 *
 * @param {object} tree - tree-sitter parse tree
 * @param {string} filePath - relative file path
 * @param {object[]} definitions - symbol definitions from the parser
 * @returns {{ parameters, returns, assignments, argFlows, mutations }}
 */
export function extractDataflow(tree, _filePath, _definitions) {
  const parameters = [];
  const returns = [];
  const assignments = [];
  const argFlows = [];
  const mutations = [];

  // Build a scope stack as we traverse
  // Each scope: { funcName, funcNode, params: Map<name, index>, locals: Map<name, source> }
  const scopeStack = [];

  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
  }

  function findBinding(name) {
    // Search from innermost scope outward
    for (let i = scopeStack.length - 1; i >= 0; i--) {
      const scope = scopeStack[i];
      if (scope.params.has(name))
        return { type: 'param', index: scope.params.get(name), funcName: scope.funcName };
      if (scope.locals.has(name))
        return { type: 'local', source: scope.locals.get(name), funcName: scope.funcName };
    }
    return null;
  }

  function enterScope(fnNode) {
    const name = functionName(fnNode);
    const paramsNode = fnNode.childForFieldName('parameters');
    const paramList = extractParams(paramsNode);
    const paramMap = new Map();
    for (const p of paramList) {
      paramMap.set(p.name, p.index);
      if (name) {
        parameters.push({
          funcName: name,
          paramName: p.name,
          paramIndex: p.index,
          line: (paramsNode?.startPosition?.row ?? fnNode.startPosition.row) + 1,
        });
      }
    }
    scopeStack.push({ funcName: name, funcNode: fnNode, params: paramMap, locals: new Map() });
  }

  function exitScope() {
    scopeStack.pop();
  }

  /**
   * Determine confidence for a variable binding flowing as an argument.
   */
  function bindingConfidence(binding) {
    if (!binding) return 0.5;
    if (binding.type === 'param') return 1.0;
    if (binding.type === 'local') {
      // Local from a call return → 0.9, from destructuring → 0.8
      if (binding.source?.type === 'call_return') return 0.9;
      if (binding.source?.type === 'destructured') return 0.8;
      return 0.9;
    }
    return 0.5;
  }

  // Recursive AST walk
  function visit(node) {
    if (!node) return;
    const t = node.type;

    // Enter function scopes
    if (
      t === 'function_declaration' ||
      t === 'method_definition' ||
      t === 'arrow_function' ||
      t === 'function_expression' ||
      t === 'function'
    ) {
      enterScope(node);
      // Visit body
      for (const child of node.namedChildren) {
        visit(child);
      }
      exitScope();
      return;
    }

    // Return statements
    if (t === 'return_statement') {
      const scope = currentScope();
      if (scope?.funcName) {
        const expr = node.namedChildren[0];
        const referencedNames = [];
        if (expr) collectIdentifiers(expr, referencedNames);
        returns.push({
          funcName: scope.funcName,
          expression: truncate(expr ? expr.text : ''),
          referencedNames,
          line: node.startPosition.row + 1,
        });
      }
      // Still visit children for nested expressions
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Variable declarations: track assignments from calls
    if (t === 'variable_declarator') {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      const scope = currentScope();

      if (nameNode && valueNode && scope) {
        // Resolve the call expression from the value (handles await wrapping)
        let callExpr = null;
        if (valueNode.type === 'call_expression') {
          callExpr = valueNode;
        } else if (valueNode.type === 'await_expression') {
          const awaitChild = valueNode.namedChildren[0];
          if (awaitChild?.type === 'call_expression') callExpr = awaitChild;
        }

        if (callExpr) {
          const callee = resolveCalleeName(callExpr);
          if (callee && scope.funcName) {
            // Destructuring: const { a, b } = foo()
            if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
              const names = extractParamNames(nameNode);
              for (const n of names) {
                assignments.push({
                  varName: n,
                  callerFunc: scope.funcName,
                  sourceCallName: callee,
                  expression: truncate(node.text),
                  line: node.startPosition.row + 1,
                });
                scope.locals.set(n, { type: 'destructured', callee });
              }
            } else {
              // Simple: const x = foo()
              assignments.push({
                varName: nameNode.text,
                callerFunc: scope.funcName,
                sourceCallName: callee,
                expression: truncate(node.text),
                line: node.startPosition.row + 1,
              });
              scope.locals.set(nameNode.text, { type: 'call_return', callee });
            }
          }
        }
      }
      // Visit children
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Call expressions: track argument flows
    if (t === 'call_expression') {
      const callee = resolveCalleeName(node);
      const argsNode = node.childForFieldName('arguments');
      const scope = currentScope();

      if (callee && argsNode && scope?.funcName) {
        let argIndex = 0;
        for (const arg of argsNode.namedChildren) {
          // Handle spread arguments: foo(...args)
          const unwrapped = arg.type === 'spread_element' ? arg.namedChildren[0] : arg;
          if (!unwrapped) {
            argIndex++;
            continue;
          }
          const argName = unwrapped.type === 'identifier' ? unwrapped.text : null;
          const argMember =
            unwrapped.type === 'member_expression' ? memberReceiver(unwrapped) : null;
          const trackedName = argName || argMember;

          if (trackedName) {
            const binding = findBinding(trackedName);
            if (binding) {
              argFlows.push({
                callerFunc: scope.funcName,
                calleeName: callee,
                argIndex,
                argName: trackedName,
                binding,
                confidence: bindingConfidence(binding),
                expression: truncate(arg.text),
                line: node.startPosition.row + 1,
              });
            }
          }
          argIndex++;
        }
      }
      // Visit children (but not arguments again — we handled them)
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Assignment expressions: mutation detection + non-declaration call captures
    if (t === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      const scope = currentScope();

      if (scope?.funcName) {
        // Mutation: obj.prop = value
        if (left?.type === 'member_expression') {
          const receiver = memberReceiver(left);
          if (receiver) {
            const binding = findBinding(receiver);
            if (binding) {
              mutations.push({
                funcName: scope.funcName,
                receiverName: receiver,
                binding,
                mutatingExpr: truncate(node.text),
                line: node.startPosition.row + 1,
              });
            }
          }
        }

        // Non-declaration assignment: x = foo() (without const/let/var)
        if (left?.type === 'identifier' && right) {
          let callExpr = null;
          if (right.type === 'call_expression') {
            callExpr = right;
          } else if (right.type === 'await_expression') {
            const awaitChild = right.namedChildren[0];
            if (awaitChild?.type === 'call_expression') callExpr = awaitChild;
          }
          if (callExpr) {
            const callee = resolveCalleeName(callExpr);
            if (callee) {
              assignments.push({
                varName: left.text,
                callerFunc: scope.funcName,
                sourceCallName: callee,
                expression: truncate(node.text),
                line: node.startPosition.row + 1,
              });
              scope.locals.set(left.text, { type: 'call_return', callee });
            }
          }
        }
      }

      // Visit children
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Mutation detection: mutating method calls (push, pop, splice, etc.)
    if (t === 'expression_statement') {
      const expr = node.namedChildren[0];
      if (expr?.type === 'call_expression') {
        const fn = expr.childForFieldName('function');
        if (fn?.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          if (prop && MUTATING_METHODS.has(prop.text)) {
            const receiver = memberReceiver(fn);
            const scope = currentScope();
            if (receiver && scope?.funcName) {
              const binding = findBinding(receiver);
              if (binding) {
                mutations.push({
                  funcName: scope.funcName,
                  receiverName: receiver,
                  binding,
                  mutatingExpr: truncate(expr.text),
                  line: node.startPosition.row + 1,
                });
              }
            }
          }
        }
      }
    }

    // Default: visit all children
    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(tree.rootNode);

  return { parameters, returns, assignments, argFlows, mutations };
}

/**
 * Collect all identifier names referenced within a node.
 */
function collectIdentifiers(node, out) {
  if (node.type === 'identifier') {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out);
  }
}

// ── buildDataflowEdges ──────────────────────────────────────────────────────

/**
 * Build dataflow edges and insert them into the database.
 * Called during graph build when --dataflow is enabled.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {Map<string, object>} fileSymbols - map of relPath → symbols
 * @param {string} rootDir - absolute root directory
 * @param {object} engineOpts - engine options
 */
export async function buildDataflowEdges(db, fileSymbols, rootDir, _engineOpts) {
  // Lazily init WASM parsers if needed
  let parsers = null;
  let extToLang = null;
  let needsFallback = false;

  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      const ext = path.extname(relPath).toLowerCase();
      if (
        ext === '.js' ||
        ext === '.ts' ||
        ext === '.tsx' ||
        ext === '.jsx' ||
        ext === '.mjs' ||
        ext === '.cjs'
      ) {
        needsFallback = true;
        break;
      }
    }
  }

  if (needsFallback) {
    const { createParsers, LANGUAGE_REGISTRY } = await import('./parser.js');
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

  const insert = db.prepare(
    `INSERT INTO dataflow (source_id, target_id, kind, param_index, expression, line, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  // MVP scope: only resolve function/method nodes for dataflow edges.
  // Future expansion: add 'parameter', 'property', 'constant' kinds to track
  // data flow through property accessors or constant references.
  const getNodeByNameAndFile = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND file = ? AND kind IN ('function', 'method')`,
  );

  const getNodeByName = db.prepare(
    `SELECT id, name, kind, file, line FROM nodes
     WHERE name = ? AND kind IN ('function', 'method')
     ORDER BY file, line LIMIT 10`,
  );

  let totalEdges = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const ext = path.extname(relPath).toLowerCase();
      // Only JS/TS for MVP
      if (
        ext !== '.js' &&
        ext !== '.ts' &&
        ext !== '.tsx' &&
        ext !== '.jsx' &&
        ext !== '.mjs' &&
        ext !== '.cjs'
      ) {
        continue;
      }

      let tree = symbols._tree;

      // WASM fallback if no cached tree
      if (!tree) {
        if (!extToLang || !getParserFn) continue;
        const langId = extToLang.get(ext);
        if (!langId || !DATAFLOW_LANG_IDS.has(langId)) continue;

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

      const data = extractDataflow(tree, relPath, symbols.definitions);

      // Resolve function names to node IDs in this file first, then globally
      function resolveNode(funcName) {
        const local = getNodeByNameAndFile.all(funcName, relPath);
        if (local.length > 0) return local[0];
        const global = getNodeByName.all(funcName);
        return global.length > 0 ? global[0] : null;
      }

      // flows_to: parameter/variable passed as argument to another function
      for (const flow of data.argFlows) {
        const sourceNode = resolveNode(flow.callerFunc);
        const targetNode = resolveNode(flow.calleeName);
        if (sourceNode && targetNode) {
          insert.run(
            sourceNode.id,
            targetNode.id,
            'flows_to',
            flow.argIndex,
            flow.expression,
            flow.line,
            flow.confidence,
          );
          totalEdges++;
        }
      }

      // returns: call return value captured in caller
      for (const assignment of data.assignments) {
        const producerNode = resolveNode(assignment.sourceCallName);
        const consumerNode = resolveNode(assignment.callerFunc);
        if (producerNode && consumerNode) {
          insert.run(
            producerNode.id,
            consumerNode.id,
            'returns',
            null,
            assignment.expression,
            assignment.line,
            1.0,
          );
          totalEdges++;
        }
      }

      // mutates: parameter-derived value is mutated
      for (const mut of data.mutations) {
        const mutatorNode = resolveNode(mut.funcName);
        if (mutatorNode && mut.binding?.type === 'param') {
          // The mutation in this function affects the parameter source
          insert.run(
            mutatorNode.id,
            mutatorNode.id,
            'mutates',
            null,
            mut.mutatingExpr,
            mut.line,
            1.0,
          );
          totalEdges++;
        }
      }
    }
  });

  tx();
  info(`Dataflow: ${totalEdges} edges inserted`);
}

// ── Query functions ─────────────────────────────────────────────────────────

/**
 * Look up node(s) by name with optional file/kind/noTests filtering.
 * Similar to findMatchingNodes in queries.js but operates on the dataflow table.
 */
function findNodes(db, name, opts = {}) {
  const kinds = opts.kind ? [opts.kind] : ALL_SYMBOL_KINDS;
  const placeholders = kinds.map(() => '?').join(', ');
  const params = [`%${name}%`, ...kinds];

  let fileCondition = '';
  if (opts.file) {
    fileCondition = ' AND file LIKE ?';
    params.push(`%${opts.file}%`);
  }

  const rows = db
    .prepare(
      `SELECT * FROM nodes
       WHERE name LIKE ? AND kind IN (${placeholders})${fileCondition}
       ORDER BY file, line`,
    )
    .all(...params);

  return opts.noTests ? rows.filter((n) => !isTestFile(n.file)) : rows;
}

/**
 * Check if the dataflow table exists and has data.
 */
function hasDataflowTable(db) {
  try {
    const row = db.prepare('SELECT COUNT(*) as c FROM dataflow').get();
    return row.c > 0;
  } catch {
    return false;
  }
}

/**
 * Return all dataflow edges for a symbol.
 *
 * @param {string} name - symbol name (partial match)
 * @param {string} [customDbPath] - path to graph.db
 * @param {object} [opts] - { noTests, file, kind, limit, offset }
 * @returns {{ name, results: object[] }}
 */
export function dataflowData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;

  if (!hasDataflowTable(db)) {
    db.close();
    return {
      name,
      results: [],
      warning:
        'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
    };
  }

  const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  const flowsToOut = db.prepare(
    `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'flows_to'`,
  );
  const flowsToIn = db.prepare(
    `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'flows_to'`,
  );
  const returnsOut = db.prepare(
    `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
  );
  const returnsIn = db.prepare(
    `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'returns'`,
  );
  const mutatesOut = db.prepare(
    `SELECT d.*, n.name AS target_name, n.kind AS target_kind, n.file AS target_file, n.line AS target_line
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'mutates'`,
  );
  const mutatesIn = db.prepare(
    `SELECT d.*, n.name AS source_name, n.kind AS source_kind, n.file AS source_file, n.line AS source_line
     FROM dataflow d JOIN nodes n ON d.source_id = n.id
     WHERE d.target_id = ? AND d.kind = 'mutates'`,
  );

  const hc = new Map();
  const results = nodes.map((node) => {
    const sym = normalizeSymbol(node, db, hc);

    const flowsTo = flowsToOut.all(node.id).map((r) => ({
      target: r.target_name,
      kind: r.target_kind,
      file: r.target_file,
      line: r.line,
      paramIndex: r.param_index,
      expression: r.expression,
      confidence: r.confidence,
    }));

    const flowsFrom = flowsToIn.all(node.id).map((r) => ({
      source: r.source_name,
      kind: r.source_kind,
      file: r.source_file,
      line: r.line,
      paramIndex: r.param_index,
      expression: r.expression,
      confidence: r.confidence,
    }));

    const returnConsumers = returnsOut.all(node.id).map((r) => ({
      consumer: r.target_name,
      kind: r.target_kind,
      file: r.target_file,
      line: r.line,
      expression: r.expression,
    }));

    const returnedBy = returnsIn.all(node.id).map((r) => ({
      producer: r.source_name,
      kind: r.source_kind,
      file: r.source_file,
      line: r.line,
      expression: r.expression,
    }));

    const mutatesTargets = mutatesOut.all(node.id).map((r) => ({
      target: r.target_name,
      expression: r.expression,
      line: r.line,
    }));

    const mutatedBy = mutatesIn.all(node.id).map((r) => ({
      source: r.source_name,
      expression: r.expression,
      line: r.line,
    }));

    if (noTests) {
      const filter = (arr) => arr.filter((r) => !isTestFile(r.file));
      return {
        ...sym,
        flowsTo: filter(flowsTo),
        flowsFrom: filter(flowsFrom),
        returns: returnConsumers.filter((r) => !isTestFile(r.file)),
        returnedBy: returnedBy.filter((r) => !isTestFile(r.file)),
        mutates: mutatesTargets,
        mutatedBy,
      };
    }

    return {
      ...sym,
      flowsTo,
      flowsFrom,
      returns: returnConsumers,
      returnedBy,
      mutates: mutatesTargets,
      mutatedBy,
    };
  });

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

/**
 * BFS through flows_to + returns edges to find how data gets from A to B.
 *
 * @param {string} from - source symbol name
 * @param {string} to - target symbol name
 * @param {string} [customDbPath]
 * @param {object} [opts] - { noTests, maxDepth, limit, offset }
 * @returns {{ from, to, found, hops?, path? }}
 */
export function dataflowPathData(from, to, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const noTests = opts.noTests || false;
  const maxDepth = opts.maxDepth || 10;

  if (!hasDataflowTable(db)) {
    db.close();
    return {
      from,
      to,
      found: false,
      warning:
        'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
    };
  }

  const fromNodes = findNodes(db, from, { noTests, file: opts.fromFile, kind: opts.kind });
  if (fromNodes.length === 0) {
    db.close();
    return { from, to, found: false, error: `No symbol matching "${from}"` };
  }

  const toNodes = findNodes(db, to, { noTests, file: opts.toFile, kind: opts.kind });
  if (toNodes.length === 0) {
    db.close();
    return { from, to, found: false, error: `No symbol matching "${to}"` };
  }

  const sourceNode = fromNodes[0];
  const targetNode = toNodes[0];

  if (sourceNode.id === targetNode.id) {
    const hc = new Map();
    const sym = normalizeSymbol(sourceNode, db, hc);
    db.close();
    return {
      from,
      to,
      found: true,
      hops: 0,
      path: [{ ...sym, edgeKind: null }],
    };
  }

  // BFS through flows_to and returns edges
  const neighborStmt = db.prepare(
    `SELECT n.id, n.name, n.kind, n.file, n.line, d.kind AS edge_kind, d.expression
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind IN ('flows_to', 'returns')`,
  );

  const visited = new Set([sourceNode.id]);
  const parent = new Map();
  let queue = [sourceNode.id];
  let found = false;

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextQueue = [];
    for (const currentId of queue) {
      const neighbors = neighborStmt.all(currentId);
      for (const n of neighbors) {
        if (noTests && isTestFile(n.file)) continue;
        if (n.id === targetNode.id) {
          if (!found) {
            found = true;
            parent.set(n.id, {
              parentId: currentId,
              edgeKind: n.edge_kind,
              expression: n.expression,
            });
          }
          continue;
        }
        if (!visited.has(n.id)) {
          visited.add(n.id);
          parent.set(n.id, {
            parentId: currentId,
            edgeKind: n.edge_kind,
            expression: n.expression,
          });
          nextQueue.push(n.id);
        }
      }
    }
    if (found) break;
    queue = nextQueue;
    if (queue.length === 0) break;
  }

  if (!found) {
    db.close();
    return { from, to, found: false };
  }

  // Reconstruct path
  const nodeById = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const hc = new Map();
  const pathItems = [];
  let cur = targetNode.id;
  while (cur !== undefined) {
    const nodeRow = nodeById.get(cur);
    const parentInfo = parent.get(cur);
    pathItems.unshift({
      ...normalizeSymbol(nodeRow, db, hc),
      edgeKind: parentInfo?.edgeKind ?? null,
      expression: parentInfo?.expression ?? null,
    });
    cur = parentInfo?.parentId;
    if (cur === sourceNode.id) {
      const srcRow = nodeById.get(cur);
      pathItems.unshift({
        ...normalizeSymbol(srcRow, db, hc),
        edgeKind: null,
        expression: null,
      });
      break;
    }
  }

  db.close();
  return { from, to, found: true, hops: pathItems.length - 1, path: pathItems };
}

/**
 * Forward BFS through returns edges: "if I change this function's return value, what breaks?"
 *
 * @param {string} name - symbol name
 * @param {string} [customDbPath]
 * @param {object} [opts] - { noTests, depth, file, kind, limit, offset }
 * @returns {{ name, results: object[] }}
 */
export function dataflowImpactData(name, customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  const maxDepth = opts.depth || 5;
  const noTests = opts.noTests || false;

  if (!hasDataflowTable(db)) {
    db.close();
    return {
      name,
      results: [],
      warning:
        'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
    };
  }

  const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
  if (nodes.length === 0) {
    db.close();
    return { name, results: [] };
  }

  // Forward BFS: who consumes this function's return value (directly or transitively)?
  const consumersStmt = db.prepare(
    `SELECT DISTINCT n.*
     FROM dataflow d JOIN nodes n ON d.target_id = n.id
     WHERE d.source_id = ? AND d.kind = 'returns'`,
  );

  const hc = new Map();
  const results = nodes.map((node) => {
    const sym = normalizeSymbol(node, db, hc);
    const visited = new Set([node.id]);
    const levels = {};
    let frontier = [node.id];

    for (let d = 1; d <= maxDepth; d++) {
      const nextFrontier = [];
      for (const fid of frontier) {
        const consumers = consumersStmt.all(fid);
        for (const c of consumers) {
          if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
            visited.add(c.id);
            nextFrontier.push(c.id);
            if (!levels[d]) levels[d] = [];
            levels[d].push(normalizeSymbol(c, db, hc));
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    return {
      ...sym,
      levels,
      totalAffected: visited.size - 1,
    };
  });

  db.close();
  const base = { name, results };
  return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
}

// ── Display formatters ──────────────────────────────────────────────────────

/**
 * CLI display for dataflow command.
 */
export function dataflow(name, customDbPath, opts = {}) {
  if (opts.impact) {
    return dataflowImpact(name, customDbPath, opts);
  }

  const data = dataflowData(name, customDbPath, opts);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (opts.ndjson) {
    for (const r of data.results) {
      console.log(JSON.stringify(r));
    }
    return;
  }

  if (data.warning) {
    console.log(`⚠  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(`\n${r.kind} ${r.name}  (${r.file}:${r.line})`);
    console.log('─'.repeat(60));

    if (r.flowsTo.length > 0) {
      console.log('\n  Data flows TO:');
      for (const f of r.flowsTo) {
        const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
        console.log(`    → ${f.target} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
      }
    }

    if (r.flowsFrom.length > 0) {
      console.log('\n  Data flows FROM:');
      for (const f of r.flowsFrom) {
        const conf = f.confidence < 1.0 ? ` [${(f.confidence * 100).toFixed(0)}%]` : '';
        console.log(`    ← ${f.source} (${f.file}:${f.line}) arg[${f.paramIndex}]${conf}`);
      }
    }

    if (r.returns.length > 0) {
      console.log('\n  Return value consumed by:');
      for (const c of r.returns) {
        console.log(`    → ${c.consumer} (${c.file}:${c.line})  ${c.expression}`);
      }
    }

    if (r.returnedBy.length > 0) {
      console.log('\n  Uses return value of:');
      for (const p of r.returnedBy) {
        console.log(`    ← ${p.producer} (${p.file}:${p.line})  ${p.expression}`);
      }
    }

    if (r.mutates.length > 0) {
      console.log('\n  Mutates:');
      for (const m of r.mutates) {
        console.log(`    ✎ ${m.expression}  (line ${m.line})`);
      }
    }

    if (r.mutatedBy.length > 0) {
      console.log('\n  Mutated by:');
      for (const m of r.mutatedBy) {
        console.log(`    ✎ ${m.source} — ${m.expression}  (line ${m.line})`);
      }
    }
  }
}

/**
 * CLI display for dataflow --impact.
 */
function dataflowImpact(name, customDbPath, opts = {}) {
  const data = dataflowImpactData(name, customDbPath, {
    noTests: opts.noTests,
    depth: opts.depth ? Number(opts.depth) : 5,
    file: opts.file,
    kind: opts.kind,
    limit: opts.limit,
    offset: opts.offset,
  });

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (opts.ndjson) {
    for (const r of data.results) {
      console.log(JSON.stringify(r));
    }
    return;
  }

  if (data.warning) {
    console.log(`⚠  ${data.warning}`);
    return;
  }
  if (data.results.length === 0) {
    console.log(`No symbols matching "${name}".`);
    return;
  }

  for (const r of data.results) {
    console.log(
      `\n${r.kind} ${r.name}  (${r.file}:${r.line})  — ${r.totalAffected} data-dependent consumer${r.totalAffected !== 1 ? 's' : ''}`,
    );
    for (const [level, items] of Object.entries(r.levels)) {
      console.log(`  Level ${level}:`);
      for (const item of items) {
        console.log(`    ${item.name} (${item.file}:${item.line})`);
      }
    }
  }
}
