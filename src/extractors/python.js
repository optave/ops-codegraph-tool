import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Python files.
 */
export function extractPythonSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walkPythonNode(node) {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const decorators = [];
          if (node.previousSibling && node.previousSibling.type === 'decorator') {
            decorators.push(node.previousSibling.text);
          }
          const parentClass = findPythonParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          const kind = parentClass ? 'method' : 'function';
          definitions.push({
            name: fullName,
            kind,
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            decorators,
          });
        }
        break;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          const superclasses =
            node.childForFieldName('superclasses') || findChild(node, 'argument_list');
          if (superclasses) {
            for (let i = 0; i < superclasses.childCount; i++) {
              const child = superclasses.child(i);
              if (child && child.type === 'identifier') {
                classes.push({
                  name: nameNode.text,
                  extends: child.text,
                  line: node.startPosition.row + 1,
                });
              }
            }
          }
        }
        break;
      }

      case 'decorated_definition': {
        for (let i = 0; i < node.childCount; i++) walkPythonNode(node.child(i));
        return;
      }

      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn) {
          let callName = null;
          let receiver;
          if (fn.type === 'identifier') callName = fn.text;
          else if (fn.type === 'attribute') {
            const attr = fn.childForFieldName('attribute');
            if (attr) callName = attr.text;
            const obj = fn.childForFieldName('object');
            if (obj) receiver = obj.text;
          }
          if (callName) {
            const call = { name: callName, line: node.startPosition.row + 1 };
            if (receiver) call.receiver = receiver;
            calls.push(call);
          }
        }
        break;
      }

      case 'import_statement': {
        const names = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'dotted_name' || child.type === 'aliased_import')) {
            const name =
              child.type === 'aliased_import'
                ? (child.childForFieldName('alias') || child.childForFieldName('name'))?.text
                : child.text;
            if (name) names.push(name);
          }
        }
        if (names.length > 0)
          imports.push({
            source: names[0],
            names,
            line: node.startPosition.row + 1,
            pythonImport: true,
          });
        break;
      }

      case 'import_from_statement': {
        let source = '';
        const names = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === 'dotted_name' || child.type === 'relative_import') {
            if (!source) source = child.text;
            else names.push(child.text);
          }
          if (child.type === 'aliased_import') {
            const n = child.childForFieldName('name') || child.child(0);
            if (n) names.push(n.text);
          }
          if (child.type === 'wildcard_import') names.push('*');
        }
        if (source)
          imports.push({ source, names, line: node.startPosition.row + 1, pythonImport: true });
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkPythonNode(node.child(i));
  }

  function findPythonParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_definition') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  walkPythonNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}
