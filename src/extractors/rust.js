import { findChild, nodeEndLine, rustVisibility } from './helpers.js';

/**
 * Extract symbols from Rust files.
 */
export function extractRustSymbols(tree, _filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function findCurrentImpl(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'impl_item') {
        const typeNode = current.childForFieldName('type');
        return typeNode ? typeNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  function walkRustNode(node) {
    switch (node.type) {
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const implType = findCurrentImpl(node);
          const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
          const kind = implType ? 'method' : 'function';
          const params = extractRustParameters(node.childForFieldName('parameters'));
          definitions.push({
            name: fullName,
            kind,
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: params.length > 0 ? params : undefined,
            visibility: rustVisibility(node),
          });
        }
        break;
      }

      case 'struct_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const fields = extractStructFields(node);
          definitions.push({
            name: nameNode.text,
            kind: 'struct',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: fields.length > 0 ? fields : undefined,
            visibility: rustVisibility(node),
          });
        }
        break;
      }

      case 'enum_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const variants = extractEnumVariants(node);
          definitions.push({
            name: nameNode.text,
            kind: 'enum',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
            children: variants.length > 0 ? variants : undefined,
          });
        }
        break;
      }

      case 'const_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'constant',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
        }
        break;
      }

      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({
            name: nameNode.text,
            kind: 'trait',
            line: node.startPosition.row + 1,
            endLine: nodeEndLine(node),
          });
          const body = node.childForFieldName('body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const child = body.child(i);
              if (
                child &&
                (child.type === 'function_signature_item' || child.type === 'function_item')
              ) {
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

      case 'impl_item': {
        const typeNode = node.childForFieldName('type');
        const traitNode = node.childForFieldName('trait');
        if (typeNode && traitNode) {
          classes.push({
            name: typeNode.text,
            implements: traitNode.text,
            line: node.startPosition.row + 1,
          });
        }
        break;
      }

      case 'use_declaration': {
        const argNode = node.child(1);
        if (argNode) {
          const usePaths = extractRustUsePath(argNode);
          for (const imp of usePaths) {
            imports.push({
              source: imp.source,
              names: imp.names,
              line: node.startPosition.row + 1,
              rustUse: true,
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
          } else if (fn.type === 'field_expression') {
            const field = fn.childForFieldName('field');
            if (field) {
              const value = fn.childForFieldName('value');
              const call = { name: field.text, line: node.startPosition.row + 1 };
              if (value) call.receiver = value.text;
              calls.push(call);
            }
          } else if (fn.type === 'scoped_identifier') {
            const name = fn.childForFieldName('name');
            if (name) {
              const path = fn.childForFieldName('path');
              const call = { name: name.text, line: node.startPosition.row + 1 };
              if (path) call.receiver = path.text;
              calls.push(call);
            }
          }
        }
        break;
      }

      case 'macro_invocation': {
        const macroNode = node.child(0);
        if (macroNode) {
          calls.push({ name: `${macroNode.text}!`, line: node.startPosition.row + 1 });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) walkRustNode(node.child(i));
  }

  walkRustNode(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

// ── Child extraction helpers ────────────────────────────────────────────────

function extractRustParameters(paramListNode) {
  const params = [];
  if (!paramListNode) return params;
  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param) continue;
    if (param.type === 'self_parameter') {
      params.push({ name: 'self', kind: 'parameter', line: param.startPosition.row + 1 });
    } else if (param.type === 'parameter') {
      const pattern = param.childForFieldName('pattern');
      if (pattern) {
        params.push({ name: pattern.text, kind: 'parameter', line: param.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function extractStructFields(structNode) {
  const fields = [];
  const fieldList =
    structNode.childForFieldName('body') || findChild(structNode, 'field_declaration_list');
  if (!fieldList) return fields;
  for (let i = 0; i < fieldList.childCount; i++) {
    const field = fieldList.child(i);
    if (!field || field.type !== 'field_declaration') continue;
    const nameNode = field.childForFieldName('name');
    if (nameNode) {
      fields.push({ name: nameNode.text, kind: 'property', line: field.startPosition.row + 1 });
    }
  }
  return fields;
}

function extractEnumVariants(enumNode) {
  const variants = [];
  const body = enumNode.childForFieldName('body') || findChild(enumNode, 'enum_variant_list');
  if (!body) return variants;
  for (let i = 0; i < body.childCount; i++) {
    const variant = body.child(i);
    if (!variant || variant.type !== 'enum_variant') continue;
    const nameNode = variant.childForFieldName('name');
    if (nameNode) {
      variants.push({ name: nameNode.text, kind: 'constant', line: variant.startPosition.row + 1 });
    }
  }
  return variants;
}

function extractRustUsePath(node) {
  if (!node) return [];

  if (node.type === 'use_list') {
    const results = [];
    for (let i = 0; i < node.childCount; i++) {
      results.push(...extractRustUsePath(node.child(i)));
    }
    return results;
  }

  if (node.type === 'scoped_use_list') {
    const pathNode = node.childForFieldName('path');
    const listNode = node.childForFieldName('list');
    const prefix = pathNode ? pathNode.text : '';
    if (listNode) {
      const names = [];
      for (let i = 0; i < listNode.childCount; i++) {
        const child = listNode.child(i);
        if (
          child &&
          (child.type === 'identifier' || child.type === 'use_as_clause' || child.type === 'self')
        ) {
          const name =
            child.type === 'use_as_clause'
              ? (child.childForFieldName('alias') || child.childForFieldName('name'))?.text
              : child.text;
          if (name) names.push(name);
        }
      }
      return [{ source: prefix, names }];
    }
    return [{ source: prefix, names: [] }];
  }

  if (node.type === 'use_as_clause') {
    const name = node.childForFieldName('alias') || node.childForFieldName('name');
    return [{ source: node.text, names: name ? [name.text] : [] }];
  }

  if (node.type === 'use_wildcard') {
    const pathNode = node.childForFieldName('path');
    return [{ source: pathNode ? pathNode.text : '*', names: ['*'] }];
  }

  if (node.type === 'scoped_identifier' || node.type === 'identifier') {
    const text = node.text;
    const lastName = text.split('::').pop();
    return [{ source: text, names: [lastName] }];
  }

  return [];
}
