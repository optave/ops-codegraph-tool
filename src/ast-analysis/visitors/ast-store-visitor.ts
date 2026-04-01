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

function extractName(kind: string, node: TreeSitterNode): string | null {
  if (kind === 'throw') {
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
  if (kind === 'await') {
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

  function collectNode(node: TreeSitterNode, kind: string): void {
    if (matched.has(node.id)) return;

    const line = node.startPosition.row + 1;
    let name: string | null | undefined;
    let text: string | null = null;

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
      if (content.length < 2) return;
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
