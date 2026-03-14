export function nodeEndLine(node) {
  return node.endPosition.row + 1;
}

export function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === type) return child;
  }
  return null;
}

/**
 * Extract visibility from a node by scanning its children for modifier keywords.
 * Works for Java, C#, PHP, and similar languages where modifiers are child nodes.
 * @param {object} node - tree-sitter node
 * @param {Set<string>} [modifierTypes] - node types that indicate modifiers
 * @returns {'public'|'private'|'protected'|undefined}
 */
const DEFAULT_MODIFIER_TYPES = new Set([
  'modifiers',
  'modifier',
  'visibility_modifier',
  'accessibility_modifier',
]);
const VISIBILITY_KEYWORDS = new Set(['public', 'private', 'protected']);

/**
 * Python convention: __name → private, _name → protected, else undefined.
 */
export function pythonVisibility(name) {
  if (name.startsWith('__') && name.endsWith('__')) return undefined; // dunder — public
  if (name.startsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return undefined;
}

/**
 * Go convention: uppercase first letter → public, lowercase → private.
 */
export function goVisibility(name) {
  if (!name) return undefined;
  // Strip receiver prefix (e.g., "Receiver.Method" → check "Method")
  const bare = name.includes('.') ? name.split('.').pop() : name;
  if (!bare) return undefined;
  return bare[0] === bare[0].toUpperCase() && bare[0] !== bare[0].toLowerCase()
    ? 'public'
    : 'private';
}

/**
 * Rust: check for `visibility_modifier` child (pub, pub(crate), etc.).
 */
export function rustVisibility(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'visibility_modifier') {
      return 'public'; // pub, pub(crate), pub(super) all mean "visible"
    }
  }
  return 'private';
}

export function extractModifierVisibility(node, modifierTypes = DEFAULT_MODIFIER_TYPES) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    // Direct keyword match (e.g., PHP visibility_modifier = "public")
    if (modifierTypes.has(child.type)) {
      const text = child.text;
      if (VISIBILITY_KEYWORDS.has(text)) return text;
      // C# 'private protected' — accessible to derived types in same assembly → protected
      if (text === 'private protected') return 'protected';
      // Compound modifiers node (Java: "public static") — scan its text for a keyword
      for (const kw of VISIBILITY_KEYWORDS) {
        if (text.includes(kw)) return kw;
      }
    }
  }
  return undefined;
}
