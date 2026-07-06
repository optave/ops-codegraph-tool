import type { ComplexityRules, DataflowRulesConfig, HalsteadRules } from '../../types.js';
import { makeDataflowRules } from '../shared.js';

// ─── Lua ──────────────────────────────────────────────────────────────────────
//
// Lua function_declaration: name via `childForFieldName('name')` (confirmed in extractor line 47).
// The name node may be `method_index_expression`, `dot_index_expression`, or `identifier`.
// Parameters: `childForFieldName('parameters')` (confirmed in extractor line 89) — returns
// a node containing `identifier` children directly (no wrapper type).
// function_call: name via `childForFieldName('name')` (confirmed in extractor line 132).
// dot_index_expression: table=`childForFieldName('table')`, field=`childForFieldName('field')`.
// method_index_expression: table=`childForFieldName('table')`, method=`childForFieldName('method')`.

export const dataflowLua: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_declaration']),
  nameField: 'name',

  paramListField: 'parameters',
  // Lua params are bare identifier children in the param list — no wrapper type
  paramIdentifier: 'identifier',

  returnNode: 'return_statement',

  callNode: 'function_call',
  callFunctionField: 'name',
  callArgsField: 'arguments',

  memberNode: 'dot_index_expression',
  memberObjectField: 'table',
  memberPropertyField: 'field',
});

// Lua's `if_statement` is flat, not nested: `elseif`/`else` are separate node
// types (`elseif_statement`, `else_statement`) attached to the *same*
// `if_statement` via repeated `alternative:` fields — confirmed by parsing
// `if a then .. elseif b then .. else .. end` and inspecting the S-expression:
// `(if_statement condition: (...) consequence: (...) alternative: (elseif_statement ...) alternative: (else_statement ...))`.
// This is structurally identical to Python's elif_clause/else_clause pattern
// (Pattern B), not JS's nested else_clause>if_statement (Pattern A) or Go's
// alternative-field-holds-nested-if (Pattern C) — so elseViaAlternative: false
// and neither elseif_statement nor else_statement is in nestingNodes (matching
// how Python's elif_clause/else_clause are siblings of the primary if, not
// separately-nested branches).
//
// binary_expression is Lua's single generic binary-op node (arithmetic,
// comparison, concat, AND logical `and`/`or`) — same shared-type pattern as
// Ruby's `binary` node. classifyLogicalOp/handleLogicalOperator only acts when
// `node.child(1)` (the operator token) is in logicalOperators, so comparisons
// and arithmetic on the same node type are correctly ignored.
export const complexityLua: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'elseif_statement',
    'else_statement',
    'for_statement',
    'while_statement',
    'repeat_statement',
  ]),
  caseNodes: new Set([]),
  logicalOperators: new Set(['and', 'or']),
  logicalNodeType: 'binary_expression',
  optionalChainType: null,
  nestingNodes: new Set(['if_statement', 'for_statement', 'while_statement', 'repeat_statement']),
  functionNodes: new Set(['function_declaration']),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_statement',
  elifNodeType: 'elseif_statement',
  elseViaAlternative: false,
  switchLikeNodes: new Set([]),
};

// Member/method access (`dot_index_expression` `.`, `method_index_expression`
// `:`) and invocation (`function_call`) are wrapper nodes without a dedicated
// "call happened" token, so they're counted as compound operators — mirrors
// Python's ['call', 'subscript', 'attribute']. The '.'/':' separator tokens are
// ALSO in operatorLeafTypes (matching Python counting both 'attribute' and
// '.'), so member access contributes two distinct operator kinds, consistent
// with the existing per-language precedent.
export const halsteadLua: HalsteadRules = {
  operatorLeafTypes: new Set([
    '+',
    '-',
    '*',
    '/',
    '//',
    '%',
    '^',
    '#',
    '..',
    '==',
    '~=',
    '<=',
    '>=',
    '<',
    '>',
    '=',
    'and',
    'or',
    'not',
    '&',
    '|',
    '~',
    '<<',
    '>>',
    '.',
    ',',
    ':',
    '::',
    ';',
    'if',
    'then',
    'else',
    'elseif',
    'end',
    'for',
    'while',
    'do',
    'repeat',
    'until',
    'function',
    'local',
    'return',
    'break',
    'goto',
    'in',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'number',
    'string_content',
    'true',
    'false',
    'nil',
    '...',
  ]),
  compoundOperators: new Set([
    'function_call',
    'bracket_index_expression',
    'dot_index_expression',
    'method_index_expression',
  ]),
  skipTypes: new Set([]),
};

