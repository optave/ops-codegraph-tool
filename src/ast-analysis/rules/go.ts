import type {
  CfgRulesConfig,
  ComplexityRules,
  DataflowRulesConfig,
  HalsteadRules,
} from '../../types.js';
import { makeCfgRules, makeDataflowRules } from '../shared.js';

// ─── Complexity ───────────────────────────────────────────────────────────

export const complexity: ComplexityRules = {
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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead: HalsteadRules = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg: CfgRulesConfig = makeCfgRules({
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

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
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
    if (node.type === 'parameter_declaration') {
      const names: string[] = [];
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes: Record<string, string> | null = {
  interpreted_string_literal: 'string',
  raw_string_literal: 'string',
};
