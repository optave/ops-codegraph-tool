import { findChild, nodeEndLine, rustVisibility } from './helpers.js';

/**
 * Extract symbols from Rust files.
 */
export function extractRustSymbols(tree, _filePath) {
  const ctx = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkRustNode(tree.rootNode, ctx);
  extractRustTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkRustNode(node, ctx) {
  switch (node.type) {
    case 'function_item':
      handleRustFuncItem(node, ctx);
      break;
    case 'struct_item':
      handleRustStructItem(node, ctx);
      break;
    case 'enum_item':
      handleRustEnumItem(node, ctx);
      break;
    case 'const_item':
      handleRustConstItem(node, ctx);
      break;
    case 'trait_item':
      handleRustTraitItem(node, ctx);
      break;
    case 'impl_item':
      handleRustImplItem(node, ctx);
      break;
    case 'use_declaration':
      handleRustUseDecl(node, ctx);
      break;
    case 'call_expression':
      handleRustCallExpr(node, ctx);
      break;
    case 'macro_invocation':
      handleRustMacroInvocation(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) walkRustNode(node.child(i), ctx);
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleRustFuncItem(node, ctx) {
  // Skip default-impl functions already emitted by handleRustTraitItem
  if (node.parent?.parent?.type === 'trait_item') return;
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const implType = findCurrentImpl(node);
  const fullName = implType ? `${implType}.${nameNode.text}` : nameNode.text;
  const kind = implType ? 'method' : 'function';
  const params = extractRustParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: rustVisibility(node),
  });
}

function handleRustStructItem(node, ctx) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const fields = extractStructFields(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: fields.length > 0 ? fields : undefined,
    visibility: rustVisibility(node),
  });
}

function handleRustEnumItem(node, ctx) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const variants = extractEnumVariants(node);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: variants.length > 0 ? variants : undefined,
  });
}

function handleRustConstItem(node, ctx) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'constant',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleRustTraitItem(node, ctx) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'trait',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  const body = node.childForFieldName('body');
  if (body) {
    for (let i = 0; i < body.childCount; i++) {
      const child = body.child(i);
      if (child && (child.type === 'function_signature_item' || child.type === 'function_item')) {
        const methName = child.childForFieldName('name');
        if (methName) {
          ctx.definitions.push({
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

function handleRustImplItem(node, ctx) {
  const typeNode = node.childForFieldName('type');
  const traitNode = node.childForFieldName('trait');
  if (typeNode && traitNode) {
    ctx.classes.push({
      name: typeNode.text,
      implements: traitNode.text,
      line: node.startPosition.row + 1,
    });
  }
}

function handleRustUseDecl(node, ctx) {
  const argNode = node.child(1);
  if (!argNode) return;
  const usePaths = extractRustUsePath(argNode);
  for (const imp of usePaths) {
    ctx.imports.push({
      source: imp.source,
      names: imp.names,
      line: node.startPosition.row + 1,
      rustUse: true,
    });
  }
}

function handleRustCallExpr(node, ctx) {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    ctx.calls.push({ name: fn.text, line: node.startPosition.row + 1 });
  } else if (fn.type === 'field_expression') {
    const field = fn.childForFieldName('field');
    if (field) {
      const value = fn.childForFieldName('value');
      const call = { name: field.text, line: node.startPosition.row + 1 };
      if (value) call.receiver = value.text;
      ctx.calls.push(call);
    }
  } else if (fn.type === 'scoped_identifier') {
    const name = fn.childForFieldName('name');
    if (name) {
      const path = fn.childForFieldName('path');
      const call = { name: name.text, line: node.startPosition.row + 1 };
      if (path) call.receiver = path.text;
      ctx.calls.push(call);
    }
  }
}

function handleRustMacroInvocation(node, ctx) {
  const macroNode = node.child(0);
  if (macroNode) {
    ctx.calls.push({ name: `${macroNode.text}!`, line: node.startPosition.row + 1 });
  }
}

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

function extractRustTypeMap(node, ctx) {
  extractRustTypeMapDepth(node, ctx, 0);
}

function extractRustTypeMapDepth(node, ctx, depth) {
  if (depth >= 200) return;

  // let x: MyType = ...
  if (node.type === 'let_declaration') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && pattern.type === 'identifier' && typeNode) {
      const typeName = extractRustTypeName(typeNode);
      if (typeName) ctx.typeMap.set(pattern.text, { type: typeName, confidence: 0.9 });
    }
  }

  // fn foo(x: MyType) — parameter node has pattern + type fields
  if (node.type === 'parameter') {
    const pattern = node.childForFieldName('pattern');
    const typeNode = node.childForFieldName('type');
    if (pattern && typeNode) {
      const name = pattern.type === 'identifier' ? pattern.text : null;
      if (name && name !== 'self' && name !== '&self' && name !== '&mut self') {
        const typeName = extractRustTypeName(typeNode);
        if (typeName) ctx.typeMap.set(name, { type: typeName, confidence: 0.9 });
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractRustTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractRustTypeName(typeNode) {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'type_identifier' || t === 'identifier') return typeNode.text;
  if (t === 'scoped_type_identifier') return typeNode.text;
  // Reference: &MyType or &mut MyType → MyType
  if (t === 'reference_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child && (child.type === 'type_identifier' || child.type === 'scoped_type_identifier')) {
        return child.text;
      }
    }
  }
  // Generic: Vec<T> → Vec
  if (t === 'generic_type') {
    const first = typeNode.child(0);
    return first ? first.text : null;
  }
  return null;
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
