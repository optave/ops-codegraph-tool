import type {
  ComplexityRules,
  DataflowRulesConfig,
  HalsteadRules,
  TreeSitterNode,
} from '../../types.js';
import { makeDataflowRules } from '../shared.js';

// ─── Kotlin ───────────────────────────────────────────────────────────────────
//
// Kotlin function_declaration wraps params in `function_value_parameters`.
// The name is a `simple_identifier` direct child (found via findChild in extractor).
// call_expression: first child is simple_identifier OR navigation_expression (method call).
// navigation_expression: acts as member access for `obj.method()`.
// Field names for call function/args are NOT standard named fields in tree-sitter-kotlin,
// so we leave callFunctionField/callArgsField at defaults — childForFieldName returns null
// gracefully and the analysis falls back to skipping arg tracking.

function getKotlinParamListNode(funcNode: TreeSitterNode): TreeSitterNode | null {
  for (const child of funcNode.namedChildren) {
    if (child.type === 'function_value_parameters') return child;
  }
  return null;
}

function extractKotlinParamName(node: TreeSitterNode): string[] | null {
  if (node.type !== 'parameter') return null;
  const nameNode = node.childForFieldName('name');
  if (nameNode) return [nameNode.text];
  // Fallback: find simple_identifier among named children
  for (const child of node.namedChildren) {
    if (child.type === 'simple_identifier') return [child.text];
  }
  return null;
}

export const dataflowKotlin: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_declaration']),
  nameField: 'name',

  getParamListNode: getKotlinParamListNode,
  paramWrapperTypes: new Set(['parameter']),
  extractParamName: extractKotlinParamName,

  returnNode: 'return_statement',

  callNode: 'call_expression',
  // tree-sitter-kotlin does not expose standard named fields for call function/args;
  // defaults ('function'/'arguments') will return null gracefully.

  memberNode: 'navigation_expression',
  // Field names for navigation_expression object/property also lack standard names;
  // defaults will return null gracefully.
});

// Kotlin's grammar splits `&&`/`||` into two distinct node types (unlike most
// languages, which share one generic binary-expression node for every
// operator) — both must be listed in logicalNodeTypes for cyclomatic/cognitive
// counting to see both operators. Mirrors the native `KOTLIN_RULES`.
export const complexityKotlin: ComplexityRules = {
  branchNodes: new Set([
    'if_expression',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'catch_block',
    'when_expression',
    'when_entry',
  ]),
  caseNodes: new Set(['when_entry']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['conjunction_expression', 'disjunction_expression']),
  optionalChainType: 'safe_navigation',
  nestingNodes: new Set([
    'if_expression',
    'for_statement',
    'while_statement',
    'do_while_statement',
    'catch_block',
    'when_expression',
  ]),
  functionNodes: new Set(['function_declaration']),
  ifNodeType: 'if_expression',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['when_expression']),
};

export const halsteadKotlin: HalsteadRules = {
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
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '===',
    '!==',
    '&&',
    '||',
    '!',
    '++',
    '--',
    '..',
    '?:',
    '?.',
    'is',
    'as',
    'as?',
    'in',
    '!in',
    'if',
    'else',
    'for',
    'while',
    'do',
    'when',
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
    'simple_identifier',
    'type_identifier',
    'integer_literal',
    'long_literal',
    'real_literal',
    'hex_literal',
    'bin_literal',
    'string_literal',
    'character_literal',
    'true',
    'false',
    'null',
    'this',
    'super',
  ]),
  compoundOperators: new Set(['call_expression', 'indexing_expression']),
  skipTypes: new Set(['type_arguments', 'type_parameters']),
};

// ─── Swift ────────────────────────────────────────────────────────────────────
//
// Swift function_declaration: name is `simple_identifier`, params in child node.
// The extractor uses findChild(node, 'simple_identifier') for the function name.
// Swift's tree-sitter grammar wraps params in a `parameter` or `parameters` node.
// call_expression: first child is simple_identifier or navigation_expression.
// navigation_expression: obj.method() — last child is navigation_suffix > simple_identifier.

function getSwiftParamListNode(funcNode: TreeSitterNode): TreeSitterNode | null {
  // Look for parameter_clause or parameters as a direct child
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (!child) continue;
    if (child.type === 'parameter_clause' || child.type === 'parameters') return child;
  }
  return null;
}

function extractSwiftParamName(node: TreeSitterNode): string[] | null {
  if (node.type === 'parameter') {
    // Swift parameters have internal label + external label; use internal name
    // The `name` field in tree-sitter-swift is the internal parameter name
    const nameNode = node.childForFieldName('name') ?? node.childForFieldName('internal_name');
    if (nameNode) return [nameNode.text];
    // Fallback: find simple_identifier
    for (const child of node.namedChildren) {
      if (child.type === 'simple_identifier') return [child.text];
    }
  }
  return null;
}

