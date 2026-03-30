import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { extractModifierVisibility, findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from C++ files.
 */
export function extractCppSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkCppNode(tree.rootNode, ctx);
  return ctx;
}

function walkCppNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handleCppFunctionDef(node, ctx);
      break;
    case 'class_specifier':
      handleCppClassSpecifier(node, ctx);
      break;
    case 'struct_specifier':
      handleCppStructSpecifier(node, ctx);
      break;
    case 'enum_specifier':
      handleCppEnumSpecifier(node, ctx);
      break;
    case 'namespace_definition':
      handleCppNamespaceDef(node, ctx);
      break;
    case 'type_definition':
      handleCppTypedef(node, ctx);
      break;
    case 'preproc_include':
      handleCppInclude(node, ctx);
      break;
    case 'call_expression':
      handleCppCallExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkCppNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleCppFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

  // If this function is inside a class/struct field_declaration_list, emit as method
  const parentClass = findCppParentClass(node);
  const fullName = parentClass ? `${parentClass}.${name}` : name;
  const kind = parentClass ? 'method' : 'function';

  const params = extractCppParameters(funcDeclarator.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: parentClass ? extractModifierVisibility(node) : undefined,
  });
}

function handleCppClassSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCppClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  // Inheritance via base_class_clause
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

function handleCppStructSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCppClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
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

function handleCppEnumSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractCppEnumEntries(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleCppNamespaceDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'namespace',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleCppTypedef(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleCppInclude(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleCppCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

// ── Utility helpers ─────────────────────────────────────────────────────────

function findCppParentClass(node: TreeSitterNode): string | null {
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

function extractCppParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
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

function extractCppClassFields(classNode: TreeSitterNode): SubDeclaration[] {
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

function extractCppEnumEntries(enumNode: TreeSitterNode): SubDeclaration[] {
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
