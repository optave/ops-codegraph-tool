import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  extractBodyMembers,
  findParentNode,
  MAX_WALK_DEPTH,
  nodeEndLine,
  rustVisibility,
  setTypeMapEntry,
} from './helpers.js';

/**
 * Extract symbols from Rust files.
 */
export function extractRustSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkRustNode(tree.rootNode, ctx);
  extractRustTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkRustNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_item':
      handleRustFuncItem(node, ctx);
      break;
    case 'struct_item':
      handleRustStructItem(node, ctx);
      break;
    case 'enum_item':
      handleRustEnumItem(node, ctx);
      break;
    case 'const_item':
      handleRustConstItem(node, ctx);
      break;
    case 'trait_item':
      handleRustTraitItem(node, ctx);
      break;
    case 'impl_item':
      handleRustImplItem(node, ctx);
      break;
    case 'use_declaration':
      handleRustUseDecl(node, ctx);
      break;
    case 'call_expression':
      handleRustCallExpr(node, ctx);
      break;
    case 'macro_invocation':
      handleRustMacroInvocation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkRustNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleRustFuncItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip default-impl functions already emitted by handleRustTraitItem
  if (node.parent?.parent?.type === 'trait_item') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const implType = findCurrentImpl(node);
  const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
  const kind = implType ? 'method' : 'function';
  const params = extractRustParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: rustVisibility(node),
  });
}

function handleRustStructItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const fields = extractStructFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: fields.length > 0 ? fields : undefined,
    visibility: rustVisibility(node),
  });
}

function handleRustEnumItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const variants = extractEnumVariants(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: variants.length > 0 ? variants : undefined,
  });
}

function handleRustConstItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'constant',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleRustTraitItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'trait',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  const body = node.childForFieldName('body');
  if (body) extractTraitMethods(body, nameNode.text, ctx);
}

/** Extract method signatures/definitions from a trait body. */
function extractTraitMethods(body: TreeSitterNode, traitName: string, ctx: ExtractorOutput): void {
  for (let i = 0; i < body.childCount; i++) {
    const child = body.child(i);
    if (child && (child.type === 'function_signature_item' || child.type === 'function_item')) {
      const methName = child.childForFieldName('name');
      if (methName) {
        ctx.definitions.push({
          name: `${traitName}.${methName.text}`,
          kind: 'method',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
    }
  }
}

function handleRustImplItem(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  if (typeNode && traitNode) {
    ctx.classes.push({
      name: typeNode.text,
      implements: traitNode.text,
      line: node.startPosition.row + 1,
    });
  }
}

function handleRustUseDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const argNode = node.child(1);
  if (!argNode) return;
  const usePaths = extractRustUsePath(argNode);
  for (const imp of usePaths) {
    ctx.imports.push({
      source: imp.source,
      names: imp.names,
      line: node.startPosition.row + 1,
      rustUse: true,
    });
  }
}

function handleRustCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  const call = extractRustCallInfo(fn, node.startPosition.row + 1);
  if (call) ctx.calls.push(call);
}

/** Extract call info from a Rust call function node. */
function extractRustCallInfo(fn: TreeSitterNode, line: number): Call | null {
  if (fn.type === 'identifier') return { name: fn.text, line };
  if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    if (!field) return null;
    const value = fn.childForFieldName('value');
    const call: Call = { name: field.text, line };
    if (value) call.receiver = value.text;
    return call;
  }
  if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    if (!name) return null;
    const path = fn.childForFieldName('path');
    const call: Call = { name: name.text, line };
    if (path) call.receiver = path.text;
    return call;
  }
  return null;
}

function handleRustMacroInvocation(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const macroNode = node.child(0);
  if (macroNode) {
    ctx.calls.push({ name: `${macroNode.text}!`, line: node.startPosition.row + 1 });
  }
}

