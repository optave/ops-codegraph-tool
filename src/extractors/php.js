import { findChild, nodeEndLine } from './helpers.js';

function extractPhpParameters(fnNode) {
  const params = [];
  const paramsNode =
    fnNode.childForFieldName('parameters') || findChild(fnNode, 'formal_parameters');
  if (!paramsNode) return params;
  for (let i = 0; i < paramsNode.childCount; i++) {
    const param = paramsNode.child(i);
    if (!param) continue;
    if (param.type === 'simple_parameter' || param.type === 'variadic_parameter') {
      const nameNode = param.childForFieldName('name') || findChild(param, 'variable_name');
      if (nameNode) {
        params.push({ name: nameNode.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractPhpClassChildren(classNode) {
  const children = [];
  const body = classNode.childForFieldName('body') || findChild(classNode, 'declaration_list');
  if (!body) return children;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;
    if (member.type === 'property_declaration') {
      for (let j = 0; j < member.childCount; j++) {
        const el = member.child(j);
        if (!el || el.type !== 'property_element') continue;
        const varNode = findChild(el, 'variable_name');
        if (varNode) {
          children.push({
            name: varNode.text,
            kind: 'property',
            line: member.startPosition.row + 1,
          });
        }
      }
    } else if (member.type === 'const_declaration') {
      for (let j = 0; j < member.childCount; j++) {
        const el = member.child(j);
        if (!el || el.type !== 'const_element') continue;
        const nameNode = el.childForFieldName('name') || findChild(el, 'name');
        if (nameNode) {
          children.push({
            name: nameNode.text,
            kind: 'constant',
            line: member.startPosition.row + 1,
          });
        }
      }
    }
  }
  return children;
}

function extractPhpEnumCases(enumNode) {
  const children = [];
  const body = enumNode.childForFieldName('body') || findChild(enumNode, 'enum_declaration_list');
  if (!body) return children;
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== 'enum_case') continue;
    const nameNode = member.childForFieldName('name');
    if (nameNode) {
      children.push({ name: nameNode.text, kind: 'constant', line: member.startPosition.row + 1 });
    }
  }
  return children;
}

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
          const params = extractPhpParameters(node);
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: params.length > 0 ? params : undefined,
          });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const classChildren = extractPhpClassChildren(node);
          definitions.push({
            name: nameNode.text,
            kind: 'class',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: classChildren.length > 0 ? classChildren : undefined,
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
          const enumChildren = extractPhpEnumCases(node);
          definitions.push({
            name: nameNode.text,
            kind: 'enum',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: enumChildren.length > 0 ? enumChildren : undefined,
          });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const parentClass = findPHPParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          const params = extractPhpParameters(node);
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: params.length > 0 ? params : undefined,
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
          const obj = node.childForFieldName('object');
          const call = { name: name.text, line: node.startPosition.row + 1 };
          if (obj) call.receiver = obj.text;
          calls.push(call);
        }
        break;
      }

      case 'scoped_call_expression': {
        const name = node.childForFieldName('name');
        if (name) {
          const scope = node.childForFieldName('scope');
          const call = { name: name.text, line: node.startPosition.row + 1 };
          if (scope) call.receiver = scope.text;
          calls.push(call);
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
