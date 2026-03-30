import type {
  Call,
  ClassRelation,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractModifierVisibility,
  findChild,
  MAX_WALK_DEPTH,
  nodeEndLine,
  setTypeMapEntry,
} from './helpers.js';

/**
 * Extract symbols from C# files.
 */
export function extractCSharpSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkCSharpNode(tree.rootNode, ctx);
  reclassifyCSharpImplements(ctx);
  extractCSharpTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkCSharpNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_declaration':
      handleCsClassDecl(node, ctx);
      break;
    case 'struct_declaration':
      handleCsStructDecl(node, ctx);
      break;
    case 'record_declaration':
      handleCsRecordDecl(node, ctx);
      break;
    case 'interface_declaration':
      handleCsInterfaceDecl(node, ctx);
      break;
    case 'enum_declaration':
      handleCsEnumDecl(node, ctx);
      break;
    case 'method_declaration':
      handleCsMethodDecl(node, ctx);
      break;
    case 'constructor_declaration':
      handleCsConstructorDecl(node, ctx);
      break;
    case 'property_declaration':
      handleCsPropertyDecl(node, ctx);
      break;
    case 'using_directive':
      handleCsUsingDirective(node, ctx);
      break;
    case 'invocation_expression':
      handleCsInvocationExpr(node, ctx);
      break;
    case 'object_creation_expression':
      handleCsObjectCreation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkCSharpNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleCsClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classChildren = extractCSharpClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: classChildren.length > 0 ? classChildren : undefined,
  });
  extractCSharpBaseTypes(node, nameNode.text, ctx.classes);
}

function handleCsStructDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const structChildren = extractCSharpClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: structChildren.length > 0 ? structChildren : undefined,
  });
  extractCSharpBaseTypes(node, nameNode.text, ctx.classes);
}

function handleCsRecordDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'record',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  extractCSharpBaseTypes(node, nameNode.text, ctx.classes);
}

function handleCsInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleCsEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const enumChildren = extractCSharpEnumMembers(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: enumChildren.length > 0 ? enumChildren : undefined,
  });
}

function handleCsMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip interface methods already emitted by handleCsInterfaceDecl
  if (node.parent?.parent?.type === 'interface_declaration') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentType = findCSharpParentType(node);
  const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
  const params = extractCSharpParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleCsConstructorDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentType = findCSharpParentType(node);
  const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
  const params = extractCSharpParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleCsPropertyDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentType = findCSharpParentType(node);
  const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
  ctx.definitions.push({
    name: fullName,
    kind: 'property',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: extractModifierVisibility(node),
  });
}

function handleCsUsingDirective(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode =
    node.childForFieldName('name') ||
    findChild(node, 'qualified_name') ||
    findChild(node, 'identifier');
  if (!nameNode) return;
  const fullPath = nameNode.text;
  const lastName = fullPath.split('.').pop() ?? fullPath;
  ctx.imports.push({
    source: fullPath,
    names: [lastName],
    line: node.startPosition.row + 1,
    csharpUsing: true,
  });
}

function handleCsInvocationExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function') || node.child(0);
  if (!fn) return;
  if (fn.type === 'identifier') {
    ctx.calls.push({ name: fn.text, line: node.startPosition.row + 1 });
  } else if (fn.type === 'member_access_expression') {
    const name = fn.childForFieldName('name');
    if (name) {
      const expr = fn.childForFieldName('expression');
      const call: Call = { name: name.text, line: node.startPosition.row + 1 };
      if (expr) call.receiver = expr.text;
      ctx.calls.push(call);
    }
  } else if (fn.type === 'generic_name' || fn.type === 'member_binding_expression') {
    const name = fn.childForFieldName('name') || fn.child(0);
    if (name) ctx.calls.push({ name: name.text, line: node.startPosition.row + 1 });
  }
}

function handleCsObjectCreation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName =
    typeNode.type === 'generic_name'
      ? typeNode.childForFieldName('name')?.text || typeNode.child(0)?.text
      : typeNode.text;
  if (typeName) ctx.calls.push({ name: typeName, line: node.startPosition.row + 1 });
}

