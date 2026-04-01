import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Clojure files.
 *
 * Clojure tree-sitter grammar (sogaiu/tree-sitter-clojure) notes:
 * - The grammar is minimal: everything is a list/vector/map/symbol
 * - We detect definitions by the first symbol in a list: defn, def, defprotocol, etc.
 * - Namespace: (ns name ...)
 * - Imports: (:require ...) inside ns, or (require ...)
 */
export function extractClojureSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkClojureNode(tree.rootNode, ctx, null);
  return ctx;
}

function walkClojureNode(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentNs: string | null,
): void {
  let nextNs = currentNs;

  if (node.type === 'list_lit') {
    nextNs = handleListForm(node, ctx, currentNs) ?? currentNs;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkClojureNode(child, ctx, nextNs);
  }
}

/** Returns new namespace name if this is an `ns` form, otherwise null. */
function handleListForm(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentNs: string | null,
): string | null {
  const firstSym = findFirstSymbol(node);
  if (!firstSym) return null;

  const name = firstSym.text;

  switch (name) {
    case 'ns':
      return handleNsForm(node, ctx);
    case 'def':
    case 'defonce':
      handleDefForm(node, ctx, currentNs, 'variable');
      return null;
    case 'defn':
    case 'defn-':
      handleDefnForm(node, ctx, currentNs, name === 'defn-' ? 'private' : 'public');
      return null;
    case 'defmacro':
      handleDefnForm(node, ctx, currentNs, 'public');
      return null;
    case 'defprotocol':
      handleDefprotocol(node, ctx);
      return null;
    case 'defrecord':
    case 'deftype':
      handleDefrecord(node, ctx, name);
      return null;
    case 'defmulti':
      handleDefForm(node, ctx, currentNs, 'function');
      return null;
    case 'defmethod':
      handleDefnForm(node, ctx, currentNs, 'public');
      return null;
    case 'require':
    case 'use':
    case 'import':
      handleImportForm(node, ctx, name);
      return null;
    default: {
      // Regular function call
      if (!name.startsWith(':') && !name.startsWith('(')) {
        ctx.calls.push({ name, line: node.startPosition.row + 1 });
      }
      return null;
    }
  }
}

function findFirstSymbol(listNode: TreeSitterNode): TreeSitterNode | null {
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!child) continue;
    // Skip delimiters and metadata
    if ('()[]{}#'.includes(child.type) || child.type === 'meta_lit') continue;
    if (child.type === 'sym_lit' || child.type === 'kwd_lit') return child;
    break;
  }
  return null;
}

function findSecondSymbol(listNode: TreeSitterNode): TreeSitterNode | null {
  let count = 0;
  for (let i = 0; i < listNode.childCount; i++) {
    const child = listNode.child(i);
    if (!child) continue;
    if ('()[]{}#'.includes(child.type) || child.type === 'meta_lit') continue;
    if (child.type === 'sym_lit' || child.type === 'kwd_lit') {
      count++;
      if (count === 2) return child;
    }
  }
  return null;
}

function handleNsForm(node: TreeSitterNode, ctx: ExtractorOutput): string | null {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return null;

  const nsName = nameNode.text;
  ctx.definitions.push({
    name: nsName,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  // Extract requires from ns form
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'list_lit') {
      const kw = findFirstSymbol(child);
      if (kw && (kw.text === ':require' || kw.text === ':import' || kw.text === ':use')) {
        extractNsRequires(child, ctx);
      }
    }
  }

  return nsName;
}

function extractNsRequires(requireForm: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < requireForm.childCount; i++) {
    const child = requireForm.child(i);
    if (!child) continue;
    // Vector form: [some.ns :as alias]
    if (child.type === 'vec_lit') {
      const sym = findFirstSymbol(child);
      if (sym) {
        ctx.imports.push({
          source: sym.text,
          names: [sym.text.split('.').pop() || sym.text],
          line: child.startPosition.row + 1,
        });
      }
    }
    // Symbol form: some.ns
    if (child.type === 'sym_lit' && i > 0) {
      const text = child.text;
      if (!text.startsWith(':')) {
        ctx.imports.push({
          source: text,
          names: [text.split('.').pop() || text],
          line: child.startPosition.row + 1,
        });
      }
    }
  }
}

function handleDefForm(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentNs: string | null,
  kindOrFallback: 'variable' | 'function',
): void {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return;

  const rawName = nameNode.text;
  const fullName = currentNs ? `${currentNs}/${rawName}` : rawName;

  ctx.definitions.push({
    name: fullName,
    kind: kindOrFallback,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDefnForm(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentNs: string | null,
  visibility: 'public' | 'private',
): void {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return;

  const rawName = nameNode.text;
  const fullName = currentNs ? `${currentNs}/${rawName}` : rawName;
  const params = extractClojureParams(node);

  ctx.definitions.push({
    name: fullName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    visibility,
    children: params.length > 0 ? params : undefined,
  });
}

function extractClojureParams(defnNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  // Find the parameter vector [x y z]
  for (let i = 0; i < defnNode.childCount; i++) {
    const child = defnNode.child(i);
    if (!child || child.type !== 'vec_lit') continue;
    for (let j = 0; j < child.childCount; j++) {
      const param = child.child(j);
      if (!param) continue;
      if (param.type === 'sym_lit') {
        params.push({ name: param.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
    break; // Only first vector is params
  }
  return params;
}

function handleDefprotocol(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDefrecord(node: TreeSitterNode, ctx: ExtractorOutput, keyword: string): void {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: keyword === 'defrecord' ? 'record' : 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleImportForm(node: TreeSitterNode, ctx: ExtractorOutput, keyword: string): void {
  const nameNode = findSecondSymbol(node);
  if (!nameNode) return;

  ctx.imports.push({
    source: nameNode.text,
    names: [keyword],
    line: node.startPosition.row + 1,
  });
}
