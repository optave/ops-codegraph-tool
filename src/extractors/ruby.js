import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Ruby files.
 */
export function extractRubySymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findRubyParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      if (current.type === 'module') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walkRubyNode(node) {
    switch (node.type) {
      case 'class': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          const superclass = node.childForFieldName('superclass');
          if (superclass) {
            // superclass wraps the < token and class name
            for (let i = 0; i < superclass.childCount; i++) {
              const child = superclass.child(i);
              if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
                classes.push({
                  name: nameNode.text,
                  extends: child.text,
                  line: node.startPosition.row + 1,
                });
                break;
              }
            }
            // Direct superclass node may be a constant
            if (superclass.type === 'superclass') {
              for (let i = 0; i < superclass.childCount; i++) {
                const child = superclass.child(i);
                if (child && (child.type === 'constant' || child.type === 'scope_resolution')) {
                  classes.push({
                    name: nameNode.text,
                    extends: child.text,
                    line: node.startPosition.row + 1,
                  });
                  break;
                }
              }
            }
          }
        }
        break;
      }

      case 'module': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'module',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findRubyParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'singleton_method': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findRubyParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({
            name: fullName,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'call': {
        const methodNode = node.childForFieldName('method');
        if (methodNode) {
          // Check for require/require_relative
          if (methodNode.text === 'require' || methodNode.text === 'require_relative') {
            const args = node.childForFieldName('arguments');
            if (args) {
              for (let i = 0; i < args.childCount; i++) {
                const arg = args.child(i);
                if (arg && (arg.type === 'string' || arg.type === 'string_content')) {
                  const strContent = arg.text.replace(/^['"]|['"]$/g, '');
                  imports.push({
                    source: strContent,
                    names: [strContent.split('/').pop()],
                    line: node.startPosition.row + 1,
                    rubyRequire: true,
                  });
                  break;
                }
                // Look inside string for string_content
                if (arg && arg.type === 'string') {
                  const content = findChild(arg, 'string_content');
                  if (content) {
                    imports.push({
                      source: content.text,
                      names: [content.text.split('/').pop()],
                      line: node.startPosition.row + 1,
                      rubyRequire: true,
                    });
                    break;
                  }
                }
              }
            }
          } else if (
            methodNode.text === 'include' ||
            methodNode.text === 'extend' ||
            methodNode.text === 'prepend'
          ) {
            // Module inclusion — treated like implements
            const parentClass = findRubyParentClass(node);
            if (parentClass) {
              const args = node.childForFieldName('arguments');
              if (args) {
                for (let i = 0; i < args.childCount; i++) {
                  const arg = args.child(i);
                  if (arg && (arg.type === 'constant' || arg.type === 'scope_resolution')) {
                    classes.push({
                      name: parentClass,
                      implements: arg.text,
                      line: node.startPosition.row + 1,
                    });
                  }
                }
              }
            }
          } else {
            calls.push({ name: methodNode.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkRubyNode(node.child(i));
  }

  walkRubyNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
