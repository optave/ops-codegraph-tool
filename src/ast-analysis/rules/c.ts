import type {
  ComplexityRules,
  DataflowRulesConfig,
  HalsteadRules,
  TreeSitterNode,
} from '../../types.js';
import { makeDataflowRules } from '../shared.js';

// ─── C Complexity ─────────────────────────────────────────────────────────
//
// Mirrors the native `C_RULES` in `crates/codegraph-core/src/ast_analysis/complexity.rs`.
//
// tree-sitter-c's if_statement wraps its else branch in a real `else_clause`
// node (`if_statement condition consequence else_clause(else [if_statement |
// <substatement>])`) — confirmed by parsing `if (..) {..} else if (..) {..}
// else {..}` and inspecting the S-expression. This is Pattern A (JS/C#/Rust
// style: an else_clause node wraps either a nested if_statement for
// `else if` or the plain else body), NOT Pattern C (Go/Java style, where the
// `alternative` field holds the substatement directly with no wrapper node).

export const complexity: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'while_statement',
    'do_statement',
    'case_statement',
    'conditional_expression',
  ]),
  caseNodes: new Set(['case_statement']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['binary_expression']),
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'while_statement',
    'do_statement',
    'conditional_expression',
  ]),
  functionNodes: new Set(['function_definition']),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_statement']),
};

// ─── C++ Complexity ───────────────────────────────────────────────────────
//
// Mirrors the native `CPP_RULES`. Adds `for_range_loop` and `catch_clause`
// on top of the C rule set; uses the same else_clause wrapper (Pattern A) as
// C, confirmed by parsing the same if/else-if/else shape with tree-sitter-cpp.

export const complexityCpp: ComplexityRules = {
  branchNodes: new Set([
    'if_statement',
    'else_clause',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'case_statement',
    'conditional_expression',
    'catch_clause',
  ]),
  caseNodes: new Set(['case_statement']),
  logicalOperators: new Set(['&&', '||']),
  logicalNodeTypes: new Set(['binary_expression']),
  optionalChainType: null,
  nestingNodes: new Set([
    'if_statement',
    'for_statement',
    'for_range_loop',
    'while_statement',
    'do_statement',
    'catch_clause',
    'conditional_expression',
  ]),
  functionNodes: new Set(['function_definition']),
  ifNodeType: 'if_statement',
  elseNodeType: 'else_clause',
  elifNodeType: null,
  elseViaAlternative: false,
  switchLikeNodes: new Set(['switch_statement']),
};

// ─── C Halstead ───────────────────────────────────────────────────────────
//
// Mirrors the native `C_HALSTEAD`.

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
    '~',
    '<<',
    '>>',
    '++',
    '--',
    'sizeof',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'return',
    'break',
    'continue',
    'goto',
    '.',
    '->',
    ',',
    ';',
    ':',
    '?',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'type_identifier',
    'field_identifier',
    'number_literal',
    'string_literal',
    'char_literal',
    'true',
    'false',
    'null',
  ]),
  compoundOperators: new Set(['call_expression', 'subscript_expression']),
  skipTypes: new Set([]),
};

// ─── C++ Halstead ─────────────────────────────────────────────────────────
//
// Mirrors the native `CPP_HALSTEAD`. Adds C++-specific operators/keywords
// (`new`, `delete`, `throw`, `try`/`catch`, `::`) and raw string literals.

export const halsteadCpp: HalsteadRules = {
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
    '~',
    '<<',
    '>>',
    '++',
    '--',
    'sizeof',
    'new',
    'delete',
    'throw',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'return',
    'break',
    'continue',
    'try',
    'catch',
    '.',
    '->',
    '::',
    ',',
    ';',
    ':',
    '?',
  ]),
  operandLeafTypes: new Set([
    'identifier',
    'type_identifier',
    'field_identifier',
    'namespace_identifier',
    'number_literal',
    'string_literal',
    'raw_string_literal',
    'char_literal',
    'true',
    'false',
    'nullptr',
    'this',
  ]),
  compoundOperators: new Set(['call_expression', 'subscript_expression', 'new_expression']),
  skipTypes: new Set(['template_argument_list', 'template_parameter_list']),
};

// ─── C/C++ function-name extraction ──────────────────────────────────────────
//
// C/C++ function_definition nests the name inside declarators:
//   function_definition
//     declarator: function_declarator
//       declarator: identifier | pointer_declarator | qualified_identifier | ...
//       parameters: parameter_list
//
// We unwrap through common decorator wrappers to reach the bare identifier.

const DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'reference_declarator',
  'array_declarator',
  'parenthesized_declarator',
  'abstract_function_declarator',
]);

