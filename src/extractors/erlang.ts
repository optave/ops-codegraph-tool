import type { ExtractorOutput, SubDeclaration, TreeSitterNode, TreeSitterTree } from '../types.js';
import { findChild, nodeEndLine } from './helpers.js';

/**
 * Extract symbols from Erlang files.
 *
 * tree-sitter-erlang (WhatsApp) grammar notes:
 * - module_attribute: -module(name).
 * - record_decl: -record(name, {fields}).
 * - fun_decl: contains function_clause children
 * - function_clause: atom expr_args clause_body
 * - call: function calls, with remote child for module:func
 * - expr_args: parenthesized argument lists
 */
export function extractErlangSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkErlangNode(tree.rootNode, ctx);
  return ctx;
}

function walkErlangNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'module_attribute':
      handleModuleAttr(node, ctx);
      break;
    case 'record_decl':
      handleRecordDecl(node, ctx);
      break;
    case 'type_alias':
    case 'opaque':
      handleTypeAlias(node, ctx);
      break;
    case 'fun_decl':
      handleFunDecl(node, ctx);
      break;
    case 'function_clause':
      // Only handle if not inside fun_decl (fun_decl handles its own clauses)
      if (node.parent?.type !== 'fun_decl') {
        handleFunctionClause(node, ctx);
      }
      break;
    case 'pp_define':
      handleDefine(node, ctx);
      break;
    case 'pp_include':
    case 'pp_include_lib':
      handleInclude(node, ctx);
      break;
    case 'import_attribute':
      handleImportAttr(node, ctx);
      break;
    case 'call':
      handleCall(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkErlangNode(child, ctx);
  }
}

function handleModuleAttr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // module_attribute: - module ( atom ) .
  // Prefer the named `name` field exposed by tree-sitter-erlang so we don't
  // accidentally pick up the `module` keyword if a future grammar exposes it
  // as a named `atom` child.
  const nameNode = node.childForFieldName('name') ?? findChild(node, 'atom');
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'module',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleRecordDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // record_decl: - record ( atom , { record_field, ... } ) .
  const nameNode = findChild(node, 'atom');
  if (!nameNode) return;

  const children: SubDeclaration[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'record_field' || child.type === 'typed_record_field') {
      const fieldName = findChild(child, 'atom');
      if (fieldName) {
        children.push({
          name: fieldName.text,
          kind: 'property',
          line: child.startPosition.row + 1,
        });
      }
    }
  }

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'record',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: children.length > 0 ? children : undefined,
  });
}

function handleTypeAlias(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // type_alias: -type name(...) :: ty.
  // Name is typically wrapped in a `type_name` node containing an `atom`.
  // Mirrors the Rust `handle_type_alias` fallback so the two engines agree
  // even when the grammar nests the name inside `type_name`.
  const directAtom = findChild(node, 'atom');
  const wrappedAtom =
    !directAtom && findChild(node, 'type_name') != null
      ? findChild(findChild(node, 'type_name') as TreeSitterNode, 'atom')
      : null;
  const nameNode = directAtom ?? wrappedAtom;
  if (!nameNode) return;

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'type',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleFunDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // fun_decl contains one or more function_clause children + dots
  // Extract from the first function_clause
  const clause = findChild(node, 'function_clause');
  if (!clause) return;

  handleFunctionClause(clause, ctx);
}

function handleFunctionClause(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // function_clause: atom expr_args clause_body
  const nameNode = node.childForFieldName('name') ?? findChild(node, 'atom');
  if (!nameNode) return;

  const params = extractErlangParams(node);
  const arity = params.length;

  // Don't duplicate if we already have this function at the same arity.
  // Erlang overloads by arity, so `foo/1` and `foo/2` are distinct definitions.
  if (
    ctx.definitions.some(
      (d) =>
        d.name === nameNode.text && d.kind === 'function' && (d.children?.length ?? 0) === arity,
    )
  ) {
    return;
  }

  ctx.definitions.push({
    name: nameNode.text,
    kind: 'function',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node.parent?.type === 'fun_decl' ? node.parent : node),
    children: params.length > 0 ? params : undefined,
    visibility: 'public',
  });
}

function extractErlangParams(clauseNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const argsNode = clauseNode.childForFieldName('args') ?? findChild(clauseNode, 'expr_args');
  if (!argsNode) return params;

  // Iterate named children so every argument pattern counts as one parameter,
  // independent of whether it is a bare `var`/`atom` or a complex destructuring
  // pattern (tuple, list, binary, etc.). Punctuation tokens are anonymous and
  // therefore excluded automatically.
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const child = argsNode.namedChild(i);
    if (!child) continue;
    const label =
      child.type === 'var' || child.type === 'atom'
        ? child.text
        : // Placeholder for complex patterns so arity is preserved.
          `_${i}`;
    params.push({ name: label, kind: 'parameter', line: child.startPosition.row + 1 });
  }
  return params;
}

function handleDefine(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // pp_define: -define(NAME, value).
  const nameNode =
    findChild(node, 'var') || findChild(node, 'atom') || findChild(node, 'macro_lhs');
  if (!nameNode) return;

  const name =
    nameNode.type === 'macro_lhs'
      ? (findChild(nameNode, 'var')?.text ?? nameNode.text)
      : nameNode.text;

  ctx.definitions.push({
    name,
    kind: 'variable',
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
  });
}

function handleInclude(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const strNode = findChild(node, 'string');
  if (!strNode) return;

  const source = strNode.text.replace(/^"|"$/g, '');
  ctx.imports.push({
    source,
    names: ['include'],
    line: node.startPosition.row + 1,
  });
}

function handleImportAttr(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const moduleNode = findChild(node, 'atom');
  if (!moduleNode) return;

  const names: string[] = [];
  // Find exported function names
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'fa') {
      const fnName = findChild(child, 'atom');
      if (fnName) names.push(fnName.text);
    }
  }

  ctx.imports.push({
    source: moduleNode.text,
    names: names.length > 0 ? names : [moduleNode.text],
    line: node.startPosition.row + 1,
  });
}

function handleCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // call: first child is function ref (atom or remote), then expr_args
  const funcNode = node.child(0);
  if (!funcNode) return;

  if (funcNode.type === 'atom' || funcNode.type === 'identifier') {
    ctx.calls.push({ name: funcNode.text, line: node.startPosition.row + 1 });
  } else if (funcNode.type === 'remote') {
    // module:function — remote has atom : atom children
    const atoms: string[] = [];
    for (let i = 0; i < funcNode.childCount; i++) {
      const child = funcNode.child(i);
      if (child && (child.type === 'atom' || child.type === 'var')) {
        atoms.push(child.text);
      }
    }
    if (atoms.length >= 2) {
      ctx.calls.push({
        name: atoms[atoms.length - 1]!,
        receiver: atoms.slice(0, -1).join(':'),
        line: node.startPosition.row + 1,
      });
    } else if (atoms.length === 1) {
      ctx.calls.push({ name: atoms[0]!, line: node.startPosition.row + 1 });
    }
  }
}
