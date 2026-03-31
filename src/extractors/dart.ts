import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Dart files.
 */
export function extractDartSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkDartNode(tree.rootNode, ctx);
  return ctx;
}

function walkDartNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'class_definition':
      handleDartClass(node, ctx);
      break;
    case 'enum_declaration':
      handleDartEnum(node, ctx);
      break;
    case 'mixin_declaration':
      handleDartMixin(node, ctx);
      break;
    case 'extension_declaration':
      handleDartExtension(node, ctx);
      break;
    case 'function_signature':
      handleDartFunction(node, ctx);
      break;
    case 'method_signature':
      handleDartMethodSig(node, ctx);
      break;
    case 'library_import':
      handleDartImport(node, ctx);
      break;
    case 'constructor_invocation':
    case 'new_expression':
      handleDartConstructorCall(node, ctx);
      break;
    case 'type_alias':
      handleDartTypeAlias(node, ctx);
      break;
    case 'selector':
      handleDartSelector(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkDartNode(child, ctx);
  }
}

function handleDartClass(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;
  const name = nameNode.text;
  const children: SubDeclaration[] = [];

  const body = node.childForFieldName('body') || findChild(node, 'class_body');
  if (body) {
    extractDartClassMembers(body, name, ctx, children);
  }

  ctx.definitions.push({
    name,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });

  extractDartInheritance(node, name, ctx);
}

function extractDartClassMembers(
  body: TreeSitterNode,
  className: string,
  ctx: ExtractorOutput,
  children: SubDeclaration[],
): void {
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member) continue;

    if (member.type === 'method_signature' || member.type === 'function_signature') {
      const fnName = extractDartFunctionName(member);
      if (fnName) {
        ctx.definitions.push({
          name: `${className}.${fnName}`,
          kind: 'method',
          line: member.startPosition.row + 1,
          endLine: nodeEndLine(member),
        });
      }
    } else if (member.type === 'declaration') {
      // Field declarations
      for (let j = 0; j < member.childCount; j++) {
        const decl = member.child(j);
        if (decl?.type === 'identifier') {
          children.push({
            name: decl.text,
            kind: 'property',
            line: member.startPosition.row + 1,
          });
          break;
        }
      }
    }
  }
}

function extractDartFunctionName(node: TreeSitterNode): string | null {
  const nameNode = node.childForFieldName('name');
  if (nameNode) return nameNode.text;

  // Walk children for function_signature inside method_signature
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'function_signature' ||
      child.type === 'getter_signature' ||
      child.type === 'setter_signature' ||
      child.type === 'constructor_signature'
    ) {
      const name = child.childForFieldName('name');
      if (name) return name.text;
    }
  }
  return null;
}

function handleDartEnum(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'enum',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartMixin(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartExtension(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'class',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartFunction(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Skip methods already emitted by class handler
  if (isInsideDartClass(node)) return;

  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleDartMethodSig(node: TreeSitterNode, ctx: ExtractorOutput): void {
  if (isInsideDartClass(node)) return;
  const fnName = extractDartFunctionName(node);
  if (!fnName) return;

  ctx.definitions.push({
    name: fnName,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function isInsideDartClass(node: TreeSitterNode): boolean {
  let current = node.parent;
  while (current) {
    if (
      current.type === 'class_body' ||
      current.type === 'class_definition' ||
      current.type === 'enum_body' ||
      current.type === 'mixin_declaration'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function handleDartImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const spec = findChild(node, 'import_specification');
  if (!spec) return;

  const uri = findChild(spec, 'configurable_uri') || findChild(spec, 'uri');
  if (!uri) return;

  const source = uri.text.replace(/^['"]|['"]$/g, '');
  const names: string[] = [];

  // Check for `as` alias
  const alias = findChild(spec, 'identifier');
  if (alias) names.push(alias.text);

  ctx.imports.push({
    source,
    names: names.length > 0 ? names : [source.split('/').pop() || source],
    line: node.startPosition.row + 1,
  });
}

function handleDartConstructorCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'type_identifier') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.calls.push({
    name: nameNode.text,
    line: node.startPosition.row + 1,
  });
}

function handleDartSelector(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // selector with argument_part represents a function call
  const argPart = findChild(node, 'argument_part');
  if (!argPart) return;

  // Look for the identifier this selector belongs to
  const unconditional = findChild(node, 'unconditional_assignable_selector');
  if (unconditional) {
    const id = findChild(unconditional, 'identifier');
    if (id) {
      ctx.calls.push({ name: id.text, line: node.startPosition.row + 1 });
    }
  }
}

function handleDartTypeAlias(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = findChild(node, 'type_identifier') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function extractDartInheritance(node: TreeSitterNode, name: string, ctx: ExtractorOutput): void {
  const superclass = node.childForFieldName('superclass');
  if (superclass) {
    const typeName =
      findChild(superclass, 'type_identifier') || findChild(superclass, 'identifier');
    if (typeName) {
      ctx.classes.push({ name, extends: typeName.text, line: node.startPosition.row + 1 });
    }
  }

  const interfaces = node.childForFieldName('interfaces');
  if (interfaces) {
    for (let i = 0; i < interfaces.childCount; i++) {
      const iface = interfaces.child(i);
      if (!iface) continue;
      const typeName =
        iface.type === 'type_identifier'
          ? iface
          : findChild(iface, 'type_identifier') || findChild(iface, 'identifier');
      if (typeName) {
        ctx.classes.push({ name, implements: typeName.text, line: node.startPosition.row + 1 });
      }
    }
  }
}
