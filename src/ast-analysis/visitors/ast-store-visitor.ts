import type {
  Definition,
  EnterNodeResult,
  TreeSitterNode,
  Visitor,
  VisitorContext,
} from '../../types.js';
import type { AstStringConfig } from '../rules/index.js';

const TEXT_MAX = 200;

// ── Cross-language node-type constants (mirror Rust `helpers.rs`) ────────
const IDENT_TYPES = new Set<string>([
  'identifier',
  'type_identifier',
  'name',
  'qualified_name',
  'scoped_identifier',
  'qualified_identifier',
  'member_expression',
  'member_access_expression',
  'field_expression',
  'attribute',
  'scoped_type_identifier',
]);

const CALL_TYPES = new Set<string>([
  'call_expression',
  'call',
  'invocation_expression',
  'method_invocation',
  'function_call_expression',
  'member_call_expression',
  'scoped_call_expression',
]);

const DEFAULT_STRING_CONFIG: AstStringConfig = { quoteChars: '\'"`', stringPrefixes: '' };

// Keyword tokens skipped when extracting the inner expression text of a
// throw/raise/await/new node. Module-level constant avoids reallocating on
// every call (can be hot in large files).
const CHILD_EXPR_SKIP_KEYWORDS = new Set<string>(['throw', 'raise', 'await', 'new']);

interface AstStoreRow {
  file: string;
  line: number;
  kind: string;
  name: string | null | undefined;
  text: string | null;
  receiver: string | null;
  parentNodeId: number | null;
}

function truncate(s: string | null | undefined, max: number = TEXT_MAX): string | null {
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function trimLeadingChars(s: string, chars: string): string {
  if (!chars) return s;
  let i = 0;
  while (i < s.length && chars.includes(s[i]!)) i++;
  return i === 0 ? s : s.slice(i);
}

function trimTrailingChars(s: string, chars: string): string {
  if (!chars) return s;
  let i = s.length;
  while (i > 0 && chars.includes(s[i - 1]!)) i--;
  return i === s.length ? s : s.slice(0, i);
}

/** Extract constructor name from a `new_expression` / `object_creation_expression`. */
function extractConstructorName(node: TreeSitterNode): string {
  for (const field of ['type', 'class', 'constructor']) {
    const f = node.childForFieldName(field);
    if (f?.text) return f.text;
  }
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (IDENT_TYPES.has(child.type)) return child.text;
  }
  const raw = node.text || '';
  const beforeParen = raw.split('(')[0] || raw;
  return beforeParen.replace(/^new\s+/, '').trim() || '?';
}

/** Extract function name from a call node. */
function extractCallName(node: TreeSitterNode): string {
  for (const field of ['function', 'method', 'name']) {
    const f = node.childForFieldName(field);
    if (f?.text) return f.text;
  }
  const text = node.text || '';
  return text.split('(')[0] || '?';
}

/** Extract name from a throw/raise statement — matches native `extract_throw_target`. */
function extractThrowName(node: TreeSitterNode, newTypes: Set<string>): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const ck = child.type;
    if (newTypes.has(ck)) return extractConstructorName(child);
    if (CALL_TYPES.has(ck)) return extractCallName(child);
    if (IDENT_TYPES.has(ck)) return child.text;
  }
  return truncate(node.text) ?? node.text ?? '';
}

/** Extract name from an await expression — matches native `extract_awaited_name`. */
function extractAwaitName(node: TreeSitterNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const ck = child.type;
    if (CALL_TYPES.has(ck)) return extractCallName(child);
    if (IDENT_TYPES.has(ck)) return child.text;
  }
  return truncate(node.text) ?? node.text ?? '';
}

/** Extract text of the expression inside a throw/await, skipping the keyword. */
function extractChildExpressionText(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (!CHILD_EXPR_SKIP_KEYWORDS.has(child.type)) return truncate(child.text);
  }
  return truncate(node.text);
}

/**
 * Count code points cheaply: skip the `[...s]` spread when `s.length` already
 * decides the answer. Each code point is 1 or 2 UTF-16 units, so `.length < 2`
 * implies `< 2` code points and `.length >= 3` already guarantees `>= 2` code
 * points (worst case: one surrogate pair + one BMP char = 2 code points).
 * Only `.length === 2` is genuinely ambiguous (could be a single surrogate
 * pair = 1 code point, or two BMP chars = 2 code points) and needs the spread.
 */
function codePointCountAtLeast2(s: string): boolean {
  const len = s.length;
  if (len < 2) return false;
  if (len >= 3) return true;
  return [...s].length >= 2;
}

/**
 * Extract string content from a string-literal node, mirroring the native
 * engine's `build_string_node` (`helpers.rs`). Returns `null` when the
 * content is shorter than 2 Unicode code points.
 */
function extractStringContent(node: TreeSitterNode, cfg: AstStringConfig): string | null {
  const raw = node.text ?? '';
  const isRawString = node.type.includes('raw_string');

  let s = raw;
  s = trimLeadingChars(s, '@');
  if (cfg.stringPrefixes) s = trimLeadingChars(s, cfg.stringPrefixes);
  if (isRawString) s = trimLeadingChars(s, 'r#');
  s = trimLeadingChars(s, cfg.quoteChars);
  if (isRawString) s = trimTrailingChars(s, '#');
  s = trimTrailingChars(s, cfg.quoteChars);

  return codePointCountAtLeast2(s) ? s : null;
}

