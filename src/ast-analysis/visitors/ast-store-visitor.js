/**
 * Visitor: Extract new/throw/await/string/regex AST nodes during a shared walk.
 *
 * Replaces the standalone walkAst() DFS in ast.js with a visitor that plugs
 * into the unified walkWithVisitors framework.
 */

/** Max length for the `text` column. */
const TEXT_MAX = 200;

function truncate(s, max = TEXT_MAX) {
  if (!s) return null;
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}

function extractNewName(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
  }
  return node.text?.split('(')[0]?.replace('new ', '').trim() || '?';
}

function extractExpressionText(node) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type !== 'throw' && child.type !== 'await') {
      return truncate(child.text);
    }
  }
  return truncate(node.text);
}

function extractName(kind, node) {
  if (kind === 'throw') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'new_expression') return extractNewName(child);
      if (child.type === 'call_expression') {
        const fn = child.childForFieldName('function');
        return fn ? fn.text : child.text?.split('(')[0] || '?';
      }
      if (child.type === 'identifier') return child.text;
    }
    return truncate(node.text);
  }
  if (kind === 'await') {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type === 'call_expression') {
        const fn = child.childForFieldName('function');
        return fn ? fn.text : child.text?.split('(')[0] || '?';
      }
      if (child.type === 'identifier' || child.type === 'member_expression') {
        return child.text;
      }
    }
    return truncate(node.text);
  }
  return truncate(node.text);
}

/**
 * Create an AST-store visitor for use with walkWithVisitors.
 *
 * @param {object} astTypeMap - node type → kind mapping (e.g. JS_TS_AST_TYPES)
 * @param {object[]} defs     - symbol definitions for parent lookup
 * @param {string} relPath    - relative file path
 * @param {Map} nodeIdMap     - def key → node ID mapping
 * @returns {Visitor}
 */
export function createAstStoreVisitor(astTypeMap, defs, relPath, nodeIdMap) {
  const rows = [];
  // Track which nodes we've already matched to avoid duplicates in recursive walk
  const matched = new Set();

  function findParentDef(line) {
    let best = null;
    for (const def of defs) {
      if (def.line <= line && (def.endLine == null || def.endLine >= line)) {
        if (!best || def.endLine - def.line < best.endLine - best.line) {
          best = def;
        }
      }
    }
    return best;
  }

  function resolveParentNodeId(line) {
    const parentDef = findParentDef(line);
    if (!parentDef) return null;
    return nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
  }

  return {
    name: 'ast-store',

    enterNode(node, _context) {
      if (matched.has(node.id)) return;

      const kind = astTypeMap[node.type];
      if (!kind) return;

      const line = node.startPosition.row + 1;
      let name;
      let text = null;

      if (kind === 'new') {
        name = extractNewName(node);
        text = truncate(node.text);
      } else if (kind === 'throw') {
        name = extractName('throw', node);
        text = extractExpressionText(node);
      } else if (kind === 'await') {
        name = extractName('await', node);
        text = extractExpressionText(node);
      } else if (kind === 'string') {
        const content = node.text?.replace(/^['"`]|['"`]$/g, '') || '';
        if (content.length < 2) return; // skip trivial strings, walker still descends
        name = truncate(content, 100);
        text = truncate(node.text);
      } else if (kind === 'regex') {
        name = node.text || '?';
        text = truncate(node.text);
      }

      rows.push({
        file: relPath,
        line,
        kind,
        name,
        text,
        receiver: null,
        parentNodeId: resolveParentNodeId(line),
      });

      matched.add(node.id);

      // Don't recurse into children for new/throw/await (same as original walkAst)
      if (kind !== 'string' && kind !== 'regex') {
        return { skipChildren: true };
      }
    },

    finish() {
      return rows;
    },
  };
}
