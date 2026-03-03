import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from HCL (Terraform) files.
 */
export function extractHCLSymbols(tree, _filePath) {
  const definitions = [];
  const imports = [];

  function walkHclNode(node) {
    if (node.type === 'block') {
      const children = [];
      for (let i = 0; i < node.childCount; i++) children.push(node.child(i));

      const identifiers = children.filter((c) => c.type === 'identifier');
      const strings = children.filter((c) => c.type === 'string_lit');

      if (identifiers.length > 0) {
        const blockType = identifiers[0].text;
        let name = '';

        if (blockType === 'resource' && strings.length >= 2) {
          name = `${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if (blockType === 'data' && strings.length >= 2) {
          name = `data.${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if (
          (blockType === 'variable' || blockType === 'output' || blockType === 'module') &&
          strings.length >= 1
        ) {
          name = `${blockType}.${strings[0].text.replace(/"/g, '')}`;
        } else if (blockType === 'locals') {
          name = 'locals';
        } else if (blockType === 'terraform' || blockType === 'provider') {
          name = blockType;
          if (strings.length >= 1) name += `.${strings[0].text.replace(/"/g, '')}`;
        }

        if (name) {
          // Extract attributes as property children for variable/output blocks
          let blockChildren;
          if (blockType === 'variable' || blockType === 'output') {
            blockChildren = [];
            const body = children.find((c) => c.type === 'body');
            if (body) {
              for (let j = 0; j < body.childCount; j++) {
                const attr = body.child(j);
                if (attr && attr.type === 'attribute') {
                  const key = attr.childForFieldName('key') || attr.child(0);
                  if (key) {
                    blockChildren.push({
                      name: key.text,
                      kind: 'property',
                      line: attr.startPosition.row + 1,
                    });
                  }
                }
              }
            }
          }
          definitions.push({
            name,
            kind: blockType,
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: blockChildren?.length > 0 ? blockChildren : undefined,
          });
        }

        if (blockType === 'module') {
          const body = children.find((c) => c.type === 'body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const attr = body.child(i);
              if (attr && attr.type === 'attribute') {
                const key = attr.childForFieldName('key') || attr.child(0);
                const val = attr.childForFieldName('val') || attr.child(2);
                if (key && key.text === 'source' && val) {
                  const src = val.text.replace(/"/g, '');
                  if (src.startsWith('./') || src.startsWith('../')) {
                    imports.push({ source: src, names: [], line: attr.startPosition.row + 1 });
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) walkHclNode(node.child(i));
  }

  walkHclNode(tree.rootNode);
  return { definitions, calls: [], imports, classes: [], exports: [] };
}
