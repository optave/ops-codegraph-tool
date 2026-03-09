/**
 * PHP — AST analysis rules.
 */

import { makeCfgRules, makeDataflowRules } from '../shared.js';

// ─── Complexity ───────────────────────────────────────────────────────────

export const complexity = {
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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg = makeCfgRules({
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

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow = makeDataflowRules({
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
    if (node.type === 'simple_parameter' || node.type === 'variadic_parameter') {
      const nameNode = node.childForFieldName('name');
      return nameNode ? [nameNode.text] : null;
    }
    if (node.type === 'variable_name') return [node.text];
    return null;
  },
});

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes = null;