export const dataflowSwift: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_declaration']),
  nameField: 'name',

  getParamListNode: getSwiftParamListNode,
  paramWrapperTypes: new Set(['parameter']),
  extractParamName: extractSwiftParamName,

  returnNode: 'return_statement',

  callNode: 'call_expression',
  // tree-sitter-swift call_expression: function is first child, args follow.
  // No standard named fields — leave defaults to return null gracefully.

  memberNode: 'navigation_expression',
  // navigation_expression field names are non-standard in tree-sitter-swift.
});

// tree-sitter-swift, like tree-sitter-kotlin, splits && / || into distinct
// node types (conjunction_expression / disjunction_expression) rather than
// sharing one generic binary node — confirmed by parsing `a && b || a` and
// inspecting the S-expression. Mirrors the native `SWIFT_RULES`/`SWIFT_HALSTEAD`.
export const complexitySwift: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'for_in_statement',
    'while_statement',
    'repeat_while_statement',
    'catch_clause',
    'switch_entry',
    'ternary_expression',
    'guard_statement',
  ]),
  caseNodes: new Set(['switch_entry']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['conjunction_expression', 'disjunction_expression']),
  optionalChainType: 'optional_chaining_expression',
  nestingNodes: new Set([
    'if_statement',
    'for_in_statement',
    'while_statement',
    'repeat_while_statement',
    'catch_clause',
    'ternary_expression',
    'guard_statement',
  ]),
  functionNodes: new Set(['function_declaration', 'init_declaration']),
  ifNodeType: 'if_statement',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['switch_statement']),
};

export const halsteadSwift: HalsteadRules = {
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
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '===',
    '!==',
    '&&',
    '||',
    '!',
    '?',
    '??',
    '...',
    '..<',
    'is',
    'as',
    'as?',
    'as!',
    'if',
    'else',
    'for',
    'while',
    'repeat',
    'switch',
    'guard',
    'return',
    'throw',
    'break',
    'continue',
    'try',
    'catch',
    '.',
    ',',
    ';',
    ':',
    '->',
  ]),
  operandLeafTypes: new Set([
    'simple_identifier',
    'type_identifier',
    'integer_literal',
    'real_literal',
    'hex_literal',
    'oct_literal',
    'bin_literal',
    'string_literal',
    'true',
    'false',
    'nil',
    'self',
    'super',
  ]),
  compoundOperators: new Set(['call_expression', 'subscript_expression']),
  skipTypes: new Set(['type_arguments', 'type_parameters']),
};

// ─── Scala ────────────────────────────────────────────────────────────────────
//
// Scala function_definition: `node.childForFieldName('name')` for the name (confirmed
// in extractor). Parameters are via findChild(funcNode, 'parameters') (no named field).
// call_expression: `childForFieldName('function')` confirmed in extractor line 146.
// field_expression: `childForFieldName('value')` = object, `childForFieldName('field')` = property.
// val_definition / var_definition: `childForFieldName('pattern')` = name side.

function getScalaParamListNode(funcNode: TreeSitterNode): TreeSitterNode | null {
  // Scala parameters list is a direct child; extractor uses findChild(funcNode, 'parameters')
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (child?.type === 'parameters') return child;
  }
  return null;
}

function extractScalaParamName(node: TreeSitterNode): string[] | null {
  if (node.type !== 'parameter') return null;
  // Extractor uses findChild(param, 'identifier')
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') return [child.text];
  }
  return null;
}

export const dataflowScala: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_definition']),
  nameField: 'name',

  getParamListNode: getScalaParamListNode,
  paramWrapperTypes: new Set(['parameter']),
  extractParamName: extractScalaParamName,

  returnNode: 'return_expression',

  varDeclaratorNodes: new Set(['val_definition', 'var_definition']),
  varNameField: 'pattern',

  callNode: 'call_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',

  memberNode: 'field_expression',
  memberObjectField: 'value',
  memberPropertyField: 'field',
});

// Mirrors the native `SCALA_RULES`/`SCALA_HALSTEAD`.
export const complexityScala: ComplexityRules = {
  branchNodes: new Set([
    'if_expression',
    'for_expression',
    'while_expression',
    'do_while_expression',
    'catch_clause',
    'case_clause',
    'match_expression',
  ]),
  caseNodes: new Set(['case_clause']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['infix_expression']),
  optionalChainType: null,
  nestingNodes: new Set([
    'if_expression',
    'for_expression',
    'while_expression',
    'do_while_expression',
    'catch_clause',
    'match_expression',
  ]),
  functionNodes: new Set(['function_definition']),
  ifNodeType: 'if_expression',
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['match_expression']),
};

