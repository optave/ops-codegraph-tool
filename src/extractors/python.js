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
          const fnChildren = extractPythonParameters(node);
          definitions.push({
            name: fullName,
            kind,
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            decorators,
            children: fnChildren.length > 0 ? fnChildren : undefined,
          });
        }
        break;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const clsChildren = extractPythonClassProperties(node);
          definitions.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: clsChildren.length > 0 ? clsChildren : undefined,
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

      case 'expression_statement': {
        // Module-level UPPER_CASE assignments → constants
        if (node.parent && node.parent.type === 'module') {
          const assignment = findChild(node, 'assignment');
          if (assignment) {
            const left = assignment.childForFieldName('left');
            if (left && left.type === 'identifier' && /^[A-Z_][A-Z0-9_]*$/.test(left.text)) {
              definitions.push({
                name: left.text,
                kind: 'constant',
                line: node.startPosition.row + 1,
              });
            }
          }
        }
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

  function extractPythonParameters(fnNode) {
    const params = [];
    const paramsNode = fnNode.childForFieldName('parameters') || findChild(fnNode, 'parameters');
    if (!paramsNode) return params;
    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i);
      if (!child) continue;
      const t = child.type;
      if (t === 'identifier') {
        params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
      } else if (
        t === 'typed_parameter' ||
        t === 'default_parameter' ||
        t === 'typed_default_parameter'
      ) {
        const nameNode = child.childForFieldName('name') || child.child(0);
        if (nameNode && nameNode.type === 'identifier') {
          params.push({
            name: nameNode.text,
            kind: 'parameter',
            line: child.startPosition.row + 1,
          });
        }
      } else if (t === 'list_splat_pattern' || t === 'dictionary_splat_pattern') {
        // *args, **kwargs
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner && inner.type === 'identifier') {
            params.push({ name: inner.text, kind: 'parameter', line: child.startPosition.row + 1 });
            break;
          }
        }
      }
    }
    return params;
  }

  function extractPythonClassProperties(classNode) {
    const props = [];
    const seen = new Set();
    const body = classNode.childForFieldName('body') || findChild(classNode, 'block');
    if (!body) return props;

    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (!child) continue;

      // Direct class attribute assignments: x = 5
      if (child.type === 'expression_statement') {
        const assignment = findChild(child, 'assignment');
        if (assignment) {
          const left = assignment.childForFieldName('left');
          if (left && left.type === 'identifier' && !seen.has(left.text)) {
            seen.add(left.text);
            props.push({ name: left.text, kind: 'property', line: child.startPosition.row + 1 });
          }
        }
      }

      // __init__ method: self.x = ... assignments
      if (child.type === 'function_definition') {
        const fnName = child.childForFieldName('name');
        if (fnName && fnName.text === '__init__') {
          const initBody = child.childForFieldName('body') || findChild(child, 'block');
          if (initBody) {
            walkInitBody(initBody, seen, props);
          }
        }
      }

      // decorated __init__
      if (child.type === 'decorated_definition') {
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j);
          if (inner && inner.type === 'function_definition') {
            const fnName = inner.childForFieldName('name');
            if (fnName && fnName.text === '__init__') {
              const initBody = inner.childForFieldName('body') || findChild(inner, 'block');
              if (initBody) {
                walkInitBody(initBody, seen, props);
              }
            }
          }
        }
      }
    }
    return props;
  }

  function walkInitBody(bodyNode, seen, props) {
    for (let i = 0; i < bodyNode.childCount; i++) {
      const stmt = bodyNode.child(i);
      if (!stmt || stmt.type !== 'expression_statement') continue;
      const assignment = findChild(stmt, 'assignment');
      if (!assignment) continue;
      const left = assignment.childForFieldName('left');
      if (!left || left.type !== 'attribute') continue;
      const obj = left.childForFieldName('object');
      const attr = left.childForFieldName('attribute');
      if (
        obj &&
        obj.text === 'self' &&
        attr &&
        attr.type === 'identifier' &&
        !seen.has(attr.text)
      ) {
        seen.add(attr.text);
        props.push({ name: attr.text, kind: 'property', line: stmt.startPosition.row + 1 });
      }
    }
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
