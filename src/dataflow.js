/**
 * Dataflow analysis — define/use chains and data movement edges.
 *
 * Adds three edge types to track how data moves through functions:
 *   - flows_to:  parameter/variable flows into another function as an argument
 *   - returns:   a call's return value is captured and used in the caller
 *   - mutates:   a parameter-derived value is mutated (e.g. arr.push())
 *
 * Opt-in via `build --dataflow`. Supports all languages with DATAFLOW_RULES.
 */

import fs from 'node:fs';
import path from 'node:path';
import { openReadonlyOrFail } from './db.js';
import { info } from './logger.js';
import { paginateResult } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';
import { ALL_SYMBOL_KINDS, normalizeSymbol } from './queries.js';
import { outputResult } from './result-formatter.js';
import { isTestFile } from './test-filter.js';

// ─── Language-Specific Dataflow Rules ────────────────────────────────────

const DATAFLOW_DEFAULTS = {
  // Scope entry
  functionNodes: new Set(), // REQUIRED: non-empty

  // Function name extraction
  nameField: 'name',
  varAssignedFnParent: null, // parent type for `const fn = ...` (JS only)
  assignmentFnParent: null, // parent type for `x = function...` (JS only)
  pairFnParent: null, // parent type for `{ key: function }` (JS only)

  // Parameters
  paramListField: 'parameters',
  paramIdentifier: 'identifier',
  paramWrapperTypes: new Set(),
  defaultParamType: null,
  restParamType: null,
  objectDestructType: null,
  arrayDestructType: null,
  shorthandPropPattern: null,
  pairPatternType: null,
  extractParamName: null, // override: (node) => string[]

  // Return
  returnNode: null,

  // Variable declarations
  varDeclaratorNode: null,
  varDeclaratorNodes: null,
  varNameField: 'name',
  varValueField: 'value',
  assignmentNode: null,
  assignLeftField: 'left',
  assignRightField: 'right',

  // Calls
  callNode: null,
  callNodes: null,
  callFunctionField: 'function',
  callArgsField: 'arguments',
  spreadType: null,

  // Member access
  memberNode: null,
  memberObjectField: 'object',
  memberPropertyField: 'property',
  optionalChainNode: null,

  // Await
  awaitNode: null,

  // Mutation
  mutatingMethods: new Set(),
  expressionStmtNode: 'expression_statement',
  callObjectField: null, // Java: combined call+member has [object] field on call node

  // Structural wrappers
  expressionListType: null, // Go: expression_list wraps LHS/RHS of short_var_declaration
  equalsClauseType: null, // C#: equals_value_clause wraps variable initializer
  argumentWrapperType: null, // PHP: individual args wrapped in 'argument' nodes
  extraIdentifierTypes: null, // Set of additional identifier-like types (PHP: variable_name, name)
};

const DATAFLOW_RULE_KEYS = new Set(Object.keys(DATAFLOW_DEFAULTS));

export function makeDataflowRules(overrides) {
  for (const key of Object.keys(overrides)) {
    if (!DATAFLOW_RULE_KEYS.has(key)) {
      throw new Error(`Dataflow rules: unknown key "${key}"`);
    }
  }
  const rules = { ...DATAFLOW_DEFAULTS, ...overrides };
  if (!(rules.functionNodes instanceof Set) || rules.functionNodes.size === 0) {
    throw new Error('Dataflow rules: functionNodes must be a non-empty Set');
  }
  return rules;
}

// ── JS / TS / TSX ────────────────────────────────────────────────────────

