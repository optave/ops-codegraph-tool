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
  let nextModule = currentModule;

  if (node.type === 'call') {
    const target = node.childForFieldName('target');
    if (target?.type === 'identifier' && target.text === 'defmodule') {
      const args = findChild(node, 'arguments');
      const aliasNode = args && findChild(args, 'alias');
      if (aliasNode) nextModule = aliasNode.text;
    }
    handleElixirCall(node, ctx, nextModule);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkElixirNode(child, ctx, nextModule);
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
  _ctx: ExtractorOutput,
  _moduleName: string,
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
      collectElixirParamIdentifiers(param, params);
    }
  }
  return params;
}

/**
 * Walk a parameter pattern and emit each bound identifier as a `parameter`
 * child. Handles bare identifiers, default-value `a \\ default`, list-cons
 * `[head | tail]`, list `[a, b, c]`, tuple `{x, y}`, and map / struct
 * destructuring (`%{k: v}`, `%Foo{k: v}`).
 *
 * Implemented as an iterative worklist (rather than recursion + helpers) so
 * the call graph has no function-level cycle: only one function performs the
 * traversal and it invokes only leaf helpers (`pushSubNodes`, `pushMapValues`).
 */
function collectElixirParamIdentifiers(root: TreeSitterNode, out: SubDeclaration[]): void {
  const stack: TreeSitterNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    switch (node.type) {
      case 'identifier':
        out.push({ name: node.text, kind: 'parameter', line: node.startPosition.row + 1 });
        break;
      case 'binary_operator':
        pushElixirBinaryOperatorOperands(node, stack);
        break;
      case 'list':
      case 'tuple':
        pushElixirSequenceItems(node, stack);
        break;
      case 'map':
        pushElixirMapValues(node, stack);
        break;
    }
  }
}

/**
 * Push the binding-relevant operands of a `binary_operator` parameter onto the
 * worklist:
 * - `name \\ default` (default-value) binds the left operand only.
 * - `head | tail`     (list-cons, appears inside a `list` pattern) binds both.
 */
function pushElixirBinaryOperatorOperands(node: TreeSitterNode, stack: TreeSitterNode[]): void {
  const op = node.child(1);
  if (!op) return;
  if (op.type === '\\\\') {
    const left = node.child(0);
    if (left) stack.push(left);
    return;
  }
  if (op.type === '|') {
    const right = node.child(2);
    const left = node.child(0);
    if (right) stack.push(right);
    if (left) stack.push(left);
  }
}

/**
 * Push the binding-relevant elements of a `list` or `tuple` parameter onto
 * the worklist, skipping punctuation tokens.
 *
 * Items are pushed in reverse source order so that `stack.pop()` yields them
 * left-to-right (the worklist is a LIFO stack).
 */
function pushElixirSequenceItems(node: TreeSitterNode, stack: TreeSitterNode[]): void {
  for (let i = node.childCount - 1; i >= 0; i--) {
    const c = node.child(i);
    if (!c) continue;
    const t = c.type;
    if (t === '[' || t === ']' || t === '{' || t === '}' || t === ',') continue;
    stack.push(c);
  }
}

/**
 * Push the value side of every pair in a `map` or `%Foo{...}` parameter onto
 * the worklist. The struct alias (`Foo`) is a type, not a bound identifier, so
 * the leading `struct` child is intentionally skipped.
 *
 * Items are pushed in reverse source order so that `stack.pop()` yields them
 * left-to-right (the worklist is a LIFO stack).
 */
function pushElixirMapValues(node: TreeSitterNode, stack: TreeSitterNode[]): void {
  // Collect values in source order first, then push in reverse so pop() is l-to-r.
  const values: TreeSitterNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const content = node.child(i);
    if (!content || content.type !== 'map_content') continue;
    for (let j = 0; j < content.childCount; j++) {
      const kws = content.child(j);
      if (!kws || kws.type !== 'keywords') continue;
      for (let k = 0; k < kws.childCount; k++) {
        const pair = kws.child(k);
        if (!pair || pair.type !== 'pair') continue;
        for (let p = 0; p < pair.childCount; p++) {
          const part = pair.child(p);
          if (!part || part.type === 'keyword') continue;
          values.push(part);
        }
      }
    }
  }
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v) stack.push(v);
  }
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
