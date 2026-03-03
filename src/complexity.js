import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { openReadonlyOrFail } from './db.js';
import { info } from './logger.js';
import { paginateResult, printNdjson } from './paginate.js';
import { LANGUAGE_REGISTRY } from './parser.js';
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
  // If/else pattern detection
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_statement']),
};

const PYTHON_RULES = {
  branchNodes: new Set([
    'if_statement',
    'elif_clause',
    'else_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'match_statement',
  ]),
  caseNodes: new Set(['case_clause']),
  logicalOperators: new Set(['and', 'or']),
  logicalNodeType: 'boolean_operator',
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
  ]),
  functionNodes: new Set(['function_definition', 'lambda']),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: 'elif_clause',
  elseViaAlternative: false,
  switchLikeNodes: new Set(['match_statement']),
};

const GO_RULES = {
  branchNodes: new Set([
    'if_statement',
    'for_statement',
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
  ]),
  caseNodes: new Set(['expression_case', 'type_case', 'default_case', 'communication_case']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeType: 'binary_expression',
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'expression_switch_statement',
    'type_switch_statement',
    'select_statement',
  ]),
  functionNodes: new Set(['function_declaration', 'method_declaration', 'func_literal']),
  ifNodeType: 'if_statement',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['expression_switch_statement', 'type_switch_statement']),
};

const RUST_RULES = {
  branchNodes: new Set([
    'if_expression',
    'else_clause',
    'for_expression',
    'while_expression',
    'loop_expression',
    'if_let_expression',
    'while_let_expression',
    'match_expression',
  ]),
  caseNodes: new Set(['match_arm']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeType: 'binary_expression',
  optionalChainType: null,
  nestingNodes: new Set([
    'if_expression',
    'for_expression',
    'while_expression',
    'loop_expression',
    'if_let_expression',
    'while_let_expression',
    'match_expression',
  ]),
  functionNodes: new Set(['function_item', 'closure_expression']),
  ifNodeType: 'if_expression',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['match_expression']),
};

const JAVA_RULES = {
  branchNodes: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
    'switch_expression',
  ]),
  caseNodes: new Set(['switch_label']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeType: 'binary_expression',
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'enhanced_for_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'ternary_expression',
  ]),
  functionNodes: new Set(['method_declaration', 'constructor_declaration', 'lambda_expression']),
  ifNodeType: 'if_statement',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['switch_expression']),
};

const CSHARP_RULES = {
  branchNodes: new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'for_each_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
    'switch_statement',
  ]),
  caseNodes: new Set(['switch_section']),
  logicalOperators: new Set(['&&', '||', '??']),
  logicalNodeType: 'binary_expression',
  optionalChainType: 'conditional_access_expression',
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'for_each_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
    'switch_statement',
  ]),
  functionNodes: new Set([
    'method_declaration',
    'constructor_declaration',
    'lambda_expression',
    'local_function_statement',
  ]),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_statement']),
};

const RUBY_RULES = {
  branchNodes: new Set([
    'if',
    'elsif',
    'else',
    'unless',
    'case',
    'for',
    'while',
    'until',
    'rescue',
    'conditional',
  ]),
  caseNodes: new Set(['when']),
  logicalOperators: new Set(['and', 'or', '&&', '||']),
  logicalNodeType: 'binary',
  optionalChainType: null,
  nestingNodes: new Set(['if', 'unless', 'case', 'for', 'while', 'until', 'rescue', 'conditional']),
  functionNodes: new Set(['method', 'singleton_method', 'lambda', 'do_block']),
  ifNodeType: 'if',
  elseNodeType: 'else',
  elifNodeType: 'elsif',
  elseViaAlternative: false,
  switchLikeNodes: new Set(['case']),
};

const PHP_RULES = {
  branchNodes: new Set([
    'if_statement',
    'else_if_clause',
    'else_clause',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
    'switch_statement',
  ]),
  caseNodes: new Set(['case_statement', 'default_statement']),
  logicalOperators: new Set(['&&', '||', 'and', 'or', '??']),
  logicalNodeType: 'binary_expression',
  optionalChainType: 'nullsafe_member_access_expression',
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
    'switch_statement',
  ]),
  functionNodes: new Set([
    'function_definition',
    'method_declaration',
    'anonymous_function_creation_expression',
    'arrow_function',
  ]),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: 'else_if_clause',
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_statement']),
};

export const COMPLEXITY_RULES = new Map([
  ['javascript', JS_TS_RULES],
  ['typescript', JS_TS_RULES],
  ['tsx', JS_TS_RULES],
  ['python', PYTHON_RULES],
  ['go', GO_RULES],
  ['rust', RUST_RULES],
  ['java', JAVA_RULES],
  ['c_sharp', CSHARP_RULES],
  ['ruby', RUBY_RULES],
  ['php', PHP_RULES],
]);

// Extensions whose language has complexity rules — used to skip needless WASM init
const COMPLEXITY_EXTENSIONS = new Set();
for (const entry of LANGUAGE_REGISTRY) {
  if (COMPLEXITY_RULES.has(entry.id)) {
    for (const ext of entry.extensions) COMPLEXITY_EXTENSIONS.add(ext);
  }
}

// ─── Halstead Operator/Operand Classification ────────────────────────────

