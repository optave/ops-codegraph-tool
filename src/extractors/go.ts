import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import {
  findChild,
  goVisibility,
  lastPathSegment,
  MAX_WALK_DEPTH,
  nodeEndLine,
  setTypeMapEntry,
  stripQuotes,
} from './helpers.js';

/**
 * Extract symbols from Go files.
 */
export function extractGoSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkGoNode(tree.rootNode, ctx);
  extractGoTypeMap(tree.rootNode, ctx);
  matchGoStructuralInterfaces(ctx);
  return ctx;
}

function walkGoNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkGoNode(child, ctx);
  }
}

// ── Walk-path per-node-type handlers ────────────────────────────────────────

function handleGoFuncDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleGoMethodDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const receiver = node.childForFieldName('receiver');
  const receiverType = receiver ? extractGoReceiverType(receiver) : null;
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

/** Extract the receiver type name from a method receiver parameter list. */
function extractGoReceiverType(receiver: TreeSitterNode): string | null {
  for (let i = 0; i < receiver.childCount; i++) {
    const param = receiver.child(i);
    if (!param) continue;
    const typeNode = param.childForFieldName('type');
    if (typeNode) {
      return typeNode.type === 'pointer_type' ? typeNode.text.replace(/^\*/, '') : typeNode.text;
    }
  }
  return null;
}

function handleGoTypeDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const spec = node.child(i);
    if (!spec || spec.type !== 'type_spec') continue;
    const nameNode = spec.childForFieldName('name');
    const typeNode = spec.childForFieldName('type');
    if (!nameNode || !typeNode) continue;

    if (typeNode.type === 'struct_type') {
      handleGoStructType(node, nameNode, typeNode, ctx);
    } else if (typeNode.type === 'interface_type') {
      handleGoInterfaceType(node, nameNode, typeNode, ctx);
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

/** Handle a struct type_spec: emit struct definition with field children. */
function handleGoStructType(
  declNode: TreeSitterNode,
  nameNode: TreeSitterNode,
  typeNode: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  const fields = extractStructFields(typeNode);
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: declNode.startPosition.row + 1,
    endLine: nodeEndLine(declNode),
    children: fields.length > 0 ? fields : undefined,
  });
}

/** Handle an interface type_spec: emit interface definition + method definitions. */
function handleGoInterfaceType(
  declNode: TreeSitterNode,
  nameNode: TreeSitterNode,
  typeNode: TreeSitterNode,
  ctx: ExtractorOutput,
): void {
  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: declNode.startPosition.row + 1,
    endLine: nodeEndLine(declNode),
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
}

function handleGoImportDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function extractGoImportSpec(spec: TreeSitterNode, ctx: ExtractorOutput): void {
  const pathNode = spec.childForFieldName('path');
  if (pathNode) {
    const importPath = stripQuotes(pathNode.text);
    const nameNode = spec.childForFieldName('name');
    const alias = nameNode ? nameNode.text : lastPathSegment(importPath);
    ctx.imports.push({
      source: importPath,
      names: [alias],
      line: spec.startPosition.row + 1,
      goImport: true,
    });
  }
}

function handleGoConstDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
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

function handleGoCallExpr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const fn = node.childForFieldName('function');
  if (!fn) return;
  if (fn.type === 'identifier') {
    ctx.calls.push({ name: fn.text, line: node.startPosition.row + 1 });
  } else if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    if (field) {
      const operand = fn.childForFieldName('operand');
      const call: Call = { name: field.text, line: node.startPosition.row + 1 };
      if (operand) call.receiver = operand.text;
      ctx.calls.push(call);
    }
  }
}

// ── Type map extraction ─────────────────────────────────────────────────────

function extractGoTypeMap(node: TreeSitterNode, ctx: ExtractorOutput): void {
  extractGoTypeMapDepth(node, ctx, 0);
}

/** Map identifiers in a typed declaration node to their type (confidence 0.9). */
function handleTypedIdentifiers(
  node: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): void {
  const typeNode = node.childForFieldName('type');
  if (!typeNode) return;
  const typeName = extractGoTypeName(typeNode);
  if (!typeName) return;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'identifier') {
      setTypeMapEntry(typeMap, child.text, typeName, 0.9);
    }
  }
}

/** Infer type from a single RHS expression in a short var declaration. */
/** x := Struct{...} — composite literal (confidence 1.0). */
function inferCompositeLiteral(
  varNode: TreeSitterNode,
  rhs: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): boolean {
  if (rhs.type !== 'composite_literal') return false;
  const typeNode = rhs.childForFieldName('type');
  if (!typeNode) return false;
  const typeName = extractGoTypeName(typeNode);
  if (typeName) setTypeMapEntry(typeMap, varNode.text, typeName, 1.0);
  return true;
}

/** x := &Struct{...} — address-of composite literal (confidence 1.0). */
function inferAddressOfComposite(
  varNode: TreeSitterNode,
  rhs: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): boolean {
  if (rhs.type !== 'unary_expression') return false;
  const operand = rhs.childForFieldName('operand');
  if (!operand || operand.type !== 'composite_literal') return false;
  const typeNode = operand.childForFieldName('type');
  if (!typeNode) return false;
  const typeName = extractGoTypeName(typeNode);
  if (typeName) setTypeMapEntry(typeMap, varNode.text, typeName, 1.0);
  return true;
}

