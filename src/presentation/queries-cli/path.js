import { kindIcon, pathData } from '../../domain/queries.js';
import { outputResult } from '../../infrastructure/result-formatter.js';

export function symbolPath(from, to, customDbPath, opts = {}) {
  const data = pathData(from, to, customDbPath, opts);
  if (outputResult(data, null, opts)) return;

  if (data.error) {
    console.log(data.error);
    return;
  }

  if (!data.found) {
    const dir = data.reverse ? 'reverse ' : '';
    console.log(`No ${dir}path from "${from}" to "${to}" within ${data.maxDepth} hops.`);
    if (data.fromCandidates.length > 1) {
      console.log(
        `\n  "${from}" matched ${data.fromCandidates.length} symbols — using top match: ${data.fromCandidates[0].name} (${data.fromCandidates[0].file}:${data.fromCandidates[0].line})`,
      );
    }
    if (data.toCandidates.length > 1) {
      console.log(
        `  "${to}" matched ${data.toCandidates.length} symbols — using top match: ${data.toCandidates[0].name} (${data.toCandidates[0].file}:${data.toCandidates[0].line})`,
      );
    }
    return;
  }

  if (data.hops === 0) {
    console.log(`\n"${from}" and "${to}" resolve to the same symbol (0 hops):`);
    const n = data.path[0];
    console.log(`  ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}\n`);
    return;
  }

  const dir = data.reverse ? ' (reverse)' : '';
  console.log(
    `\nPath from ${from} to ${to} (${data.hops} ${data.hops === 1 ? 'hop' : 'hops'})${dir}:\n`,
  );
  for (let i = 0; i < data.path.length; i++) {
    const n = data.path[i];
    const indent = '  '.repeat(i + 1);
    if (i === 0) {
      console.log(`${indent}${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`);
    } else {
      console.log(
        `${indent}--[${n.edgeKind}]--> ${kindIcon(n.kind)} ${n.name} (${n.kind}) -- ${n.file}:${n.line}`,
      );
    }
  }

  if (data.alternateCount > 0) {
    console.log(
      `\n  (${data.alternateCount} alternate shortest ${data.alternateCount === 1 ? 'path' : 'paths'} at same depth)`,
    );
  }
  console.log();
}
