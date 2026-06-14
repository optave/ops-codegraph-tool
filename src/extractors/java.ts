import type {
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
  TypeMapEntry,
} from '../types.js';
import {
  extractBodyMembers,
  extractModifierVisibility,
  extractSimpleParameters,
  findChild,
  findParentNode,
  lastPathSegment,
  nodeEndLine,
  nodeStartLine,
  pushCall,
  pushImport,
  setTypeMapEntry,
} from './helpers.js';

/**
 * Extract symbols from Java files.
 */
export function extractJavaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkJavaNode(tree.rootNode, ctx);
  return ctx;
}

function walkJavaNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_declaration':
      handleJavaClassDecl(node, ctx);
      break;
    case 'interface_declaration':
      handleJavaInterfaceDecl(node, ctx);
      break;
    case 'enum_declaration':
      handleJavaEnumDecl(node, ctx);
      break;
    case 'method_declaration':
      handleJavaMethodDecl(node, ctx);
      break;
    case 'constructor_declaration':
      handleJavaConstructorDecl(node, ctx);
      break;
    case 'import_declaration':
      handleJavaImportDecl(node, ctx);
      break;
    case 'method_invocation':
      handleJavaMethodInvocation(node, ctx);
      break;
    case 'object_creation_expression':
      handleJavaObjectCreation(node, ctx);
      break;
    case 'local_variable_declaration':
      handleJavaLocalVarDecl(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkJavaNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleJavaClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const classChildren = extractClassFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: classChildren.length > 0 ? classChildren : undefined,
  });

  extractJavaSuperclass(node, nameNode.text, ctx);

  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    extractJavaInterfaces(interfaces, nameNode.text, nodeStartLine(node), ctx);
  }
}

/** Extract the superclass (extends) relationship from a Java class declaration. */
function extractJavaSuperclass(
  node: TreeSitterNode,
  className: string,
  ctx: ExtractorOutput,
): void {
  const superclass = node.childForFieldName('superclass');
  if (!superclass) return;
  const superName = findJavaSuperTypeName(superclass);
  if (superName) {
    ctx.classes.push({ name: className, extends: superName, line: nodeStartLine(node) });
  }
}

/** Find the type name from a superclass node (handles generic_type unwrapping). */
function findJavaSuperTypeName(superclass: TreeSitterNode): string | undefined {
  for (let i = 0; i < superclass.childCount; i++) {
    const child = superclass.child(i);
    if (!child) continue;
    if (JAVA_TYPE_NODE_TYPES.has(child.type)) {
      return resolveJavaIfaceName(child);
    }
  }
  return undefined;
}

const JAVA_TYPE_NODE_TYPES = new Set(['type_identifier', 'identifier', 'generic_type']);

/** Resolve interface name from a type node (handles generic_type unwrapping). */
function resolveJavaIfaceName(node: TreeSitterNode): string | undefined {
  return node.type === 'generic_type' ? node.child(0)?.text : node.text;
}

/** Push a single interface type node as an implements entry. */
function pushJavaIface(
  node: TreeSitterNode,
  className: string,
  line: number,
  ctx: ExtractorOutput,
): void {
  if (!JAVA_TYPE_NODE_TYPES.has(node.type)) return;
  const ifaceName = resolveJavaIfaceName(node);
  if (ifaceName) ctx.classes.push({ name: className, implements: ifaceName, line });
}

function extractJavaInterfaces(
  interfaces: TreeSitterNode,
  className: string,
  line: number,
  ctx: ExtractorOutput,
): void {
  for (let i = 0; i < interfaces.childCount; i++) {
    const child = interfaces.child(i);
    if (!child) continue;

    if (child.type === 'type_list') {
      for (let j = 0; j < child.childCount; j++) {
        const t = child.child(j);
        if (t) pushJavaIface(t, className, line, ctx);
      }
    } else {
      pushJavaIface(child, className, line, ctx);
    }
  }
}

function handleJavaInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
  });
  const body = node.childForFieldName('body');
  if (body) extractJavaInterfaceMethods(body, nameNode.text, ctx);
}

/** Extract method declarations from a Java interface body. */
function extractJavaInterfaceMethods(
  body: TreeSitterNode,
  ifaceName: string,
  ctx: ExtractorOutput,
): void {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child && child.type === 'method_declaration') {
      const methName = child.childForFieldName('name');
      if (methName) {
        ctx.definitions.push({
          name: `${ifaceName}.${methName.text}`,
          kind: 'method',
          line: nodeStartLine(child),
          endLine: nodeEndLine(child),
        });
      }
    }
  }
}

function handleJavaEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const enumChildren = extractEnumConstants(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: enumChildren.length > 0 ? enumChildren : undefined,
  });
}

function handleJavaMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip interface methods already emitted by handleJavaInterfaceDecl
  if (node.parent?.parent?.type === 'interface_declaration') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findJavaParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const params = extractJavaParameters(node.childForFieldName('parameters'), ctx.typeMap);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleJavaConstructorDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findJavaParentClass(node);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
  const params = extractJavaParameters(node.childForFieldName('parameters'), ctx.typeMap);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: nodeStartLine(node),
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleJavaImportDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'scoped_identifier' || child.type === 'identifier')) {
      const fullPath = child.text;
      const lastName = lastPathSegment(fullPath, '.');
      pushImport(ctx, node, fullPath, [lastName], { javaImport: true });
    }
    if (child && child.type === 'asterisk') {
      const lastImport = ctx.imports[ctx.imports.length - 1];
      if (lastImport) lastImport.names = ['*'];
    }
  }
}

function handleJavaMethodInvocation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const obj = node.childForFieldName('object');
  pushCall(ctx, node, nameNode.text, obj ? { receiver: obj.text } : {});
}

function handleJavaLocalVarDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = resolveJavaTypeText(typeNode);
  if (!typeName) return;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === 'variable_declarator') {
      const nameNode = child.childForFieldName('name');
      // Use setTypeMapEntry (first-wins on tie) to match Rust extractor semantics.
      // The typeMap is flat per-file without method scoping, so a local variable
      // in one method (e.g. `InMemoryUserRepository repo` in `createDefault()`) must
      // not override a parameter binding set by an earlier method
      // (e.g. `UserRepository repo` constructor param). First-wins preserves the
      // interface/abstract type annotation that drives correct CHA dispatch.
      if (nameNode && ctx.typeMap) setTypeMapEntry(ctx.typeMap, nameNode.text, typeName, 0.9);
    }
  }
}

function handleJavaObjectCreation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = resolveJavaTypeText(typeNode);
  if (typeName) pushCall(ctx, node, typeName);
}

/**
 * Resolve a Java type node's text, unwrapping `generic_type` to its base name.
 * Used wherever we need the bare type identifier (local var decls, object
 * creation, parameter types).
 */
function resolveJavaTypeText(typeNode: TreeSitterNode): string | undefined {
  return typeNode.type === 'generic_type' ? typeNode.child(0)?.text : typeNode.text;
}

const JAVA_PARENT_TYPES = [
  'class_declaration',
  'enum_declaration',
  'interface_declaration',
] as const;
function findJavaParentClass(node: TreeSitterNode): string | null {
  return findParentNode(node, JAVA_PARENT_TYPES);
}

// ── Child extraction helpers ────────────────────────────────────────────────

const JAVA_PARAM_TYPES = ['formal_parameter', 'spread_parameter'] as const;

function extractJavaParameters(
  paramListNode: TreeSitterNode | null,
  typeMap?: Map<string, TypeMapEntry>,
): SubDeclaration[] {
  return extractSimpleParameters(paramListNode, {
    paramTypes: JAVA_PARAM_TYPES,
    typeMap,
    resolveType: resolveJavaTypeText,
  });
}

function extractClassFields(classNode: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'class_body');
  if (!body) return fields;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (member?.type !== 'field_declaration') continue;
    extractFieldDeclarators(member, fields);
  }
  return fields;
}

/** Extract variable_declarator names from a field_declaration node. */
function extractFieldDeclarators(member: TreeSitterNode, fields: SubDeclaration[]): void {
  const vis = extractModifierVisibility(member);
  for (let j = 0; j < member.childCount; j++) {
    const child = member.child(j);
    if (child?.type !== 'variable_declarator') continue;
    const nameNode = child.childForFieldName('name');
    if (nameNode) {
      fields.push({
        name: nameNode.text,
        kind: 'property',
        line: nodeStartLine(member),
        visibility: vis,
      });
    }
  }
}

function extractEnumConstants(enumNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(enumNode, ['body', 'enum_body'], 'enum_constant', 'constant');
}
