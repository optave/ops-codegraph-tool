import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Objective-C files.
 *
 * The tree-sitter-objc grammar extends C with @interface, @implementation,
 * @protocol, method declarations, #import, and message expressions.
 */
export function extractObjCSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkObjCNode(tree.rootNode, ctx);
  return ctx;
}

function walkObjCNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_interface':
      handleClassInterface(node, ctx);
      break;
    case 'class_implementation':
      handleClassImplementation(node, ctx);
      break;
    case 'protocol_declaration':
      handleProtocolDecl(node, ctx);
      break;
    case 'category_interface':
      handleCategoryInterface(node, ctx);
      break;
    case 'category_implementation':
      handleCategoryImplementation(node, ctx);
      break;
    case 'method_declaration':
    case 'method_definition':
      handleMethodDecl(node, ctx);
      break;
    case 'function_definition':
      handleFunctionDef(node, ctx);
      break;
    case 'preproc_include':
    case 'preproc_import':
      handleImport(node, ctx);
      break;
    case 'import_declaration':
      handleAtImport(node, ctx);
      break;
    case 'struct_specifier':
      handleStructSpecifier(node, ctx);
      break;
    case 'enum_specifier':
      handleEnumSpecifier(node, ctx);
      break;
    case 'type_definition':
      handleTypedef(node, ctx);
      break;
    case 'call_expression':
      handleCCallExpr(node, ctx);
      break;
    case 'message_expression':
      handleMessageExpr(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkObjCNode(child, ctx);
  }
}

// ── ObjC class/protocol handlers ──────────────────────────────────────────

function handleClassInterface(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;
  const name = nameNode.text;

  const members = collectClassMembers(node);
  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });

  // Superclass
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    ctx.classes.push({ name, extends: superclass.text, line: node.startPosition.row + 1 });
  }

  // Protocols
  const protocols = findChild(node, 'protocol_qualifiers');
  if (protocols) {
    for (let i = 0; i < protocols.childCount; i++) {
      const proto = protocols.child(i);
      if (proto && proto.type === 'identifier') {
        ctx.classes.push({ name, implements: proto.text, line: node.startPosition.row + 1 });
      }
    }
  }
}

function handleClassImplementation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleProtocolDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleCategoryInterface(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;
  const category = node.childForFieldName('category');
  const catName = category ? `${nameNode.text}(${category.text})` : nameNode.text;

  ctx.definitions.push({
    name: catName,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleCategoryImplementation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;
  const category = node.childForFieldName('category');
  const catName = category ? `${nameNode.text}(${category.text})` : nameNode.text;

  ctx.definitions.push({
    name: catName,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

// ── Method / function handlers ────────────────────────────────────────────

function handleMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const selector = buildSelector(node);
  if (!selector) return;

  const parentClass = findObjCParentClass(node);
  const fullName = parentClass ? `${parentClass}.${selector}` : selector;

  const params = extractMethodParams(node);
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handleFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;
  const funcDeclarator =
    declarator.type === 'function_declarator'
      ? declarator
      : findChild(declarator, 'function_declarator');
  if (!funcDeclarator) return;
  const nameNode = funcDeclarator.childForFieldName('declarator');
  if (!nameNode) return;

  const params = extractCParams(funcDeclarator.childForFieldName('parameters'));
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

// ── Import handlers ───────────────────────────────────────────────────────

function handleImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleAtImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // @import Foundation;
  const moduleNode = node.childForFieldName('module') || findChild(node, 'identifier');
  if (moduleNode) {
    ctx.imports.push({
      source: moduleNode.text,
      names: [moduleNode.text],
      line: node.startPosition.row + 1,
    });
  }
}

// ── C-compatible type handlers ────────────────────────────────────────────

function handleStructSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleEnumSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleTypedef(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

// ── Call handlers ─────────────────────────────────────────────────────────

function handleCCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleMessageExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // [receiver selector:arg ...]
  const receiver = node.childForFieldName('receiver');
  const selector = node.childForFieldName('selector');
  if (!selector) return;

  const call: Call = { name: selector.text, line: node.startPosition.row + 1 };
  if (receiver) call.receiver = receiver.text;
  ctx.calls.push(call);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildSelector(methodNode: TreeSitterNode): string | null {
  const selector = methodNode.childForFieldName('selector');
  if (selector) return selector.text;

  // Build selector from keyword children: initWith:name:
  const parts: string[] = [];
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i);
    if (!child) continue;
    if (child.type === 'keyword_selector') {
      for (let j = 0; j < child.childCount; j++) {
        const kw = child.child(j);
        if (kw && kw.type === 'keyword_declarator') {
          const kwName = kw.childForFieldName('keyword');
          if (kwName) parts.push(kwName.text);
        }
      }
    }
    if (child.type === 'identifier' && i === 1) {
      // Simple unary selector
      return child.text;
    }
  }
  return parts.length > 0 ? `${parts.join(':')}:` : null;
}

function findObjCParentClass(node: TreeSitterNode): string | null {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_interface' ||
      current.type === 'class_implementation' ||
      current.type === 'protocol_declaration' ||
      current.type === 'category_interface' ||
      current.type === 'category_implementation'
    ) {
      const nameNode = current.childForFieldName('name') || findObjCDeclName(current);
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Find the declaration name for ObjC constructs where the grammar does not
 * expose the class/protocol name as a named field.  The identifier appears
 * right after the `@interface` / `@implementation` / `@protocol` keyword.
 */
function findObjCDeclName(node: TreeSitterNode): TreeSitterNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') return child;
  }
  return null;
}

function collectClassMembers(classNode: TreeSitterNode): SubDeclaration[] {
  const members: SubDeclaration[] = [];
  for (let i = 0; i < classNode.childCount; i++) {
    const child = classNode.child(i);
    if (!child) continue;
    if (child.type === 'method_declaration' || child.type === 'method_definition') {
      const sel = buildSelector(child);
      if (sel) {
        members.push({ name: sel, kind: 'method', line: child.startPosition.row + 1 });
      }
    }
    if (child.type === 'property_declaration') {
      const propName = child.childForFieldName('name');
      if (propName) {
        members.push({ name: propName.text, kind: 'property', line: child.startPosition.row + 1 });
      }
    }
  }
  return members;
}

function extractMethodParams(methodNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i);
    if (!child || child.type !== 'keyword_selector') continue;
    for (let j = 0; j < child.childCount; j++) {
      const kw = child.child(j);
      if (kw && kw.type === 'keyword_declarator') {
        const nameNode = kw.childForFieldName('name');
        if (nameNode) {
          params.push({
            name: nameNode.text,
            kind: 'parameter',
            line: nameNode.startPosition.row + 1,
          });
        }
      }
    }
  }
  return params;
}

function extractCParams(paramListNode: TreeSitterNode | null): SubDeclaration[] {
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
