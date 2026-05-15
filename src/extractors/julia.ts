import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
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

function qualifyName(base: string, currentModule: string | null): string {
  // For qualified names (`function Base.show ... end` inside `module Foo`,
  // or short-form `Foo.bar(x, y) = x + y` inside `module Outer`), the LHS
  // is a `scoped_identifier` already containing the qualifier — skip the
  // module prefix to avoid producing `Foo.Base.show` / `Outer.Foo.bar`.
  if (currentModule && !base.includes('.')) return `${currentModule}.${base}`;
  return base;
}

/**
 * Extract the call_expression from a function/macro definition's signature.
 *
 * tree-sitter-julia wraps the signature in a `signature` node whose direct
 * children include the `call_expression` for the function name and parameters.
 * `findChild` only inspects direct children, so we unwrap one level explicitly.
 * Without this step, `findChild(node, 'call_expression')` on a
 * `function_definition` would match the *body's* first call_expression
 * (e.g. `println(...)` inside the body) instead of the signature.
 *
 * Grammar assumption: every `function_definition` / `macro_definition` emits a
 * `signature` child in the current tree-sitter-julia grammar. The fallback to
 * `findChild(node, 'call_expression')` exists only as a defensive measure for
 * grammar drift — if it ever fires on a real definition, that fallback would
 * silently match the first body call_expression and mis-record the function
 * name. Callers must therefore treat a missing `signature` as a parser/grammar
 * mismatch worth investigating, not as a routine code path.
 */
function signatureCall(node: TreeSitterNode): TreeSitterNode | null {
  const sig = findChild(node, 'signature');
  if (sig) return findChild(sig, 'call_expression');
  return findChild(node, 'call_expression');
}

function handleFunctionDef(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  const callSig = signatureCall(node);
  if (callSig) {
    const funcNameNode = callSig.child(0);
    if (funcNameNode) {
      const name = qualifyName(funcNameNode.text, currentModule);
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

  ctx.definitions.push({
    name: qualifyName(nameNode.text, currentModule),
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

    const params = extractJuliaParams(lhs);

    ctx.definitions.push({
      name: qualifyName(funcNameNode.text, currentModule),
      kind: 'function',
      line: node.startPosition.row + 1,
      endLine: nodeEndLine(node),
      children: params.length > 0 ? params : undefined,
    });
  }
}

/**
 * Locate the base-name identifier within a `type_head` node.
 *
 * Handles plain identifiers, `Name <: Super` binary expressions, and
 * parameterized forms like `Name{T}` / `Name{T} <: Super{T,1}` by recursing
 * into wrapper kinds the Julia grammar actually emits for type heads
 * (binary expressions, parametrized type expressions, parameterized
 * identifiers). Returns `null` when no identifier can be located — callers
 * should skip emitting a definition in that case.
 *
 * Note: `type_parameter_list` / `type_argument_list` are intentionally
 * excluded — Julia's grammar uses `curly_expression` for `{T}` constructs,
 * not those node kinds. Including them would risk recursing into a
 * type-parameter list and returning a type variable (e.g. `T`) instead of
 * the struct name if `findBaseName` were ever called on a node lacking a
 * direct `identifier` child.
 */
const TYPE_HEAD_WRAPPERS: ReadonlySet<string> = new Set([
  'binary_expression',
  'parametrized_type_expression',
  'parameterized_identifier',
]);

function findBaseName(node: TreeSitterNode): TreeSitterNode | null {
  if (node.type === 'identifier') return node;
  const direct = findChild(node, 'identifier');
  if (direct) return direct;
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (TYPE_HEAD_WRAPPERS.has(child.type)) {
      const found = findBaseName(child);
      if (found) return found;
    }
  }
  return null;
}

function handleStructDef(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // struct_definition: struct type_head fields... end
  // type_head wraps the name and optional supertype. The name may be a
  // bare `identifier`, a parameterized form (e.g. `Vec{T}`), or either
  // of those nested inside a `binary_expression` (`Name <: Super`).
  const typeHead = findChild(node, 'type_head');
  if (!typeHead) return;

  let nameNode: TreeSitterNode | null;
  let supertypeNode: TreeSitterNode | null = null;

  const binary = findChild(typeHead, 'binary_expression');
  if (binary) {
    // Walk into each side of the binary expression to find the base-name
    // identifier — handles parameterized forms like `Vec{T} <: AbstractArray{T,1}`.
    const sides: TreeSitterNode[] = [];
    for (let i = 0; i < binary.childCount; i++) {
      const c = binary.child(i);
      if (c && c.type !== 'operator') sides.push(c);
    }
    nameNode = sides[0] ? findBaseName(sides[0]) : null;
    supertypeNode = sides[1] ? findBaseName(sides[1]) : null;
  } else {
    nameNode = findBaseName(typeHead);
  }

  if (!nameNode) return;
  const structName = nameNode.text;

  const children: SubDeclaration[] = [];
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
    } else if (child.type === 'identifier') {
      // Plain identifier fields (no type annotation) appear as direct
      // identifier children of struct_definition. The type_head is a
      // separate node so there is nothing to filter out here.
      children.push({ name: child.text, kind: 'property', line: child.startPosition.row + 1 });
    }
  }

  if (supertypeNode) {
    ctx.classes.push({
      name: structName,
      extends: supertypeNode.text,
      line: node.startPosition.row + 1,
    });
  }

  ctx.definitions.push({
    name: structName,
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
  // tree-sitter-julia shapes:
  //   `using LinearAlgebra`     → using_statement [ using, identifier ]
  //   `import Foo.Bar`          → import_statement [ import, scoped_identifier ]
  //   `import Base: show`       → import_statement [ import, selected_import[Base, show] ]
  //   `import Foo.Bar: baz`     → import_statement [ import, selected_import[scoped_identifier, baz] ]
  const names: string[] = [];
  let source = '';

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'scoped_identifier') {
      const txt = child.text;
      if (!source) source = txt;
      names.push(txt.split('.').pop() || txt);
    } else if (child.type === 'selected_import') {
      // First identifier-bearing node is the source module; the rest are
      // imported names. The module may itself be a `scoped_identifier`
      // (e.g. `import Foo.Bar: baz`) — handle it alongside bare
      // `identifier` and use the trailing segment as the display name,
      // mirroring the outer loop.
      let first = true;
      for (let j = 0; j < child.childCount; j++) {
        const part = child.child(j);
        if (!part) continue;
        if (part.type !== 'identifier' && part.type !== 'scoped_identifier') continue;
        const txt = part.text;
        if (first) {
          if (!source) source = txt;
          first = false;
        } else {
          names.push(txt.split('.').pop() || txt);
        }
      }
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
