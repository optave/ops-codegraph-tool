import type {
  Call,
  ExtractorOutput,
  SubDeclaration,
  TreeSitterNode,
  TreeSitterTree,
} from '../types.js';
import { findChild, nodeEndLine, nodeStartLine } from './helpers.js';

/**
 * Lua base-library global function names and standard-library module
 * tables. A plain `identifier = identifier` assignment whose LHS is one of
 * these escapes local/lexical scoping entirely: the LHS names a language
 * builtin rather than a locally declared variable that scope-based tracking
 * could follow, so a function assigned here (`require = tracedRequire`, the
 * monkey-patch pattern from issue #1776) becomes reachable through every
 * later unqualified use of the builtin name — anywhere in the codebase,
 * since it's a genuine global, not just within this file's call graph.
 * Mirrors `LUA_BUILTIN_GLOBALS` in `crates/codegraph-core/src/extractors/lua.rs`.
 */
const LUA_BUILTIN_GLOBALS: Set<string> = new Set([
  'assert',
  'collectgarbage',
  'dofile',
  'error',
  'getfenv',
  'getmetatable',
  'ipairs',
  'load',
  'loadfile',
  'loadstring',
  'module',
  'next',
  'pairs',
  'pcall',
  'print',
  'rawequal',
  'rawget',
  'rawlen',
  'rawset',
  'require',
  'select',
  'setfenv',
  'setmetatable',
  'tonumber',
  'tostring',
  'type',
  'unpack',
  'xpcall',
  // Standard-library module tables — wholesale replacement (e.g. sandboxing)
  // is the same "escapes local scope" shape as a single builtin function.
  'string',
  'table',
  'math',
  'io',
  'os',
  'coroutine',
  'debug',
  'utf8',
  'bit32',
]);

/**
 * Extract symbols from Lua files.
 */
export function extractLuaSymbols(tree: TreeSitterTree, _filePath: string): ExtractorOutput {
  const ctx: ExtractorOutput = {
    definitions: [],
    calls: [],
    imports: [],
    classes: [],
    exports: [],
    typeMap: new Map(),
  };

  walkLuaNode(tree.rootNode, ctx);
  return ctx;
}

function walkLuaNode(node: TreeSitterNode, ctx: ExtractorOutput): void {
  switch (node.type) {
    case 'function_declaration':
      handleLuaFunctionDecl(node, ctx);
      break;
    case 'variable_declaration':
      handleLuaVariableDecl(node, ctx);
      break;
    case 'function_call':
      handleLuaFunctionCall(node, ctx);
      break;
    case 'assignment_statement':
      handleLuaAssignmentStatement(node, ctx);
      break;
  }

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) walkLuaNode(child, ctx);
  }
}

function handleLuaFunctionDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  let name: string;
  let kind: 'function' | 'method' = 'function';

  if (nameNode.type === 'method_index_expression') {
    const table = nameNode.childForFieldName('table');
    const method = nameNode.childForFieldName('method');
    if (table && method) {
      name = `${table.text}.${method.text}`;
      kind = 'method';
    } else {
      name = nameNode.text;
    }
  } else if (nameNode.type === 'dot_index_expression') {
    const table = nameNode.childForFieldName('table');
    const field = nameNode.childForFieldName('field');
    if (table && field) {
      name = `${table.text}.${field.text}`;
      kind = 'method';
    } else {
      name = nameNode.text;
    }
  } else {
    name = nameNode.text;
  }

  const params = extractLuaParams(node);

  ctx.definitions.push({
    name,
    kind,
    line: node.startPosition.row + 1,
    endLine: nodeEndLine(node),
    children: params.length > 0 ? params : undefined,
  });
}

function extractLuaParams(funcNode: TreeSitterNode): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  const paramList = funcNode.childForFieldName('parameters');
  if (!paramList) return params;

  for (let i = 0; i < paramList.childCount; i++) {
    const param = paramList.child(i);
    if (param?.type !== 'identifier') continue;
    params.push({ name: param.text, kind: 'parameter', line: param.startPosition.row + 1 });
  }
  return params;
}

function handleLuaVariableDecl(node: TreeSitterNode, ctx: ExtractorOutput): void {
  // Check for require calls in the assignment
  const assignment = findChild(node, 'assignment_statement');
  if (assignment) {
    checkForRequire(assignment, ctx);
  }
}

