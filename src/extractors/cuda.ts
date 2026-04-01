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
    if (CUDA_QUALIFIERS.has(child.text)) {
      qualifiers.push(child.text);
    }
    // Also check storage_class_specifier or attribute children
    if (child.type === 'storage_class_specifier' || child.type === 'attribute_specifier') {
      if (CUDA_QUALIFIERS.has(child.text)) qualifiers.push(child.text);
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
      const name =
        nameNode.type === 'identifier'
          ? nameNode.text
          : (findChild(nameNode, 'identifier')?.text ?? nameNode.text);
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
    if (nameNode) {
      const name =
        nameNode.type === 'identifier'
          ? nameNode.text
          : (findChild(nameNode, 'identifier')?.text ?? nameNode.text);
      fields.push({
        name,
        kind: 'property',
        line: member.startPosition.row + 1,
        visibility: extractModifierVisibility(member),
      });
    }
  }
  return fields;
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