function findCSharpParentType(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_declaration' ||
      current.type === 'struct_declaration' ||
      current.type === 'interface_declaration' ||
      current.type === 'enum_declaration' ||
      current.type === 'record_declaration'
    ) {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractCSharpParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = param.childForFieldName('name');
    if (nameNode) {
      params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function extractCSharpClassFields(classNode: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'declaration_list');
  if (!body) return fields;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== 'field_declaration') continue;
    const varDecl = findChild(member, 'variable_declaration');
    if (!varDecl) continue;
    for (let j = 0; j < varDecl.childCount; j++) {
      const child = varDecl.child(j);
      if (!child || child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        fields.push({
          name: nameNode.text,
          kind: 'property',
          line: member.startPosition.row + 1,
          visibility: extractModifierVisibility(member),
        });
      }
    }
  }
  return fields;
}

function extractCSharpEnumMembers(enumNode: TreeSitterNode): SubDeclaration[] {
  const constants: SubDeclaration[] = [];
  const body =
    enumNode.childForFieldName('body') || findChild(enumNode, 'enum_member_declaration_list');
  if (!body) return constants;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== 'enum_member_declaration') continue;
    const nameNode = member.childForFieldName('name');
    if (nameNode) {
      constants.push({ name: nameNode.text, kind: 'constant', line: member.startPosition.row + 1 });
    }
  }
  return constants;
}

// ── Type map extraction ──────────────────────────────────────────────────────

function extractCSharpTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractCSharpTypeMapDepth(node, ctx, 0);
}

function extractCSharpTypeMapDepth(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  depth: number,
): void {
  if (depth >= MAX_WALK_DEPTH) return;

  // local_declaration_statement → variable_declaration → type + variable_declarator(s)
  if (node.type === 'variable_declaration') {
    const typeNode = node.childForFieldName('type') || node.child(0);
    if (typeNode && typeNode.type !== 'var_keyword') {
      const typeName = extractCSharpTypeName(typeNode);
      if (typeName) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'variable_declarator') {
            const nameNode = child.childForFieldName('name') || child.child(0);
            if (nameNode && nameNode.type === 'identifier') {
              if (ctx.typeMap) setTypeMapEntry(ctx.typeMap, nameNode.text, typeName, 0.9);
            }
          }
        }
      }
    }
  }

  // Method/constructor parameter: parameter node has type + name fields
  if (node.type === 'parameter') {
    const typeNode = node.childForFieldName('type');
    const nameNode = node.childForFieldName('name');
    if (typeNode && nameNode) {
      const typeName = extractCSharpTypeName(typeNode);
      if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, nameNode.text, typeName, 0.9);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractCSharpTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractCSharpTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'identifier' || t === 'qualified_name') return typeNode.text;
  if (t === 'predefined_type') return null; // skip int, string, etc
  if (t === 'generic_name') {
    const first = typeNode.child(0);
    return first ? first.text : null;
  }
  if (t === 'nullable_type') {
    const inner = typeNode.child(0);
    return inner ? extractCSharpTypeName(inner) : null;
  }
  return null;
}

/**
 * Post-walk pass: reclassify `extends` entries as `implements` when the target
 * is a known interface in the same file. At extraction time we cannot distinguish
 * base classes from interfaces in the base_list, so we fix it up here using the
 * definitions collected during the walk.
 */
function reclassifyCSharpImplements(ctx: ExtractorOutput): void {
  const interfaceNames = new Set<string>();
  for (const def of ctx.definitions) {
    if (def.kind === 'interface') interfaceNames.add(def.name);
  }
  for (const cls of ctx.classes) {
    if (cls.extends && interfaceNames.has(cls.extends)) {
      cls.implements = cls.extends;
      delete cls.extends;
    }
  }
}

function extractCSharpBaseTypes(
  node: TreeSitterNode,
  className: string,
  classes: ClassRelation[],
): void {
  // tree-sitter-c-sharp exposes base_list as a child node type, not a field
  const baseList = node.childForFieldName('bases') || findChild(node, 'base_list');
  if (!baseList) return;
  for (let i = 0; i < baseList.childCount; i++) {
    const child = baseList.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'qualified_name') {
      classes.push({ name: className, extends: child.text, line: node.startPosition.row + 1 });
    } else if (child.type === 'generic_name') {
      const name = child.childForFieldName('name') || child.child(0);
      if (name)
        classes.push({ name: className, extends: name.text, line: node.startPosition.row + 1 });
    }
  }
}