const RUST_IMPL_TYPES = ['impl_item'] as const;
function findCurrentImpl(node: TreeSitterNode): string | null {
  return findParentNode(node, RUST_IMPL_TYPES, 'type');
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractRustParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param) continue;
    if (param.type === 'self_parameter') {
      // Skip self — matches native engine behaviour
    } else if (param.type === 'parameter') {
      const pattern = param.childForFieldName('pattern');
      if (pattern) {
        params.push({ name: pattern.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractStructFields(structNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(
    structNode,
    ['body', 'field_declaration_list'],
    'field_declaration',
    'property',
  );
}

function extractEnumVariants(enumNode: TreeSitterNode): SubDeclaration[] {
  return extractBodyMembers(enumNode, ['body', 'enum_variant_list'], 'enum_variant', 'constant');
}

function extractRustTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractRustTypeMapDepth(node, ctx, 0);
}

function extractRustTypeMapDepth(node: TreeSitterNode, ctx: ExtractorOutput, depth: number): void {
  if (depth >= MAX_WALK_DEPTH) return;

  // let x: MyType = ...
  if (node.type === 'let_declaration') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && pattern.type === 'identifier' && typeNode) {
      const typeName = extractRustTypeName(typeNode);
      if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, pattern.text, typeName, 0.9);
    }
  }

  // fn foo(x: MyType) — parameter node has pattern + type fields
  if (node.type === 'parameter') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && typeNode) {
      const name = pattern.type === 'identifier' ? pattern.text : null;
      if (name && name !== 'self' && name !== '&self' && name !== '&mut self') {
        const typeName = extractRustTypeName(typeNode);
        if (typeName && ctx.typeMap) setTypeMapEntry(ctx.typeMap, name, typeName, 0.9);
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractRustTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractRustTypeName(typeNode: TreeSitterNode): string | null {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'type_identifier' || t === 'identifier') return typeNode.text;
  if (t === 'scoped_type_identifier') return typeNode.text;
  // Reference: &MyType or &mut MyType → MyType
  if (t === 'reference_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child && (child.type === 'type_identifier' || child.type === 'scoped_type_identifier')) {
        return child.text;
      }
    }
  }
  // Generic: Vec<T> → Vec
  if (t === 'generic_type') {
    const first = typeNode.child(0);
    return first ? first.text : null;
  }
  return null;
}

/** Collect names from a scoped_use_list's list node. */
function collectScopedNames(listNode: TreeSitterNode): string[] {
  const names: string[] = [];
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'self') {
      names.push(child.text);
    } else if (child.type === 'use_as_clause') {
      const name = (child.childForFieldName('alias') || child.childForFieldName('name'))?.text;
      if (name) names.push(name);
    }
  }
  return names;
}

function extractRustUsePath(node: TreeSitterNode | null): { source: string; names: string[] }[] {
  if (!node) return [];

  switch (node.type) {
    case 'use_list': {
      const results: { source: string; names: string[] }[] = [];
      for (let i = 0; i < node.childCount; i++) {
        results.push(...extractRustUsePath(node.child(i)));
      }
      return results;
    }
    case 'scoped_use_list': {
      const pathNode = node.childForFieldName('path');
      const listNode = node.childForFieldName('list');
      const prefix = pathNode ? pathNode.text : '';
      if (!listNode) return [{ source: prefix, names: [] }];
      return [{ source: prefix, names: collectScopedNames(listNode) }];
    }
    case 'use_as_clause': {
      const name = node.childForFieldName('alias') || node.childForFieldName('name');
      return [{ source: node.text, names: name ? [name.text] : [] }];
    }
    case 'use_wildcard': {
      const pathNode = node.childForFieldName('path');
      return [{ source: pathNode ? pathNode.text : '*', names: ['*'] }];
    }
    case 'scoped_identifier':
    case 'identifier': {
      const text = node.text;
      const lastName = text.split('::').pop() ?? text;
      return [{ source: text, names: [lastName] }];
    }
    default:
      return [];
  }
}