function unwrapDeclarator(node: TreeSitterNode | null): TreeSitterNode | null {
  let cur = node;
  while (cur && DECLARATOR_WRAPPERS.has(cur.type)) {
    cur = cur.childForFieldName('declarator');
  }
  return cur;
}

function extractCFunctionName(node: TreeSitterNode): string | null {
  const decl = node.childForFieldName('declarator');
  if (!decl) return null;

  // For pointer/reference-returning functions (int *foo(), T &bar()), the direct
  // child is a pointer_declarator or similar wrapper — unwrap one level first.
  const unwrapped = DECLARATOR_WRAPPERS.has(decl.type)
    ? decl.childForFieldName('declarator')
    : decl;
  const funcDecl = unwrapped?.type === 'function_declarator' ? unwrapped : null;
  if (!funcDecl) return null;

  const inner = funcDecl.childForFieldName('declarator');
  const nameNode = unwrapDeclarator(inner);
  if (!nameNode) return null;

  // qualified_identifier (C++ method): extract the unqualified_identifier
  if (nameNode.type === 'qualified_identifier') {
    const unqual =
      nameNode.childForFieldName('name') ??
      nameNode.namedChildren[nameNode.namedChildren.length - 1] ??
      null;
    return unqual?.text ?? null;
  }

  return nameNode.type === 'identifier' || nameNode.type === 'field_identifier'
    ? nameNode.text
    : null;
}

// Traverse through pointer/reference/array wrappers to reach function_declarator.
function findFuncDeclarator(node: TreeSitterNode | null): TreeSitterNode | null {
  if (!node) return null;
  if (node.type === 'function_declarator') return node;
  if (DECLARATOR_WRAPPERS.has(node.type)) {
    return findFuncDeclarator(node.childForFieldName('declarator'));
  }
  return null;
}

// Navigate function_definition → (optional wrapper) → function_declarator → parameters.
// Needed because C/C++ params are on function_declarator, not directly on function_definition.
function getCParamListNode(funcNode: TreeSitterNode): TreeSitterNode | null {
  const decl = funcNode.childForFieldName('declarator');
  return findFuncDeclarator(decl)?.childForFieldName('parameters') ?? null;
}

function extractCParamName(node: TreeSitterNode): string[] | null {
  if (node.type !== 'parameter_declaration') return null;
  const decl = node.childForFieldName('declarator');
  if (!decl) return null;

  // Reference declarator (T& name, T&& name): tree-sitter-cpp uses no named
  // 'declarator' field inside reference_declarator, so unwrapDeclarator would
  // return null. Handle it first by taking the last named child.
  if (decl.type === 'reference_declarator') {
    const inner = decl.namedChild(decl.namedChildCount - 1);
    if (inner?.type === 'identifier') return [inner.text];
    return null;
  }

  const nameNode = unwrapDeclarator(decl);
  if (!nameNode) return null;
  if (nameNode.type === 'identifier') return [nameNode.text];
  return null;
}

// ─── C Dataflow rules ─────────────────────────────────────────────────────────

export const dataflow: DataflowRulesConfig = makeDataflowRules({
  functionNodes: new Set(['function_definition']),
  nameField: 'declarator',
  nameExtractor: extractCFunctionName,

  paramListField: 'parameters',
  getParamListNode: getCParamListNode,
  paramIdentifier: 'identifier',
  paramWrapperTypes: new Set(['parameter_declaration']),
  extractParamName: extractCParamName,

  returnNode: 'return_statement',

  varDeclaratorNode: 'init_declarator',
  varNameField: 'declarator',
  varValueField: 'value',

  assignmentNode: 'assignment_expression',
  assignLeftField: 'left',
  assignRightField: 'right',

  callNode: 'call_expression',
  callFunctionField: 'function',
  callArgsField: 'arguments',

  memberNode: 'field_expression',
  memberObjectField: 'argument',
  memberPropertyField: 'field',

  expressionStmtNode: 'expression_statement',
  mutatingMethods: new Set(),
});

// C++ extends C with additional function node types
export const dataflowCpp: DataflowRulesConfig = makeDataflowRules({
  ...dataflow,
  functionNodes: new Set([
    'function_definition',
    // function_declaration is a forward declaration (no body) in tree-sitter-cpp;
    // including it creates spurious param vertices from prototypes and can overwrite
    // correct dataflow_summary rows with flows_to_return=0 when the declaration is
    // processed after the definition.
  ]),
  // C++ call expressions can use :: scope resolution
  mutatingMethods: new Set([
    'push_back',
    'push_front',
    'insert',
    'erase',
    'clear',
    'resize',
    'reserve',
    'emplace',
    'emplace_back',
    'emplace_front',
    'append',
    'assign',
  ]),
});