export const halsteadScala: HalsteadRules = {
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
    '==',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    '&&',
    '||',
    '!',
    '::',
    '++',
    ':+',
    '+:',
    'if',
    'else',
    'for',
    'while',
    'do',
    'match',
    'case',
    'return',
    'throw',
    'yield',
    'try',
    'catch',
    'finally',
    '.',
    ',',
    ';',
    ':',
    '=>',
    '<-',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'type_identifier',
    'integer_literal',
    'floating_point_literal',
    'string_literal',
    'character_literal',
    'symbol_literal',
    'true',
    'false',
    'null',
    'this',
    'super',
  ]),
  compoundOperators: new Set(['call_expression', 'field_expression']),
  skipTypes: new Set(['type_arguments', 'type_parameters']),
};

// ─── Dart ─────────────────────────────────────────────────────────────────────
//
// Dart uses `function_signature` for top-level functions and `method_signature`
// for class methods (both confirmed in extractor). The extractor uses
// `childForFieldName('name')` for the function name on both node types.
// Dart call: `selector` node with `argument_part` — the extractor uses this.
// There is no standard `call_expression` node type in tree-sitter-dart.
// We use `function_signature` as the primary function node type.
// Parameters: `childForFieldName('parameters')` on function_signature (confirmed in extractor).

function extractDartParamName(node: TreeSitterNode): string[] | null {
  // Dart: parameter types include 'formal_parameter', 'named_formal_parameter',
  // 'optional_formal_parameter', and bare 'identifier'
  if (
    node.type === 'formal_parameter' ||
    node.type === 'optional_formal_parameter' ||
    node.type === 'named_formal_parameter'
  ) {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return [nameNode.text];
    // Fallback: last identifier child is usually the name
    let lastName: string | null = null;
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') lastName = child.text;
    }
    if (lastName) return [lastName];
  }
  if (node.type === 'identifier') return [node.text];
  return null;
}

export const dataflowDart: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_signature', 'method_signature']),
  nameField: 'name',

  paramListField: 'parameters',
  paramWrapperTypes: new Set([
    'formal_parameter',
    'optional_formal_parameter',
    'named_formal_parameter',
  ]),
  extractParamName: extractDartParamName,

  returnNode: 'return_statement',

  callNode: 'call_expression',
  // tree-sitter-dart does not have standard named fields for calls;
  // the extractor uses `selector` nodes instead. Leave defaults.
});

// ─── Groovy ───────────────────────────────────────────────────────────────────
//
// Groovy has multiple function node types (method_definition/declaration,
// constructor_definition/declaration, function_definition/declaration).
// Params: `childForFieldName('parameters')` with fallback to findChild('formal_parameters')
// (confirmed in extractor extractGroovyParams, line 334).
// call_expression: `childForFieldName('function')` confirmed in extractor line 299.
// field_expression: `childForFieldName('argument')` = object (confirmed in extractor line 303),
// `childForFieldName('field')` = property.

function getGroovyParamListNode(funcNode: TreeSitterNode): TreeSitterNode | null {
  const byField = funcNode.childForFieldName('parameters');
  if (byField) return byField;
  // Fallback: search for formal_parameters child
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (child?.type === 'formal_parameters') return child;
  }
  return null;
}

function extractGroovyParamName(node: TreeSitterNode): string[] | null {
  if (node.type === 'formal_parameter' || node.type === 'parameter') {
    const nameNode = node.childForFieldName('name');
    if (nameNode) return [nameNode.text];
    // Fallback: first identifier child
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') return [child.text];
    }
  }
  return null;
}

export const dataflowGroovy: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set([
    'method_definition',
    'method_declaration',
    'constructor_definition',
    'constructor_declaration',
    'function_definition',
    'function_declaration',
  ]),
  nameField: 'name',

  getParamListNode: getGroovyParamListNode,
  paramWrapperTypes: new Set(['formal_parameter', 'parameter']),
  extractParamName: extractGroovyParamName,

  returnNode: 'return_statement',

  varDeclaratorNode: 'variable_declarator',

  callNodes: new Set([
    'call_expression',
    'function_call',
    'juxt_function_call',
    'method_invocation',
  ]),
  callFunctionField: 'function',
  callArgsField: 'arguments',

  memberNode: 'field_expression',
  memberObjectField: 'argument',
  memberPropertyField: 'field',
});
