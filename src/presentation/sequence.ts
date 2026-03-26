import { kindIcon } from '../domain/queries.js';
import { sequenceData, sequenceToMermaid } from '../features/sequence.js';
import { outputResult } from '../infrastructure/result-formatter.js';

interface SequenceOpts {
  json?: boolean;
  ndjson?: boolean;
  table?: boolean;
  csv?: boolean;
  depth?: number;
  noTests?: boolean;
  file?: string;
  kind?: string;
  limit?: number;
  offset?: number;
}

export function sequence(name: string, dbPath: string | undefined, opts: SequenceOpts = {}): void {
  const data = sequenceData(name, dbPath, opts) as any;

  if (outputResult(data, 'messages', opts)) return;

  // Default: mermaid format
  if (!data.entry) {
    console.log(`No matching function found for "${name}".`);
    return;
  }

  const e = data.entry;
  console.log(`\nSequence from: [${kindIcon(e.kind)}] ${e.name}  ${e.file}:${e.line}`);
  console.log(`Participants: ${data.participants.length}  Messages: ${data.totalMessages}`);
  if (data.truncated) {
    console.log(`  (truncated at depth ${data.depth})`);
  }
  console.log();

  if (data.messages.length === 0) {
    console.log('  (leaf node — no callees)');
    return;
  }

  console.log(sequenceToMermaid(data));
}
