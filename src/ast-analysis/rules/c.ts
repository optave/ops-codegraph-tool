import type { DataflowRulesConfig, TreeSitterNode } from '../../types.js';
import { makeDataflowRules } from '../shared.js';

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
