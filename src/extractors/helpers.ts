import type {
  Call,
  DynamicKind,
  ExtractorOutput,
  Import,
  SubDeclaration,
  TreeSitterNode,
  TypeMapEntry,
} from '../types.js';

/**
 * Maximum recursion depth for tree-sitter AST walkers.
 * Shared across all language extractors to prevent stack overflow on deeply nested ASTs.
 */
export const MAX_WALK_DEPTH = 200;

/** Convert a tree-sitter node's start row to a 1-based source line. */
export function nodeStartLine(node: TreeSitterNode): number {
  return node.startPosition.row + 1;
}

export function nodeEndLine(node: TreeSitterNode): number {
  return node.endPosition.row + 1;
}

export function findChild(node: TreeSitterNode, type: string): TreeSitterNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/**
 * Find the first child whose type is in `types`. Useful when several grammar
 * variants name the same conceptual node differently (e.g. `string` vs
 * `string_literal`). Returns the first match in document order, or null.
 */
export function findFirstChildOfTypes(
  node: TreeSitterNode,
  types: readonly string[],
): TreeSitterNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

/**
 * Iterate the direct children of `node` in document order, skipping nulls and
 * tokens whose type appears in `skipTypes`. Mirrors the common
 * `for (let i = 0; i < node.childCount; i++) { const c = node.child(i); if (...) continue; ... }`
 * idiom while letting callers filter out grammar punctuation (`,`, `(`, `{`, etc.).
 */
export function* iterChildren(
  node: TreeSitterNode,
  skipTypes: ReadonlySet<string> = EMPTY_SKIP_SET,
): Generator<TreeSitterNode> {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (skipTypes.has(child.type)) continue;
    yield child;
  }
}

const EMPTY_SKIP_SET: ReadonlySet<string> = new Set();

/** Common punctuation tokens — handy as a `skipTypes` set for `iterChildren`. */
export const PUNCTUATION_TOKENS: ReadonlySet<string> = new Set([
  ',',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ':',
  '.',
]);

/**
 * Merge a type-map entry, keeping the higher-confidence one.
 * Shared across all language extractors that build type maps for call resolution.
 */
export function setTypeMapEntry(
  typeMap: Map<string, TypeMapEntry>,
  name: string,
  type: string,
  confidence: number,
): void {
  const existing = typeMap.get(name);
  if (!existing || confidence > existing.confidence) {
    typeMap.set(name, { type, confidence });
  }
}

/**
 * Extract visibility from a node by scanning its children for modifier keywords.
 * Works for Java, C#, PHP, and similar languages where modifiers are child nodes.
 * @param {object} node - tree-sitter node
 * @param {Set<string>} [modifierTypes] - node types that indicate modifiers
 * @returns {'public'|'private'|'protected'|undefined}
 */
const DEFAULT_MODIFIER_TYPES: Set<string> = new Set([
  'modifiers',
  'modifier',
  'visibility_modifier',
  'accessibility_modifier',
]);
const VISIBILITY_KEYWORDS: Set<string> = new Set(['public', 'private', 'protected']);

/**
 * Python convention: __name → private, _name → protected, else undefined.
 */
export function pythonVisibility(name: string): 'public' | 'private' | 'protected' | undefined {
  if (name.startsWith('__') && name.endsWith('__')) return undefined; // dunder — public
  if (name.startsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return undefined;
}

/**
 * Go convention: uppercase first letter → public, lowercase → private.
 */
export function goVisibility(name: string): 'public' | 'private' | 'protected' | undefined {
  if (!name) return undefined;
  // Strip receiver prefix (e.g., "Receiver.Method" → check "Method")
  const bare = name.includes('.') ? (name.split('.').pop() ?? name) : name;
  if (!bare) return undefined;
  const first = bare[0];
  if (!first) return undefined;
  return first === first.toUpperCase() && first !== first.toLowerCase() ? 'public' : 'private';
}

/**
 * Rust: check for `visibility_modifier` child (pub, pub(crate), etc.).
 */
export function rustVisibility(node: TreeSitterNode): 'public' | 'private' {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'visibility_modifier') {
      return 'public'; // pub, pub(crate), pub(super) all mean "visible"
    }
  }
  return 'private';
}

// ── Parser abstraction helpers ─────────────────────────────────────────────

/**
 * Walk up the parent chain to find an enclosing node whose type is in `typeNames`.
 * Returns the text of `nameField` (default `'name'`) on the matching ancestor, or null.
 *
 * Replaces per-language `findParentClass` / `findParentType` / `findCurrentImpl` helpers.
 */