const JS_TS_HALSTEAD = {
  operatorLeafTypes: new Set([
    // Arithmetic
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
    // Assignment
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '<<=',
    '>>=',
    '>>>=',
    '&=',
    '|=',
    '^=',
    '&&=',
    '||=',
    '??=',
    // Comparison
    '==',
    '===',
    '!=',
    '!==',
    '<',
    '>',
    '<=',
    '>=',
    // Logical
    '&&',
    '||',
    '!',
    '??',
    // Bitwise
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '>>>',
    // Unary
    '++',
    '--',
    // Keywords as operators
    'typeof',
    'instanceof',
    'new',
    'return',
    'throw',
    'yield',
    'await',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    // Arrow, spread, ternary, access
    '=>',
    '...',
    '?',
    ':',
    '.',
    '?.',
    // Delimiters counted as operators
    ',',
    ';',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'property_identifier',
    'shorthand_property_identifier',
    'shorthand_property_identifier_pattern',
    'number',
    'string_fragment',
    'regex_pattern',
    'true',
    'false',
    'null',
    'undefined',
    'this',
    'super',
    'private_property_identifier',
  ]),
  compoundOperators: new Set([
    'call_expression',
    'subscript_expression',
    'new_expression',
    'template_substitution',
  ]),
  skipTypes: new Set(['type_annotation', 'type_parameters', 'return_type', 'implements_clause']),
};

const PYTHON_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
    '//',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '//=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    'and',
    'or',
    'not',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    'if',
    'else',
    'elif',
    'for',
    'while',
    'with',
    'try',
    'except',
    'finally',
    'raise',
    'return',
    'yield',
    'await',
    'pass',
    'break',
    'continue',
    'import',
    'from',
    'as',
    'in',
    'is',
    'lambda',
    'del',
    '.',
    ',',
    ':',
    '@',
    '->',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'integer',
    'float',
    'string_content',
    'true',
    'false',
    'none',
  ]),
  compoundOperators: new Set(['call', 'subscript', 'attribute']),
  skipTypes: new Set([]),
};

const GO_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '=',
    ':=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '&&',
    '||',
    '!',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '&^',
    '++',
    '--',
    'if',
    'else',
    'for',
    'switch',
    'select',
    'case',
    'default',
    'return',
    'break',
    'continue',
    'goto',
    'fallthrough',
    'go',
    'defer',
    'range',
    'chan',
    'func',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    '.',
    ',',
    ';',
    ':',
    '<-',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'field_identifier',
    'package_identifier',
    'type_identifier',
    'int_literal',
    'float_literal',
    'imaginary_literal',
    'rune_literal',
    'interpreted_string_literal',
    'raw_string_literal',
    'true',
    'false',
    'nil',
    'iota',
  ]),
  compoundOperators: new Set(['call_expression', 'index_expression', 'selector_expression']),
  skipTypes: new Set([]),
};

const RUST_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '&&',
    '||',
    '!',
    '&',
    '|',
    '^',
    '<<',
    '>>',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'match',
    'return',
    'break',
    'continue',
    'let',
    'mut',
    'ref',
    'as',
    'in',
    'move',
    'fn',
    'struct',
    'enum',
    'trait',
    'impl',
    'pub',
    'mod',
    'use',
    '.',
    ',',
    ';',
    ':',
    '::',
    '=>',
    '->',
    '?',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'field_identifier',
    'type_identifier',
    'integer_literal',
    'float_literal',
    'string_content',
    'char_literal',
    'true',
    'false',
    'self',
    'Self',
  ]),
  compoundOperators: new Set(['call_expression', 'index_expression', 'field_expression']),
  skipTypes: new Set([]),
};

const JAVA_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '>>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '&&',
    '||',
    '!',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '>>>',
    '++',
    '--',
    'instanceof',
    'new',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'return',
    'throw',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    '.',
    ',',
    ';',
    ':',
    '?',
    '->',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'type_identifier',
    'decimal_integer_literal',
    'hex_integer_literal',
    'octal_integer_literal',
    'binary_integer_literal',
    'decimal_floating_point_literal',
    'hex_floating_point_literal',
    'string_literal',
    'character_literal',
    'true',
    'false',
    'null',
    'this',
    'super',
  ]),
  compoundOperators: new Set(['method_invocation', 'array_access', 'object_creation_expression']),
  skipTypes: new Set(['type_arguments', 'type_parameters']),
};

const CSHARP_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '&&',
    '||',
    '!',
    '??',
    '??=',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '++',
    '--',
    'is',
    'as',
    'new',
    'typeof',
    'sizeof',
    'nameof',
    'if',
    'else',
    'for',
    'foreach',
    'while',
    'do',
    'switch',
    'case',
    'return',
    'throw',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'await',
    'yield',
    '.',
    '?.',
    ',',
    ';',
    ':',
    '=>',
    '->',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'integer_literal',
    'real_literal',
    'string_literal',
    'character_literal',
    'verbatim_string_literal',
    'interpolated_string_text',
    'true',
    'false',
    'null',
    'this',
    'base',
  ]),
  compoundOperators: new Set([
    'invocation_expression',
    'element_access_expression',
    'object_creation_expression',
  ]),
  skipTypes: new Set(['type_argument_list', 'type_parameter_list']),
};

const RUBY_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '<=>',
    '===',
    '=~',
    '!~',
    '&&',
    '||',
    '!',
    'and',
    'or',
    'not',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    'if',
    'else',
    'elsif',
    'unless',
    'case',
    'when',
    'for',
    'while',
    'until',
    'do',
    'begin',
    'end',
    'return',
    'raise',
    'break',
    'next',
    'redo',
    'retry',
    'rescue',
    'ensure',
    'yield',
    'def',
    'class',
    'module',
    '.',
    ',',
    ':',
    '::',
    '=>',
    '->',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'constant',
    'instance_variable',
    'class_variable',
    'global_variable',
    'integer',
    'float',
    'string_content',
    'symbol',
    'true',
    'false',
    'nil',
    'self',
  ]),
  compoundOperators: new Set(['call', 'element_reference']),
  skipTypes: new Set([]),
};

