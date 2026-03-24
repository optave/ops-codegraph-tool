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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead: HalsteadRules = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg: CfgRulesConfig = makeCfgRules({
  ifNode: 'if_statement',
  elifNode: 'elif_clause',
  elseClause: 'else_clause',
  forNodes: new Set(['for_statement']),
  whileNode: 'while_statement',
  switchNode: 'match_statement',
  caseNode: 'case_clause',
  tryNode: 'try_statement',
  catchNode: 'except_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'raise_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  functionNodes: new Set(['function_definition']),
});

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes: Record<string, string> | null = null;