// ─── R ────────────────────────────────────────────────────────────────────────
//
// R functions are defined as: `name <- function_definition` (binary_operator with `<-`).
// The extractor handles this as binary_operator + function_definition on the RHS.
// There is no standalone function declaration node — `function_definition` is always
// an RHS expression. The parent `binary_operator` is the true "function node".
// R does NOT have an explicit `return` statement keyword that always appears —
// `return()` is a regular function call. Set returnNode: null.
// call node: `call` (confirmed in extractor handleCall line 111).
// The call node's first child (not a named field) is the function expression.
// Parameters: findChild(funcDef, 'parameters') on function_definition (extractor line 88).
// Each parameter is a `parameter` node with `childForFieldName('name')` or identifier child.

export const dataflowR: DataflowRulesConfig = makeDataflowRules({
  // R functions are the `binary_operator` node where RHS is `function_definition`.
  // We track the binary_operator as a function scope, but the param list lives
  // inside the nested `function_definition` child. This is best-effort: the
  // unified dataflow walker will find `binary_operator` nodes but may not locate
  // the param list via the standard field walk. Most analysis benefit comes from
  // variable tracking and call arg flows.
  // Use function_definition directly: the walker will enter it as function scope.
  functionNodes: new Set(['function_definition']),
  // R function_definition has no 'name' field — the name comes from the enclosing
  // binary_operator's LHS. The nameExtractor is not needed here since the
  // extractor handles name resolution; the dataflow visitor just needs to find
  // the function scope boundary.
  nameField: 'name',

  paramListField: 'parameters',
  paramWrapperTypes: new Set(['parameter']),

  returnNode: null, // R uses return() as a function call, not a statement

  callNode: 'call',
  // R `call` node has the function as its first child (not a named field).
  // Leaving callFunctionField at default 'function' — childForFieldName will
  // return null, and the analysis falls back to skipping the callee name.

  assignmentNode: 'binary_operator',
  assignLeftField: 'left',
  assignRightField: 'right',
});

// ─── Julia ────────────────────────────────────────────────────────────────────
//
// Julia function_definition: extractor uses a `signature` child → `call_expression`
// to find the function name + params (complex nesting). The function node type
// is `function_definition` (confirmed in extractor line 41).
// The params are inside the signature's call_expression's argument_list.
// For dataflow purposes, we just mark function_definition as the scope boundary.
// Params are inside function_definition → signature → call_expression → argument_list.
// Since there's no direct param list field on function_definition, use getParamListNode.
// call_expression: `node.child(0)` for function name (confirmed in extractor handleCall line 387).
// Julia has explicit `return_statement` (confirmed in extractor comment: "Julia has explicit return").
// variable assignment: `assignment` node (confirmed in extractor handleAssignment line 158).

export const dataflowJulia: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_definition']),
  nameField: 'name',

  // Julia params are buried deep: function_definition → signature → call_expression → argument_list.
  // No direct named field on function_definition for params. Leave param extraction
  // to best-effort: getParamListNode returns null (default), so params will be skipped
  // gracefully. The primary value is function scope tracking and call arg flows.
  paramListField: 'parameters',

  returnNode: 'return_statement',

  assignmentNode: 'assignment',
  assignLeftField: 'left',
  assignRightField: 'right',

  callNode: 'call_expression',
  // Julia call_expression: first child is the function (no named field 'function').
  // Leave callFunctionField at default — will return null gracefully.
});

// ─── Bash ─────────────────────────────────────────────────────────────────────
//
// Bash function_definition: name via `childForFieldName('name')` (confirmed in extractor line 42).
// Bash has no typed parameters or return values.
// command: `command_name` child (extractor handleBashCommand line 55).
// No param lists, no return nodes, no variable declarators in the conventional sense.
// Minimal config — primarily useful for function scope tracking and call edges.

export const dataflowBash: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_definition']),
  nameField: 'name',

  returnNode: null, // Bash has no explicit return statement node (return is a command)

  callNode: 'command',
  // Bash `command` node: function name is in `command_name` child (not a named field).
  // Leave callFunctionField at default — will return null gracefully.
});
