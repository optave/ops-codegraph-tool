import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { extractModifierVisibility, findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from CUDA files.
 *
 * CUDA is a C++ superset. The tree-sitter-cuda grammar extends C++ with
 * __global__, __device__, __host__, __shared__ qualifiers and kernel
 * launch syntax (<<<...>>>). We reuse C++ handler patterns and add
 * CUDA-specific qualifier detection.
 */
export function extractCudaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkCudaNode(tree.rootNode, ctx);
  return ctx;
}

const CUDA_QUALIFIERS = new Set([
  '__global__',
  '__device__',
  '__host__',
  '__shared__',
  '__constant__',
]);

function walkCudaNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handleCudaFunctionDef(node, ctx);
      break;
    case 'class_specifier':
      handleCudaClassSpecifier(node, ctx);
      break;
    case 'struct_specifier':
      handleCudaStructSpecifier(node, ctx);
      break;
    case 'enum_specifier':
      handleCudaEnumSpecifier(node, ctx);
      break;
    case 'namespace_definition':
      handleCudaNamespaceDef(node, ctx);
      break;
    case 'type_definition':
      handleCudaTypedef(node, ctx);
      break;
    case 'preproc_include':
      handleCudaInclude(node, ctx);
      break;
    case 'call_expression':
      handleCudaCallExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkCudaNode(child, ctx);
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

function handleCudaFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;
  const funcDeclarator =
    declarator.type === 'function_declarator'
      ? declarator
      : findChild(declarator, 'function_declarator');
  if (!funcDeclarator) return;
  const nameNode = funcDeclarator.childForFieldName('declarator');
  if (!nameNode) return;
  const name = nameNode.text;

  const parentClass = findCudaParentClass(node);
  const fullName = parentClass ? `${parentClass}.${name}` : name;
  const kind = parentClass ? 'method' : 'function';

  const params = extractCudaParameters(funcDeclarator.childForFieldName('parameters'));
  const decorators = extractCudaQualifiers(node);

  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: parentClass ? extractModifierVisibility(node) : undefined,
    decorators: decorators.length > 0 ? decorators : undefined,
  });
}

function handleCudaClassSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCudaClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  const baseClause = findChild(node, 'base_class_clause');
  if (baseClause) {
    for (let i = 0; i < baseClause.childCount; i++) {
      const child = baseClause.child(i);
      if (child && (child.type === 'type_identifier' || child.type === 'qualified_identifier')) {
        ctx.classes.push({
          name: nameNode.text,
          extends: child.text,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handleCudaStructSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCudaClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleCudaEnumSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCudaEnumEntries(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleCudaNamespaceDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'namespace',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleCudaTypedef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  let name: string | undefined;
  for (let i = node.childCount - 1; i >= 0; i--) {
    const child = node.child(i);
    if (
      child &&
      (child.type === 'type_identifier' ||
        child.type === 'identifier' ||
        child.type === 'primitive_type')
    ) {
      name = child.text;
      break;
    }
  }
  if (!name) return;
  ctx.definitions.push({
    name,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleCudaInclude(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return;
  const raw = pathNode.text;
  const source = raw.replace(/^["<]|[">]$/g, '');
  const lastName = source.split('/').pop() ?? source;
  ctx.imports.push({
    source,
    names: [lastName],
    line: node.startPosition.row + 1,
    cInclude: true,
  });
}

function handleCudaCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return;
  const call: Call = { name: '', line: node.startPosition.row + 1 };
  if (funcNode.type === 'field_expression') {
    const field = funcNode.childForFieldName('field');
    const argument = funcNode.childForFieldName('argument');
    if (field) call.name = field.text;
    if (argument) call.receiver = argument.text;
  } else {
    call.name = funcNode.text;
  }
  if (call.name) ctx.calls.push(call);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractCudaQualifiers(node: TreeSitterNode): string[] {
  const qualifiers: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    // Check direct text match for bare qualifier tokens, or look inside
    // storage_class_specifier / attribute_specifier wrapper nodes.
    // Use `else if` to avoid pushing the same qualifier twice when
    // wrapper-node text also matches CUDA_QUALIFIERS directly.
    if (child.type === 'storage_class_specifier' || child.type === 'attribute_specifier') {
      if (CUDA_QUALIFIERS.has(child.text)) qualifiers.push(child.text);
    } else if (CUDA_QUALIFIERS.has(child.text)) {
      qualifiers.push(child.text);
    }
  }
  return qualifiers;
}

function findCudaParentClass(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (current.type === 'field_declaration_list') {
      const classNode = current.parent;
      if (
        classNode &&
        (classNode.type === 'class_specifier' || classNode.type === 'struct_specifier')
      ) {
        const nameNode = classNode.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
    }
    current = current.parent;
  }
  return null;
}

function extractCudaParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param || param.type !== 'parameter_declaration') continue;
    const nameNode = param.childForFieldName('declarator');
    if (nameNode) {
      // Reuse the field-name drill helper so function-type parameters like
      // `void process(int callback(int))` yield the bare name `callback`
      // instead of the raw declarator text, matching the native unwrap path.
      const name = extractCudaFieldName(nameNode);
      params.push({ name, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function extractCudaClassFields(classNode: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
  const body =
    classNode.childForFieldName('body') || findChild(classNode, 'field_declaration_list');
  if (!body) return fields;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== 'field_declaration') continue;
    const nameNode = member.childForFieldName('declarator');
    if (!nameNode) continue;
    // Skip method declarations — a `field_declaration` whose declarator
    // (after unwrapping pointer/reference/array) is a `function_declarator`
    // is a method signature in a header, not a data field. Native and WASM
    // previously diverged on how to format these (native stripped the `*`
    // from pointer-return types, WASM kept it), and both produced
    // method-signature-shaped "property" entries that are not real fields.
    if (isCudaMethodDeclarator(nameNode)) continue;
    const name = extractCudaFieldName(nameNode);
    fields.push({
      name,
      kind: 'property',
      line: member.startPosition.row + 1,
      visibility: extractModifierVisibility(member),
    });
  }
  return fields;
}

const CUDA_DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'reference_declarator',
  'array_declarator',
  'parenthesized_declarator',
]);

function isCudaMethodDeclarator(node: TreeSitterNode): boolean {
  let current: TreeSitterNode | null = node;
  while (current && CUDA_DECLARATOR_WRAPPERS.has(current.type)) {
    current = current.childForFieldName('declarator');
  }
  if (current?.type !== 'function_declarator') return false;
  // A `function_declarator` whose inner declarator is a `parenthesized_declarator`
  // is a function-pointer (or function-reference) field — e.g. `void (*cb)(int)`
  // parses as function_declarator > parenthesized_declarator > pointer_declarator >
  // field_identifier. Those are real data fields, not method declarations.
  const inner = current.childForFieldName('declarator');
  return inner?.type !== 'parenthesized_declarator';
}

/**
 * Resolve the identifier of a declarator by walking through any combination of
 * pointer/reference/array/parenthesized wrappers and `function_declarator`
 * nodes. Used by both class-field extraction (where `function_declarator`
 * indicates a function-pointer field after method declarations have been
 * filtered out) and parameter extraction (where `function_declarator` wraps a
 * bare function-type parameter name like `callback` in
 * `void process(int callback(int))`).
 */
function extractCudaFieldName(decl: TreeSitterNode): string {
  let current: TreeSitterNode | null = decl;
  while (current) {
    if (current.type === 'identifier' || current.type === 'field_identifier') {
      return current.text;
    }
    if (CUDA_DECLARATOR_WRAPPERS.has(current.type) || current.type === 'function_declarator') {
      const next = innerCudaDeclarator(current);
      if (!next) break;
      current = next;
      continue;
    }
    break;
  }
  return decl.text;
}

/**
 * Find the inner declarator of a wrapper node. Most C++ declarator wrappers
 * expose it via the `declarator` field, but some (e.g. `parenthesized_declarator`
 * and `reference_declarator` in tree-sitter-cuda) have unnamed children — so
 * fall back to scanning children for a declarator-shaped node.
 */
function innerCudaDeclarator(node: TreeSitterNode): TreeSitterNode | null {
  const named = node.childForFieldName('declarator');
  if (named) return named;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'identifier' ||
      child.type === 'field_identifier' ||
      child.type === 'function_declarator' ||
      CUDA_DECLARATOR_WRAPPERS.has(child.type)
    ) {
      return child;
    }
  }
  return null;
}

function extractCudaEnumEntries(enumNode: TreeSitterNode): SubDeclaration[] {
  const entries: SubDeclaration[] = [];
  const body = findChild(enumNode, 'enumerator_list');
  if (!body) return entries;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== 'enumerator') continue;
    const nameNode = member.childForFieldName('name');
    if (nameNode) {
      entries.push({ name: nameNode.text, kind: 'constant', line: member.startPosition.row + 1 });
    }
  }
  return entries;
}
