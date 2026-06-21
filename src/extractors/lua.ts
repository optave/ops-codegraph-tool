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
    if (param?.type !== 'identifier') continue;
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

  // load(chunk) / loadstring(chunk) — dynamic code execution; always undecidable
  if (
    nameNode.type === 'identifier' &&
    (nameNode.text === 'load' || nameNode.text === 'loadstring' || nameNode.text === 'dofile')
  ) {
    ctx.calls.push({
      name: '<dynamic:eval>',
      line: node.startPosition.row + 1,
      dynamic: true,
      dynamicKind: 'eval',
    });
    return;
  }

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
  } else if (nameNode.type === 'bracket_index_expression') {
    // t[k]() — bracket-index function call; key may be variable.
    // AST: bracket_index_expression → [table_node, '[', key_expr, ']']
    // childForFieldName('key') is not defined for this node type in tree-sitter-lua,
    // so we locate the key by scanning past the '[', ']', and the table node (by id).
    const table = nameNode.childForFieldName('table');
    const tableId = table?.id;
    let key: TreeSitterNode | null = null;
    for (let i = 0; i < nameNode.childCount; i++) {
      const ch = nameNode.child(i);
      if (!ch) continue;
      // Skip punctuation and the table node (compare by node id)
      if (ch.type === '[' || ch.type === ']' || ch.id === tableId) continue;
      key = ch;
      break;
    }
    if (key && (key.type === 'string' || key.type === 'string_literal')) {
      call.name = key.text.replace(/['"]/g, '');
      call.receiver = table?.text;
    } else {
      // Variable key — flagged as computed-key
      ctx.calls.push({
        name: '<dynamic:computed-key>',
        line: call.line,
        dynamic: true,
        dynamicKind: 'computed-key',
        keyExpr: key?.text,
        receiver: table?.text,
      });
      return;
    }
  } else {
    call.name = nameNode.text;
  }

  if (call.name) ctx.calls.push(call);
}
