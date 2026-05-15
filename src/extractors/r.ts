import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from R files.
 *
 * tree-sitter-r grammar (r-lib/tree-sitter-r) notes:
 * - Assignments: binary_operator with `<-` or `=` operator
 * - Functions: function_definition as RHS of assignment
 * - Calls: call node with function/arguments fields
 * - Imports: library() and require() calls
 * - S4 classes: setClass(), setRefClass()
 */
export function extractRSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkRNode(tree.rootNode, ctx);
  return ctx;
}

function walkRNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'binary_operator':
      handleBinaryOp(node, ctx);
      break;
    case 'call':
      handleCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkRNode(child, ctx);
  }
}

function handleBinaryOp(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // binary_operator: child[0]=LHS, child[1]=operator (<- or =), child[2]=RHS
  if (node.childCount < 3) return;

  const lhs = node.child(0);
  const op = node.child(1);
  const rhs = node.child(2);

  if (!lhs || !op || !rhs) return;
  if (op.text !== '<-' && op.text !== '=' && op.text !== '<<-') return;
  if (lhs.type !== 'identifier') return;

  if (rhs.type === 'function_definition') {
    const params = extractRParams(rhs);
    ctx.definitions.push({
      name: lhs.text,
      kind: 'function',
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: params.length > 0 ? params : undefined,
    });
  } else {
    // Variable assignment — only record top-level
    if (node.parent?.type === 'program') {
      ctx.definitions.push({
        name: lhs.text,
        kind: 'variable',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
      });
    }
  }
}

function extractRParams(funcDef: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramsNode = findChild(funcDef, 'parameters');
  if (!paramsNode) return params;

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);
    if (!child) continue;
    if (child.type === 'parameter') {
      // parameter node has name and possibly default value
      const nameNode = child.childForFieldName('name') || findChild(child, 'identifier');
      if (nameNode) {
        params.push({ name: nameNode.text, kind: 'parameter', line: child.startPosition.row + 1 });
      } else if (child.text && child.text !== ',' && child.text !== '(' && child.text !== ')') {
        // Some grammars have the param as plain text
        params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    }
    if (child.type === 'identifier') {
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
    }
  }
  return params;
}

function handleCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // call: child[0]=function, then arguments
  const funcNode = node.child(0);
  if (!funcNode) return;

  const funcName = funcNode.text;

  // library() and require() are imports
  if (funcName === 'library' || funcName === 'require') {
    handleLibraryCall(node, ctx);
    return;
  }

  // source() is a file import
  if (funcName === 'source') {
    handleSourceCall(node, ctx);
    return;
  }

  // setClass / setRefClass for S4
  if (funcName === 'setClass' || funcName === 'setRefClass') {
    handleSetClass(node, ctx);
    return;
  }

  if (funcName === 'setGeneric') {
    handleSetGeneric(node, ctx);
    return;
  }

  if (funcName === 'setMethod') {
    handleSetMethod(node, ctx);
    return;
  }

  // Regular call
  if (funcNode.type === 'identifier') {
    ctx.calls.push({ name: funcName, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'namespace_operator') {
    // pkg::func
    const parts = funcName.split('::');
    if (parts.length >= 2) {
      ctx.calls.push({
        name: parts[parts.length - 1]!,
        receiver: parts.slice(0, -1).join('::'),
        line: node.startPosition.row + 1,
      });
    }
  }
}

function handleLibraryCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Find the package name in arguments. For named arguments like
  // `library(package = dplyr)`, prefer the field-named `value` child of the
  // `argument` node so we extract `dplyr` (the value), not `package` (the
  // parameter name). Keeps native (Rust) and WASM extractors in parity.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'arguments') {
      for (let j = 0; j < child.childCount; j++) {
        const arg = child.child(j);
        if (!arg) continue;
        if (arg.type === 'identifier') {
          ctx.imports.push({
            source: arg.text,
            names: [arg.text],
            line: node.startPosition.row + 1,
          });
          return;
        }
        if (arg.type === 'string' || arg.type === 'string_content') {
          const text = arg.text.replace(/^["']|["']$/g, '');
          ctx.imports.push({
            source: text,
            names: [text],
            line: node.startPosition.row + 1,
          });
          return;
        }
        // Argument might be wrapped
        if (arg.type === 'argument') {
          // Prefer the `value` field (correct for named arguments).
          const valueNode = arg.childForFieldName('value');
          let pick: TreeSitterNode | null = null;
          if (valueNode && (valueNode.type === 'string' || valueNode.type === 'identifier')) {
            pick = valueNode;
          } else {
            // Fallback: skip the parameter-name child if the grammar exposes
            // it via the `name` field, then pick the first string/identifier.
            const nameNode = arg.childForFieldName('name');
            for (let k = 0; k < arg.childCount; k++) {
              const inner = arg.child(k);
              if (!inner) continue;
              if (nameNode && inner.id === nameNode.id) continue;
              if (inner.type === 'string' || inner.type === 'identifier') {
                pick = inner;
                break;
              }
            }
          }
          if (pick) {
            const text = pick.text.replace(/^["']|["']$/g, '');
            ctx.imports.push({
              source: text,
              names: [text],
              line: node.startPosition.row + 1,
            });
            return;
          }
        }
      }
    }
  }
}

function handleSourceCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // source() only accepts string literals — `source(varname)` is not an import.
  const path = firstStringArgument(node);
  if (path === null) return;
  ctx.imports.push({
    source: path,
    names: ['source'],
    line: node.startPosition.row + 1,
  });
}

function handleSetClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const name = firstStringArgument(node);
  if (name === null) return;
  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleSetGeneric(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const name = firstStringArgument(node);
  if (name === null) return;
  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

// setMethod("greet", "Person", function(x) ...) registers an implementation of
// the generic `greet` — it is not a new top-level definition. Emitting a
// definition here produced two `function` nodes with the same name (one from
// setGeneric, one from setMethod) and broke resolution. Emit a call edge to
// the generic instead; the method body's calls are still picked up by the
// recursive walk of the anonymous function argument.
function handleSetMethod(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const name = firstStringArgument(node);
  if (name === null) return;
  ctx.calls.push({ name, line: node.startPosition.row + 1 });
}

// tree-sitter-r wraps each positional argument in an `argument` node that
// contains the actual `string` (or `identifier`) child, so the inner string
// must be unwrapped — checking `child.type === 'string'` directly misses it.
// Mirrors `first_argument_value` in the Rust extractor for parity.
function firstStringArgument(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'arguments') continue;
    for (let j = 0; j < child.childCount; j++) {
      const arg = child.child(j);
      if (!arg) continue;
      if (arg.type === 'string') {
        return stripQuotes(arg.text);
      }
      if (arg.type === 'argument') {
        const valueNode = arg.childForFieldName('value');
        if (valueNode && valueNode.type === 'string') return stripQuotes(valueNode.text);
        for (let k = 0; k < arg.childCount; k++) {
          const inner = arg.child(k);
          if (inner && inner.type === 'string') return stripQuotes(inner.text);
        }
      }
    }
  }
  return null;
}

function stripQuotes(text: string): string {
  return text.replace(/^["']|["']$/g, '');
}
