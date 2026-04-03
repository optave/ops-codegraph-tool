import type { SubDeclaration, TreeSitterNode, TypeMapEntry } from '../types.js';

/**
 * Maximum recursion depth for tree-sitter AST walkers.
 * Shared across all language extractors to prevent stack overflow on deeply nested ASTs.
 */
export const MAX_WALK_DEPTH = 200;

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
