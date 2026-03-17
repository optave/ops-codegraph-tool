import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from HCL (Terraform) files.
 */
export function extractHCLSymbols(tree, _filePath) {
  const ctx = { definitions: [], imports: [] };

  walkHclNode(tree.rootNode, ctx);
  return {
    definitions: ctx.definitions,
    calls: [],
    imports: ctx.imports,
    classes: [],
    exports: [],
  };
}

function walkHclNode(node, ctx) {
  if (node.type === 'block') {
    handleHclBlock(node, ctx);
  }

  for (let i = 0; i < node.childCount; i++) walkHclNode(node.child(i), ctx);
}

function handleHclBlock(node, ctx) {
  const children = [];
  for (let i = 0; i < node.childCount; i++) children.push(node.child(i));

  const identifiers = children.filter((c) => c.type === 'identifier');
  const strings = children.filter((c) => c.type === 'string_lit');

  if (identifiers.length === 0) return;
  const blockType = identifiers[0].text;
  const name = resolveHclBlockName(blockType, strings);

  if (name) {
    let blockChildren;
    if (blockType === 'variable' || blockType === 'output') {
      blockChildren = extractHclAttributes(children);
    }
    ctx.definitions.push({
      name,
      kind: blockType,
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: blockChildren?.length > 0 ? blockChildren : undefined,
    });
  }

  if (blockType === 'module') {
    extractHclModuleSource(children, node, ctx);
  }
}

function resolveHclBlockName(blockType, strings) {
  if (blockType === 'resource' && strings.length >= 2) {
    return `${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
  }
  if (blockType === 'data' && strings.length >= 2) {
    return `data.${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
  }
  if (
    (blockType === 'variable' || blockType === 'output' || blockType === 'module') &&
    strings.length >= 1
  ) {
    return `${blockType}.${strings[0].text.replace(/"/g, '')}`;
  }
  if (blockType === 'locals') return 'locals';
  if (blockType === 'terraform' || blockType === 'provider') {
    let name = blockType;
    if (strings.length >= 1) name += `.${strings[0].text.replace(/"/g, '')}`;
    return name;
  }
  return '';
}

function extractHclAttributes(children) {
  const attrs = [];
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

function extractHclModuleSource(children, _node, ctx) {
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
