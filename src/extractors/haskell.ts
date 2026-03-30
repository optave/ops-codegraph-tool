import type {
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Haskell files.
 *
 * Note: tree-sitter-haskell uses `type_synomym` (misspelled) for type aliases.
 */
export function extractHaskellSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkHaskellNode(tree.rootNode, ctx);
  return ctx;
}

function walkHaskellNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function':
      handleHaskellFunction(node, ctx);
      break;
    case 'bind':
      handleHaskellBind(node, ctx);
      break;
    case 'data_type':
      handleHaskellDataType(node, ctx);
      break;
    case 'newtype':
      handleHaskellNewtype(node, ctx);
      break;
    case 'type_synomym':
      handleHaskellTypeSynonym(node, ctx);
      break;
    case 'class':
      handleHaskellClass(node, ctx);
      break;
    case 'instance':
      handleHaskellInstance(node, ctx);
      break;
    case 'import':
      handleHaskellImport(node, ctx);
      break;
    case 'apply':
      handleHaskellApply(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkHaskellNode(child, ctx);
  }
}

function handleHaskellFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  const params = extractHaskellParams(node);

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function extractHaskellParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  // Haskell function patterns are positional children
  for (let i = 0; i < funcNode.childCount; i++) {
    const child = funcNode.child(i);
    if (!child) continue;
    if (child.type === 'patterns' || child.type === 'parameter') {
      for (let j = 0; j < child.childCount; j++) {
        const pat = child.child(j);
        if (pat && (pat.type === 'variable' || pat.type === 'identifier')) {
          params.push({ name: pat.text, kind: 'parameter', line: pat.startPosition.row + 1 });
        }
      }
    }
    if (child.type === 'variable' && i > 0) {
      // Pattern parameters after the function name
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
    }
  }
  return params;
}

function handleHaskellBind(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleHaskellDataType(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;

  const children: SubDeclaration[] = [];
  // Extract constructors
  const constructors = node.childForFieldName('constructors');
  if (constructors) {
    for (let i = 0; i < constructors.childCount; i++) {
      const ctor = constructors.child(i);
      if (!ctor) continue;
      if (ctor.type === 'data_constructor' || ctor.type === 'gadt_constructor') {
        const ctorName = findChild(ctor, 'constructor') || findChild(ctor, 'constructor_operator');
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

  ctx.definitions.push({
    name,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleHaskellNewtype(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleHaskellTypeSynonym(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleHaskellClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleHaskellInstance(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleHaskellImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const moduleNode = node.childForFieldName('module');
  if (!moduleNode) return;

  const source = moduleNode.text;
  const names: string[] = [];

  const alias = node.childForFieldName('alias');
  if (alias) names.push(alias.text);

  const importList = node.childForFieldName('names');
  if (importList) {
    for (let i = 0; i < importList.childCount; i++) {
      const item = importList.child(i);
      if (
        item &&
        (item.type === 'variable' || item.type === 'constructor' || item.type === 'type')
      ) {
        names.push(item.text);
      }
    }
  }

  ctx.imports.push({
    source,
    names: names.length > 0 ? names : [source.split('.').pop() || source],
    line: node.startPosition.row + 1,
  });
}

function handleHaskellApply(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.childForFieldName('function');
  if (!funcNode) return;

  // Only record named function applications, not complex expressions
  if (
    funcNode.type === 'variable' ||
    funcNode.type === 'constructor' ||
    funcNode.type === 'identifier'
  ) {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'qualified_variable' || funcNode.type === 'qualified_constructor') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  }
}
