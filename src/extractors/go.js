import { findChild, goVisibility, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Go files.
 */
export function extractGoSymbols(tree, _filePath) {
  const ctx = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkGoNode(tree.rootNode, ctx);
  extractGoTypeMap(tree.rootNode, ctx);
  return ctx;
}

function walkGoNode(node, ctx) {
  switch (node.type) {
    case 'function_declaration':
      handleGoFuncDecl(node, ctx);
      break;
    case 'method_declaration':
      handleGoMethodDecl(node, ctx);
      break;
    case 'type_declaration':
      handleGoTypeDecl(node, ctx);
      break;
    case 'import_declaration':
      handleGoImportDecl(node, ctx);
      break;
    case 'const_declaration':
      handleGoConstDecl(node, ctx);
      break;
    case 'call_expression':
      handleGoCallExpr(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) walkGoNode(node.child(i), ctx);
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleGoFuncDecl(node, ctx) {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const params = extractGoParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: goVisibility(nameNode.text),
  });
}

function handleGoMethodDecl(node, ctx) {
  const nameNode = node.childForFieldName('name');
  const receiver = node.childForFieldName('receiver');
  if (!nameNode) return;
  let receiverType = null;
  if (receiver) {
    for (let i = 0; i < receiver.childCount; i++) {
      const param = receiver.child(i);
      if (!param) continue;
      const typeNode = param.childForFieldName('type');
      if (typeNode) {
        receiverType =
          typeNode.type === 'pointer_type' ? typeNode.text.replace(/^\*/, '') : typeNode.text;
        break;
      }
    }
  }
  const fullName = receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text;
  const params = extractGoParameters(node.childForFieldName('parameters'));
  ctx.definitions.push({
    name: fullName,
    kind: 'method',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
    visibility: goVisibility(nameNode.text),
  });
}

function handleGoTypeDecl(node, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const spec = node.child(i);
    if (!spec || spec.type !== 'type_spec') continue;
    const nameNode = spec.childForFieldName('name');
    const typeNode = spec.childForFieldName('type');
    if (nameNode && typeNode) {
      if (typeNode.type === 'struct_type') {
        const fields = extractStructFields(typeNode);
        ctx.definitions.push({
          name: nameNode.text,
          kind: 'struct',
          line: node.startPosition.row + 1,
          endLine: nodeEndLine(node),
          children: fields.length > 0 ? fields : undefined,
        });
      } else if (typeNode.type === 'interface_type') {
        ctx.definitions.push({
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
              ctx.definitions.push({
                name: `${nameNode.text}.${methName.text}`,
                kind: 'method',
                line: member.startPosition.row + 1,
                endLine: member.endPosition.row + 1,
              });
            }
          }
        }
      } else {
        ctx.definitions.push({
          name: nameNode.text,
          kind: 'type',
          line: node.startPosition.row + 1,
          endLine: nodeEndLine(node),
        });
      }
    }
  }
}

function handleGoImportDecl(node, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'import_spec') {
      extractGoImportSpec(child, ctx);
    }
    if (child.type === 'import_spec_list') {
      for (let j = 0; j < child.childCount; j++) {
        const spec = child.child(j);
        if (spec && spec.type === 'import_spec') {
          extractGoImportSpec(spec, ctx);
        }
      }
    }
  }
}

function extractGoImportSpec(spec, ctx) {
  const pathNode = spec.childForFieldName('path');
  if (pathNode) {
    const importPath = pathNode.text.replace(/"/g, '');
    const nameNode = spec.childForFieldName('name');
    const alias = nameNode ? nameNode.text : importPath.split('/').pop();
    ctx.imports.push({
      source: importPath,
      names: [alias],
      line: spec.startPosition.row + 1,
      goImport: true,
    });
  }
}

function handleGoConstDecl(node, ctx) {
  for (let i = 0; i < node.childCount; i++) {
    const spec = node.child(i);
    if (!spec || spec.type !== 'const_spec') continue;
    const constName = spec.childForFieldName('name');
    if (constName) {
      ctx.definitions.push({
        name: constName.text,
        kind: 'constant',
        line: spec.startPosition.row + 1,
        endLine: spec.endPosition.row + 1,
      });
    }
  }
}

function handleGoCallExpr(node, ctx) {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    ctx.calls.push({ name: fn.text, line: node.startPosition.row + 1 });
  } else if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    if (field) {
      const operand = fn.childForFieldName('operand');
      const call = { name: field.text, line: node.startPosition.row + 1 };
      if (operand) call.receiver = operand.text;
      ctx.calls.push(call);
    }
  }
}

