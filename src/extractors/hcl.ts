import type {
  Definition,
  ExtractorOutput,
  Import,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from HCL (Terraform) files.
 */
export function extractHCLSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: { definitions: Definition[]; imports: Import[] } = { definitions: [], imports: [] };

  walkHclNode(tree.rootNode, ctx);
  return {
    definitions: ctx.definitions,
    calls: [],
    imports: ctx.imports,
    classes: [],
    exports: [],
    typeMap: new Map(),
  } as ExtractorOutput;
}

function walkHclNode(
  node: TreeSitterNode,
  ctx: { definitions: Definition[]; imports: Import[] },
): void {
  if (node.type === 'block') {
    handleHclBlock(node, ctx);
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkHclNode(child, ctx);
  }
}

function handleHclBlock(
  node: TreeSitterNode,
  ctx: { definitions: Definition[]; imports: Import[] },
): void {
  const children: TreeSitterNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) children.push(child);
  }

  const identifiers = children.filter((c) => c.type === 'identifier');
  const strings = children.filter((c) => c.type === 'string_lit');

  const firstIdent = identifiers[0];
  if (!firstIdent) return;
  const blockType = firstIdent.text;
  const name = resolveHclBlockName(blockType, strings);

  if (name) {
    let blockChildren: SubDeclaration[] | undefined;
    if (blockType === 'variable' || blockType === 'output') {
      blockChildren = extractHclAttributes(children);
    }
    ctx.definitions.push({
      name,
      kind: blockType as Definition['kind'],
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: blockChildren?.length ? blockChildren : undefined,
    });
  }

  if (blockType === 'module') {
    extractHclModuleSource(children, node, ctx);
  }
}

function resolveHclBlockName(blockType: string, strings: TreeSitterNode[]): string {
  const s0 = strings[0];
  const s1 = strings[1];
  if (blockType === 'resource' && s0 && s1) {
    return `${s0.text.replace(/"/g, '')}.${s1.text.replace(/"/g, '')}`;
  }
  if (blockType === 'data' && s0 && s1) {
    return `data.${s0.text.replace(/"/g, '')}.${s1.text.replace(/"/g, '')}`;
  }
  if ((blockType === 'variable' || blockType === 'output' || blockType === 'module') && s0) {
    return `${blockType}.${s0.text.replace(/"/g, '')}`;
  }
  if (blockType === 'locals') return 'locals';
  if (blockType === 'terraform' || blockType === 'provider') {
    let name = blockType;
    if (s0) name += `.${s0.text.replace(/"/g, '')}`;
    return name;
  }
  return '';
}

function extractHclAttributes(children: TreeSitterNode[]): SubDeclaration[] {
  const attrs: SubDeclaration[] = [];
  const body = children.find((c) => c.type === 'body');
  if (!body) return attrs;
  for (let j = 0; j < body.childCount; j++) {
    const attr = body.child(j);
    if (attr && attr.type === 'attribute') {
      const key = attr.childForFieldName('key') || attr.child(0);
      if (key) {
        attrs.push({ name: key.text, kind: 'property', line: attr.startPosition.row + 1 });
      }
    }
  }
  return attrs;
}

function extractHclModuleSource(
  children: TreeSitterNode[],
  _node: TreeSitterNode,
  ctx: { definitions: Definition[]; imports: Import[] },
): void {
  const body = children.find((c) => c.type === 'body');
  if (!body) return;
  for (let i = 0; i < body.childCount; i++) {
    const attr = body.child(i);
    if (attr && attr.type === 'attribute') {
      const key = attr.childForFieldName('key') || attr.child(0);
      const val = attr.childForFieldName('val') || attr.child(2);
      if (key && key.text === 'source' && val) {
        const src = val.text.replace(/"/g, '');
        if (src.startsWith('./') || src.startsWith('../')) {
          ctx.imports.push({ source: src, names: [], line: attr.startPosition.row + 1 });
        }
      }
    }
  }
}
