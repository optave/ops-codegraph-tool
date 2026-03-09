/**
 * Java — AST analysis rules.
 */

import { makeCfgRules, makeDataflowRules } from '../shared.js';

// ─── Complexity ───────────────────────────────────────────────────────────

export const complexity = {
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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg = makeCfgRules({
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

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow = makeDataflowRules({
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes = null;
