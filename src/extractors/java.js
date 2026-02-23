import { nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Java files.
 */
export function extractJavaSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findJavaParentClass(node) {
    let current = node.parent;
    while (current) {
      if (
        current.type === 'class_declaration' ||
        current.type === 'enum_declaration' ||
        current.type === 'interface_declaration'
      ) {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walkJavaNode(node) {
    switch (node.type) {
      case 'class_declaration': {
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
            for (let i = 0; i < superclass.childCount; i++) {
              const child = superclass.child(i);
              if (
                child &&
                (child.type === 'type_identifier' ||
                  child.type === 'identifier' ||
                  child.type === 'generic_type')
              ) {
                const superName = child.type === 'generic_type' ? child.child(0)?.text : child.text;
                if (superName)
                  classes.push({
                    name: nameNode.text,
                    extends: superName,
                    line: node.startPosition.row + 1,
                  });
                break;
              }
            }
          }

          const interfaces = node.childForFieldName('interfaces');
          if (interfaces) {
            for (let i = 0; i < interfaces.childCount; i++) {
              const child = interfaces.child(i);
              if (
                child &&
                (child.type === 'type_identifier' ||
                  child.type === 'identifier' ||
                  child.type === 'type_list' ||
                  child.type === 'generic_type')
              ) {
                if (child.type === 'type_list') {
                  for (let j = 0; j < child.childCount; j++) {
                    const t = child.child(j);
                    if (
                      t &&
                      (t.type === 'type_identifier' ||
                        t.type === 'identifier' ||
                        t.type === 'generic_type')
                    ) {
                      const ifaceName = t.type === 'generic_type' ? t.child(0)?.text : t.text;
                      if (ifaceName)
                        classes.push({
                          name: nameNode.text,
                          implements: ifaceName,
                          line: node.startPosition.row + 1,
                        });
                    }
                  }
                } else {
                  const ifaceName =
                    child.type === 'generic_type' ? child.child(0)?.text : child.text;
                  if (ifaceName)
                    classes.push({
                      name: nameNode.text,
                      implements: ifaceName,
                      line: node.startPosition.row + 1,
                    });
                }
              }
            }
          }
        }
        break;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'interface',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (child && child.type === 'method_declaration') {
                const methName = child.childForFieldName('name');
                if (methName) {
                  definitions.push({
                    name: `${nameNode.text}.${methName.text}`,
                    kind: 'method',
                    line: child.startPosition.row + 1,
                    endLine: child.endPosition.row + 1,
                  });
                }
              }
            }
          }
        }
        break;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'enum',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findJavaParentClass(node);
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

      case 'constructor_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findJavaParentClass(node);
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

      case 'import_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'scoped_identifier' || child.type === 'identifier')) {
            const fullPath = child.text;
            const lastName = fullPath.split('.').pop();
            imports.push({
              source: fullPath,
              names: [lastName],
              line: node.startPosition.row + 1,
              javaImport: true,
            });
          }
          if (child && child.type === 'asterisk') {
            const lastImport = imports[imports.length - 1];
            if (lastImport) lastImport.names = ['*'];
          }
        }
        break;
      }

      case 'method_invocation': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          calls.push({ name: nameNode.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'object_creation_expression': {
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
          const typeName =
            typeNode.type === 'generic_type' ? typeNode.child(0)?.text : typeNode.text;
          if (typeName) calls.push({ name: typeName, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkJavaNode(node.child(i));
  }

  walkJavaNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
