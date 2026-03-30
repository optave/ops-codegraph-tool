import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Lua files.
 */
export function extractLuaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkLuaNode(tree.rootNode, ctx);
  return ctx;
}

function walkLuaNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_declaration':
      handleLuaFunctionDecl(node, ctx);
      break;
    case 'variable_declaration':
      handleLuaVariableDecl(node, ctx);
      break;
    case 'function_call':
      handleLuaFunctionCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkLuaNode(child, ctx);
  }
}

function handleLuaFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  let name: string;
  let kind: 'function' | 'method' = 'function';

  if (nameNode.type === 'method_index_expression') {
    const table = nameNode.childForFieldName('table');
    const method = nameNode.childForFieldName('method');
    if (table && method) {
      name = `${table.text}.${method.text}`;
      kind = 'method';
    } else {
      name = nameNode.text;
    }
  } else if (nameNode.type === 'dot_index_expression') {
    const table = nameNode.childForFieldName('table');
    const field = nameNode.childForFieldName('field');
    if (table && field) {
      name = `${table.text}.${field.text}`;
      kind = 'method';
    } else {
      name = nameNode.text;
    }
  } else {
    name = nameNode.text;
  }

  const params = extractLuaParams(node);

  ctx.definitions.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function extractLuaParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList = funcNode.childForFieldName('parameters');
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (!param || param.type !== 'identifier') continue;
    params.push({ name: param.text, kind: 'parameter', line: param.startPosition.row + 1 });
  }
  return params;
}

function handleLuaVariableDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Check for require calls in the assignment
  const assignment = findChild(node, 'assignment_statement');
  if (assignment) {
    checkForRequire(assignment, ctx);
  }
}

function checkForRequire(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'function_call') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier' && nameNode.text === 'require') {
        const args = child.childForFieldName('arguments');
        if (args) {
          const strArg = findChild(args, 'string');
          if (strArg) {
            const source = strArg.text.replace(/^['"]|['"]$/g, '');
            ctx.imports.push({
              source,
              names: ['require'],
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

function handleLuaFunctionCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  // Check for require() as import
  if (nameNode.type === 'identifier' && nameNode.text === 'require') {
    const args = node.childForFieldName('arguments');
    if (args) {
      const strArg = findChild(args, 'string');
      if (strArg) {
        const source = strArg.text.replace(/^['"]|['"]$/g, '');
        ctx.imports.push({
          source,
          names: ['require'],
          line: node.startPosition.row + 1,
        });
        return;
      }
    }
  }

  const call: Call = { name: '', line: node.startPosition.row + 1 };

  if (nameNode.type === 'method_index_expression') {
    const table = nameNode.childForFieldName('table');
    const method = nameNode.childForFieldName('method');
    if (method) call.name = method.text;
    if (table) call.receiver = table.text;
  } else if (nameNode.type === 'dot_index_expression') {
    const table = nameNode.childForFieldName('table');
    const field = nameNode.childForFieldName('field');
    if (field) call.name = field.text;
    if (table) call.receiver = table.text;
  } else {
    call.name = nameNode.text;
  }

  if (call.name) ctx.calls.push(call);
}
