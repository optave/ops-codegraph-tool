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
    // tree-sitter-objc v3 emits `module_import` for `@import Foundation;`
    // statements. Older grammar revisions used `import_declaration`, so we
    // accept both for forward/backward compatibility and keep behaviour
    // aligned with `handle_at_import` on the Rust side.
    case 'module_import':
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
  // Categories declared as `@interface Foo (Cat)` arrive as `class_interface`
  // with a `category` field (rather than the `category_interface` node type).
  // Qualify the display name with `(Cat)` so symbols stay grouped per category
  // and match the Rust extractor.
  const category = node.childForFieldName('category');
  const displayName = category ? `${name}(${category.text})` : name;

  const members = collectClassMembers(node);
  ctx.definitions.push({
    name: displayName,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: members.length > 0 ? members : undefined,
  });

  // Superclass — keyed on the bare class name (categories don't have a superclass).
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    ctx.classes.push({ name, extends: superclass.text, line: node.startPosition.row + 1 });
  }

  // Adopted protocols. tree-sitter-objc v3 wraps the adopted-protocol list in
  // `parameterized_arguments` (not `protocol_qualifiers`, which was the v2
  // grammar shape). Each child is wrapped in `type_name > type_identifier`;
  // fall back to a bare `identifier`/`type_identifier` for older grammars.
  const protocols = findChild(node, 'parameterized_arguments');
  if (protocols) {
    for (let i = 0; i < protocols.childCount; i++) {
      const proto = protocols.child(i);
      if (!proto) continue;
      let protoName: string | null = null;
      if (proto.type === 'type_name') {
        const inner = findChild(proto, 'type_identifier') || findChild(proto, 'identifier');
        if (inner) protoName = inner.text;
      } else if (proto.type === 'identifier' || proto.type === 'type_identifier') {
        protoName = proto.text;
      }
      if (protoName) {
        ctx.classes.push({ name, implements: protoName, line: node.startPosition.row + 1 });
      }
    }
  }
}

function handleClassImplementation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findObjCDeclName(node);
  if (!nameNode) return;
  // Categories declared as `@implementation Foo (Cat)` arrive as
  // `class_implementation` with a `category` field. Mirror the Rust extractor
  // and qualify the display name with `(Cat)`.
  const category = node.childForFieldName('category');
  const displayName = category ? `${nameNode.text}(${category.text})` : nameNode.text;

  ctx.definitions.push({
    name: displayName,
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
  // tree-sitter-objc does not expose a `function` field on `call_expression`,
  // so the named-field lookup almost always misses. Fall back to the first
  // `identifier` / `field_expression` child to mirror `handle_c_call_expr` in
  // `crates/codegraph-core/src/extractors/objc.rs` and keep engine parity.
  let funcNode = node.childForFieldName('function');
  if (!funcNode) {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child && (child.type === 'identifier' || child.type === 'field_expression')) {
        funcNode = child;
        break;
      }
    }
  }
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

  // tree-sitter-objc v3 does not expose a `selector` field on
  // `message_expression`; instead every keyword identifier has the `method`
  // field. Assemble the selector by joining `method` children with `:`,
  // appending a trailing `:` when the message has at least one colon
  // (keyword form). Mirrors `build_message_selector` in
  // `crates/codegraph-core/src/extractors/objc.rs`.
  const parts: string[] = [];
  let hasColon = false;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const fieldName = node.fieldNameForChild(i);
    if (fieldName === 'method') parts.push(child.text);
    if (child.type === ':') hasColon = true;
  }
  let name: string;
  if (parts.length > 0) {
    name = hasColon ? `${parts.join(':')}:` : parts.join(':');
  } else {
    // Fallback: some grammar revisions expose a `selector` field.
    const selector = node.childForFieldName('selector');
    if (!selector) return;
    name = selector.text;
  }

  const call: Call = { name, line: node.startPosition.row + 1 };
  if (receiver) call.receiver = receiver.text;
  ctx.calls.push(call);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function buildSelector(methodNode: TreeSitterNode): string | null {
  // tree-sitter-objc v3 does not expose a `selector` field; the selector is
  // assembled from the leading `identifier` keywords. Multi-keyword forms
  // look like `setName:(...)x age:(...)y` and appear as flat
  // `identifier` + `method_parameter` children directly under the method
  // node (not wrapped in `keyword_selector`). Mirrors `build_selector` in
  // `crates/codegraph-core/src/extractors/objc.rs`.
  const parts: string[] = [];
  let hasParams = false;
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      parts.push(child.text);
    } else if (child.type === 'method_parameter') {
      hasParams = true;
    }
  }
  if (parts.length === 0) return null;
  return hasParams ? `${parts.join(':')}:` : parts.join(':');
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
      if (!nameNode) return null;
      // Categories: include `(Cat)` so methods are grouped per category.
      // Two categories on the same class can declare same-named methods, so
      // qualifying the parent name keeps the symbols disambiguated. Mirrors
      // `find_objc_parent_class` in `crates/codegraph-core/src/extractors/objc.rs`.
      const category = current.childForFieldName('category');
      if (category) return `${nameNode.text}(${category.text})`;
      return nameNode.text;
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
      const propName = extractPropertyName(child);
      if (propName) {
        members.push({ name: propName, kind: 'property', line: child.startPosition.row + 1 });
      }
    }
  }
  return members;
}

/**
 * Extract the property name from `@property (...) Type *foo;`. The v3 grammar
 * does not expose `name` as a named field on `property_declaration`; instead
 * the identifier nests under `struct_declaration > struct_declarator >
 * [pointer_declarator >] identifier`. Mirrors `extract_property_name` in
 * `crates/codegraph-core/src/extractors/objc.rs`.
 */
function extractPropertyName(propNode: TreeSitterNode): string | null {
  const structDecl = findChild(propNode, 'struct_declaration');
  if (!structDecl) return null;
  for (let i = 0; i < structDecl.childCount; i++) {
    const child = structDecl.child(i);
    if (!child || child.type !== 'struct_declarator') continue;
    const id = findIdentifierDeep(child);
    if (id) return id.text;
  }
  return null;
}

function findIdentifierDeep(node: TreeSitterNode): TreeSitterNode | null {
  if (node.type === 'identifier') return node;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const found = findIdentifierDeep(child);
    if (found) return found;
  }
  return null;
}

function extractMethodParams(methodNode: TreeSitterNode): SubDeclaration[] {
  // The v3 grammar emits flat `method_parameter` children under the method
  // node; the parameter name is the last `identifier` inside each
  // `method_parameter`. Mirrors `extract_method_params` in
  // `crates/codegraph-core/src/extractors/objc.rs`.
  const params: SubDeclaration[] = [];
  for (let i = 0; i < methodNode.childCount; i++) {
    const child = methodNode.child(i);
    if (!child || child.type !== 'method_parameter') continue;
    let nameNode: TreeSitterNode | null = null;
    for (let j = 0; j < child.childCount; j++) {
      const inner = child.child(j);
      if (inner && inner.type === 'identifier') nameNode = inner;
    }
    if (nameNode) {
      params.push({
        name: nameNode.text,
        kind: 'parameter',
        line: nameNode.startPosition.row + 1,
      });
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