const PHP_HALSTEAD = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '%',
    '**',
    '=',
    '+=',
    '-=',
    '*=',
    '/=',
    '%=',
    '**=',
    '.=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '==',
    '===',
    '!=',
    '!==',
    '<',
    '>',
    '<=',
    '>=',
    '<=>',
    '&&',
    '||',
    '!',
    'and',
    'or',
    'xor',
    '??',
    '&',
    '|',
    '^',
    '~',
    '<<',
    '>>',
    '++',
    '--',
    'instanceof',
    'new',
    'clone',
    'if',
    'else',
    'elseif',
    'for',
    'foreach',
    'while',
    'do',
    'switch',
    'case',
    'return',
    'throw',
    'break',
    'continue',
    'try',
    'catch',
    'finally',
    'echo',
    'print',
    'yield',
    '.',
    '->',
    '?->',
    '::',
    ',',
    ';',
    ':',
    '?',
    '=>',
  ]),
  operandLeafTypes: new Set([
    'name',
    'variable_name',
    'integer',
    'float',
    'string_content',
    'true',
    'false',
    'null',
  ]),
  compoundOperators: new Set([
    'function_call_expression',
    'member_call_expression',
    'scoped_call_expression',
    'subscript_expression',
    'object_creation_expression',
  ]),
  skipTypes: new Set([]),
};

export const HALSTEAD_RULES = new Map([
  ['javascript', JS_TS_HALSTEAD],
  ['typescript', JS_TS_HALSTEAD],
  ['tsx', JS_TS_HALSTEAD],
  ['python', PYTHON_HALSTEAD],
  ['go', GO_HALSTEAD],
  ['rust', RUST_HALSTEAD],
  ['java', JAVA_HALSTEAD],
  ['c_sharp', CSHARP_HALSTEAD],
  ['ruby', RUBY_HALSTEAD],
  ['php', PHP_HALSTEAD],
]);

// ─── Halstead Metrics Computation ─────────────────────────────────────────

/**
 * Compute Halstead metrics for a function's AST subtree.
 *
 * @param {object} functionNode - tree-sitter node for the function
 * @param {string} language - Language ID
 * @returns {{ n1: number, n2: number, bigN1: number, bigN2: number, vocabulary: number, length: number, volume: number, difficulty: number, effort: number, bugs: number } | null}
 */