function checkForRequire(node: TreeSitterNode, ctx: ExtractorOutput): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'function_call') {
      const nameNode = child.childForFieldName('name');
      if (nameNode && nameNode.type === 'identifier' && nameNode.text === 'require') {
        const args = child.childForFieldName('arguments');
        if (args) {
          const strArg = findChild(args, 'string');
          if (strArg) {
            const source = strArg.text.replace(/^['"]|['"]$/g, '');
            ctx.imports.push({
              source,
              names: ['require'],
              line: child.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

/**
 * Detect `<builtin> = <identifier>` assignments — a locally declared
 * function bound to a Lua global/builtin identifier (e.g.
 * `require = tracedRequire`), the monkey-patch pattern from issue #1776.
 * Every later unqualified call to the builtin name (`require(...)`)
 * anywhere in the codebase actually invokes the RHS function, but that call
 * site names the builtin, never the RHS function directly — so without
 * this, the RHS function has no inbound edge at all and is misclassified
 * dead-unresolved.
 *
 * Emits a dynamic `value-ref` call for the RHS identifier — the same
 * classification #1771 uses for bare identifiers referenced as
 * object-literal property values: a bare identifier used in a value
 * position, not a call site. Resolution downstream (build-edges.ts /
 * incremental.ts / build_edges.rs) already restricts `value-ref` calls to
 * function/method-kind targets only, so a builtin reassigned to a
 * non-function value (`unpack = someTable`) is silently dropped rather than
 * fabricating a nonsensical edge — no further changes needed there.
 *
 * Scoped narrowly to plain `identifier = identifier` pairs where the LHS
 * matches a known Lua builtin/stdlib-module name (`LUA_BUILTIN_GLOBALS`).
 * General local-to-local variable aliasing (`local a = someFunc; a()`) is a
 * much larger points-to/alias-tracking problem this fix does not attempt to
 * solve — see #1776 for the scoping rationale.
 *
 * Handles both the bare top-level form (`require = tracedRequire`, a
 * standalone `assignment_statement`) and the `local`-declared form
 * (`local require = tracedRequire`, an `assignment_statement` nested inside
 * `variable_declaration`) identically: shadowing a builtin name with
 * `local` is the same "redirect every later unqualified use" idiom, just
 * lexically scoped rather than truly global.
 *
 * Multi-assignment (`a, b = f, g`) is handled positionally, matching Lua's
 * own assignment semantics — mixed variable kinds (`t.b, a = f, g`) do not
 * shift the pairing, since each side is indexed independently by position
 * rather than pre-filtered to identifiers first.
 */
function handleLuaAssignmentStatement(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const variableList = findChild(node, 'variable_list');
  const expressionList = findChild(node, 'expression_list');
  if (!variableList || !expressionList) return;

  const variables = variableList.namedChildren;
  const expressions = expressionList.namedChildren;
  const pairCount = Math.min(variables.length, expressions.length);

  for (let i = 0; i < pairCount; i++) {
    const lhs = variables[i];
    const rhs = expressions[i];
    if (!lhs || !rhs) continue;
    if (lhs.type !== 'identifier' || rhs.type !== 'identifier') continue;
    if (!LUA_BUILTIN_GLOBALS.has(lhs.text) || LUA_BUILTIN_GLOBALS.has(rhs.text)) continue;

    ctx.calls.push({
      name: rhs.text,
      line: nodeStartLine(rhs),
      dynamic: true,
      dynamicKind: 'value-ref',
    });
  }
}

/**
 * Lua string node types across grammar variants — `string` is the only kind
 * the current `@tree-sitter-grammars/tree-sitter-lua` grammar (npm, used by
 * this WASM extractor) produces; `string_literal` is included so this stays
 * in lockstep with the native Rust extractor's own (equally defensive) check.
 */
const LUA_STRING_NODE_TYPES = new Set(['string', 'string_literal']);

function handleLuaFunctionCall(node: TreeSitterNode, ctx: ExtractorOutput): void {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return;

  // load(chunk) / loadstring(chunk) / dofile(...) — dynamic code execution;
  // undecidable statically. Mirrors handle_lua_function_call's `load` arm in
  // crates/codegraph-core/src/extractors/lua.rs.
  if (nameNode.type === 'identifier') {
    const ident = nameNode.text;
    if (ident === 'load' || ident === 'loadstring' || ident === 'dofile') {
      ctx.calls.push({
        name: '<dynamic:eval>',
        line: node.startPosition.row + 1,
        dynamic: true,
        dynamicKind: 'eval',
      });
      return;
    }
  }

  // Check for require() as import
  if (nameNode.type === 'identifier' && nameNode.text === 'require') {
    const args = node.childForFieldName('arguments');
    if (args) {
      const strArg = findChild(args, 'string');
      if (strArg) {
        const source = strArg.text.replace(/^['"]|['"]$/g, '');
        ctx.imports.push({
          source,
          names: ['require'],
          line: node.startPosition.row + 1,
        });
        return;
      }
    }
  }

  const call: Call = { name: '', line: node.startPosition.row + 1 };

  if (nameNode.type === 'method_index_expression') {
    const table = nameNode.childForFieldName('table');
    const method = nameNode.childForFieldName('method');
    if (method) call.name = method.text;
    if (table) call.receiver = table.text;
  } else if (nameNode.type === 'dot_index_expression') {
    const table = nameNode.childForFieldName('table');
    const field = nameNode.childForFieldName('field');
    if (field) call.name = field.text;
    if (table) call.receiver = table.text;
  } else if (nameNode.type === 'bracket_index_expression') {
    // t[k]() — bracket-index call; key may be a string literal (resolvable
    // directly, same as a `.field`/`:method` call) or a variable/expression
    // (undecidable statically — flagged `computed-key`). Mirrors
    // handle_lua_function_call's `bracket_index_expression` arm in
    // crates/codegraph-core/src/extractors/lua.rs.
    const table = nameNode.childForFieldName('table');
    const key = nameNode.childForFieldName('field');
    if (key) {
      if (LUA_STRING_NODE_TYPES.has(key.type)) {
        call.name = key.text.replace(/^['"]|['"]$/g, '');
        if (table) call.receiver = table.text;
      } else {
        const dynamicCall: Call = {
          name: '<dynamic:computed-key>',
          line: node.startPosition.row + 1,
          dynamic: true,
          dynamicKind: 'computed-key',
          keyExpr: key.text,
        };
        if (table) dynamicCall.receiver = table.text;
        ctx.calls.push(dynamicCall);
        return;
      }
    }
  } else {
    call.name = nameNode.text;
  }

  if (call.name) ctx.calls.push(call);
}
