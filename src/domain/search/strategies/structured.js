import { findCalleeNames, findCallerNames } from '../../../db/index.js';
import { extractLeadingComment, splitIdentifier } from './text-utils.js';

/**
 * Build graph-enriched text for a symbol using dependency context.
 * Produces compact, semantic text (~100 tokens) instead of full source code.
 */
export function buildStructuredText(node, file, lines, db) {
  const readable = splitIdentifier(node.name);
  const parts = [`${node.kind} ${node.name} (${readable}) in ${file}`];
  const startLine = Math.max(0, node.line - 1);

  // Extract parameters from signature (best-effort, single-line)
  const sigLine = lines[startLine] || '';
  const paramMatch = sigLine.match(/\(([^)]*)\)/);
  if (paramMatch?.[1]?.trim()) {
    parts.push(`Parameters: ${paramMatch[1].trim()}`);
  }

  // Graph context: callees (capped at 10)
  const callees = findCalleeNames(db, node.id);
  if (callees.length > 0) {
    parts.push(`Calls: ${callees.slice(0, 10).join(', ')}`);
  }

  // Graph context: callers (capped at 10)
  const callers = findCallerNames(db, node.id);
  if (callers.length > 0) {
    parts.push(`Called by: ${callers.slice(0, 10).join(', ')}`);
  }

  // Leading comment (high semantic value) or first few lines of code
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
