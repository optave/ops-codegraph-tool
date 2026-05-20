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
 * Grammar source: `tree-sitter-fsharp` v0.3.0 installed via a pinned GitHub
 * tarball in `package.json` because the ionide/tree-sitter-fsharp project has
 * no v0.3.0 release published to the npm registry. The cargo crate the native
 * engine uses is also v0.3.0; both engines must stay aligned. Upgrading
 * requires a manual edit of the tarball URL in `package.json` and
 * `package-lock.json` — `npm update` will not bump this entry.
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
    case 'module_defn':
      // Nested signature module (`module Foo = ...`) in `.fsi` files,
      // emitted by both the WASM (npm ionide tarball v0.3.0) and cargo
      // v0.3.0 tree-sitter-fsharp signature grammars. Accumulate the
      // dotted module path so nested `val` declarations are qualified
      // as `Outer.Inner.foo` in parity with the native engine.
      nextModule = handleModuleDefn(node, ctx, currentModule);
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
    case 'value_definition':
      handleValueDefinition(node, ctx, currentModule);
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

function handleModuleDefn(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): string | null {
  // `module_defn` (cargo 0.3.0 signature grammar) wraps `module Foo = ...`
  // sections inside an outer `namespace` or another module. The name is a
  // direct `identifier` child.
  const nameNode = findChild(node, 'identifier');
  if (!nameNode) return currentModule;

  const qualified = currentModule ? `${currentModule}.${nameNode.text}` : nameNode.text;
  ctx.definitions.push({
    name: qualified,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
  return qualified;
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

// Handle `val name : type` declarations in `.fsi` signature files.
// The signature grammar reuses `value_definition` for `val` bindings,
// distinguished from the source grammar's `let` bindings by the first
// child being the literal `val` keyword. Source-file `value_definition`
// nodes (which start with `let`) are intentionally ignored to preserve
// `.fs` extractor parity.
function handleValueDefinition(
  node: TreeSitterNode,
  ctx: ExtractorOutput,
  currentModule: string | null,
): void {
  const first = node.child(0);
  if (!first || first.type !== 'val') return;

  const declLeft = findChild(node, 'value_declaration_left');
  if (!declLeft) return;

  const pattern = findChild(declLeft, 'identifier_pattern');
  if (!pattern) return;

  const ident =
    findChild(findChild(pattern, 'long_identifier_or_op') ?? pattern, 'identifier') ??
    findChild(pattern, 'identifier');
  if (!ident) return;

  // The npm and cargo tree-sitter-fsharp 0.3.0 grammars — though sharing a
  // version tag — emit type signatures with different node shapes:
  //   • WASM (npm 0.3.0 ionide tarball): `function_type` is the explicit
  //     function-type kind, present as a direct child of `value_definition`
  //     for `a -> b` types; plain values (e.g. `val pi : float`) appear as
  //     `simple_type`.
  //   • Native (cargo 0.3.0): every type signature is wrapped in
  //     `curried_spec`. A function type contains one or more `arguments_spec`
  //     children; a plain value wraps a single `simple_type`.
  // Classify as a function whenever `function_type` appears OR a
  // `curried_spec` contains an `arguments_spec` child, so both engines stay
  // in parity until the grammars converge.
  let hasFunctionType = false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === 'function_type') {
      hasFunctionType = true;
      break;
    }
    if (c.type === 'curried_spec') {
      for (let j = 0; j < c.childCount; j++) {
        if (c.child(j)?.type === 'arguments_spec') {
          hasFunctionType = true;
          break;
        }
      }
      if (hasFunctionType) break;
    }
  }

  const name = currentModule ? `${currentModule}.${ident.text}` : ident.text;
  ctx.definitions.push({
    name,
    kind: hasFunctionType ? 'function' : 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}
