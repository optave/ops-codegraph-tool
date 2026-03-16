import { splitIdentifier } from './text-utils.js';

/**
 * Build raw source-code text for a symbol (original strategy).
 */
export function buildSourceText(node, file, lines) {
  const startLine = Math.max(0, node.line - 1);
  const endLine = node.end_line
    ? Math.min(lines.length, node.end_line)
    : Math.min(lines.length, startLine + 15);
  const context = lines.slice(startLine, endLine).join('\n');
  const readable = splitIdentifier(node.name);
  return `${node.kind} ${node.name} (${readable}) in ${file}\n${context}`;
}