// Per-astTypeMap cache for the set of node-types that map to kind 'new'.
// Computed once per unique astTypeMap reference (one per language) instead
// of once per file.
const _newTypesCache = new WeakMap<Record<string, string>, Set<string>>();
function newTypesFor(astTypeMap: Record<string, string>): Set<string> {
  let s = _newTypesCache.get(astTypeMap);
  if (s) return s;
  s = new Set<string>();
  for (const type in astTypeMap) {
    if (astTypeMap[type] === 'new') s.add(type);
  }
  _newTypesCache.set(astTypeMap, s);
  return s;
}

export function createAstStoreVisitor(
  astTypeMap: Record<string, string>,
  defs: Definition[],
  relPath: string,
  nodeIdMap: Map<string, number>,
  stringConfig: AstStringConfig = DEFAULT_STRING_CONFIG,
  stopRecurseKinds: ReadonlySet<string> = new Set(),
): Visitor {
  const rows: AstStoreRow[] = [];
  const matched = new Set<number>();
  const newTypes = newTypesFor(astTypeMap);
  // When nodeIdMap is empty, parentNodeId resolution is wasted work — the
  // worker passes an empty map and the main thread re-resolves against its
  // own DB-populated map in features/ast.ts::collectFileAstRows. Skip the
  // findParentDef linear scan in that case.
  const skipParentLookup = nodeIdMap.size === 0;

  function findParentDef(line: number): Definition | null {
    let best: Definition | null = null;
    for (const def of defs) {
      if (def.line <= line && (def.endLine == null || def.endLine >= line)) {
        if (!best || (def.endLine ?? 0) - def.line < (best.endLine ?? 0) - best.line) {
          best = def;
        }
      }
    }
    return best;
  }

  function resolveParentNodeId(line: number): number | null {
    if (skipParentLookup) return null;
    const parentDef = findParentDef(line);
    if (!parentDef) return null;
    return nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
  }

  type NameTextResult = { name: string | null | undefined; text: string | null; skip?: boolean };
  type KindHandler = (node: TreeSitterNode) => NameTextResult;

  const kindHandlers: Record<string, KindHandler> = {
    new: (node) => ({ name: extractConstructorName(node), text: truncate(node.text) }),
    throw: (node) => ({
      name: extractThrowName(node, newTypes),
      text: extractChildExpressionText(node),
    }),
    await: (node) => ({ name: extractAwaitName(node), text: extractChildExpressionText(node) }),
    string: (node) => {
      const content = extractStringContent(node, stringConfig);
      if (content == null) return { name: null, text: null, skip: true };
      return { name: truncate(content, 100), text: truncate(node.text) };
    },
    regex: (node) => ({ name: node.text || '?', text: truncate(node.text) }),
  };
  const defaultResult: NameTextResult = { name: undefined, text: null };

  function resolveNameAndText(node: TreeSitterNode, kind: string): NameTextResult {
    const handler = kindHandlers[kind];
    return handler ? handler(node) : defaultResult;
  }

  function collectNode(node: TreeSitterNode, kind: string): void {
    if (matched.has(node.id)) return;

    const resolved = resolveNameAndText(node, kind);
    if (resolved.skip) return;

    rows.push({
      file: relPath,
      line: node.startPosition.row + 1,
      kind,
      name: resolved.name,
      text: resolved.text,
      receiver: null,
      parentNodeId: resolveParentNodeId(node.startPosition.row + 1),
    });

    matched.add(node.id);
  }

  return {
    name: 'ast-store',

    enterNode(node: TreeSitterNode, _context: VisitorContext): EnterNodeResult | undefined {
      // Guard: skip re-collection but do NOT skipChildren — node.id (memory address)
      // can be reused by tree-sitter, so a collision would incorrectly suppress an
      // unrelated subtree. The parent call's skipChildren handles the intended case.
      if (matched.has(node.id)) return;

      // Gate with `hasOwn` because plain-object lookup walks Object.prototype:
      // tree-sitter node types like `constructor` (Haskell sum-types: Left,
      // Right) would otherwise resolve to `Object.prototype.constructor` (the
      // Object() function), which then crashes the worker boundary with
      // "function Object() { [native code] } could not be cloned" when the
      // resulting astNodes row is structured-cloned back to the main thread.
      if (!Object.hasOwn(astTypeMap, node.type)) return;
      const kind = astTypeMap[node.type];
      if (!kind) return;

      collectNode(node, kind);

      // Mirror the native walker's recursion policy. In JS/TS, the native
      // javascript.rs walker returns after collecting `new` or `throw` to
      // avoid double-counting the wrapped expression (e.g. `throw new
      // Error('x')` emits one `throw` row, not throw+new+string). Other
      // languages go through helpers.rs::walk_ast_nodes_with_config_depth
      // which always recurses — so `stopRecurseKinds` is empty for them.
      if (stopRecurseKinds.has(kind)) {
        return { skipChildren: true };
      }
    },

    finish(): AstStoreRow[] {
      return rows;
    },
  };
}