export function computeHalsteadMetrics(functionNode, language) {
  const rules = HALSTEAD_RULES.get(language);
  if (!rules) return null;

  const operators = new Map(); // type -> count
  const operands = new Map(); // text -> count

  function walk(node) {
    if (!node) return;

    // Skip type annotation subtrees
    if (rules.skipTypes.has(node.type)) return;

    // Compound operators (non-leaf): count the node type as an operator
    if (rules.compoundOperators.has(node.type)) {
      operators.set(node.type, (operators.get(node.type) || 0) + 1);
    }

    // Leaf nodes: classify as operator or operand
    if (node.childCount === 0) {
      if (rules.operatorLeafTypes.has(node.type)) {
        operators.set(node.type, (operators.get(node.type) || 0) + 1);
      } else if (rules.operandLeafTypes.has(node.type)) {
        const text = node.text;
        operands.set(text, (operands.get(text) || 0) + 1);
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(functionNode);

  const n1 = operators.size; // distinct operators
  const n2 = operands.size; // distinct operands
  let bigN1 = 0; // total operators
  for (const c of operators.values()) bigN1 += c;
  let bigN2 = 0; // total operands
  for (const c of operands.values()) bigN2 += c;

  const vocabulary = n1 + n2;
  const length = bigN1 + bigN2;

  // Guard against zero
  const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
  const difficulty = n2 > 0 ? (n1 / 2) * (bigN2 / n2) : 0;
  const effort = difficulty * volume;
  const bugs = volume / 3000;

  return {
    n1,
    n2,
    bigN1,
    bigN2,
    vocabulary,
    length,
    volume: +volume.toFixed(2),
    difficulty: +difficulty.toFixed(2),
    effort: +effort.toFixed(2),
    bugs: +bugs.toFixed(4),
  };
}

// ─── LOC Metrics Computation ──────────────────────────────────────────────

const C_STYLE_PREFIXES = ['//', '/*', '*', '*/'];

const COMMENT_PREFIXES = new Map([
  ['javascript', C_STYLE_PREFIXES],
  ['typescript', C_STYLE_PREFIXES],
  ['tsx', C_STYLE_PREFIXES],
  ['go', C_STYLE_PREFIXES],
  ['rust', C_STYLE_PREFIXES],
  ['java', C_STYLE_PREFIXES],
  ['c_sharp', C_STYLE_PREFIXES],
  ['python', ['#']],
  ['ruby', ['#']],
  ['php', ['//', '#', '/*', '*', '*/']],
]);

/**
 * Compute LOC metrics from a function node's source text.
 *
 * @param {object} functionNode - tree-sitter node
 * @param {string} [language] - Language ID (falls back to C-style prefixes)
 * @returns {{ loc: number, sloc: number, commentLines: number }}
 */
export function computeLOCMetrics(functionNode, language) {
  const text = functionNode.text;
  const lines = text.split('\n');
  const loc = lines.length;
  const prefixes = (language && COMMENT_PREFIXES.get(language)) || C_STYLE_PREFIXES;

  let commentLines = 0;
  let blankLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      blankLines++;
    } else if (prefixes.some((p) => trimmed.startsWith(p))) {
      commentLines++;
    }
  }

  const sloc = Math.max(1, loc - blankLines - commentLines);
  return { loc, sloc, commentLines };
}

// ─── Maintainability Index ────────────────────────────────────────────────

/**
 * Compute normalized Maintainability Index (0-100 scale).
 *
 * Original SEI formula: MI = 171 - 5.2*ln(V) - 0.23*G - 16.2*ln(LOC) + 50*sin(sqrt(2.4*CM))
 * Microsoft normalization: max(0, min(100, MI * 100/171))
 *
 * @param {number} volume - Halstead volume
 * @param {number} cyclomatic - Cyclomatic complexity
 * @param {number} sloc - Source lines of code
 * @param {number} [commentRatio] - Comment ratio (0-1), optional
 * @returns {number} Normalized MI (0-100)
 */
export function computeMaintainabilityIndex(volume, cyclomatic, sloc, commentRatio) {
  // Guard against zero/negative values in logarithms
  const safeVolume = Math.max(volume, 1);
  const safeSLOC = Math.max(sloc, 1);

  let mi = 171 - 5.2 * Math.log(safeVolume) - 0.23 * cyclomatic - 16.2 * Math.log(safeSLOC);

  if (commentRatio != null && commentRatio > 0) {
    mi += 50 * Math.sin(Math.sqrt(2.4 * commentRatio));
  }

  // Microsoft normalization: 0-100 scale
  const normalized = Math.max(0, Math.min(100, (mi * 100) / 171));
  return +normalized.toFixed(1);
}

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

    // Handle branch/control flow nodes (skip keyword leaf tokens like Ruby's `if`)
    if (rules.branchNodes.has(type) && node.childCount > 0) {
      // Pattern A: else clause wraps if (JS/C#/Rust)
      if (rules.elseNodeType && type === rules.elseNodeType) {
        const firstChild = node.namedChild(0);
        if (firstChild && firstChild.type === rules.ifNodeType) {
          // else-if: the if_statement child handles its own increment
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

      // Pattern B: explicit elif node (Python/Ruby/PHP)
      if (rules.elifNodeType && type === rules.elifNodeType) {
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false);
        }
        return;
      }

      // Detect else-if via Pattern A or C
      let isElseIf = false;
      if (type === rules.ifNodeType) {
        if (rules.elseViaAlternative) {
          // Pattern C (Go/Java): if_statement is the alternative of parent if_statement
          isElseIf =
            node.parent?.type === rules.ifNodeType &&
            node.parent.childForFieldName('alternative')?.id === node.id;
        } else if (rules.elseNodeType) {
          // Pattern A (JS/C#/Rust): if_statement inside else_clause
          isElseIf = node.parent?.type === rules.elseNodeType;
        }
      }

      if (isElseIf) {
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

      // Switch-like nodes don't add cyclomatic themselves (cases do)
      if (rules.switchLikeNodes?.has(type)) {
        cyclomatic--; // Undo the ++ above; cases handle cyclomatic
      }

      if (rules.nestingNodes.has(type)) {
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel + 1, false);
        }
        return;
      }
    }

    // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
    if (
      rules.elseViaAlternative &&
      type !== rules.ifNodeType &&
      node.parent?.type === rules.ifNodeType &&
      node.parent.childForFieldName('alternative')?.id === node.id
    ) {
      cognitive++;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel, false);
      }
      return;
    }

    // Handle case nodes (cyclomatic only, skip keyword leaves)
    if (rules.caseNodes.has(type) && node.childCount > 0) {
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

// ─── Merged Single-Pass Computation ───────────────────────────────────────

/**
 * Compute all metrics (complexity + Halstead + LOC + MI) in a single DFS walk.
 * Merges computeFunctionComplexity and computeHalsteadMetrics into one tree
 * traversal, avoiding two separate DFS walks per function node at build time.
 * LOC is text-based (not tree-based) and computed separately (very cheap).
 *
 * @param {object} functionNode - tree-sitter node for the function
 * @param {string} langId - Language ID (e.g. 'javascript', 'python')
 * @returns {{ cognitive: number, cyclomatic: number, maxNesting: number, halstead: object|null, loc: object, mi: number } | null}
 */
export function computeAllMetrics(functionNode, langId) {
  const cRules = COMPLEXITY_RULES.get(langId);
  if (!cRules) return null;
  const hRules = HALSTEAD_RULES.get(langId);

  // ── Complexity state ──
  let cognitive = 0;
  let cyclomatic = 1; // McCabe starts at 1
  let maxNesting = 0;

  // ── Halstead state ──
  const operators = hRules ? new Map() : null;
  const operands = hRules ? new Map() : null;

  function walk(node, nestingLevel, isTopFunction, halsteadSkip) {
    if (!node) return;

    const type = node.type;

    // ── Halstead classification ──
    // Propagate skip through type-annotation subtrees (e.g. TS generics, Java type params)
    const skipH = halsteadSkip || (hRules ? hRules.skipTypes.has(type) : false);
    if (hRules && !skipH) {
      // Compound operators (non-leaf): count node type as operator
      if (hRules.compoundOperators.has(type)) {
        operators.set(type, (operators.get(type) || 0) + 1);
      }
      // Leaf nodes: classify as operator or operand
      if (node.childCount === 0) {
        if (hRules.operatorLeafTypes.has(type)) {
          operators.set(type, (operators.get(type) || 0) + 1);
        } else if (hRules.operandLeafTypes.has(type)) {
          const text = node.text;
          operands.set(text, (operands.get(text) || 0) + 1);
        }
      }
    }

    // ── Complexity: track nesting depth ──
    if (nestingLevel > maxNesting) maxNesting = nestingLevel;

    // Handle logical operators in binary expressions
    if (type === cRules.logicalNodeType) {
      const op = node.child(1)?.type;
      if (op && cRules.logicalOperators.has(op)) {
        cyclomatic++;
        const parent = node.parent;
        let sameSequence = false;
        if (parent && parent.type === cRules.logicalNodeType) {
          const parentOp = parent.child(1)?.type;
          if (parentOp === op) sameSequence = true;
        }
        if (!sameSequence) cognitive++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false, skipH);
        }
        return;
      }
    }

    // Handle optional chaining (cyclomatic only)
    if (type === cRules.optionalChainType) {
      cyclomatic++;
    }

    // Handle branch/control flow nodes (skip keyword leaf tokens like Ruby's `if`)
    if (cRules.branchNodes.has(type) && node.childCount > 0) {
      // Pattern A: else clause wraps if (JS/C#/Rust)
      if (cRules.elseNodeType && type === cRules.elseNodeType) {
        const firstChild = node.namedChild(0);
        if (firstChild && firstChild.type === cRules.ifNodeType) {
          for (let i = 0; i < node.childCount; i++) {
            walk(node.child(i), nestingLevel, false, skipH);
          }
          return;
        }
        cognitive++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false, skipH);
        }
        return;
      }

      // Pattern B: explicit elif node (Python/Ruby/PHP)
      if (cRules.elifNodeType && type === cRules.elifNodeType) {
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false, skipH);
        }
        return;
      }

      // Detect else-if via Pattern A or C
      let isElseIf = false;
      if (type === cRules.ifNodeType) {
        if (cRules.elseViaAlternative) {
          isElseIf =
            node.parent?.type === cRules.ifNodeType &&
            node.parent.childForFieldName('alternative')?.id === node.id;
        } else if (cRules.elseNodeType) {
          isElseIf = node.parent?.type === cRules.elseNodeType;
        }
      }

      if (isElseIf) {
        cognitive++;
        cyclomatic++;
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel, false, skipH);
        }
        return;
      }

      // Regular branch node
      cognitive += 1 + nestingLevel;
      cyclomatic++;

      // Switch-like nodes don't add cyclomatic themselves (cases do)
      if (cRules.switchLikeNodes?.has(type)) {
        cyclomatic--;
      }

      if (cRules.nestingNodes.has(type)) {
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i), nestingLevel + 1, false, skipH);
        }
        return;
      }
    }

    // Pattern C plain else: block that is the alternative of an if_statement (Go/Java)
    if (
      cRules.elseViaAlternative &&
      type !== cRules.ifNodeType &&
      node.parent?.type === cRules.ifNodeType &&
      node.parent.childForFieldName('alternative')?.id === node.id
    ) {
      cognitive++;
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel, false, skipH);
      }
      return;
    }

    // Handle case nodes (cyclomatic only, skip keyword leaves)
    if (cRules.caseNodes.has(type) && node.childCount > 0) {
      cyclomatic++;
    }

    // Handle nested function definitions (increase nesting)
    if (!isTopFunction && cRules.functionNodes.has(type)) {
      for (let i = 0; i < node.childCount; i++) {
        walk(node.child(i), nestingLevel + 1, false, skipH);
      }
      return;
    }

    // Walk children
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i), nestingLevel, false, skipH);
    }
  }

  walk(functionNode, 0, true, false);

  // ── Compute Halstead derived metrics ──
  let halstead = null;
  if (hRules && operators && operands) {
    const n1 = operators.size;
    const n2 = operands.size;
    let bigN1 = 0;
    for (const c of operators.values()) bigN1 += c;
    let bigN2 = 0;
    for (const c of operands.values()) bigN2 += c;

    const vocabulary = n1 + n2;
    const length = bigN1 + bigN2;
    const volume = vocabulary > 0 ? length * Math.log2(vocabulary) : 0;
    const difficulty = n2 > 0 ? (n1 / 2) * (bigN2 / n2) : 0;
    const effort = difficulty * volume;
    const bugs = volume / 3000;

    halstead = {
      n1,
      n2,
      bigN1,
      bigN2,
      vocabulary,
      length,
      volume: +volume.toFixed(2),
      difficulty: +difficulty.toFixed(2),
      effort: +effort.toFixed(2),
      bugs: +bugs.toFixed(4),
    };
  }

  // ── LOC metrics (text-based, cheap) ──
  const loc = computeLOCMetrics(functionNode, langId);

  // ── Maintainability Index ──
  const volume = halstead ? halstead.volume : 0;
  const commentRatio = loc.loc > 0 ? loc.commentLines / loc.loc : 0;
  const mi = computeMaintainabilityIndex(volume, cyclomatic, loc.sloc, commentRatio);

  return { cognitive, cyclomatic, maxNesting, halstead, loc, mi };
}

