/**
 * Mermaid sequence diagram renderer — pure data → string transform.
 *
 * Converts sequenceData() output into Mermaid sequenceDiagram syntax.
 * No DB access, no I/O — just data in, formatted string out.
 */

/**
 * Escape special Mermaid characters in labels.
 */
function escapeMermaid(str) {
  return str
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/:/g, '#colon;')
    .replace(/"/g, '#quot;');
}

/**
 * Convert sequenceData result to Mermaid sequenceDiagram syntax.
 * @param {{ participants, messages, truncated, depth }} seqResult
 * @returns {string}
 */
export function sequenceToMermaid(seqResult) {
  const lines = ['sequenceDiagram'];

  for (const p of seqResult.participants) {
    lines.push(`    participant ${p.id} as ${escapeMermaid(p.label)}`);
  }

  for (const msg of seqResult.messages) {
    const arrow = msg.type === 'return' ? '-->>' : '->>';
    lines.push(`    ${msg.from}${arrow}${msg.to}: ${escapeMermaid(msg.label)}`);
  }

  if (seqResult.truncated && seqResult.participants.length > 0) {
    lines.push(
      `    note right of ${seqResult.participants[0].id}: Truncated at depth ${seqResult.depth}`,
    );
  }

  return lines.join('\n');
}