export function findParentNode(
  node: TreeSitterNode,
  typeNames: readonly string[],
  nameField: string = 'name',
): string | null {
  let current = node.parent;
  while (current) {
    if (typeNames.includes(current.type)) {
      const nameNode = current.childForFieldName(nameField);
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

/**
 * Resolve a container's body node by trying each field name in order.
 */
function resolveBodyNode(
  containerNode: TreeSitterNode,
  bodyFields: readonly string[],
): TreeSitterNode | null {
  for (const field of bodyFields) {
    const body = containerNode.childForFieldName(field) || findChild(containerNode, field);
    if (body) return body;
  }
  return null;
}

/**
 * Extract child declarations from a container node's body.
 * Finds the body via `bodyFields` (tries childForFieldName then findChild for each),
 * iterates its children, filters by `memberType`, extracts `nameField`, and returns SubDeclarations.
 *
 * Replaces per-language extractStructFields / extractEnumVariants / extractEnumConstants helpers
 * for the common case where each member has a direct name field.
 */
export function extractBodyMembers(
  containerNode: TreeSitterNode,
  bodyFields: readonly string[],
  memberType: string,
  kind: SubDeclaration['kind'],
  nameField: string = 'name',
  visibility?: (member: TreeSitterNode) => SubDeclaration['visibility'],
): SubDeclaration[] {
  const body = resolveBodyNode(containerNode, bodyFields);
  if (!body) return [];
  const members: SubDeclaration[] = [];
  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member || member.type !== memberType) continue;
    const nn = member.childForFieldName(nameField);
    if (!nn) continue;
    const entry: SubDeclaration = { name: nn.text, kind, line: member.startPosition.row + 1 };
    if (visibility) entry.visibility = visibility(member);
    members.push(entry);
  }
  return members;
}

/**
 * Strip leading/trailing quotes (single, double, or backtick) from a string.
 * Strips only the leading/trailing delimiter; interior quotes are untouched.
 */
export function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

/**
 * Extract the last segment of a delimited path.
 * e.g. `lastPathSegment('java.util.List', '.')` → `'List'`
 */
export function lastPathSegment(path: string, separator: string = '/'): string {
  return path.split(separator).pop() ?? path;
}

/**
 * Parse visibility from a modifier node's text content.
 */
function parseModifierText(text: string): 'public' | 'private' | 'protected' | undefined {
  if (VISIBILITY_KEYWORDS.has(text)) return text as 'public' | 'private' | 'protected';
  // C# 'private protected' — accessible to derived types in same assembly → protected
  if (text === 'private protected') return 'protected';
  // Compound modifiers node (Java: "public static") — scan its text for a keyword
  for (const kw of VISIBILITY_KEYWORDS) {
    if (text.includes(kw)) return kw as 'public' | 'private' | 'protected';
  }
  return undefined;
}

export function extractModifierVisibility(
  node: TreeSitterNode,
  modifierTypes: Set<string> = DEFAULT_MODIFIER_TYPES,
): 'public' | 'private' | 'protected' | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child || !modifierTypes.has(child.type)) continue;
    const result = parseModifierText(child.text);
    if (result) return result;
  }
  return undefined;
}

// ── Output-push helpers ────────────────────────────────────────────────────
//
// Most extractors finish with `ctx.calls.push({ name, line: node.startPosition.row + 1 })`
// or `ctx.imports.push({ source, names, line: node.startPosition.row + 1 })`.
// Centralising the construction keeps `line` derivation consistent and removes
// the ~108 hand-rolled `startPosition.row + 1` literals scattered across
// language extractors.

/**
 * Append a `Call` to the extractor output. `line` defaults to the start line of
 * `node`; pass `extra` for `receiver` / `dynamic` / `dynamicKind` / `keyExpr` fields.
 */
export function pushCall(
  ctx: ExtractorOutput,
  node: TreeSitterNode,
  name: string,
  extra: { receiver?: string; dynamic?: boolean; dynamicKind?: DynamicKind; keyExpr?: string } = {},
): void {
  if (!name) return;
  const call: Call = { name, line: nodeStartLine(node) };
  if (extra.receiver !== undefined) call.receiver = extra.receiver;
  if (extra.dynamic !== undefined) call.dynamic = extra.dynamic;
  if (extra.dynamicKind !== undefined) call.dynamicKind = extra.dynamicKind;
  if (extra.keyExpr !== undefined) call.keyExpr = extra.keyExpr;
  ctx.calls.push(call);
}

/**
 * Append an `Import` to the extractor output. `line` defaults to the start
 * line of `node`. If `names` is empty, the source basename (split on `/`) is
 * used as a single-name fallback — matching the convention in gleam, julia,
 * and similar module-path imports.
 */
export function pushImport(
  ctx: ExtractorOutput,
  node: TreeSitterNode,
  source: string,
  names: string[],
  flags: Partial<Omit<Import, 'source' | 'names' | 'line'>> = {},
): void {
  if (!source) return;
  const resolved = names.length > 0 ? names : [lastPathSegment(source, '/') || source];
  const entry: Import = { source, names: resolved, line: nodeStartLine(node) };
  Object.assign(entry, flags);
  ctx.imports.push(entry);
}