// ── Type map extraction ─────────────────────────────────────────────────────

function extractGoTypeMap(node, ctx) {
  extractGoTypeMapDepth(node, ctx, 0);
}

function setIfHigher(typeMap, name, type, confidence) {
  const existing = typeMap.get(name);
  if (!existing || confidence > existing.confidence) {
    typeMap.set(name, { type, confidence });
  }
}

function extractGoTypeMapDepth(node, ctx, depth) {
  if (depth >= 200) return;

  // var x MyType = ... or var x, y MyType → var_declaration > var_spec (confidence 0.9)
  if (node.type === 'var_spec') {
    const typeNode = node.childForFieldName('type');
    if (typeNode) {
      const typeName = extractGoTypeName(typeNode);
      if (typeName) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'identifier') {
            setIfHigher(ctx.typeMap, child.text, typeName, 0.9);
          }
        }
      }
    }
  }

  // Function/method parameter types: parameter_declaration (confidence 0.9)
  if (node.type === 'parameter_declaration') {
    const typeNode = node.childForFieldName('type');
    if (typeNode) {
      const typeName = extractGoTypeName(typeNode);
      if (typeName) {
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && child.type === 'identifier') {
            setIfHigher(ctx.typeMap, child.text, typeName, 0.9);
          }
        }
      }
    }
  }

  // short_var_declaration: x := Struct{}, x := &Struct{}, x := NewFoo()
  // Handles multi-variable forms: x, y := A{}, B{}
  if (node.type === 'short_var_declaration') {
    const left = node.childForFieldName('left');
    const right = node.childForFieldName('right');
    if (left && right) {
      const lefts =
        left.type === 'expression_list'
          ? Array.from({ length: left.childCount }, (_, i) => left.child(i)).filter(
              (c) => c?.type === 'identifier',
            )
          : left.type === 'identifier'
            ? [left]
            : [];
      const rights =
        right.type === 'expression_list'
          ? Array.from({ length: right.childCount }, (_, i) => right.child(i)).filter(
              (c) => c?.isNamed,
            )
          : [right];

      for (let idx = 0; idx < lefts.length; idx++) {
        const varNode = lefts[idx];
        const rhs = rights[idx];
        if (!varNode || !rhs) continue;

        // x := Struct{...} — composite literal (confidence 1.0)
        if (rhs.type === 'composite_literal') {
          const typeNode = rhs.childForFieldName('type');
          if (typeNode) {
            const typeName = extractGoTypeName(typeNode);
            if (typeName) setIfHigher(ctx.typeMap, varNode.text, typeName, 1.0);
          }
        }
        // x := &Struct{...} — address-of composite literal (confidence 1.0)
        if (rhs.type === 'unary_expression') {
          const operand = rhs.childForFieldName('operand');
          if (operand && operand.type === 'composite_literal') {
            const typeNode = operand.childForFieldName('type');
            if (typeNode) {
              const typeName = extractGoTypeName(typeNode);
              if (typeName) setIfHigher(ctx.typeMap, varNode.text, typeName, 1.0);
            }
          }
        }
        // x := NewFoo() or x := pkg.NewFoo() — factory function (confidence 0.7)
        if (rhs.type === 'call_expression') {
          const fn = rhs.childForFieldName('function');
          if (fn && fn.type === 'selector_expression') {
            const field = fn.childForFieldName('field');
            if (field?.text.startsWith('New')) {
              const typeName = field.text.slice(3);
              if (typeName) setIfHigher(ctx.typeMap, varNode.text, typeName, 0.7);
            }
          } else if (fn && fn.type === 'identifier' && fn.text.startsWith('New')) {
            const typeName = fn.text.slice(3);
            if (typeName) setIfHigher(ctx.typeMap, varNode.text, typeName, 0.7);
          }
        }
      }
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractGoTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractGoTypeName(typeNode) {
  if (!typeNode) return null;
  const t = typeNode.type;
  if (t === 'type_identifier' || t === 'identifier') return typeNode.text;
  if (t === 'qualified_type') return typeNode.text;
  // pointer type: *MyType → MyType
  if (t === 'pointer_type') {
    for (let i = 0; i < typeNode.childCount; i++) {
      const child = typeNode.child(i);
      if (child && (child.type === 'type_identifier' || child.type === 'identifier')) {
        return child.text;
      }
    }
  }
  // generic type: MyType[T] → MyType
  if (t === 'generic_type') {
    const first = typeNode.child(0);
    return first ? first.text : null;
  }
  return null;
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
