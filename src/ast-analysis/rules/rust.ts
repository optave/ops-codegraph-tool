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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead: HalsteadRules = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg: CfgRulesConfig = makeCfgRules({
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

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes: Record<string, string> | null = null;
