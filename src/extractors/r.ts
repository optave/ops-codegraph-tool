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
  if (op.text !== '<-' && op.text !== '=' && op.text !== '<<-' && op.text !== '->') return;
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

  if (funcName === 'setGeneric' || funcName === 'setMethod') {
    handleSetGeneric(node, ctx);
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
  // Find the package name in arguments
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
          const id = findChild(arg, 'identifier') || findChild(arg, 'string');
          if (id) {
            const text = id.text.replace(/^["']|["']$/g, '');
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
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'arguments') continue;
    for (let j = 0; j < child.childCount; j++) {
      const arg = child.child(j);
      if (!arg) continue;
      if (arg.type === 'string') {
        const text = arg.text.replace(/^["']|["']$/g, '');
        ctx.imports.push({
          source: text,
          names: ['source'],
          line: node.startPosition.row + 1,
        });
        return;
      }
    }
  }
}

function handleSetClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'arguments') continue;
    for (let j = 0; j < child.childCount; j++) {
      const arg = child.child(j);
      if (!arg) continue;
      if (arg.type === 'string') {
        const name = arg.text.replace(/^["']|["']$/g, '');
        ctx.definitions.push({
          name,
          kind: 'class',
          line: node.startPosition.row + 1,
          endLine: nodeEndLine(node),
        });
        return;
      }
    }
  }
}

function handleSetGeneric(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'arguments') continue;
    for (let j = 0; j < child.childCount; j++) {
      const arg = child.child(j);
      if (!arg) continue;
      if (arg.type === 'string') {
        const name = arg.text.replace(/^["']|["']$/g, '');
        ctx.definitions.push({
          name,
          kind: 'function',
          line: node.startPosition.row + 1,
          endLine: nodeEndLine(node),
        });
        return;
      }
    }
  }
}
