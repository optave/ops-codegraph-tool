import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractModifierVisibility,
  findChild,
  findParentNode,
  lastPathSegment,
  nodeEndLine,
} from './helpers.js';

/**
 * Extract symbols from Groovy files.
 *
 * Groovy is a JVM language with Java-like class/interface/enum structures
 * plus closures, traits, and dynamic typing. The tree-sitter-groovy grammar
 * models classes, methods, imports, and call expressions similarly to Java.
 */
export function extractGroovySymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkGroovyNode(tree.rootNode, ctx);
  return ctx;
}

function walkGroovyNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_definition':
    case 'class_declaration':
      handleGroovyClassDecl(node, ctx);
      break;
    case 'interface_definition':
    case 'interface_declaration':
      handleGroovyInterfaceDecl(node, ctx);
      break;
    case 'enum_definition':
    case 'enum_declaration':
      handleGroovyEnumDecl(node, ctx);
      break;
    case 'method_definition':
    case 'method_declaration':
      handleGroovyMethodDecl(node, ctx);
      break;
    case 'constructor_definition':
    case 'constructor_declaration':
      handleGroovyConstructorDecl(node, ctx);
      break;
    case 'function_definition':
    case 'function_declaration':
      handleGroovyFunctionDecl(node, ctx);
      break;
    case 'import_statement':
    case 'import_declaration':
      handleGroovyImport(node, ctx);
      break;
    case 'method_call':
    case 'method_invocation':
    case 'call_expression':
    case 'function_call':
      handleGroovyCallExpr(node, ctx);
      break;
    case 'object_creation_expression':
      handleGroovyObjectCreation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkGroovyNode(child, ctx);
  }
}

// ── Handlers ───────────────────────────────────────────────────────────────

const GROOVY_PARENT_TYPES = [
  'class_definition',
  'class_declaration',
  'enum_definition',
  'enum_declaration',
  'interface_definition',
  'interface_declaration',
] as const;

function handleGroovyClassDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  const members = extractGroovyClassMembers(node);
  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
    visibility: extractModifierVisibility(node),
  });

  // Superclass
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    const superName =
      superclass.type === 'generic_type' ? superclass.child(0)?.text : superclass.text;
    if (superName) {
      ctx.classes.push({ name, extends: superName, line: node.startPosition.row + 1 });
    }
  }

  // Interfaces
  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    for (let i = 0; i < interfaces.childCount; i++) {
      const iface = interfaces.child(i);
      if (
        iface &&
        (iface.type === 'type_identifier' ||
          iface.type === 'identifier' ||
          iface.type === 'generic_type')
      ) {
        const ifaceName = iface.type === 'generic_type' ? iface.child(0)?.text : iface.text;
        if (ifaceName) {
          ctx.classes.push({ name, implements: ifaceName, line: node.startPosition.row + 1 });
        }
      }
    }
  }
}

function handleGroovyInterfaceDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: extractModifierVisibility(node),
  });
}

function handleGroovyEnumDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const members: SubDeclaration[] = [];
  const body = node.childForFieldName('body') || findChild(node, 'enum_body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;
      if (child.type === 'enum_constant' || child.type === 'identifier') {
        const constName = child.childForFieldName('name') || child;
        members.push({ name: constName.text, kind: 'constant', line: child.startPosition.row + 1 });
      }
    }
  }

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });
}

function handleGroovyMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findParentNode(node, GROOVY_PARENT_TYPES);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;

  const params = extractGroovyParams(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleGroovyConstructorDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const parentClass = findParentNode(node, GROOVY_PARENT_TYPES);
  const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;

  const params = extractGroovyParams(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: extractModifierVisibility(node),
  });
}

function handleGroovyFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const params = extractGroovyParams(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handleGroovyImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // import foo.bar.Baz or import foo.bar.*
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'dotted_identifier' ||
      child.type === 'scoped_identifier' ||
      child.type === 'identifier' ||
      child.type === 'qualified_name'
    ) {
      const fullPath = child.text;
      const lastName = lastPathSegment(fullPath, '.');
      ctx.imports.push({
        source: fullPath,
        names: [lastName],
        line: node.startPosition.row + 1,
        javaImport: true,
      });
      return;
    }
  }
}

function handleGroovyCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const call: Call = { name: '', line: node.startPosition.row + 1 };

  // Try standard call_expression pattern
  const funcNode = node.childForFieldName('function') || node.childForFieldName('method');
  if (funcNode) {
    if (funcNode.type === 'field_expression' || funcNode.type === 'member_access') {
      const field = funcNode.childForFieldName('field') || funcNode.childForFieldName('property');
      const obj = funcNode.childForFieldName('argument') || funcNode.childForFieldName('object');
      if (field) call.name = field.text;
      if (obj) call.receiver = obj.text;
    } else {
      call.name = funcNode.text;
    }
  } else {
    // method_call: first child is receiver/name
    const nameNode = node.childForFieldName('name');
    const obj = node.childForFieldName('object');
    if (nameNode) {
      call.name = nameNode.text;
      if (obj) call.receiver = obj.text;
    }
  }

  if (call.name) ctx.calls.push(call);
}

function handleGroovyObjectCreation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = typeNode.type === 'generic_type' ? typeNode.child(0)?.text : typeNode.text;
  if (typeName) ctx.calls.push({ name: typeName, line: node.startPosition.row + 1 });
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractGroovyParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList =
    funcNode.childForFieldName('parameters') || findChild(funcNode, 'formal_parameters');
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param) continue;
    if (param.type === 'formal_parameter' || param.type === 'parameter') {
      const nameNode = param.childForFieldName('name');
      if (nameNode) {
        params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractGroovyClassMembers(classNode: TreeSitterNode): SubDeclaration[] {
  const members: SubDeclaration[] = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'class_body');
  if (!body) return members;

  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (!child) continue;
    if (child.type === 'field_declaration') {
      for (let j = 0; j < child.childCount; j++) {
        const varDecl = child.child(j);
        if (varDecl?.type === 'variable_declarator') {
          const nameNode = varDecl.childForFieldName('name');
          if (nameNode) {
            members.push({
              name: nameNode.text,
              kind: 'property',
              line: child.startPosition.row + 1,
              visibility: extractModifierVisibility(child),
            });
          }
        }
      }
    }
  }
  return members;
}
