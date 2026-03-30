import type {
  Call,
  ExtractorOutput,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Bash/Shell files.
 */
export function extractBashSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkBashNode(tree.rootNode, ctx);
  return ctx;
}

function walkBashNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_definition':
      handleBashFunctionDef(node, ctx);
      break;
    case 'command':
      handleBashCommand(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkBashNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleBashFunctionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleBashCommand(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // First child is command_name
  let commandNameNode: TreeSitterNode | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'command_name') {
      commandNameNode = child;
      break;
    }
  }
  if (!commandNameNode) return;

  const cmdText = commandNameNode.text;

  // "source" or "." commands are imports
  if (cmdText === 'source' || cmdText === '.') {
    // Second argument is the source path
    let argNode: TreeSitterNode | null = null;
    let foundCmd = false;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;
      if (child.type === 'command_name') {
        foundCmd = true;
        continue;
      }
      if (foundCmd && child.type !== 'command_name') {
        argNode = child;
        break;
      }
    }
    if (argNode) {
      const source = argNode.text;
      const lastName = source.split('/').pop() ?? source;
      ctx.imports.push({
        source,
        names: [lastName],
        line: node.startPosition.row + 1,
        bashSource: true,
      });
    }
    return;
  }

  // Regular command call
  const call: Call = { name: cmdText, line: node.startPosition.row + 1 };
  ctx.calls.push(call);
}
