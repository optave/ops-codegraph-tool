import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Zig files.
 *
 * Zig's structs/enums/unions are anonymous — their names come from the
 * enclosing `variable_declaration` (e.g. `const Foo = struct { ... };`).
 */
export function extractZigSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkZigNode(tree.rootNode, ctx);
  return ctx;
}

function walkZigNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_declaration':
      handleZigFunction(node, ctx);
      break;
    case 'variable_declaration':
      handleZigVariable(node, ctx);
      break;
    case 'call_expression':
      handleZigCallExpression(node, ctx);
      break;
    case 'builtin_function':
      handleZigBuiltin(node, ctx);
      break;
    case 'test_declaration':
      handleZigTest(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkZigNode(child, ctx);
  }
}

function isInsideZigContainer(node: TreeSitterNode): boolean {
  let current = node.parent;
  while (current) {
    if (current.type === 'struct_declaration' || current.type === 'union_declaration') return true;
    current = current.parent;
  }
  return false;
}

function handleZigFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (isInsideZigContainer(node)) return; // already emitted by extractZigContainerMethods

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const params = extractZigParams(node);

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: isZigPub(node) ? 'public' : 'private',
  });
}

function extractZigParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList = funcNode.childForFieldName('parameters');
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || param.type !== 'parameter') continue;
    const nameNode = findChild(param, 'identifier');
    if (nameNode) {
      params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
    }
  }
  return params;
}

function handleZigVariable(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;
  const name = nameNode.text;

  // Check if this is a struct/enum/union definition
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (child.type === 'struct_declaration') {
      const members = extractZigContainerFields(child);
      ctx.definitions.push({
        name,
        kind: 'struct',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
        children: members.length > 0 ? members : undefined,
        visibility: isZigPub(node) ? 'public' : undefined,
      });
      extractZigContainerMethods(child, name, ctx);
      return;
    }
    if (child.type === 'enum_declaration') {
      ctx.definitions.push({
        name,
        kind: 'enum',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
        visibility: isZigPub(node) ? 'public' : undefined,
      });
      return;
    }
    if (child.type === 'union_declaration') {
      ctx.definitions.push({
        name,
        kind: 'struct',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
        visibility: isZigPub(node) ? 'public' : undefined,
      });
      return;
    }
  }

  // Check for @import
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'builtin_function') {
      const builtinId = findChild(child, 'builtin_identifier');
      if (builtinId?.text === '@import') {
        const args = findChild(child, 'arguments');
        if (args) {
          const strArg = findChild(args, 'string_literal') || findChild(args, 'string');
          if (strArg) {
            const source = strArg.text.replace(/^"|"$/g, '');
            ctx.imports.push({
              source,
              names: [name],
              line: node.startPosition.row + 1,
            });
            return;
          }
        }
      }
    }
  }

  // Regular constant/variable
  const isConst = hasChildText(node, 'const');
  ctx.definitions.push({
    name,
    kind: isConst ? 'constant' : 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function extractZigContainerFields(container: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
  for (let i = 0; i < container.childCount; i++) {
    const child = container.child(i);
    if (!child || child.type !== 'container_field') continue;
    const nameNode = child.childForFieldName('name') || findChild(child, 'identifier');
    if (nameNode) {
      fields.push({ name: nameNode.text, kind: 'property', line: child.startPosition.row + 1 });
    }
  }
  return fields;
}

function extractZigContainerMethods(
  container: TreeSitterNode,
  parentName: string,
  ctx: ExtractorOutput,
): void {
  for (let i = 0; i < container.childCount; i++) {
    const child = container.child(i);
    if (!child || child.type !== 'function_declaration') continue;
    const nameNode = child.childForFieldName('name');
    if (nameNode) {
      ctx.definitions.push({
        name: `${parentName}.${nameNode.text}`,
        kind: 'method',
        line: child.startPosition.row + 1,
        endLine: nodeEndLine(child),
        visibility: isZigPub(child) ? 'public' : 'private',
      });
    }
  }
}

function handleZigCallExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return;

  const call: Call = { name: '', line: node.startPosition.row + 1 };

  if (funcNode.type === 'field_expression' || funcNode.type === 'field_access') {
    const field = funcNode.childForFieldName('field') || funcNode.childForFieldName('member');
    const value = funcNode.childForFieldName('value') || funcNode.child(0);
    if (field) call.name = field.text;
    if (value) call.receiver = value.text;
  } else {
    call.name = funcNode.text;
  }

  if (call.name) ctx.calls.push(call);
}

function handleZigBuiltin(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const builtinId = findChild(node, 'builtin_identifier');
  if (!builtinId) return;

  // Treat @import as import (when standalone, not in variable_declaration)
  if (builtinId.text === '@import' && node.parent?.type !== 'variable_declaration') {
    const args = findChild(node, 'arguments');
    if (args) {
      const strArg = findChild(args, 'string_literal') || findChild(args, 'string');
      if (strArg) {
        const source = strArg.text.replace(/^"|"$/g, '');
        ctx.imports.push({
          source,
          names: ['@import'],
          line: node.startPosition.row + 1,
        });
      }
    }
    return;
  }

  // Other builtins are calls
  ctx.calls.push({ name: builtinId.text, line: node.startPosition.row + 1 });
}

function handleZigTest(node: TreeSitterNode, ctx: ExtractorOutput): void {
  let name = 'test';
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'string_literal' || child.type === 'string') {
      // Extract the string content child if available, otherwise strip quotes
      const content = findChild(child, 'string_content');
      name = content ? content.text : child.text.replace(/^"|"$/g, '');
      break;
    }
    if (child.type === 'identifier') {
      name = child.text;
      break;
    }
  }

  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function isZigPub(node: TreeSitterNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'pub') return true;
    if (child && child.text === 'pub') return true;
  }
  return false;
}

function hasChildText(node: TreeSitterNode, text: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.text === text) return true;
  }
  return false;
}
