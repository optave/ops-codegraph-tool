import { findChild, nodeEndLine, pythonVisibility } from './helpers.js';

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
            visibility: pythonVisibility(nameNode.text),
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
            props.push({
              name: left.text,
              kind: 'property',
              line: child.startPosition.row + 1,
              visibility: pythonVisibility(left.text),
            });
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
        props.push({
          name: attr.text,
          kind: 'property',
          line: stmt.startPosition.row + 1,
          visibility: pythonVisibility(attr.text),
        });
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

  // Extract variable-to-type assignments for receiver type tracking
  const typeAssignments = [];
  extractPythonTypeAssignments(tree.rootNode, typeAssignments);

  return { definitions, calls, imports, classes, exports, typeAssignments };
}

/**
 * Extract variable-to-type assignments from Python AST.
 *
 * Patterns:
 *   1. x = SomeClass(...)           → confidence 1.0 (constructor call)
 *   2. x: SomeClass = ...           → confidence 0.9 (type annotation)
 *   3. x = SomeClass.create(...)    → confidence 0.7 (factory method)
 */
function extractPythonTypeAssignments(node, typeAssignments) {
  // assignment: x = SomeClass(...) or x: SomeClass = ...
  if (node.type === 'assignment') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    const typeAnno = node.childForFieldName('type');
    if (left && left.type === 'identifier') {
      const varName = left.text;

      // Pattern 1: x = SomeClass(...) — constructor call with uppercase name
      if (right && right.type === 'call') {
        const fn = right.childForFieldName('function');
        if (fn && fn.type === 'identifier') {
          const name = fn.text;
          if (name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
            typeAssignments.push({
              variable: varName,
              type: name,
              line: node.startPosition.row + 1,
              confidence: 1.0,
            });
            return;
          }
        }
        // Pattern 3: x = SomeClass.create(...)
        if (fn && fn.type === 'attribute') {
          const obj = fn.childForFieldName('object');
          if (obj && obj.type === 'identifier') {
            const objName = obj.text;
            if (
              objName[0] === objName[0].toUpperCase() &&
              objName[0] !== objName[0].toLowerCase()
            ) {
              typeAssignments.push({
                variable: varName,
                type: objName,
                line: node.startPosition.row + 1,
                confidence: 0.7,
              });
              return;
            }
          }
        }
      }

      // Pattern 2: x: SomeClass = ...
      if (typeAnno && typeAnno.type === 'type') {
        const typeIdent = typeAnno.child(0);
        if (typeIdent && typeIdent.type === 'identifier') {
          typeAssignments.push({
            variable: varName,
            type: typeIdent.text,
            line: node.startPosition.row + 1,
            confidence: 0.9,
          });
          return;
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    extractPythonTypeAssignments(node.child(i), typeAssignments);
  }
}