/** x := NewFoo() or x := pkg.NewFoo() — factory function (confidence 0.7). */
function inferFactoryCall(
  varNode: TreeSitterNode,
  rhs: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): boolean {
  if (rhs.type !== 'call_expression') return false;
  const fn = rhs.childForFieldName('function');
  if (!fn) return false;

  if (fn.type === 'selector_expression') {
    const field = fn.childForFieldName('field');
    if (field?.text.startsWith('New')) {
      const typeName = field.text.slice(3);
      if (typeName) setTypeMapEntry(typeMap, varNode.text, typeName, 0.7);
      return true;
    }
  } else if (fn.type === 'identifier' && fn.text.startsWith('New')) {
    const typeName = fn.text.slice(3);
    if (typeName) setTypeMapEntry(typeMap, varNode.text, typeName, 0.7);
    return true;
  }
  return false;
}

function inferShortVarType(
  varNode: TreeSitterNode,
  rhs: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): void {
  if (inferCompositeLiteral(varNode, rhs, typeMap)) return;
  if (inferAddressOfComposite(varNode, rhs, typeMap)) return;
  inferFactoryCall(varNode, rhs, typeMap);
}

/** Handle short_var_declaration: x := Struct{}, x := &Struct{}, x := NewFoo(). */
function handleShortVarDecl(
  node: TreeSitterNode,
  typeMap: Map<string, { type: string; confidence: number }>,
): void {
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (!left || !right) return;

  const lefts =
    left.type === 'expression_list'
      ? Array.from({ length: left.childCount }, (_, i) => left.child(i)).filter(
          (c): c is TreeSitterNode => c?.type === 'identifier',
        )
      : left.type === 'identifier'
        ? [left]
        : [];
  const rights =
    right.type === 'expression_list'
      ? Array.from({ length: right.childCount }, (_, i) => right.child(i)).filter(
          (c): c is TreeSitterNode => !!c?.type,
        )
      : [right];

  for (let idx = 0; idx < lefts.length; idx++) {
    const varNode = lefts[idx];
    const rhs = rights[idx];
    if (!varNode || !rhs) continue;
    inferShortVarType(varNode, rhs, typeMap);
  }
}

function extractGoTypeMapDepth(node: TreeSitterNode, ctx: ExtractorOutput, depth: number): void {
  if (depth >= MAX_WALK_DEPTH) return;

  if (ctx.typeMap) {
    if (node.type === 'var_spec' || node.type === 'parameter_declaration') {
      handleTypedIdentifiers(node, ctx.typeMap);
    } else if (node.type === 'short_var_declaration') {
      handleShortVarDecl(node, ctx.typeMap);
    }
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) extractGoTypeMapDepth(child, ctx, depth + 1);
  }
}

function extractGoTypeName(typeNode: TreeSitterNode): string | null {
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

function extractGoParameters(paramListNode: TreeSitterNode | null): SubDeclaration[] {
  const params: SubDeclaration[] = [];
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

// ── Go structural interface matching ─────────────────────────────────────

/**
 * Go interfaces are satisfied structurally: a struct implements an interface
 * if it has methods matching every method declared in the interface.
 * This performs file-local matching (cross-file matching requires build-edges).
 */
function matchGoStructuralInterfaces(ctx: ExtractorOutput): void {
  const { interfaceMethods, structMethods, structLines } = collectGoMethodSets(ctx);

  // Match: struct satisfies interface if it has all interface methods (name-only;
  // signatures are not verified — treat as candidate match, not definitive).
  // NOTE: embedded interfaces (type_elem nodes) are not resolved — composite
  // interfaces like `type ReadWriter interface { Reader; Writer }` will have an
  // empty method set and be silently excluded from matching.
  for (const [structName, methods] of structMethods) {
    for (const [ifaceName, ifaceMethods] of interfaceMethods) {
      if (ifaceMethods.size > 0 && [...ifaceMethods].every((m) => methods.has(m))) {
        ctx.classes.push({
          name: structName,
          implements: ifaceName,
          line: structLines.get(structName) || 1,
        });
      }
    }
  }
}

/** Collect interface and struct method sets from definitions for structural matching. */
function collectGoMethodSets(ctx: ExtractorOutput): {
  interfaceMethods: Map<string, Set<string>>;
  structMethods: Map<string, Set<string>>;
  structLines: Map<string, number>;
} {
  const interfaceMethods = new Map<string, Set<string>>();
  const structMethods = new Map<string, Set<string>>();
  const structLines = new Map<string, number>();
  const interfaceNames = new Set<string>();
  const structNames = new Set<string>();

  for (const def of ctx.definitions) {
    if (def.kind === 'interface') interfaceNames.add(def.name);
    if (def.kind === 'struct') {
      structNames.add(def.name);
      structLines.set(def.name, def.line);
    }
  }

  for (const def of ctx.definitions) {
    if (def.kind !== 'method' || !def.name.includes('.')) continue;
    const dotIdx = def.name.indexOf('.');
    const receiver = def.name.slice(0, dotIdx);
    const method = def.name.slice(dotIdx + 1);

    if (interfaceNames.has(receiver)) {
      if (!interfaceMethods.has(receiver)) interfaceMethods.set(receiver, new Set());
      interfaceMethods.get(receiver)?.add(method);
    }
    if (structNames.has(receiver)) {
      if (!structMethods.has(receiver)) structMethods.set(receiver, new Set());
      structMethods.get(receiver)?.add(method);
    }
  }

  return { interfaceMethods, structMethods, structLines };
}

function extractStructFields(structTypeNode: TreeSitterNode): SubDeclaration[] {
  const fields: SubDeclaration[] = [];
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
