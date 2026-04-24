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

// ─── Halstead ─────────────────────────────────────────────────────────────

export const halstead: HalsteadRules = {
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg: CfgRulesConfig = makeCfgRules({
  ifNode: 'if',
  elifNode: 'elsif',
  elseClause: 'else',
  forNodes: new Set(['for']),
  whileNode: 'while',
  unlessNode: 'unless',
  untilNode: 'until',
  switchNode: 'case',
  caseNode: 'when',
  defaultNode: 'else',
  tryNode: 'begin',
  catchNode: 'rescue',
  finallyNode: 'ensure',
  returnNode: 'return',
  breakNode: 'break',
  continueNode: 'next',
  blockNodes: new Set(['then', 'do', 'body_statement']),
  functionNodes: new Set(['method', 'singleton_method']),
});

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes: Record<string, string> | null = {
  string: 'string',
  regex: 'regex',
};
