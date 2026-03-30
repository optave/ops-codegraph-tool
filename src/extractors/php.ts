import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractBodyMembers,
  extractModifierVisibility,
  findChild,
  lastPathSegment,
  MAX_WALK_DEPTH,
  nodeEndLine,
} from './helpers.js';

function extractPhpParameters(fnNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode =
    fnNode.childForFieldName('parameters') || findChild(fnNode, 'formal_parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const param = paramsNode.child(i);
    if (!param) continue;
    if (param.type === 'simple_parameter' || param.type === 'variadic_parameter') {
      const nameNode = param.childForFieldName('name') || findChild(param, 'variable_name');
      if (nameNode) {
        params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

/** Extract property declarations from a PHP class member. */
function extractPhpProperties(member: TreeSitterNode, children: SubDeclaration[]): void {
  for (let j = 0; j < member.childCount; j++) {
    const el = member.child(j);
    if (!el || el.type !== 'property_element') continue;
    const varNode = findChild(el, 'variable_name');
    if (varNode) {
      children.push({
        name: varNode.text,
        kind: 'property',
        line: member.startPosition.row + 1,
        visibility: extractModifierVisibility(member),
      });
    }
  }
}

/** Extract constant declarations from a PHP class member. */
function extractPhpConstants(member: TreeSitterNode, children: SubDeclaration[]): void {
  for (let j = 0; j < member.childCount; j++) {
    const el = member.child(j);
    if (!el || el.type !== 'const_element') continue;
    const nameNode = el.childForFieldName('name') || findChild(el, 'name');
    if (nameNode) {
      children.push({
        name: nameNode.text,
        kind: 'constant',
        line: member.startPosition.row + 1,
      });
    }
  }
}

function extractPhpClassChildren(classNode: TreeSitterNode): SubDeclaration[] {
  const children: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'declaration_list');
  if (!body) return children;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;
    if (member.type === 'property_declaration') {
      extractPhpProperties(member, children);
    } else if (member.type === 'const_declaration') {
      extractPhpConstants(member, children);
    }
  }
  return children;
}

function extractPhpEnumCases(enumNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(enumNode, ['body', 'enum_declaration_list'], 'enum_case', 'constant');
}

/**
 * Extract symbols from PHP files.
 */
export function extractPHPSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkPhpNode(tree.rootNode, ctx);
  extractPhpTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkPhpNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handlePhpFuncDef(node, ctx);
      break;
    case 'class_declaration':
      handlePhpClassDecl(node, ctx);
      break;
    case 'interface_declaration':
      handlePhpInterfaceDecl(node, ctx);
      break;
    case 'trait_declaration':
      handlePhpTraitDecl(node, ctx);
      break;
    case 'enum_declaration':
      handlePhpEnumDecl(node, ctx);
      break;
    case 'method_declaration':
      handlePhpMethodDecl(node, ctx);
      break;
    case 'namespace_use_declaration':
      handlePhpNamespaceUse(node, ctx);
      break;
    case 'function_call_expression':
      handlePhpFuncCall(node, ctx);
      break;
    case 'member_call_expression':
      handlePhpMemberCall(node, ctx);
      break;
    case 'scoped_call_expression':
      handlePhpScopedCall(node, ctx);
      break;
    case 'object_creation_expression':
      handlePhpObjectCreation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkPhpNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handlePhpFuncDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const params = extractPhpParameters(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handlePhpClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classChildren = extractPhpClassChildren(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: classChildren.length > 0 ? classChildren : undefined,
  });
  const baseClause = node.childForFieldName('base_clause') || findChild(node, 'base_clause');
  if (baseClause) {
    for (let i = 0; i < baseClause.childCount; i++) {
      const child = baseClause.child(i);
      if (child && (child.type === 'name' || child.type === 'qualified_name')) {
        ctx.classes.push({
          name: nameNode.text,
          extends: child.text,
          line: node.startPosition.row + 1,
        });
        break;
      }
    }
  }
  const interfaceClause = findChild(node, 'class_interface_clause');
  if (interfaceClause) {
    for (let i = 0; i < interfaceClause.childCount; i++) {
      const child = interfaceClause.child(i);
      if (child && (child.type === 'name' || child.type === 'qualified_name')) {
        ctx.classes.push({
          name: nameNode.text,
          implements: child.text,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}

function handlePhpInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && child.type === 'method_declaration') {
        const methName = child.childForFieldName('name');
        if (methName) {
          ctx.definitions.push({
            name: `${nameNode.text}.${methName.text}`,
            kind: 'method',
            line: child.startPosition.row + 1,
            endLine: child.endPosition.row + 1,
          });
        }
      }
    }
  }
}

function handlePhpTraitDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'trait',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handlePhpEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const enumChildren = extractPhpEnumCases(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: enumChildren.length > 0 ? enumChildren : undefined,
  });
}

function handlePhpMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip interface methods already emitted by handlePhpInterfaceDecl
  if (node.parent?.parent?.type === 'interface_declaration') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findPHPParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const params = extractPhpParameters(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handlePhpNamespaceUse(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'namespace_use_clause') {
      const nameNode = findChild(child, 'qualified_name') || findChild(child, 'name');
      if (nameNode) {
        const fullPath = nameNode.text;
        const lastName = lastPathSegment(fullPath, '\\');
        const alias = child.childForFieldName('alias');
        ctx.imports.push({
          source: fullPath,
          names: [alias ? alias.text : lastName],
          line: node.startPosition.row + 1,
          phpUse: true,
        });
      }
    }
    if (child && (child.type === 'qualified_name' || child.type === 'name')) {
      const fullPath = child.text;
      const lastName = lastPathSegment(fullPath, '\\');
      ctx.imports.push({
        source: fullPath,
        names: [lastName],
        line: node.startPosition.row + 1,
        phpUse: true,
      });
    }
  }
}

function handlePhpFuncCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function') || node.child(0);
  if (!fn) return;
  if (fn.type === 'name' || fn.type === 'identifier') {
    ctx.calls.push({ name: fn.text, line: node.startPosition.row + 1 });
  } else if (fn.type === 'qualified_name') {
    const parts = fn.text.split('\\');
    ctx.calls.push({ name: parts[parts.length - 1] ?? fn.text, line: node.startPosition.row + 1 });
  }
}

function handlePhpMemberCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const name = node.childForFieldName('name');
  if (!name) return;
  const obj = node.childForFieldName('object');
  const call: Call = { name: name.text, line: node.startPosition.row + 1 };
  if (obj) call.receiver = obj.text;
  ctx.calls.push(call);
}

function handlePhpScopedCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const name = node.childForFieldName('name');
  if (!name) return;
  const scope = node.childForFieldName('scope');
  const call: Call = { name: name.text, line: node.startPosition.row + 1 };
  if (scope) call.receiver = scope.text;
  ctx.calls.push(call);
}

function handlePhpObjectCreation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const classNode = node.child(1);
  if (classNode && (classNode.type === 'name' || classNode.type === 'qualified_name')) {
    const parts = classNode.text.split('\\');
    ctx.calls.push({
      name: parts[parts.length - 1] ?? classNode.text,
      line: node.startPosition.row + 1,
    });
  }
}

function extractPhpTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractPhpTypeMapDepth(node, ctx, 0);
}

function extractPhpTypeMapDepth(node: TreeSitterNode, ctx: ExtractorOutput, depth: number): void {
  if (depth >= MAX_WALK_DEPTH) return;

  // Function/method parameters with type hints
  if (
    node.type === 'simple_parameter' ||
    node.type === 'variadic_parameter' ||
    node.type === 'property_promotion_parameter'
  ) {
    const typeNode = node.childForFieldName('type');
    const nameNode = node.childForFieldName('name') || findChild(node, 'variable_name');
    if (typeNode && nameNode) {
      const typeName = extractPhpTypeName(typeNode);
      if (typeName) ctx.typeMap?.set(nameNode.text, { type: typeName, confidence: 0.9 });
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractPhpTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractPhpTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'named_type' || t === 'name' || t === 'qualified_name') return typeNode.text;
  // Nullable: ?MyType
  if (t === 'optional_type') {
    const inner = typeNode.child(1) || typeNode.child(0);
    return inner ? extractPhpTypeName(inner) : null;
  }
  // Skip union types (too ambiguous)
  if (t === 'union_type' || t === 'intersection_type') return null;
  return null;
}

function findPHPParentClass(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'trait_declaration' ||
      current.type === 'enum_declaration'
    ) {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}
