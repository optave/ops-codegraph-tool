import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import {
  extractModifierVisibility,
  findChild,
  isCPrimitiveType,
  nodeEndLine,
  setTypeMapEntry,
} from './helpers.js';

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
    case 'declaration':
      handleCppDeclaration(node, ctx);
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

/**
 * Seed typeMap for declaration-typed locals: `UserService svc;` and
 * `UserService svc = makeService();` both yield typeMap["svc"] = "UserService"
 * at confidence 0.9. Mirrors `match_c_family_type_map` ("declaration" branch)
 * in the native Rust C++ extractor.
 */
function handleCppDeclaration(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = typeNode.text;
  // Skip primitive types — they are never class/struct receivers
  if (isCPrimitiveType(typeName)) return;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const kind = child.type;
    let nameNode: TreeSitterNode | null = null;
    if (kind === 'init_declarator') {
      nameNode = child.childForFieldName('declarator') ?? null;
    } else if (kind === 'identifier') {
      nameNode = child;
    }
    // Note: pointer_declarator / reference_declarator children (e.g. `UserService *svc;`)
    // are intentionally skipped here — they are also skipped by the native Rust
    // match_c_family_type_map helper, which only handles 'init_declarator' and
    // 'identifier' children. Both engines have the same scope for this case.
    if (!nameNode) continue;
    const varName = unwrapCppDeclaratorName(nameNode);
    if (varName) {
      setTypeMapEntry(ctx.typeMap, varName, typeName, 0.9);
    }
  }
}

function handleCppCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return;
  const callLine = node.startPosition.row + 1;

  if (funcNode.type === 'field_expression') {
    const field = funcNode.childForFieldName('field');
    const argument = funcNode.childForFieldName('argument');
    if (field) {
      ctx.calls.push({
        name: field.text,
        line: callLine,
        ...(argument ? { receiver: argument.text } : {}),
      });
    }
    return;
  }

  // (*fp)(args) — function pointer dereference call; unresolvable statically
  if (funcNode.type === 'parenthesized_expression' || funcNode.type === 'pointer_expression') {
    ctx.calls.push({
      name: '<dynamic:unresolved>',
      line: callLine,
      dynamic: true,
      dynamicKind: 'unresolved-dynamic',
    });
    return;
  }

  const fnName = funcNode.text;
  // dlsym(handle, "symbol") — dynamic symbol loading
  if (fnName === 'dlsym' || fnName === 'dlvsym') {
    // For simplicity, flag as unresolved (symbol might not be in the codebase)
    ctx.calls.push({
      name: '<dynamic:unresolved>',
      line: callLine,
      dynamic: true,
      dynamicKind: 'unresolved-dynamic',
    });
    return;
  }

  if (fnName) ctx.calls.push({ name: fnName, line: callLine });
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

const CPP_DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'reference_declarator',
  'array_declarator',
  'parenthesized_declarator',
  'function_declarator',
]);

/**
 * Drill through pointer/reference/array/parenthesized/function declarator
 * wrappers to recover the bare identifier. Mirrors `unwrap_cpp_declarator` in
 * the native C++ extractor. tree-sitter-cpp's `reference_declarator` does not
 * expose a `declarator` field, so the loop falls back to scanning children
 * for the next nested declarator or identifier.
 */
function unwrapCppDeclaratorName(node: TreeSitterNode): string {
  let current: TreeSitterNode | null = node;
  while (current && CPP_DECLARATOR_WRAPPERS.has(current.type)) {
    const named = current.childForFieldName('declarator');
    if (named) {
      current = named;
      continue;
    }
    const fallback = nextCppDeclaratorChild(current);
    if (!fallback) break;
    current = fallback;
  }
  if (current?.type === 'identifier' || current?.type === 'field_identifier') {
    return current.text;
  }
  return current?.text ?? node.text;
}

function nextCppDeclaratorChild(node: TreeSitterNode): TreeSitterNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'identifier' ||
      child.type === 'field_identifier' ||
      CPP_DECLARATOR_WRAPPERS.has(child.type)
    ) {
      return child;
    }
  }
  return null;
}

function extractCppParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (param?.type !== 'parameter_declaration') continue;
    const nameNode = param.childForFieldName('declarator');
    if (nameNode) {
      const name = unwrapCppDeclaratorName(nameNode);
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
    if (member?.type !== 'field_declaration') continue;
    const nameNode = member.childForFieldName('declarator');
    if (nameNode) {
      const name = unwrapCppDeclaratorName(nameNode);
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
    if (member?.type !== 'enumerator') continue;
    const nameNode = member.childForFieldName('name');
    if (nameNode) {
      entries.push({ name: nameNode.text, kind: 'constant', line: member.startPosition.row + 1 });
    }
  }
  return entries;
}
