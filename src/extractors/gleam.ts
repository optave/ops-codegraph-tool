import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine, stripQuotes } from './helpers.js';

/**
 * Extract symbols from Gleam files.
 *
 * Gleam tree-sitter grammar (gleam-lang/tree-sitter-gleam) notes:
 * - Functions: function with name, parameters, body fields
 * - Types: type_definition with name, constructors
 * - Type aliases: type_alias
 * - Imports: import with module, unqualified_imports
 * - External functions: external_function
 * - Constants: constant
 */
export function extractGleamSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkGleamNode(tree.rootNode, ctx);
  return ctx;
}

function walkGleamNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function':
      handleFunction(node, ctx);
      break;
    case 'type_definition':
      handleTypeDef(node, ctx);
      break;
    case 'type_alias':
      handleTypeAlias(node, ctx);
      break;
    case 'import':
      handleImport(node, ctx);
      break;
    case 'external_function':
      handleExternalFunction(node, ctx);
      break;
    case 'constant':
      handleConstant(node, ctx);
      break;
    case 'function_call':
    case 'call':
      handleCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkGleamNode(child, ctx);
  }
}

function handleFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  const visibility = isPublic(node) ? 'public' : 'private';
  const params = extractParams(node);

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility,
    children: params.length > 0 ? params : undefined,
  });
}

function handleExternalFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: isPublic(node) ? 'public' : 'private',
  });
}

function handleTypeDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'type_name');
  if (!nameNode) return;

  const children: SubDeclaration[] = [];
  // Extract constructors
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'data_constructor' || child.type === 'type_constructor') {
      const ctorName = child.childForFieldName('name') || findChild(child, 'constructor_name');
      if (ctorName) {
        children.push({ name: ctorName.text, kind: 'property', line: child.startPosition.row + 1 });
      }
    }
    // Recurse into constructors block
    if (child.type === 'data_constructors' || child.type === 'type_constructors') {
      for (let j = 0; j < child.childCount; j++) {
        const ctor = child.child(j);
        if (!ctor) continue;
        if (ctor.type === 'data_constructor' || ctor.type === 'type_constructor') {
          const ctorName = ctor.childForFieldName('name') || findChild(ctor, 'constructor_name');
          if (ctorName) {
            children.push({
              name: ctorName.text,
              kind: 'property',
              line: ctor.startPosition.row + 1,
            });
          }
        }
      }
    }
  }

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: isPublic(node) ? 'public' : 'private',
    children: children.length > 0 ? children : undefined,
  });
}

function handleTypeAlias(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'type_name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: isPublic(node) ? 'public' : 'private',
  });
}

function handleConstant(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility: isPublic(node) ? 'public' : 'private',
  });
}

function handleImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const moduleNode =
    node.childForFieldName('module') || findChild(node, 'module') || findChild(node, 'string');
  if (!moduleNode) return;

  const source = stripQuotes(moduleNode.text);
  const names: string[] = [];

  // Check for unqualified imports
  const unqualified = findChild(node, 'unqualified_imports');
  if (unqualified) {
    for (let i = 0; i < unqualified.childCount; i++) {
      const item = unqualified.child(i);
      if (item && (item.type === 'unqualified_import' || item.type === 'identifier')) {
        const nameNode = item.childForFieldName('name') || item;
        if (nameNode.type !== ',') names.push(nameNode.text);
      }
    }
  }

  // Check for alias (as)
  const alias = node.childForFieldName('alias') || findChild(node, 'identifier');
  if (alias && alias !== moduleNode) {
    names.push(alias.text);
  }

  ctx.imports.push({
    source,
    names: names.length > 0 ? names : [source.split('/').pop() || source],
    line: node.startPosition.row + 1,
  });
}

function handleCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function') || node.child(0);
  if (!funcNode) return;

  if (funcNode.type === 'identifier' || funcNode.type === 'variable') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'field_access' || funcNode.type === 'module_select') {
    const field = funcNode.childForFieldName('field') || funcNode.childForFieldName('label');
    const record = funcNode.child(0);
    if (field) {
      const call: Call = { name: field.text, line: node.startPosition.row + 1 };
      if (record && record !== field) call.receiver = record.text;
      ctx.calls.push(call);
    }
  }
}

function extractParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode =
    funcNode.childForFieldName('parameters') || findChild(funcNode, 'function_parameters');
  if (!paramsNode) return params;

  for (let i = 0; i < paramsNode.childCount; i++) {
    const param = paramsNode.child(i);
    if (!param) continue;
    if (param.type === 'function_parameter' || param.type === 'parameter') {
      const nameNode = param.childForFieldName('name') || findChild(param, 'identifier');
      if (nameNode) {
        params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
    if (param.type === 'identifier') {
      params.push({ name: param.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function isPublic(node: TreeSitterNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'visibility_modifier' || child.text === 'pub') return true;
  }
  return false;
}
