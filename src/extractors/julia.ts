import type {
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Julia files.
 *
 * tree-sitter-julia grammar notes:
 * - function_definition: `function name(params)...end`
 * - assignment: `name(params) = expr` (short form), LHS is call_expression
 * - struct_definition: `struct TypeHead...end`, name is in type_head
 * - module_definition: `module Name...end`
 * - import_statement / using_statement
 * - macro_definition: `macro name(params)...end`
 * - abstract_definition: `abstract type Name end`
 * - call_expression: function calls
 */
export function extractJuliaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkJuliaNode(tree.rootNode, ctx, null);
  return ctx;
}

function walkJuliaNode(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  let nextModule = currentModule;

  switch (node.type) {
    case 'module_definition':
      nextModule = handleModuleDef(node, ctx);
      break;
    case 'function_definition':
      handleFunctionDef(node, ctx, currentModule);
      break;
    case 'assignment':
      handleAssignment(node, ctx, currentModule);
      break;
    case 'struct_definition':
      handleStructDef(node, ctx);
      break;
    case 'abstract_definition':
      handleAbstractDef(node, ctx);
      break;
    case 'macro_definition':
      handleMacroDef(node, ctx, currentModule);
      break;
    case 'import_statement':
    case 'using_statement':
      handleImport(node, ctx);
      break;
    case 'call_expression':
      handleCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkJuliaNode(child, ctx, nextModule);
  }
}

function handleModuleDef(node: TreeSitterNode, ctx: ExtractorOutput): string | null {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return null;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });

  return nameNode.text;
}

function handleFunctionDef(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  // function_definition may have a call_expression child as the signature
  const callSig = findChild(node, 'call_expression');
  if (callSig) {
    const funcNameNode = callSig.child(0);
    if (funcNameNode) {
      const name = currentModule ? `${currentModule}.${funcNameNode.text}` : funcNameNode.text;
      const params = extractJuliaParams(callSig);
      ctx.definitions.push({
        name,
        kind: 'function',
        line: node.startPosition.row + 1,
        endLine: nodeEndLine(node),
        children: params.length > 0 ? params : undefined,
      });
      return;
    }
  }

  // Fallback: look for identifier directly
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  const name = currentModule ? `${currentModule}.${nameNode.text}` : nameNode.text;
  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleAssignment(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  // assignment: LHS operator RHS
  // Short function form: add(x, y) = x + y → LHS is call_expression
  const lhs = node.child(0);
  if (!lhs) return;

  if (lhs.type === 'call_expression') {
    const funcNameNode = lhs.child(0);
    if (!funcNameNode) return;

    const name = currentModule ? `${currentModule}.${funcNameNode.text}` : funcNameNode.text;
    const params = extractJuliaParams(lhs);

    ctx.definitions.push({
      name,
      kind: 'function',
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: params.length > 0 ? params : undefined,
    });
  }
}

function handleStructDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // struct_definition: struct type_head fields... end
  const typeHead = findChild(node, 'type_head');
  const nameNode = typeHead
    ? (findChild(typeHead, 'identifier') ?? typeHead)
    : findChild(node, 'identifier');
  if (!nameNode) return;

  const children: SubDeclaration[] = [];
  // Fields are typed_expression children of struct_definition
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'typed_expression') {
      const fieldName = findChild(child, 'identifier');
      if (fieldName) {
        children.push({
          name: fieldName.text,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
    // Plain identifier fields (no type annotation)
    if (child.type === 'identifier' && child !== nameNode && typeHead && child !== typeHead) {
      children.push({ name: child.text, kind: 'property', line: child.startPosition.row + 1 });
    }
  }

  // Check for supertype in type_head (Point <: AbstractPoint)
  if (typeHead) {
    const subtypeExpr = findChild(typeHead, 'subtype_expression');
    if (subtypeExpr) {
      // Find the supertype identifier
      for (let i = 0; i < subtypeExpr.childCount; i++) {
        const child = subtypeExpr.child(i);
        if (child?.type === 'identifier' && i > 0) {
          ctx.classes.push({
            name: nameNode.text,
            extends: child.text,
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'struct',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleAbstractDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleMacroDef(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  const nameNode = node.childForFieldName('name') || findChild(node, 'identifier');
  if (!nameNode) return;

  const name = currentModule ? `${currentModule}.@${nameNode.text}` : `@${nameNode.text}`;
  ctx.definitions.push({
    name,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleImport(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const names: string[] = [];
  let source = '';

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (
      child.type === 'identifier' ||
      child.type === 'scoped_identifier' ||
      child.type === 'selected_import'
    ) {
      if (!source) source = child.text;
      names.push(child.text.split('.').pop() || child.text);
    }
  }

  if (source) {
    ctx.imports.push({
      source,
      names: names.length > 0 ? names : [source],
      line: node.startPosition.row + 1,
    });
  }
}

function handleCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Don't record if parent is assignment LHS (that's a function definition)
  if (node.parent?.type === 'assignment' && node === node.parent.child(0)) return;
  // Don't record if parent is function_definition (that's a signature)
  if (node.parent?.type === 'function_definition') return;

  const funcNode = node.child(0);
  if (!funcNode) return;

  if (funcNode.type === 'identifier') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'field_expression' || funcNode.type === 'scoped_identifier') {
    const parts = funcNode.text.split('.');
    if (parts.length >= 2) {
      ctx.calls.push({
        name: parts[parts.length - 1]!,
        receiver: parts.slice(0, -1).join('.'),
        line: node.startPosition.row + 1,
      });
    } else {
      ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
    }
  }
}

function extractJuliaParams(callExpr: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const argList = findChild(callExpr, 'argument_list') || findChild(callExpr, 'tuple_expression');
  if (!argList) return params;

  for (let i = 0; i < argList.childCount; i++) {
    const child = argList.child(i);
    if (!child) continue;
    if (child.type === 'identifier') {
      params.push({ name: child.text, kind: 'parameter', line: child.startPosition.row + 1 });
    }
    if (child.type === 'typed_parameter' || child.type === 'typed_expression') {
      const nameNode = findChild(child, 'identifier');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          kind: 'parameter',
          line: child.startPosition.row + 1,
        });
      }
    }
    if (child.type === 'optional_parameter' || child.type === 'default_parameter') {
      const nameNode = findChild(child, 'identifier');
      if (nameNode) {
        params.push({
          name: nameNode.text,
          kind: 'parameter',
          line: child.startPosition.row + 1,
        });
      }
    }
  }
  return params;
}
