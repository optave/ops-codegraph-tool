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
    'else_clause',
    'for_statement',
    'foreach_statement',
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
    'foreach_statement',
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
  elseNodeType: null,
  elifNodeType: null,
  elseViaAlternative: true,
  switchLikeNodes: new Set(['switch_statement']),
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

// ─── CFG ──────────────────────────────────────────────────────────────────

export const cfg: CfgRulesConfig = makeCfgRules({
  ifNode: 'if_statement',
  elseViaAlternative: true,
  forNodes: new Set(['for_statement', 'foreach_statement']),
  whileNode: 'while_statement',
  doNode: 'do_statement',
  switchNode: 'switch_statement',
  caseNode: 'switch_section',
  tryNode: 'try_statement',
  catchNode: 'catch_clause',
  finallyNode: 'finally_clause',
  returnNode: 'return_statement',
  throwNode: 'throw_statement',
  breakNode: 'break_statement',
  continueNode: 'continue_statement',
  blockNode: 'block',
  labeledNode: 'labeled_statement',
  functionNodes: new Set([
    'method_declaration',
    'constructor_declaration',
    'lambda_expression',
    'local_function_statement',
  ]),
});

// ─── Dataflow ─────────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
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

// ─── AST Node Types ───────────────────────────────────────────────────────

export const astTypes: Record<string, string> | null = null;