const JS_TS_MUTATING = new Set([
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

const JS_TS_DATAFLOW = makeDataflowRules({
  functionNodes: new Set([
    'function_declaration',
    'method_definition',
    'arrow_function',
    'function_expression',
    'function',
  ]),
  varAssignedFnParent: 'variable_declarator',
  assignmentFnParent: 'assignment_expression',
  pairFnParent: 'pair',
  paramWrapperTypes: new Set(['required_parameter', 'optional_parameter']),
  defaultParamType: 'assignment_pattern',
  restParamType: 'rest_pattern',
  objectDestructType: 'object_pattern',
  arrayDestructType: 'array_pattern',
  shorthandPropPattern: 'shorthand_property_identifier_pattern',
  pairPatternType: 'pair_pattern',
  returnNode: 'return_statement',
  varDeclaratorNode: 'variable_declarator',
  assignmentNode: 'assignment_expression',
  callNode: 'call_expression',
  spreadType: 'spread_element',
  memberNode: 'member_expression',
  optionalChainNode: 'optional_chain_expression',
  awaitNode: 'await_expression',
  mutatingMethods: JS_TS_MUTATING,
});

// ── Python ───────────────────────────────────────────────────────────────

const PYTHON_DATAFLOW = makeDataflowRules({
  functionNodes: new Set(['function_definition', 'lambda']),
  defaultParamType: 'default_parameter',
  restParamType: 'list_splat_pattern',
  returnNode: 'return_statement',
  varDeclaratorNode: null,
  assignmentNode: 'assignment',
  assignLeftField: 'left',
  assignRightField: 'right',
  callNode: 'call',
  callFunctionField: 'function',
  callArgsField: 'arguments',
  spreadType: 'list_splat',
  memberNode: 'attribute',
  memberObjectField: 'object',
  memberPropertyField: 'attribute',
  awaitNode: 'await',
  mutatingMethods: new Set([
    'append',
    'extend',
    'insert',
    'pop',
    'remove',
    'clear',
    'sort',
    'reverse',
    'add',
    'discard',
    'update',
  ]),
  extractParamName(node) {
    // typed_parameter / typed_default_parameter: first identifier child is the name
    if (node.type === 'typed_parameter' || node.type === 'typed_default_parameter') {
      for (const c of node.namedChildren) {
        if (c.type === 'identifier') return [c.text];
      }
      return null;
    }
    if (node.type === 'default_parameter') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    if (node.type === 'list_splat_pattern' || node.type === 'dictionary_splat_pattern') {
      for (const c of node.namedChildren) {
        if (c.type === 'identifier') return [c.text];
      }
      return null;
    }
    return null;
  },
});

// ── Go ───────────────────────────────────────────────────────────────────

const GO_DATAFLOW = makeDataflowRules({
  functionNodes: new Set(['function_declaration', 'method_declaration', 'func_literal']),
  returnNode: 'return_statement',
  varDeclaratorNodes: new Set(['short_var_declaration', 'var_declaration']),
  varNameField: 'left',
  varValueField: 'right',
  assignmentNode: 'assignment_statement',
  assignLeftField: 'left',
  assignRightField: 'right',
  callNode: 'call_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',
  memberNode: 'selector_expression',
  memberObjectField: 'operand',
  memberPropertyField: 'field',
  mutatingMethods: new Set(),
  expressionListType: 'expression_list',
  extractParamName(node) {
    // Go: parameter_declaration has name(s) + type; e.g. `a, b int`
    if (node.type === 'parameter_declaration') {
      const names = [];
      for (const c of node.namedChildren) {
        if (c.type === 'identifier') names.push(c.text);
      }
      return names.length > 0 ? names : null;
    }
    if (node.type === 'variadic_parameter_declaration') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    return null;
  },
});

// ── Rust ─────────────────────────────────────────────────────────────────

const RUST_DATAFLOW = makeDataflowRules({
  functionNodes: new Set(['function_item', 'closure_expression']),
  returnNode: 'return_expression',
  varDeclaratorNode: 'let_declaration',
  varNameField: 'pattern',
  varValueField: 'value',
  assignmentNode: 'assignment_expression',
  callNode: 'call_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',
  memberNode: 'field_expression',
  memberObjectField: 'value',
  memberPropertyField: 'field',
  awaitNode: 'await_expression',
  mutatingMethods: new Set(['push', 'pop', 'insert', 'remove', 'clear', 'sort', 'reverse']),
  extractParamName(node) {
    if (node.type === 'parameter') {
      const pat = node.childForFieldName('pattern');
      if (pat?.type === 'identifier') return [pat.text];
      return null;
    }
    if (node.type === 'identifier') return [node.text];
    return null;
  },
});

// ── Java ─────────────────────────────────────────────────────────────────

const JAVA_DATAFLOW = makeDataflowRules({
  functionNodes: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
  returnNode: 'return_statement',
  varDeclaratorNode: 'variable_declarator',
  assignmentNode: 'assignment_expression',
  callNodes: new Set(['method_invocation', 'object_creation_expression']),
  callFunctionField: 'name',
  callArgsField: 'arguments',
  memberNode: 'field_access',
  memberObjectField: 'object',
  memberPropertyField: 'field',
  callObjectField: 'object',
  argumentWrapperType: 'argument',
  mutatingMethods: new Set(['add', 'remove', 'clear', 'put', 'set', 'push', 'pop', 'sort']),
  extractParamName(node) {
    if (node.type === 'formal_parameter' || node.type === 'spread_parameter') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    if (node.type === 'identifier') return [node.text];
    return null;
  },
});

// ── C# ───────────────────────────────────────────────────────────────────

const CSHARP_DATAFLOW = makeDataflowRules({
  functionNodes: new Set([
    'method_declaration',
    'constructor_declaration',
    'lambda_expression',
    'local_function_statement',
  ]),
  returnNode: 'return_statement',
  varDeclaratorNode: 'variable_declarator',
  varNameField: 'name',
  assignmentNode: 'assignment_expression',
  callNode: 'invocation_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',
  memberNode: 'member_access_expression',
  memberObjectField: 'expression',
  memberPropertyField: 'name',
  awaitNode: 'await_expression',
  argumentWrapperType: 'argument',
  mutatingMethods: new Set(['Add', 'Remove', 'Clear', 'Insert', 'Sort', 'Reverse', 'Push', 'Pop']),
  extractParamName(node) {
    if (node.type === 'parameter') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    if (node.type === 'identifier') return [node.text];
    return null;
  },
});

// ── PHP ──────────────────────────────────────────────────────────────────

const PHP_DATAFLOW = makeDataflowRules({
  functionNodes: new Set([
    'function_definition',
    'method_declaration',
    'anonymous_function_creation_expression',
    'arrow_function',
  ]),
  paramListField: 'parameters',
  paramIdentifier: 'variable_name',
  returnNode: 'return_statement',
  varDeclaratorNode: null,
  assignmentNode: 'assignment_expression',
  assignLeftField: 'left',
  assignRightField: 'right',
  callNodes: new Set([
    'function_call_expression',
    'member_call_expression',
    'scoped_call_expression',
  ]),
  callFunctionField: 'function',
  callArgsField: 'arguments',
  spreadType: 'spread_expression',
  memberNode: 'member_access_expression',
  memberObjectField: 'object',
  memberPropertyField: 'name',
  argumentWrapperType: 'argument',
  extraIdentifierTypes: new Set(['variable_name', 'name']),
  mutatingMethods: new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse']),
  extractParamName(node) {
    // PHP: simple_parameter → $name or &$name
    if (node.type === 'simple_parameter' || node.type === 'variadic_parameter') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    if (node.type === 'variable_name') return [node.text];
    return null;
  },
});

// ── Ruby ─────────────────────────────────────────────────────────────────

const RUBY_DATAFLOW = makeDataflowRules({
  functionNodes: new Set(['method', 'singleton_method', 'lambda']),
  paramListField: 'parameters',
  returnNode: 'return',
  varDeclaratorNode: null,
  assignmentNode: 'assignment',
  assignLeftField: 'left',
  assignRightField: 'right',
  callNode: 'call',
  callFunctionField: 'method',
  callArgsField: 'arguments',
  spreadType: 'splat_parameter',
  memberNode: 'call',
  memberObjectField: 'receiver',
  memberPropertyField: 'method',
  mutatingMethods: new Set([
    'push',
    'pop',
    'shift',
    'unshift',
    'delete',
    'clear',
    'sort!',
    'reverse!',
    'map!',
    'select!',
    'reject!',
    'compact!',
    'flatten!',
    'concat',
    'replace',
    'insert',
  ]),
  extractParamName(node) {
    if (node.type === 'identifier') return [node.text];
    if (
      node.type === 'optional_parameter' ||
      node.type === 'keyword_parameter' ||
      node.type === 'splat_parameter' ||
      node.type === 'hash_splat_parameter'
    ) {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    return null;
  },
});

// ── Rules Map + Extensions Set ───────────────────────────────────────────

export const DATAFLOW_RULES = new Map([
  ['javascript', JS_TS_DATAFLOW],
  ['typescript', JS_TS_DATAFLOW],
  ['tsx', JS_TS_DATAFLOW],
  ['python', PYTHON_DATAFLOW],
  ['go', GO_DATAFLOW],
  ['rust', RUST_DATAFLOW],
  ['java', JAVA_DATAFLOW],
  ['csharp', CSHARP_DATAFLOW],
  ['php', PHP_DATAFLOW],
  ['ruby', RUBY_DATAFLOW],
]);

const DATAFLOW_LANG_IDS = new Set(DATAFLOW_RULES.keys());

export const DATAFLOW_EXTENSIONS = new Set();
for (const entry of LANGUAGE_REGISTRY) {
  if (DATAFLOW_RULES.has(entry.id)) {
    for (const ext of entry.extensions) DATAFLOW_EXTENSIONS.add(ext);
  }
}

// ── AST helpers ──────────────────────────────────────────────────────────────

function truncate(str, max = 120) {
  if (!str) return '';
  return str.length > max ? `${str.slice(0, max)}…` : str;
}

/**
 * Get the name of a function node from the AST using rules.
 */
function functionName(fnNode, rules) {
  if (!fnNode) return null;
  // Try the standard name field first (works for most languages)
  const nameNode = fnNode.childForFieldName(rules.nameField);
  if (nameNode) return nameNode.text;

  // JS-specific: arrow_function/function_expression assigned to variable, pair, or assignment
  const parent = fnNode.parent;
  if (parent) {
    if (rules.varAssignedFnParent && parent.type === rules.varAssignedFnParent) {
      const n = parent.childForFieldName('name');
      return n ? n.text : null;
    }
    if (rules.pairFnParent && parent.type === rules.pairFnParent) {
      const keyNode = parent.childForFieldName('key');
      return keyNode ? keyNode.text : null;
    }
    if (rules.assignmentFnParent && parent.type === rules.assignmentFnParent) {
      const left = parent.childForFieldName(rules.assignLeftField);
      return left ? left.text : null;
    }
  }
  return null;
}

/**
 * Extract parameter names and indices from a formal_parameters node.
 */
function extractParams(paramsNode, rules) {
  if (!paramsNode) return [];
  const result = [];
  let index = 0;
  for (const child of paramsNode.namedChildren) {
    const names = extractParamNames(child, rules);
    for (const name of names) {
      result.push({ name, index });
    }
    index++;
  }
  return result;
}

function extractParamNames(node, rules) {
  if (!node) return [];
  const t = node.type;

  // Language-specific override (Go, Rust, Java, C#, PHP, Ruby)
  if (rules.extractParamName) {
    const result = rules.extractParamName(node);
    if (result) return result;
  }

  // Leaf identifier
  if (t === rules.paramIdentifier) return [node.text];

  // Wrapper types (TS required_parameter, Python typed_parameter, etc.)
  if (rules.paramWrapperTypes.has(t)) {
    const pattern = node.childForFieldName('pattern') || node.childForFieldName('name');
    return pattern ? extractParamNames(pattern, rules) : [];
  }

  // Default parameter (assignment_pattern / default_parameter)
  if (rules.defaultParamType && t === rules.defaultParamType) {
    const left = node.childForFieldName('left') || node.childForFieldName('name');
    return left ? extractParamNames(left, rules) : [];
  }

  // Rest / splat parameter
  if (rules.restParamType && t === rules.restParamType) {
    // Try name field first, then fall back to scanning children
    const nameNode = node.childForFieldName('name');
    if (nameNode) return [nameNode.text];
    for (const child of node.namedChildren) {
      if (child.type === rules.paramIdentifier) return [child.text];
    }
    return [];
  }

  // Object destructuring (JS only)
  if (rules.objectDestructType && t === rules.objectDestructType) {
    const names = [];
    for (const child of node.namedChildren) {
      if (rules.shorthandPropPattern && child.type === rules.shorthandPropPattern) {
        names.push(child.text);
      } else if (rules.pairPatternType && child.type === rules.pairPatternType) {
        const value = child.childForFieldName('value');
        if (value) names.push(...extractParamNames(value, rules));
      } else if (rules.restParamType && child.type === rules.restParamType) {
        names.push(...extractParamNames(child, rules));
      }
    }
    return names;
  }

  // Array destructuring (JS only)
  if (rules.arrayDestructType && t === rules.arrayDestructType) {
    const names = [];
    for (const child of node.namedChildren) {
      names.push(...extractParamNames(child, rules));
    }
    return names;
  }

  return [];
}

/** Check if a node type is identifier-like for this language. */
function isIdent(nodeType, rules) {
  if (nodeType === 'identifier' || nodeType === rules.paramIdentifier) return true;
  return rules.extraIdentifierTypes ? rules.extraIdentifierTypes.has(nodeType) : false;
}

/**
 * Resolve the name a call expression is calling using rules.
 */
function resolveCalleeName(callNode, rules) {
  const fn = callNode.childForFieldName(rules.callFunctionField);
  if (!fn) {
    // Some languages (Java method_invocation, Ruby call) use 'name' field directly
    const nameNode = callNode.childForFieldName('name') || callNode.childForFieldName('method');
    return nameNode ? nameNode.text : null;
  }
  if (isIdent(fn.type, rules)) return fn.text;
  if (fn.type === rules.memberNode) {
    const prop = fn.childForFieldName(rules.memberPropertyField);
    return prop ? prop.text : null;
  }
  if (rules.optionalChainNode && fn.type === rules.optionalChainNode) {
    const target = fn.namedChildren[0];
    if (!target) return null;
    if (target.type === rules.memberNode) {
      const prop = target.childForFieldName(rules.memberPropertyField);
      return prop ? prop.text : null;
    }
    if (target.type === 'identifier') return target.text;
    const prop = fn.childForFieldName(rules.memberPropertyField);
    return prop ? prop.text : null;
  }
  return null;
}

/**
 * Get the receiver (object) of a member expression using rules.
 */
function memberReceiver(memberExpr, rules) {
  const obj = memberExpr.childForFieldName(rules.memberObjectField);
  if (!obj) return null;
  if (isIdent(obj.type, rules)) return obj.text;
  if (obj.type === rules.memberNode) return memberReceiver(obj, rules);
  return null;
}

// ── extractDataflow ──────────────────────────────────────────────────────────

/**
 * Extract dataflow information from a parsed AST.
 *
 * @param {object} tree - tree-sitter parse tree
 * @param {string} filePath - relative file path
 * @param {object[]} definitions - symbol definitions from the parser
 * @param {string} [langId='javascript'] - language identifier for rules lookup
 * @returns {{ parameters, returns, assignments, argFlows, mutations }}
 */
export function extractDataflow(tree, _filePath, _definitions, langId = 'javascript') {
  const rules = DATAFLOW_RULES.get(langId);
  if (!rules) return { parameters: [], returns: [], assignments: [], argFlows: [], mutations: [] };

  const isCallNode = rules.callNodes ? (t) => rules.callNodes.has(t) : (t) => t === rules.callNode;

  const parameters = [];
  const returns = [];
  const assignments = [];
  const argFlows = [];
  const mutations = [];

  const scopeStack = [];

  function currentScope() {
    return scopeStack.length > 0 ? scopeStack[scopeStack.length - 1] : null;
  }

  function findBinding(name) {
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
    const name = functionName(fnNode, rules);
    const paramsNode = fnNode.childForFieldName(rules.paramListField);
    const paramList = extractParams(paramsNode, rules);
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

  function bindingConfidence(binding) {
    if (!binding) return 0.5;
    if (binding.type === 'param') return 1.0;
    if (binding.type === 'local') {
      if (binding.source?.type === 'call_return') return 0.9;
      if (binding.source?.type === 'destructured') return 0.8;
      return 0.9;
    }
    return 0.5;
  }

  /** Unwrap await if present, returning the inner expression. */
  function unwrapAwait(node) {
    if (rules.awaitNode && node.type === rules.awaitNode) {
      return node.namedChildren[0] || node;
    }
    return node;
  }

  /** Check if a node is a call expression (single or multi-type). */
  function isCall(node) {
    return node && isCallNode(node.type);
  }

  /** Handle a variable declarator / short_var_declaration node. */
  function handleVarDeclarator(node) {
    let nameNode = node.childForFieldName(rules.varNameField);
    let valueNode = rules.varValueField ? node.childForFieldName(rules.varValueField) : null;

    // C#: initializer is inside equals_value_clause child
    if (!valueNode && rules.equalsClauseType) {
      for (const child of node.namedChildren) {
        if (child.type === rules.equalsClauseType) {
          valueNode = child.childForFieldName('value') || child.namedChildren[0];
          break;
        }
      }
    }

    // Fallback: initializer is a direct unnamed child (C# variable_declarator)
    if (!valueNode) {
      for (const child of node.namedChildren) {
        if (child !== nameNode && isCall(unwrapAwait(child))) {
          valueNode = child;
          break;
        }
      }
    }

    // Go: expression_list wraps LHS/RHS — unwrap to first named child
    if (rules.expressionListType) {
      if (nameNode?.type === rules.expressionListType) nameNode = nameNode.namedChildren[0];
      if (valueNode?.type === rules.expressionListType) valueNode = valueNode.namedChildren[0];
    }

    const scope = currentScope();
    if (!nameNode || !valueNode || !scope) return;

    const unwrapped = unwrapAwait(valueNode);
    const callExpr = isCall(unwrapped) ? unwrapped : null;

    if (callExpr) {
      const callee = resolveCalleeName(callExpr, rules);
      if (callee && scope.funcName) {
        // Destructuring: const { a, b } = foo()
        if (
          (rules.objectDestructType && nameNode.type === rules.objectDestructType) ||
          (rules.arrayDestructType && nameNode.type === rules.arrayDestructType)
        ) {
          const names = extractParamNames(nameNode, rules);
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
          const varName =
            nameNode.type === 'identifier' || nameNode.type === rules.paramIdentifier
              ? nameNode.text
              : nameNode.text;
          assignments.push({
            varName,
            callerFunc: scope.funcName,
            sourceCallName: callee,
            expression: truncate(node.text),
            line: node.startPosition.row + 1,
          });
          scope.locals.set(varName, { type: 'call_return', callee });
        }
      }
    }
  }

  /** Handle assignment expressions (mutation detection + call captures). */
  function handleAssignment(node) {
    const left = node.childForFieldName(rules.assignLeftField);
    const right = node.childForFieldName(rules.assignRightField);
    const scope = currentScope();
    if (!scope?.funcName) return;

    // Mutation: obj.prop = value
    if (left && rules.memberNode && left.type === rules.memberNode) {
      const receiver = memberReceiver(left, rules);
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

    // Non-declaration assignment: x = foo()
    if (left && isIdent(left.type, rules) && right) {
      const unwrapped = unwrapAwait(right);
      const callExpr = isCall(unwrapped) ? unwrapped : null;
      if (callExpr) {
        const callee = resolveCalleeName(callExpr, rules);
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

  /** Handle call expressions: track argument flows. */
  function handleCallExpr(node) {
    const callee = resolveCalleeName(node, rules);
    const argsNode = node.childForFieldName(rules.callArgsField);
    const scope = currentScope();
    if (!callee || !argsNode || !scope?.funcName) return;

    let argIndex = 0;
    for (let arg of argsNode.namedChildren) {
      // PHP/Java: unwrap argument wrapper
      if (rules.argumentWrapperType && arg.type === rules.argumentWrapperType) {
        arg = arg.namedChildren[0] || arg;
      }
      const unwrapped =
        rules.spreadType && arg.type === rules.spreadType ? arg.namedChildren[0] || arg : arg;
      if (!unwrapped) {
        argIndex++;
        continue;
      }

      const argName = isIdent(unwrapped.type, rules) ? unwrapped.text : null;
      const argMember =
        rules.memberNode && unwrapped.type === rules.memberNode
          ? memberReceiver(unwrapped, rules)
          : null;
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

  /** Detect mutating method calls in expression statements. */
  function handleExprStmtMutation(node) {
    if (rules.mutatingMethods.size === 0) return;
    const expr = node.namedChildren[0];
    if (!expr || !isCall(expr)) return;

    let methodName = null;
    let receiver = null;

    // Standard pattern: call(fn: member(obj, prop))
    const fn = expr.childForFieldName(rules.callFunctionField);
    if (fn && fn.type === rules.memberNode) {
      const prop = fn.childForFieldName(rules.memberPropertyField);
      methodName = prop ? prop.text : null;
      receiver = memberReceiver(fn, rules);
    }

    // Java/combined pattern: call node itself has object + name fields
    if (!receiver && rules.callObjectField) {
      const obj = expr.childForFieldName(rules.callObjectField);
      const name = expr.childForFieldName(rules.callFunctionField);
      if (obj && name) {
        methodName = name.text;
        receiver = isIdent(obj.type, rules) ? obj.text : null;
      }
    }

    if (!methodName || !rules.mutatingMethods.has(methodName)) return;

    const scope = currentScope();
    if (!receiver || !scope?.funcName) return;

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

  // Recursive AST walk
  function visit(node) {
    if (!node) return;
    const t = node.type;

    // Enter function scopes
    if (rules.functionNodes.has(t)) {
      enterScope(node);
      for (const child of node.namedChildren) {
        visit(child);
      }
      exitScope();
      return;
    }

    // Return statements
    if (rules.returnNode && t === rules.returnNode) {
      const scope = currentScope();
      if (scope?.funcName) {
        const expr = node.namedChildren[0];
        const referencedNames = [];
        if (expr) collectIdentifiers(expr, referencedNames, rules);
        returns.push({
          funcName: scope.funcName,
          expression: truncate(expr ? expr.text : ''),
          referencedNames,
          line: node.startPosition.row + 1,
        });
      }
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Variable declarations
    if (rules.varDeclaratorNode && t === rules.varDeclaratorNode) {
      handleVarDeclarator(node);
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }
    if (rules.varDeclaratorNodes?.has(t)) {
      handleVarDeclarator(node);
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Call expressions
    if (isCallNode(t)) {
      handleCallExpr(node);
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Assignment expressions
    if (rules.assignmentNode && t === rules.assignmentNode) {
      handleAssignment(node);
      for (const child of node.namedChildren) {
        visit(child);
      }
      return;
    }

    // Mutation detection via expression_statement
    if (rules.expressionStmtNode && t === rules.expressionStmtNode) {
      handleExprStmtMutation(node);
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
 * Uses isIdent() to support language-specific identifier node types
 * (e.g. PHP's `variable_name`).
 */
function collectIdentifiers(node, out, rules) {
  if (!node) return;
  if (isIdent(node.type, rules)) {
    out.push(node.text);
    return;
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out, rules);
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
    if (!symbols._tree && !symbols.dataflow) {
      const ext = path.extname(relPath).toLowerCase();
      if (DATAFLOW_EXTENSIONS.has(ext)) {
        needsFallback = true;
        break;
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
      if (!DATAFLOW_EXTENSIONS.has(ext)) continue;

      // Use native dataflow data if available — skip WASM extraction
      let data = symbols.dataflow;
      if (!data) {
        let tree = symbols._tree;
        let langId = symbols._langId;

        // WASM fallback if no cached tree
        if (!tree) {
          if (!getParserFn) continue;
          langId = extToLang.get(ext);
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

        if (!langId) {
          langId = extToLang.get(ext);
          if (!langId) continue;
        }

        if (!DATAFLOW_RULES.has(langId)) continue;

        data = extractDataflow(tree, relPath, symbols.definitions, langId);
      }

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
  try {
    const noTests = opts.noTests || false;

    if (!hasDataflowTable(db)) {
      return {
        name,
        results: [],
        warning:
          'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
      };
    }

    const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
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

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
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
  try {
    const noTests = opts.noTests || false;
    const maxDepth = opts.maxDepth || 10;

    if (!hasDataflowTable(db)) {
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
      return { from, to, found: false, error: `No symbol matching "${from}"` };
    }

    const toNodes = findNodes(db, to, { noTests, file: opts.toFile, kind: opts.kind });
    if (toNodes.length === 0) {
      return { from, to, found: false, error: `No symbol matching "${to}"` };
    }

    const sourceNode = fromNodes[0];
    const targetNode = toNodes[0];

    if (sourceNode.id === targetNode.id) {
      const hc = new Map();
      const sym = normalizeSymbol(sourceNode, db, hc);
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

    return { from, to, found: true, hops: pathItems.length - 1, path: pathItems };
  } finally {
    db.close();
  }
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
  try {
    const maxDepth = opts.depth || 5;
    const noTests = opts.noTests || false;

    if (!hasDataflowTable(db)) {
      return {
        name,
        results: [],
        warning:
          'No dataflow data found. Rebuild with `codegraph build` (dataflow is now included by default).',
      };
    }

    const nodes = findNodes(db, name, { noTests, file: opts.file, kind: opts.kind });
    if (nodes.length === 0) {
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

    const base = { name, results };
    return paginateResult(base, 'results', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
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

  if (outputResult(data, 'results', opts)) return;

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

  if (outputResult(data, 'results', opts)) return;

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
