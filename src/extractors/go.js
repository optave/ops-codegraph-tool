import { findChild, goVisibility, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Go files.
 */
export function extractGoSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walkGoNode(node) {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const params = extractGoParameters(node.childForFieldName('parameters'));
          definitions.push({
            name: nameNode.text,
            kind: 'function',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: params.length > 0 ? params : undefined,
            visibility: goVisibility(nameNode.text),
          });
        }
        break;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const receiver = node.childForFieldName('receiver');
        if (nameNode) {
          let receiverType = null;
          if (receiver) {
            // receiver is a parameter_list like (r *Foo) or (r Foo)
            for (let i = 0; i < receiver.childCount; i++) {
              const param = receiver.child(i);
              if (!param) continue;
              const typeNode = param.childForFieldName('type');
              if (typeNode) {
                receiverType =
                  typeNode.type === 'pointer_type'
                    ? typeNode.text.replace(/^\*/, '')
                    : typeNode.text;
                break;
              }
            }
          }
          const fullName = receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text;
          const params = extractGoParameters(node.childForFieldName('parameters'));
          definitions.push({
            name: fullName,
            kind: 'method',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: params.length > 0 ? params : undefined,
            visibility: goVisibility(nameNode.text),
          });
        }
        break;
      }

      case 'type_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const spec = node.child(i);
          if (!spec || spec.type !== 'type_spec') continue;
          const nameNode = spec.childForFieldName('name');
          const typeNode = spec.childForFieldName('type');
          if (nameNode && typeNode) {
            if (typeNode.type === 'struct_type') {
              const fields = extractStructFields(typeNode);
              definitions.push({
                name: nameNode.text,
                kind: 'struct',
                line: node.startPosition.row + 1,
                endLine: nodeEndLine(node),
                children: fields.length > 0 ? fields : undefined,
              });
            } else if (typeNode.type === 'interface_type') {
              definitions.push({
                name: nameNode.text,
                kind: 'interface',
                line: node.startPosition.row + 1,
                endLine: nodeEndLine(node),
              });
              for (let j = 0; j < typeNode.childCount; j++) {
                const member = typeNode.child(j);
                if (member && member.type === 'method_elem') {
                  const methName = member.childForFieldName('name');
                  if (methName) {
                    definitions.push({
                      name: `${nameNode.text}.${methName.text}`,
                      kind: 'method',
                      line: member.startPosition.row + 1,
                      endLine: member.endPosition.row + 1,
                    });
                  }
                }
              }
            } else {
              definitions.push({
                name: nameNode.text,
                kind: 'type',
                line: node.startPosition.row + 1,
                endLine: nodeEndLine(node),
              });
            }
          }
        }
        break;
      }

      case 'import_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === 'import_spec') {
            const pathNode = child.childForFieldName('path');
            if (pathNode) {
              const importPath = pathNode.text.replace(/"/g, '');
              const nameNode = child.childForFieldName('name');
              const alias = nameNode ? nameNode.text : importPath.split('/').pop();
              imports.push({
                source: importPath,
                names: [alias],
                line: child.startPosition.row + 1,
                goImport: true,
              });
            }
          }
          if (child.type === 'import_spec_list') {
            for (let j = 0; j < child.childCount; j++) {
              const spec = child.child(j);
              if (spec && spec.type === 'import_spec') {
                const pathNode = spec.childForFieldName('path');
                if (pathNode) {
                  const importPath = pathNode.text.replace(/"/g, '');
                  const nameNode = spec.childForFieldName('name');
                  const alias = nameNode ? nameNode.text : importPath.split('/').pop();
                  imports.push({
                    source: importPath,
                    names: [alias],
                    line: spec.startPosition.row + 1,
                    goImport: true,
                  });
                }
              }
            }
          }
        }
        break;
      }

      case 'const_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const spec = node.child(i);
          if (!spec || spec.type !== 'const_spec') continue;
          const constName = spec.childForFieldName('name');
          if (constName) {
            definitions.push({
              name: constName.text,
              kind: 'constant',
              line: spec.startPosition.row + 1,
              endLine: spec.endPosition.row + 1,
            });
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          if (fn.type === 'identifier') {
            calls.push({ name: fn.text, line: node.startPosition.row + 1 });
          } else if (fn.type === 'selector_expression') {
            const field = fn.childForFieldName('field');
            if (field) {
              const operand = fn.childForFieldName('operand');
              const call = { name: field.text, line: node.startPosition.row + 1 };
              if (operand) call.receiver = operand.text;
              calls.push(call);
            }
          }
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkGoNode(node.child(i));
  }

  walkGoNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractGoParameters(paramListNode) {
  const params = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param || param.type !== 'parameter_declaration') continue;
    // A parameter_declaration may have multiple identifiers (e.g., `a, b int`)
    for (let j = 0; j < param.childCount; j++) {
      const child = param.child(j);
      if (child && child.type === 'identifier') {
        params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractStructFields(structTypeNode) {
  const fields = [];
  const fieldList = findChild(structTypeNode, 'field_declaration_list');
  if (!fieldList) return fields;
  for (let i = 0; i < fieldList.childCount; i++) {
    const field = fieldList.child(i);
    if (!field || field.type !== 'field_declaration') continue;
    const nameNode = field.childForFieldName('name');
    if (nameNode) {
      fields.push({ name: nameNode.text, kind: 'property', line: field.startPosition.row + 1 });
    } else {
      // Struct fields may have multiple names or use first identifier child
      for (let j = 0; j < field.childCount; j++) {
        const child = field.child(j);
        if (child && child.type === 'field_identifier') {
          fields.push({ name: child.text, kind: 'property', line: field.startPosition.row + 1 });
        }
      }
    }
  }
  return fields;
}
