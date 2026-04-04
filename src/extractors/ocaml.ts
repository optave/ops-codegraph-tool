import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from OCaml files.
 */
export function extractOCamlSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkOCamlNode(tree.rootNode, ctx);
  return ctx;
}

function walkOCamlNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'value_definition':
      handleOCamlValueDef(node, ctx);
      break;
    case 'let_binding':
      // Only handle top-level let bindings not inside value_definition
      if (node.parent?.type !== 'value_definition') {
        handleOCamlLetBinding(node, ctx);
      }
      break;
    case 'module_definition':
      handleOCamlModuleDef(node, ctx);
      break;
    case 'type_definition':
      handleOCamlTypeDef(node, ctx);
      break;
    case 'class_definition':
      handleOCamlClassDef(node, ctx);
      break;
    case 'open_module':
      handleOCamlOpen(node, ctx);
      break;
    case 'application_expression':
      handleOCamlApplication(node, ctx);
      break;
    // Shared node types present in both .ml and .mli files
    case 'value_specification':
      handleOCamlValueSpec(node, ctx);
      break;
    case 'external':
      handleOCamlExternal(node, ctx);
      break;
    case 'module_type_definition':
      handleOCamlModuleTypeDef(node, ctx);
      break;
    case 'exception_definition':
      handleOCamlExceptionDef(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkOCamlNode(child, ctx);
  }
}

function handleOCamlValueDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // value_definition contains one or more let_bindings
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === 'let_binding') {
      handleOCamlLetBinding(child, ctx);
    }
  }
}

function handleOCamlLetBinding(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // let_binding has a pattern (the name) and optionally a body
  const pattern = node.childForFieldName('pattern');
  if (!pattern) return;

  // Check if this is a function (has parameter children)
  const hasParams = hasOCamlParams(node);
  const name = extractOCamlPatternName(pattern);
  if (!name) return;

  if (hasParams) {
    const params = extractOCamlParams(node);
    ctx.definitions.push({
      name,
      kind: 'function',
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: params.length > 0 ? params : undefined,
    });
  } else {
    ctx.definitions.push({
      name,
      kind: 'variable',
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
    });
  }
}

function extractOCamlPatternName(pattern: TreeSitterNode): string | null {
  if (pattern.type === 'value_name' || pattern.type === 'identifier') {
    return pattern.text;
  }
  // Operator definitions like `let (+) a b = ...`
  if (pattern.type === 'parenthesized_operator') {
    return pattern.text;
  }
  const nameNode = findChild(pattern, 'value_name') || findChild(pattern, 'identifier');
  return nameNode ? nameNode.text : null;
}

function hasOCamlParams(letBinding: TreeSitterNode): boolean {
  for (let i = 0; i < letBinding.childCount; i++) {
    const child = letBinding.child(i);
    if (!child) continue;
    if (child.type === 'parameter' || child.type === 'value_pattern') return true;
  }
  return false;
}

function extractOCamlParams(letBinding: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  for (let i = 0; i < letBinding.childCount; i++) {
    const child = letBinding.child(i);
    if (!child) continue;
    if (child.type === 'parameter' || child.type === 'value_pattern') {
      const name = extractOCamlPatternName(child);
      if (name) {
        params.push({ name, kind: 'parameter', line: child.startPosition.row + 1 });
      }
    }
  }
  return params;
}

function handleOCamlModuleDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const binding = findChild(node, 'module_binding');
  if (!binding) return;

  const nameNode =
    binding.childForFieldName('name') ||
    findChild(binding, 'module_name') ||
    findChild(binding, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlTypeDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // type_definition contains one or more type_bindings
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || child.type !== 'type_binding') continue;

    const nameNode =
      child.childForFieldName('name') ||
      findChild(child, 'type_constructor') ||
      findChild(child, 'identifier');
    if (!nameNode) continue;

    const children: SubDeclaration[] = [];
    extractOCamlTypeConstructors(child, children);

    ctx.definitions.push({
      name: nameNode.text,
      kind: 'type',
      line: child.startPosition.row + 1,
      endLine: nodeEndLine(child),
      children: children.length > 0 ? children : undefined,
    });
  }
}

function extractOCamlTypeConstructors(
  typeBinding: TreeSitterNode,
  children: SubDeclaration[],
): void {
  for (let i = 0; i < typeBinding.childCount; i++) {
    const child = typeBinding.child(i);
    if (!child) continue;
    if (child.type === 'constructor_declaration') {
      const nameNode = findChild(child, 'constructor_name') || findChild(child, 'identifier');
      if (nameNode) {
        children.push({ name: nameNode.text, kind: 'property', line: child.startPosition.row + 1 });
      }
    }
  }
}

function handleOCamlClassDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const binding = findChild(node, 'class_binding');
  if (!binding) return;

  const nameNode = binding.childForFieldName('name') || findChild(binding, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlOpen(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // open_module contains a module_path
  let moduleName: string | null = null;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'module_path' ||
      child.type === 'module_name' ||
      child.type === 'extended_module_path' ||
      child.type === 'constructor_name'
    ) {
      moduleName = child.text;
      break;
    }
  }
  if (!moduleName) return;

  ctx.imports.push({
    source: moduleName,
    names: [moduleName.split('.').pop() || moduleName],
    line: node.startPosition.row + 1,
  });
}

function hasDescendantType(node: TreeSitterNode, type: string): boolean {
  if (node.type === type) return true;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && hasDescendantType(child, type)) return true;
  }
  return false;
}

function handleOCamlValueSpec(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'value_name') || findChild(node, 'parenthesized_operator');
  if (!nameNode) return;

  // Check if the type contains `->` (function_type node)
  const typeNode = node.childForFieldName('type');
  const isFunction = typeNode ? hasDescendantType(typeNode, 'function_type') : false;

  ctx.definitions.push({
    name: nameNode.text,
    kind: isFunction ? 'function' : 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlExternal(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'value_name') || findChild(node, 'parenthesized_operator');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlModuleTypeDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'module_type_name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'interface',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlExceptionDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Standard: `exception Foo of bar` — name is inside constructor_declaration
  const ctorDecl = findChild(node, 'constructor_declaration');
  const nameNode = ctorDecl
    ? findChild(ctorDecl, 'constructor_name')
    : findChild(node, 'constructor_name'); // fallback for `exception Foo = Bar` (alias)
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleOCamlApplication(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // application_expression: first child is the function, rest are arguments
  const funcNode = node.child(0);
  if (!funcNode) return;

  if (
    funcNode.type === 'value_path' ||
    funcNode.type === 'value_name' ||
    funcNode.type === 'identifier'
  ) {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'field_get_expression') {
    // Module.function calls
    const field =
      funcNode.childForFieldName('field') ||
      findChild(funcNode, 'value_name') ||
      findChild(funcNode, 'identifier');
    const record = funcNode.child(0);
    if (field) {
      const call: Call = { name: field.text, line: node.startPosition.row + 1 };
      if (record && record !== field) call.receiver = record.text;
      ctx.calls.push(call);
    }
  }
}
