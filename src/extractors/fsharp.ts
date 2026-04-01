import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from F# files.
 *
 * tree-sitter-fsharp grammar notes:
 * - named_module: top-level module declaration
 * - function_declaration_left: LHS of `let name params = ...`
 * - import_decl: `open Namespace`
 * - type_definition > union_type_defn / record_type_defn
 * - application_expression: function calls
 */
export function extractFSharpSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkFSharpNode(tree.rootNode, ctx, null);
  return ctx;
}

function walkFSharpNode(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  let nextModule = currentModule;

  switch (node.type) {
    case 'named_module':
      nextModule = handleNamedModule(node, ctx);
      break;
    case 'function_declaration_left':
      handleFunctionDecl(node, ctx, currentModule);
      break;
    case 'type_definition':
      handleTypeDef(node, ctx);
      break;
    case 'import_decl':
      handleImportDecl(node, ctx);
      break;
    case 'application_expression':
      handleApplication(node, ctx);
      break;
    case 'dot_expression':
      handleDotExpression(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkFSharpNode(child, ctx, nextModule);
  }
}

function handleNamedModule(node: TreeSitterNode, ctx: ExtractorOutput): string | null {
  const nameNode = findChild(node, 'long_identifier');
  if (!nameNode) return null;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  return nameNode.text;
}

function handleFunctionDecl(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  // function_declaration_left: "add x y" — first child is the name identifier
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return;

  // Avoid duplicates — the walk will also visit children
  if (
    ctx.definitions.some((d) => d.name === nameNode.text && d.line === node.startPosition.row + 1)
  )
    return;

  const params = extractFSharpParams(node);
  const name = currentModule ? `${currentModule}.${nameNode.text}` : nameNode.text;

  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node.parent ?? node),
    children: params.length > 0 ? params : undefined,
  });
}

function extractFSharpParams(declLeft: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const argPatterns = findChild(declLeft, 'argument_patterns');
  if (!argPatterns) return params;

  collectParamIdentifiers(argPatterns, params);
  return params;
}

function collectParamIdentifiers(node: TreeSitterNode, params: SubDeclaration[]): void {
  if (node.type === 'identifier') {
    params.push({ name: node.text, kind: 'parameter', line: node.startPosition.row + 1 });
    return;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectParamIdentifiers(child, params);
  }
}

function handleTypeDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // type_definition contains union_type_defn, record_type_defn, etc.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;

    if (
      child.type === 'union_type_defn' ||
      child.type === 'record_type_defn' ||
      child.type === 'type_abbreviation_defn' ||
      child.type === 'class_type_defn' ||
      child.type === 'interface_type_defn' ||
      child.type === 'type_defn'
    ) {
      const nameNode = findChild(child, 'type_name');
      const name = nameNode
        ? (findChild(nameNode, 'identifier')?.text ?? nameNode.text)
        : findChild(child, 'identifier')?.text;
      if (!name) continue;

      const kind = determineFSharpTypeKind(child);
      const children: SubDeclaration[] = [];
      extractFSharpTypeMembers(child, children);

      ctx.definitions.push({
        name,
        kind,
        line: child.startPosition.row + 1,
        endLine: nodeEndLine(child),
        children: children.length > 0 ? children : undefined,
      });
    }
  }
}

function determineFSharpTypeKind(
  typeDefn: TreeSitterNode,
): 'class' | 'type' | 'record' | 'enum' | 'interface' {
  switch (typeDefn.type) {
    case 'union_type_defn':
      return 'enum';
    case 'record_type_defn':
      return 'record';
    case 'class_type_defn':
      return 'class';
    case 'interface_type_defn':
      return 'interface';
    default:
      return 'type';
  }
}

function extractFSharpTypeMembers(typeDefn: TreeSitterNode, children: SubDeclaration[]): void {
  for (let i = 0; i < typeDefn.childCount; i++) {
    const child = typeDefn.child(i);
    if (!child) continue;

    if (child.type === 'union_type_case') {
      const nameNode = findChild(child, 'identifier');
      if (nameNode) {
        children.push({
          name: nameNode.text,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
    if (child.type === 'record_field') {
      const nameNode = child.childForFieldName('name') || findChild(child, 'identifier');
      if (nameNode) {
        children.push({
          name: nameNode.text,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
    // Recurse into containers like union_type_cases
    if (child.type === 'union_type_cases' || child.type === 'record_fields') {
      extractFSharpTypeMembers(child, children);
    }
  }
}

function handleImportDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const moduleNode = findChild(node, 'long_identifier');
  if (!moduleNode) return;

  const source = moduleNode.text;
  ctx.imports.push({
    source,
    names: [source.split('.').pop() || source],
    line: node.startPosition.row + 1,
  });
}

function handleApplication(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const funcNode = node.child(0);
  if (!funcNode) return;

  if (funcNode.type === 'identifier' || funcNode.type === 'long_identifier') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'long_identifier_or_op') {
    const id = findChild(funcNode, 'identifier') || findChild(funcNode, 'long_identifier');
    if (id) ctx.calls.push({ name: id.text, line: node.startPosition.row + 1 });
  }
}

function handleDotExpression(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const parts: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && (child.type === 'identifier' || child.type === 'long_identifier')) {
      parts.push(child.text);
    }
  }
  if (parts.length >= 2) {
    const call: Call = {
      name: parts[parts.length - 1]!,
      receiver: parts.slice(0, -1).join('.'),
      line: node.startPosition.row + 1,
    };
    ctx.calls.push(call);
  }
}