// ─── Build-Time: Compute Metrics for Changed Files ────────────────────────

/**
 * Find the function body node in a parse tree that matches a given line range.
 */
export function findFunctionNode(rootNode, startLine, _endLine, rules) {
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
  // Only initialize WASM parsers if some files lack both a cached tree AND pre-computed complexity
  let parsers = null;
  let extToLang = null;
  let needsFallback = false;
  for (const [relPath, symbols] of fileSymbols) {
    if (!symbols._tree) {
      // Only consider files whose language actually has complexity rules
      const ext = path.extname(relPath).toLowerCase();
      if (!COMPLEXITY_EXTENSIONS.has(ext)) continue;
      // Check if all function/method defs have pre-computed complexity (native engine)
      const hasPrecomputed = symbols.definitions.every(
        (d) => (d.kind !== 'function' && d.kind !== 'method') || d.complexity,
      );
      if (!hasPrecomputed) {
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

  const { getParser } = await import('./parser.js');

  const upsert = db.prepare(
    `INSERT OR REPLACE INTO function_complexity
     (node_id, cognitive, cyclomatic, max_nesting,
      loc, sloc, comment_lines,
      halstead_n1, halstead_n2, halstead_big_n1, halstead_big_n2,
      halstead_vocabulary, halstead_length, halstead_volume,
      halstead_difficulty, halstead_effort, halstead_bugs,
      maintainability_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const getNodeId = db.prepare(
    "SELECT id FROM nodes WHERE name = ? AND kind IN ('function','method') AND file = ? AND line = ?",
  );

  let analyzed = 0;

  const tx = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      // Check if all function/method defs have pre-computed complexity
      const allPrecomputed = symbols.definitions.every(
        (d) => (d.kind !== 'function' && d.kind !== 'method') || d.complexity,
      );

      let tree = symbols._tree;
      let langId = symbols._langId;

      // Only attempt WASM fallback if we actually need AST-based computation
      if (!allPrecomputed && !tree) {
        const ext = path.extname(relPath).toLowerCase();
        if (!COMPLEXITY_EXTENSIONS.has(ext)) continue; // Language has no complexity rules
        if (!extToLang) continue; // No WASM parsers available
        langId = extToLang.get(ext);
        if (!langId) continue;

        const absPath = path.join(rootDir, relPath);
        let code;
        try {
          code = fs.readFileSync(absPath, 'utf-8');
        } catch {
          continue;
        }

        const parser = getParser(parsers, absPath);
        if (!parser) continue;

        try {
          tree = parser.parse(code);
        } catch {
          continue;
        }
      }

      const rules = langId ? COMPLEXITY_RULES.get(langId) : null;

      for (const def of symbols.definitions) {
        if (def.kind !== 'function' && def.kind !== 'method') continue;
        if (!def.line) continue;

        // Use pre-computed complexity from native engine if available
        if (def.complexity) {
          const row = getNodeId.get(def.name, relPath, def.line);
          if (!row) continue;
          const ch = def.complexity.halstead;
          const cl = def.complexity.loc;
          upsert.run(
            row.id,
            def.complexity.cognitive,
            def.complexity.cyclomatic,
            def.complexity.maxNesting ?? 0,
            cl ? cl.loc : 0,
            cl ? cl.sloc : 0,
            cl ? cl.commentLines : 0,
            ch ? ch.n1 : 0,
            ch ? ch.n2 : 0,
            ch ? ch.bigN1 : 0,
            ch ? ch.bigN2 : 0,
            ch ? ch.vocabulary : 0,
            ch ? ch.length : 0,
            ch ? ch.volume : 0,
            ch ? ch.difficulty : 0,
            ch ? ch.effort : 0,
            ch ? ch.bugs : 0,
            def.complexity.maintainabilityIndex ?? 0,
          );
          analyzed++;
          continue;
        }

        // Fallback: compute from AST tree
        if (!tree || !rules) continue;

        const funcNode = findFunctionNode(tree.rootNode, def.line, def.endLine, rules);
        if (!funcNode) continue;

        // Single-pass: complexity + Halstead + LOC + MI in one DFS walk
        const metrics = computeAllMetrics(funcNode, langId);
        if (!metrics) continue;

        const row = getNodeId.get(def.name, relPath, def.line);
        if (!row) continue;

        const h = metrics.halstead;
        upsert.run(
          row.id,
          metrics.cognitive,
          metrics.cyclomatic,
          metrics.maxNesting,
          metrics.loc.loc,
          metrics.loc.sloc,
          metrics.loc.commentLines,
          h ? h.n1 : 0,
          h ? h.n2 : 0,
          h ? h.bigN1 : 0,
          h ? h.bigN2 : 0,
          h ? h.vocabulary : 0,
          h ? h.length : 0,
          h ? h.volume : 0,
          h ? h.difficulty : 0,
          h ? h.effort : 0,
          h ? h.bugs : 0,
          metrics.mi,
        );
        analyzed++;
      }

      // Release cached tree for GC
      symbols._tree = null;
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
    maintainabilityIndex: { warn: 20, fail: null },
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

  const isValidThreshold = (v) => typeof v === 'number' && Number.isFinite(v);

  let having = '';
  if (aboveThreshold) {
    const conditions = [];
    if (isValidThreshold(thresholds.cognitive?.warn)) {
      conditions.push(`fc.cognitive >= ${thresholds.cognitive.warn}`);
    }
    if (isValidThreshold(thresholds.cyclomatic?.warn)) {
      conditions.push(`fc.cyclomatic >= ${thresholds.cyclomatic.warn}`);
    }
    if (isValidThreshold(thresholds.maxNesting?.warn)) {
      conditions.push(`fc.max_nesting >= ${thresholds.maxNesting.warn}`);
    }
    if (isValidThreshold(thresholds.maintainabilityIndex?.warn)) {
      conditions.push(
        `fc.maintainability_index > 0 AND fc.maintainability_index <= ${thresholds.maintainabilityIndex.warn}`,
      );
    }
    if (conditions.length > 0) {
      having = `AND (${conditions.join(' OR ')})`;
    }
  }

  const orderMap = {
    cognitive: 'fc.cognitive DESC',
    cyclomatic: 'fc.cyclomatic DESC',
    nesting: 'fc.max_nesting DESC',
    mi: 'fc.maintainability_index ASC',
    volume: 'fc.halstead_volume DESC',
    effort: 'fc.halstead_effort DESC',
    bugs: 'fc.halstead_bugs DESC',
    loc: 'fc.loc DESC',
  };
  const orderBy = orderMap[sort] || 'fc.cognitive DESC';

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT n.name, n.kind, n.file, n.line, n.end_line,
              fc.cognitive, fc.cyclomatic, fc.max_nesting,
              fc.loc, fc.sloc, fc.maintainability_index,
              fc.halstead_volume, fc.halstead_difficulty, fc.halstead_effort, fc.halstead_bugs
       FROM function_complexity fc
       JOIN nodes n ON fc.node_id = n.id
       ${where} ${having}
       ORDER BY ${orderBy}`,
      )
      .all(...params);
  } catch {
    // Check if graph has nodes even though complexity table is missing/empty
    let hasGraph = false;
    try {
      hasGraph = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c > 0;
    } catch {
      /* ignore */
    }
    db.close();
    return { functions: [], summary: null, thresholds, hasGraph };
  }

  // Post-filter test files if needed (belt-and-suspenders for isTestFile)
  const filtered = noTests ? rows.filter((r) => !isTestFile(r.file)) : rows;

  const functions = filtered.map((r) => {
    const exceeds = [];
    if (isValidThreshold(thresholds.cognitive?.warn) && r.cognitive >= thresholds.cognitive.warn)
      exceeds.push('cognitive');
    if (isValidThreshold(thresholds.cyclomatic?.warn) && r.cyclomatic >= thresholds.cyclomatic.warn)
      exceeds.push('cyclomatic');
    if (
      isValidThreshold(thresholds.maxNesting?.warn) &&
      r.max_nesting >= thresholds.maxNesting.warn
    )
      exceeds.push('maxNesting');
    if (
      isValidThreshold(thresholds.maintainabilityIndex?.warn) &&
      r.maintainability_index > 0 &&
      r.maintainability_index <= thresholds.maintainabilityIndex.warn
    )
      exceeds.push('maintainabilityIndex');

    return {
      name: r.name,
      kind: r.kind,
      file: r.file,
      line: r.line,
      endLine: r.end_line || null,
      cognitive: r.cognitive,
      cyclomatic: r.cyclomatic,
      maxNesting: r.max_nesting,
      loc: r.loc || 0,
      sloc: r.sloc || 0,
      maintainabilityIndex: r.maintainability_index || 0,
      halstead: {
        volume: r.halstead_volume || 0,
        difficulty: r.halstead_difficulty || 0,
        effort: r.halstead_effort || 0,
        bugs: r.halstead_bugs || 0,
      },
      exceeds: exceeds.length > 0 ? exceeds : undefined,
    };
  });

  // Summary stats
  let summary = null;
  try {
    const allRows = db
      .prepare(
        `SELECT fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.maintainability_index
       FROM function_complexity fc JOIN nodes n ON fc.node_id = n.id
       WHERE n.kind IN ('function','method')
       ${noTests ? `AND n.file NOT LIKE '%.test.%' AND n.file NOT LIKE '%.spec.%' AND n.file NOT LIKE '%__test__%' AND n.file NOT LIKE '%__tests__%' AND n.file NOT LIKE '%.stories.%'` : ''}`,
      )
      .all();

    if (allRows.length > 0) {
      const miValues = allRows.map((r) => r.maintainability_index || 0);
      summary = {
        analyzed: allRows.length,
        avgCognitive: +(allRows.reduce((s, r) => s + r.cognitive, 0) / allRows.length).toFixed(1),
        avgCyclomatic: +(allRows.reduce((s, r) => s + r.cyclomatic, 0) / allRows.length).toFixed(1),
        maxCognitive: Math.max(...allRows.map((r) => r.cognitive)),
        maxCyclomatic: Math.max(...allRows.map((r) => r.cyclomatic)),
        avgMI: +(miValues.reduce((s, v) => s + v, 0) / miValues.length).toFixed(1),
        minMI: +Math.min(...miValues).toFixed(1),
        aboveWarn: allRows.filter(
          (r) =>
            (isValidThreshold(thresholds.cognitive?.warn) &&
              r.cognitive >= thresholds.cognitive.warn) ||
            (isValidThreshold(thresholds.cyclomatic?.warn) &&
              r.cyclomatic >= thresholds.cyclomatic.warn) ||
            (isValidThreshold(thresholds.maxNesting?.warn) &&
              r.max_nesting >= thresholds.maxNesting.warn) ||
            (isValidThreshold(thresholds.maintainabilityIndex?.warn) &&
              r.maintainability_index > 0 &&
              r.maintainability_index <= thresholds.maintainabilityIndex.warn),
        ).length,
      };
    }
  } catch {
    /* ignore */
  }

  // When summary is null (no complexity rows), check if graph has nodes
  let hasGraph = false;
  if (summary === null) {
    try {
      hasGraph = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c > 0;
    } catch {
      /* ignore */
    }
  }

  db.close();
  const base = { functions, summary, thresholds, hasGraph };
  return paginateResult(base, 'functions', { limit: opts.limit, offset: opts.offset });
}

/**
 * Generator: stream complexity rows one-by-one using .iterate() for memory efficiency.
 * @param {string} [customDbPath]
 * @param {object} [opts]
 * @param {boolean} [opts.noTests]
 * @param {string} [opts.file]
 * @param {string} [opts.target]
 * @param {string} [opts.kind]
 * @param {string} [opts.sort]
 * @yields {{ name: string, kind: string, file: string, line: number, cognitive: number, cyclomatic: number, maxNesting: number, loc: number, sloc: number }}
 */
export function* iterComplexity(customDbPath, opts = {}) {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const noTests = opts.noTests || false;
    const sort = opts.sort || 'cognitive';

    let where = "WHERE n.kind IN ('function','method')";
    const params = [];

    if (noTests) {
      where += ` AND n.file NOT LIKE '%.test.%'
         AND n.file NOT LIKE '%.spec.%'
         AND n.file NOT LIKE '%__test__%'
         AND n.file NOT LIKE '%__tests__%'
         AND n.file NOT LIKE '%.stories.%'`;
    }
    if (opts.target) {
      where += ' AND n.name LIKE ?';
      params.push(`%${opts.target}%`);
    }
    if (opts.file) {
      where += ' AND n.file LIKE ?';
      params.push(`%${opts.file}%`);
    }
    if (opts.kind) {
      where += ' AND n.kind = ?';
      params.push(opts.kind);
    }

    const orderMap = {
      cognitive: 'fc.cognitive DESC',
      cyclomatic: 'fc.cyclomatic DESC',
      nesting: 'fc.max_nesting DESC',
      mi: 'fc.maintainability_index ASC',
      volume: 'fc.halstead_volume DESC',
      effort: 'fc.halstead_effort DESC',
      bugs: 'fc.halstead_bugs DESC',
      loc: 'fc.loc DESC',
    };
    const orderBy = orderMap[sort] || 'fc.cognitive DESC';

    const stmt = db.prepare(
      `SELECT n.name, n.kind, n.file, n.line, n.end_line,
              fc.cognitive, fc.cyclomatic, fc.max_nesting, fc.loc, fc.sloc
       FROM function_complexity fc
       JOIN nodes n ON fc.node_id = n.id
       ${where}
       ORDER BY ${orderBy}`,
    );
    for (const r of stmt.iterate(...params)) {
      if (noTests && isTestFile(r.file)) continue;
      yield {
        name: r.name,
        kind: r.kind,
        file: r.file,
        line: r.line,
        endLine: r.end_line || null,
        cognitive: r.cognitive,
        cyclomatic: r.cyclomatic,
        maxNesting: r.max_nesting,
        loc: r.loc || 0,
        sloc: r.sloc || 0,
      };
    }
  } finally {
    db.close();
  }
}

/**
 * Format complexity output for CLI display.
 */
export function complexity(customDbPath, opts = {}) {
  const data = complexityData(customDbPath, opts);

  if (opts.ndjson) {
    printNdjson(data, 'functions');
    return;
  }
  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  if (data.functions.length === 0) {
    if (data.summary === null) {
      if (data.hasGraph) {
        console.log(
          '\nNo complexity data found, but a graph exists. Run "codegraph build --no-incremental" to populate complexity metrics.\n',
        );
      } else {
        console.log(
          '\nNo complexity data found. Run "codegraph build" first to analyze your codebase.\n',
        );
      }
    } else {
      console.log('\nNo functions match the given filters.\n');
    }
    return;
  }

  const header = opts.aboveThreshold ? 'Functions Above Threshold' : 'Function Complexity';
  console.log(`\n# ${header}\n`);

  if (opts.health) {
    // Health-focused view with Halstead + MI columns
    console.log(
      `  ${'Function'.padEnd(35)} ${'File'.padEnd(25)} ${'MI'.padStart(5)} ${'Vol'.padStart(7)} ${'Diff'.padStart(6)} ${'Effort'.padStart(9)} ${'Bugs'.padStart(6)} ${'LOC'.padStart(5)} ${'SLOC'.padStart(5)}`,
    );
    console.log(
      `  ${'─'.repeat(35)} ${'─'.repeat(25)} ${'─'.repeat(5)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(9)} ${'─'.repeat(6)} ${'─'.repeat(5)} ${'─'.repeat(5)}`,
    );

    for (const fn of data.functions) {
      const name = fn.name.length > 33 ? `${fn.name.slice(0, 32)}…` : fn.name;
      const file = fn.file.length > 23 ? `…${fn.file.slice(-22)}` : fn.file;
      const miWarn = fn.exceeds?.includes('maintainabilityIndex') ? '!' : ' ';
      console.log(
        `  ${name.padEnd(35)} ${file.padEnd(25)} ${String(fn.maintainabilityIndex).padStart(5)}${miWarn}${String(fn.halstead.volume).padStart(7)} ${String(fn.halstead.difficulty).padStart(6)} ${String(fn.halstead.effort).padStart(9)} ${String(fn.halstead.bugs).padStart(6)} ${String(fn.loc).padStart(5)} ${String(fn.sloc).padStart(5)}`,
      );
    }
  } else {
    // Default view with MI column appended
    console.log(
      `  ${'Function'.padEnd(40)} ${'File'.padEnd(30)} ${'Cog'.padStart(4)} ${'Cyc'.padStart(4)} ${'Nest'.padStart(5)} ${'MI'.padStart(5)}`,
    );
    console.log(
      `  ${'─'.repeat(40)} ${'─'.repeat(30)} ${'─'.repeat(4)} ${'─'.repeat(4)} ${'─'.repeat(5)} ${'─'.repeat(5)}`,
    );

    for (const fn of data.functions) {
      const name = fn.name.length > 38 ? `${fn.name.slice(0, 37)}…` : fn.name;
      const file = fn.file.length > 28 ? `…${fn.file.slice(-27)}` : fn.file;
      const warn = fn.exceeds ? ' !' : '';
      const mi = fn.maintainabilityIndex > 0 ? String(fn.maintainabilityIndex) : '-';
      console.log(
        `  ${name.padEnd(40)} ${file.padEnd(30)} ${String(fn.cognitive).padStart(4)} ${String(fn.cyclomatic).padStart(4)} ${String(fn.maxNesting).padStart(5)} ${mi.padStart(5)}${warn}`,
      );
    }
  }

  if (data.summary) {
    const s = data.summary;
    const miPart = s.avgMI != null ? ` | avg MI: ${s.avgMI}` : '';
    console.log(
      `\n  ${s.analyzed} functions analyzed | avg cognitive: ${s.avgCognitive} | avg cyclomatic: ${s.avgCyclomatic}${miPart} | ${s.aboveWarn} above threshold`,
    );
  }
  console.log();
}
