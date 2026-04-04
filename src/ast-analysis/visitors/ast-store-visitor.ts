import type {
  Definition,
  EnterNodeResult,
  TreeSitterNode,
  Visitor,
  VisitorContext,
} from '../../types.js';

const TEXT_MAX = 200;

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
  return s.length <= max ? s : `${s.slice(0, max - 1)}\u2026`;
}

function extractNewName(node: TreeSitterNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
  }
  return node.text?.split('(')[0]?.replace('new ', '').trim() || '?';
}

function extractExpressionText(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type !== 'throw' && child.type !== 'await') {
      return truncate(child.text);
    }
  }
  return truncate(node.text);
}

/** Extract the name from a throw statement's child nodes. */
function extractThrowName(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'new_expression') return extractNewName(child);
    if (child.type === 'call_expression') {
      const fn = child.childForFieldName('function');
      return fn ? fn.text : child.text?.split('(')[0] || '?';
    }
    if (child.type === 'identifier') return child.text;
  }
  return truncate(node.text);
}

/** Extract the name from an await expression's child nodes. */
function extractAwaitName(node: TreeSitterNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
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

export function createAstStoreVisitor(
  astTypeMap: Record<string, string>,
  defs: Definition[],
  relPath: string,
  nodeIdMap: Map<string, number>,
): Visitor {
  const rows: AstStoreRow[] = [];
  const matched = new Set<number>();

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
    const parentDef = findParentDef(line);
    if (!parentDef) return null;
    return nodeIdMap.get(`${parentDef.name}|${parentDef.kind}|${parentDef.line}`) || null;
  }

  function resolveNameAndText(
    node: TreeSitterNode,
    kind: string,
  ): { name: string | null | undefined; text: string | null; skip?: boolean } {
    switch (kind) {
      case 'new':
        return { name: extractNewName(node), text: truncate(node.text) };
      case 'throw':
        return { name: extractThrowName(node), text: extractExpressionText(node) };
      case 'await':
        return { name: extractAwaitName(node), text: extractExpressionText(node) };
      case 'string': {
        const content = node.text?.replace(/^['"`]|['"`]$/g, '') || '';
        if (content.length < 2) return { name: null, text: null, skip: true };
        return { name: truncate(content, 100), text: truncate(node.text) };
      }
      case 'regex':
        return { name: node.text || '?', text: truncate(node.text) };
      default:
        return { name: undefined, text: null };
    }
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

      const kind = astTypeMap[node.type];
      if (!kind) return;

      collectNode(node, kind);

      if (kind !== 'string' && kind !== 'regex') {
        return { skipChildren: true };
      }
    },

    finish(): AstStoreRow[] {
      return rows;
    },
  };
}
