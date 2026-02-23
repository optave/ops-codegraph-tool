import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from C# files.
 */
export function extractCSharpSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findCSharpParentType(node) {
    let current = node.parent;
    while (current) {
      if (
        current.type === 'class_declaration' ||
        current.type === 'struct_declaration' ||
        current.type === 'interface_declaration' ||
        current.type === 'enum_declaration' ||
        current.type === 'record_declaration'
      ) {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walkCSharpNode(node) {
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
          extractCSharpBaseTypes(node, nameNode.text, classes);
        }
        break;
      }

      case 'struct_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'struct',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          extractCSharpBaseTypes(node, nameNode.text, classes);
        }
        break;
      }

      case 'record_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'record',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          extractCSharpBaseTypes(node, nameNode.text, classes);
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
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
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
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'property_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentType = findCSharpParentType(node);
          const fullName = parentType ? `${parentType}.${nameNode.text}` : nameNode.text;
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'using_directive': {
        // using System.Collections.Generic;
        const nameNode =
          node.childForFieldName('name') ||
          findChild(node, 'qualified_name') ||
          findChild(node, 'identifier');
        if (nameNode) {
          const fullPath = nameNode.text;
          const lastName = fullPath.split('.').pop();
          imports.push({
            source: fullPath,
            names: [lastName],
            line: node.startPosition.row + 1,
            csharpUsing: true,
          });
        }
        break;
      }

      case 'invocation_expression': {
        const fn = node.childForFieldName('function') || node.child(0);
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'member_access_expression') {
            const name = fn.childForFieldName('name');
            if (name) calls.push({ name: name.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'generic_name' || fn.type === 'member_binding_expression') {
            const name = fn.childForFieldName('name') || fn.child(0);
            if (name) calls.push({ name: name.text, line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'object_creation_expression': {
        const typeNode = node.childForFieldName('type');
        if (typeNode) {
          const typeName =
            typeNode.type === 'generic_name'
              ? typeNode.childForFieldName('name')?.text || typeNode.child(0)?.text
              : typeNode.text;
          if (typeName) calls.push({ name: typeName, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkCSharpNode(node.child(i));
  }

  walkCSharpNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

function extractCSharpBaseTypes(node, className, classes) {
  const baseList = node.childForFieldName('bases');
  if (!baseList) return;
  for (let i = 0; i < baseList.childCount; i++) {
    const child = baseList.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'qualified_name') {
      classes.push({ name: className, extends: child.text, line: node.startPosition.row + 1 });
    } else if (child.type === 'generic_name') {
      const name = child.childForFieldName('name') || child.child(0);
      if (name)
        classes.push({ name: className, extends: name.text, line: node.startPosition.row + 1 });
    } else if (child.type === 'base_list') {
      for (let j = 0; j < child.childCount; j++) {
        const base = child.child(j);
        if (base && (base.type === 'identifier' || base.type === 'qualified_name')) {
          classes.push({ name: className, extends: base.text, line: node.startPosition.row + 1 });
        } else if (base && base.type === 'generic_name') {
          const name = base.childForFieldName('name') || base.child(0);
          if (name)
            classes.push({ name: className, extends: name.text, line: node.startPosition.row + 1 });
        }
      }
    }
  }
}