// ── C-family primitive types ───────────────────────────────────────────────

/**
 * Primitive C/C++/CUDA types that are never class/struct receivers. Seeding
 * these into typeMap would produce spurious receiver edges (e.g. `int x` → `int`).
 * Shared between the C++ and CUDA extractors to prevent divergence.
 */
export const C_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'int',
  'long',
  'short',
  'unsigned',
  'signed',
  'float',
  'double',
  'char',
  'bool',
  'void',
  'wchar_t',
  'auto',
  'size_t',
  'uint8_t',
  'uint16_t',
  'uint32_t',
  'uint64_t',
  'int8_t',
  'int16_t',
  'int32_t',
  'int64_t',
  'ptrdiff_t',
  'intptr_t',
  'uintptr_t',
]);

/**
 * Return true when `typeName` is a primitive C/C++/CUDA type.
 * Strips leading qualifiers (`const int` → `int`) before checking.
 */
export function isCPrimitiveType(typeName: string): boolean {
  const base = typeName.split(/\s+/).pop() ?? typeName;
  return C_PRIMITIVE_TYPES.has(base) || C_PRIMITIVE_TYPES.has(typeName);
}

// ── Parameter extraction ───────────────────────────────────────────────────

/**
 * Options for {@link extractSimpleParameters}.
 */
export interface ExtractParametersOptions {
  /** Tree-sitter types that mark a single parameter node (e.g. `formal_parameter`). */
  paramTypes: readonly string[];
  /**
   * Field name on each parameter that holds the bound identifier. Defaults to
   * `'name'`. Pass `null` to use the parameter node itself when its type is in
   * `paramTypes` and it has no `name` field (e.g. R's bare `identifier`).
   */
  nameField?: string | null;
  /**
   * If true, when `nameField` lookup fails fall back to the first `identifier`
   * child of the parameter. Useful for Gleam / Solidity-style grammars.
   */
  fallbackToIdentifier?: boolean;
  /**
   * Optional type-map sink. When provided, the parameter's `type` field text
   * (if present) is recorded with the given confidence.
   */
  typeMap?: Map<string, TypeMapEntry>;
  /** Confidence used when writing into `typeMap`. Defaults to `0.9`. */
  typeMapConfidence?: number;
  /**
   * Optional callback to derive the type text from the parameter's `type`
   * field node. Defaults to `node.text`. Use this for languages where the
   * `type` field is wrapped (e.g. Java `generic_type` → first child).
   */
  resolveType?: (typeNode: TreeSitterNode) => string | undefined;
}

/**
 * Extract parameters from a parameter-list node using a uniform pattern.
 *
 * This collapses the boilerplate in `extract*Params` helpers across
 * Java/Julia/Gleam/Solidity/R/etc. — each one walks the parameter list,
 * matches a parameter node type, reads the `name` field, and pushes a
 * `SubDeclaration` with `kind: 'parameter'`.
 */
export function extractSimpleParameters(
  paramListNode: TreeSitterNode | null,
  options: ExtractParametersOptions,
): SubDeclaration[] {
  const params: SubDeclaration[] = [];
  if (!paramListNode) return params;
  const { paramTypes, nameField = 'name', fallbackToIdentifier = false } = options;

  for (let i = 0; i < paramListNode.childCount; i++) {
    const param = paramListNode.child(i);
    if (!param || !paramTypes.includes(param.type)) continue;
    const nameNode = resolveParamName(param, nameField, fallbackToIdentifier);
    if (!nameNode) continue;
    params.push({ name: nameNode.text, kind: 'parameter', line: nodeStartLine(param) });
    recordParamType(param, nameNode.text, options);
  }
  return params;
}

/** Record a parameter's declared type into the type-map sink, if configured. */
function recordParamType(
  param: TreeSitterNode,
  paramName: string,
  options: ExtractParametersOptions,
): void {
  const { typeMap, resolveType, typeMapConfidence = 0.9 } = options;
  if (!typeMap) return;
  const typeNode = param.childForFieldName('type');
  if (!typeNode) return;
  const typeText = resolveType ? resolveType(typeNode) : typeNode.text;
  if (!typeText) return;
  setTypeMapEntry(typeMap, paramName, typeText, typeMapConfidence);
}

/**
 * Resolve the identifier node that names a parameter. Used by
 * {@link extractSimpleParameters}; exposed so language-specific extractors
 * can reuse the same lookup logic in custom loops.
 */
export function resolveParamName(
  paramNode: TreeSitterNode,
  nameField: string | null,
  fallbackToIdentifier: boolean,
): TreeSitterNode | null {
  if (nameField === null) {
    return paramNode;
  }
  const named = paramNode.childForFieldName(nameField);
  if (named) return named;
  if (fallbackToIdentifier) {
    return findChild(paramNode, 'identifier');
  }
  return null;
}
