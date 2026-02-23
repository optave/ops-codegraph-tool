import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from PHP files.
 */
export function extractPHPSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findPHPParentClass(node) {
    let current = node.parent;
    while (current) {
      if (
        current.type === 'class_declaration' ||
        current.type === 'trait_declaration' ||
        current.type === 'enum_declaration'
      ) {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walkPhpNode(node) {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });

          // Check base clause (extends)
          const baseClause =
            node.childForFieldName('base_clause') || findChild(node, 'base_clause');
          if (baseClause) {
            for (let i = 0; i < baseClause.childCount; i++) {
              const child = baseClause.child(i);
              if (child && (child.type === 'name' || child.type === 'qualified_name')) {
                classes.push({
                  name: nameNode.text,
                  extends: child.text,
                  line: node.startPosition.row + 1,
                });
                break;
              }
            }
          }

          // Check class interface clause (implements)
          const interfaceClause = findChild(node, 'class_interface_clause');
          if (interfaceClause) {
            for (let i = 0; i < interfaceClause.childCount; i++) {
              const child = interfaceClause.child(i);
              if (child && (child.type === 'name' || child.type === 'qualified_name')) {
                classes.push({
                  name: nameNode.text,
                  implements: child.text,
                  line: node.startPosition.row + 1,
                });
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

      case 'trait_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'trait',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
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
          const parentClass = findPHPParentClass(node);
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

      case 'namespace_use_declaration': {
        // use App\Models\User;
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'namespace_use_clause') {
            const nameNode = findChild(child, 'qualified_name') || findChild(child, 'name');
            if (nameNode) {
              const fullPath = nameNode.text;
              const lastName = fullPath.split('\\').pop();
              const alias = child.childForFieldName('alias');
              imports.push({
                source: fullPath,
                names: [alias ? alias.text : lastName],
                line: node.startPosition.row + 1,
                phpUse: true,
              });
            }
          }
          // Single use clause without wrapper
          if (child && (child.type === 'qualified_name' || child.type === 'name')) {
            const fullPath = child.text;
            const lastName = fullPath.split('\\').pop();
            imports.push({
              source: fullPath,
              names: [lastName],
              line: node.startPosition.row + 1,
              phpUse: true,
            });
          }
        }
        break;
      }

      case 'function_call_expression': {
        const fn = node.childForFieldName('function') || node.child(0);
        if (fn) {
          if (fn.type === 'name' || fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'qualified_name') {
            const parts = fn.text.split('\\');
            calls.push({ name: parts[parts.length - 1], line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'member_call_expression': {
        const name = node.childForFieldName('name');
        if (name) {
          calls.push({ name: name.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'scoped_call_expression': {
        const name = node.childForFieldName('name');
        if (name) {
          calls.push({ name: name.text, line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'object_creation_expression': {
        const classNode = node.child(1); // skip 'new' keyword
        if (classNode && (classNode.type === 'name' || classNode.type === 'qualified_name')) {
          const parts = classNode.text.split('\\');
          calls.push({ name: parts[parts.length - 1], line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkPhpNode(node.child(i));
  }

  walkPhpNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
