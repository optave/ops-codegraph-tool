import { findCalleeNames, findCallerNames } from '../../../db/index.js';
import type { BetterSqlite3Database, NodeRow } from '../../../types.js';
import { extractLeadingComment, splitIdentifier } from './text-utils.js';

interface NodeWithId extends Pick<NodeRow, 'name' | 'kind' | 'file' | 'line'> {
  id: number;
}

/**
 * Build graph-enriched text for a symbol using dependency context.
 */
export function buildStructuredText(
  node: NodeWithId,
  file: string,
  lines: string[],
  db: BetterSqlite3Database,
): string {
  const readable = splitIdentifier(node.name);
  const parts: string[] = [`${node.kind} ${node.name} (${readable}) in ${file}`];
  const startLine = Math.max(0, node.line - 1);

  const sigLine = lines[startLine] || '';
  const paramMatch = sigLine.match(/\(([^)]*)\)/);
  if (paramMatch?.[1]?.trim()) {
    parts.push(`Parameters: ${paramMatch[1].trim()}`);
  }

  const callees = findCalleeNames(db, node.id);
  if (callees.length > 0) {
    parts.push(`Calls: ${callees.slice(0, 10).join(', ')}`);
  }

  const callers = findCallerNames(db, node.id);
  if (callers.length > 0) {
    parts.push(`Called by: ${callers.slice(0, 10).join(', ')}`);
  }

  const comment = extractLeadingComment(lines, startLine);
  if (comment) {
    parts.push(comment);
  } else {
    const endLine = Math.min(lines.length, startLine + 4);
    const snippet = lines.slice(startLine, endLine).join('\n').trim();
    if (snippet) parts.push(snippet);
  }

  return parts.join('\n');
}
