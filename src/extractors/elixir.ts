import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Elixir files.
 *
 * Elixir's tree-sitter grammar represents most constructs as generic `call` nodes.
 * We distinguish modules, functions, imports etc. by the call target's identifier text.
 */
export function extractElixirSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkElixirNode(tree.rootNode, ctx, null);
  return ctx;
}

function walkElixirNode(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  if (node.type === 'call') {
    handleElixirCall(node, ctx, currentModule);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkElixirNode(child, ctx, currentModule);
  }
}

function handleElixirCall(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  const target = node.childForFieldName('target');
  if (!target) return;

  if (target.type === 'identifier') {
    const keyword = target.text;
    switch (keyword) {
      case 'defmodule':
        handleDefmodule(node, ctx);
        return;
      case 'def':
      case 'defp':
        handleDefFunction(node, ctx, currentModule, keyword === 'defp' ? 'private' : 'public');
        return;
      case 'defprotocol':
        handleDefprotocol(node, ctx);
        return;
      case 'defimpl':
        handleDefimpl(node, ctx);
        return;
      case 'import':
      case 'use':
      case 'require':
      case 'alias':
        handleElixirImport(node, ctx, keyword);
        return;
      default:
        // Regular function call
        ctx.calls.push({ name: keyword, line: node.startPosition.row + 1 });
        return;
    }
  }

  if (target.type === 'dot') {
    handleDotCall(node, target, ctx);
  }
}

function handleDefmodule(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const args = findChild(node, 'arguments');
  if (!args) return;
  const aliasNode = findChild(args, 'alias');
  if (!aliasNode) return;
  const name = aliasNode.text;

  const children: SubDeclaration[] = [];
  const doBlock = findChild(node, 'do_block');
  if (doBlock) {
    collectModuleMembers(doBlock, ctx, name, children);
  }

  ctx.definitions.push({
    name,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function collectModuleMembers(
  doBlock: TreeSitterNode,
  ctx: ExtractorOutput,
  moduleName: string,
  children: SubDeclaration[],
): void {
  for (let i = 0; i < doBlock.childCount; i++) {
    const child = doBlock.child(i);
    if (!child || child.type !== 'call') continue;
    const target = child.childForFieldName('target');
    if (!target || target.type !== 'identifier') continue;

    if (target.text === 'def' || target.text === 'defp') {
      const fnName = extractFunctionName(child);
      if (fnName) {
        children.push({
          name: fnName,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
  }
}

function handleDefFunction(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
  visibility: 'public' | 'private',
): void {
  const fnName = extractFunctionName(node);
  if (!fnName) return;

  const fullName = currentModule ? `${currentModule}.${fnName}` : fnName;
  const params = extractElixirParams(node);

  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility,
    children: params.length > 0 ? params : undefined,
  });
}

function extractFunctionName(defCallNode: TreeSitterNode): string | null {
  const args = findChild(defCallNode, 'arguments');
  if (!args) return null;

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child) continue;
    if (child.type === 'call') {
      const target = child.childForFieldName('target');
      if (target?.type === 'identifier') return target.text;
    }
    if (child.type === 'identifier') return child.text;
  }
  return null;
}

function extractElixirParams(defCallNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const args = findChild(defCallNode, 'arguments');
  if (!args) return params;

  for (let i = 0; i < args.childCount; i++) {
    const child = args.child(i);
    if (!child || child.type !== 'call') continue;
    const innerArgs = findChild(child, 'arguments');
    if (!innerArgs) continue;
    for (let j = 0; j < innerArgs.childCount; j++) {
      const param = innerArgs.child(j);
      if (!param) continue;
      if (param.type === 'identifier') {
        params.push({ name: param.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function handleDefprotocol(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const args = findChild(node, 'arguments');
  if (!args) return;
  const aliasNode = findChild(args, 'alias');
  if (!aliasNode) return;

  ctx.definitions.push({
    name: aliasNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDefimpl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const args = findChild(node, 'arguments');
  if (!args) return;
  const aliasNode = findChild(args, 'alias');
  if (!aliasNode) return;

  ctx.definitions.push({
    name: aliasNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleElixirImport(node: TreeSitterNode, ctx: ExtractorOutput, keyword: string): void {
  const args = findChild(node, 'arguments');
  if (!args) return;
  const aliasNode = findChild(args, 'alias');
  if (!aliasNode) return;

  ctx.imports.push({
    source: aliasNode.text,
    names: [keyword],
    line: node.startPosition.row + 1,
  });
}

function handleDotCall(node: TreeSitterNode, dotNode: TreeSitterNode, ctx: ExtractorOutput): void {
  const call: Call = { name: '', line: node.startPosition.row + 1 };
  const right = findChild(dotNode, 'identifier');
  const left = findChild(dotNode, 'alias');

  if (right) call.name = right.text;
  if (left) call.receiver = left.text;

  if (call.name) ctx.calls.push(call);
}
