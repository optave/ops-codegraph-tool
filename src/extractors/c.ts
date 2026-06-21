import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from C files.
 */
export function extractCSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkCNode(tree.rootNode, ctx);
  return ctx;
}

function walkCNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handleCFunctionDef(node, ctx);
      break;
    case 'struct_specifier':
      handleCStructSpecifier(node, ctx);
      break;
    case 'enum_specifier':
      handleCEnumSpecifier(node, ctx);
      break;
    case 'type_definition':
      handleCTypedef(node, ctx);
      break;
    case 'preproc_include':
      handleCInclude(node, ctx);
      break;
    case 'call_expression':
      handleCCallExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkCNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleCFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // declarator > function_declarator > declarator(identifier)
  const declarator = node.childForFieldName('declarator');
  if (!declarator) return;
  const funcDeclarator =
    declarator.type === 'function_declarator'
      ? declarator
      : findChild(declarator, 'function_declarator');
  if (!funcDeclarator) return;
  const nameNode = funcDeclarator.childForFieldName('declarator');
  if (!nameNode) return;
  const name = nameNode.type === 'identifier' ? nameNode.text : nameNode.text;

  const params = extractCParameters(funcDeclarator.childForFieldName('parameters'));
  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function handleCStructSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractStructFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleCEnumSpecifier(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const children = extractEnumEntries(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleCTypedef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // The typedef name is the last type_identifier, identifier, or primitive_type child
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

function handleCInclude(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return;
  // Strip quotes or angle brackets
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

/** Get the Nth non-punctuation argument from a C call_expression. */
function getCArg(node: TreeSitterNode, index: number): TreeSitterNode | null {
  const args = node.childForFieldName('arguments');
  if (!args) return null;
  let count = 0;
  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;
    const t = child.type;
    if (t === '(' || t === ')' || t === ',' || t === 'comment') continue;
    if (count === index) return child;
    count++;
  }
  return null;
}

function handleCCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

  // (*fp)(args) — function pointer call through dereference; unresolvable statically
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
    const nameArg = getCArg(node, 1); // second arg is the symbol name
    if (nameArg && (nameArg.type === 'string_literal' || nameArg.type === 'string_content')) {
      const sym = nameArg.text.replace(/['"]/g, '');
      if (sym) {
        ctx.calls.push({
          name: sym,
          line: callLine,
          dynamic: true,
          dynamicKind: 'reflection',
          keyExpr: nameArg.text,
        });
        return;
      }
    }
    ctx.calls.push({
      name: '<dynamic:unresolved>',
      line: callLine,
      dynamic: true,
      dynamicKind: 'unresolved-dynamic',
    });
    return;
  }

  if (fnName) {
    ctx.calls.push({ name: fnName, line: callLine });
  }
}

// ── Child extraction helpers ────────────────────────────────────────────────

const C_DECLARATOR_WRAPPERS = new Set([
  'pointer_declarator',
  'array_declarator',
  'parenthesized_declarator',
  'function_declarator',
]);

/**
 * Drill through pointer/array/parenthesized/function declarator wrappers to
 * recover the bare identifier. Mirrors `unwrap_declarator` in the native C
 * extractor so both engines agree on the name for parameters such as
 * `void process(int callback(int))` (function-type parameter → `callback`) or
 * `int *func(int)` (pointer-returning function → `func`).
 */
function unwrapCDeclaratorName(node: TreeSitterNode): string {
  let current: TreeSitterNode | null = node;
  while (current && C_DECLARATOR_WRAPPERS.has(current.type)) {
    current = current.childForFieldName('declarator');
  }
  if (current?.type === 'identifier' || current?.type === 'field_identifier') {
    return current.text;
  }
  return current?.text ?? node.text;
}

function extractCParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (param?.type !== 'parameter_declaration') continue;
    const nameNode = param.childForFieldName('declarator');
    if (nameNode) {
      const name = unwrapCDeclaratorName(nameNode);
      params.push({ name, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function extractStructFields(structNode: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
  const body = findChild(structNode, 'field_declaration_list');
  if (!body) return fields;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (member?.type !== 'field_declaration') continue;
    const nameNode = member.childForFieldName('declarator');
    if (nameNode) {
      const name = unwrapCDeclaratorName(nameNode);
      fields.push({ name, kind: 'property', line: member.startPosition.row + 1 });
    }
  }
  return fields;
}

function extractEnumEntries(enumNode: TreeSitterNode): SubDeclaration[] {
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
