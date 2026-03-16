import path from 'node:path';
import { hotspotsData, moduleBoundariesData, structureData } from '../features/structure.js';

export { hotspotsData, moduleBoundariesData, structureData };

export function formatStructure(data) {
  if (data.count === 0) return 'No directory structure found. Run "codegraph build" first.';

  const lines = [`\nProject structure (${data.count} directories):\n`];
  for (const d of data.directories) {
    const cohStr = d.cohesion !== null ? ` cohesion=${d.cohesion.toFixed(2)}` : '';
    const depth = d.directory.split('/').length - 1;
    const indent = '  '.repeat(depth);
    lines.push(
      `${indent}${d.directory}/  (${d.fileCount} files, ${d.symbolCount} symbols, <-${d.fanIn} ->${d.fanOut}${cohStr})`,
    );
    for (const f of d.files) {
      lines.push(
        `${indent}  ${path.basename(f.file)}  ${f.lineCount}L ${f.symbolCount}sym <-${f.fanIn} ->${f.fanOut}`,
      );
    }
  }
  if (data.warning) {
    lines.push('');
    lines.push(`⚠ ${data.warning}`);
  }
  return lines.join('\n');
}

export function formatHotspots(data) {
  if (data.hotspots.length === 0) return 'No hotspots found. Run "codegraph build" first.';

  const lines = [`\nHotspots by ${data.metric} (${data.level}-level, top ${data.limit}):\n`];
  let rank = 1;
  for (const h of data.hotspots) {
    const extra =
      h.kind === 'directory'
        ? `${h.fileCount} files, cohesion=${h.cohesion !== null ? h.cohesion.toFixed(2) : 'n/a'}`
        : `${h.lineCount || 0}L, ${h.symbolCount || 0} symbols`;
    lines.push(
      `  ${String(rank++).padStart(2)}. ${h.name}  <-${h.fanIn || 0} ->${h.fanOut || 0}  (${extra})`,
    );
  }
  return lines.join('\n');
}

export function formatModuleBoundaries(data) {
  if (data.count === 0) return `No modules found with cohesion >= ${data.threshold}.`;

  const lines = [`\nModule boundaries (cohesion >= ${data.threshold}, ${data.count} modules):\n`];
  for (const m of data.modules) {
    lines.push(
      `  ${m.directory}/  cohesion=${m.cohesion.toFixed(2)}  (${m.fileCount} files, ${m.symbolCount} symbols)`,
    );
    lines.push(`    Incoming: ${m.fanIn} edges    Outgoing: ${m.fanOut} edges`);
    if (m.files.length > 0) {
      lines.push(
        `    Files: ${m.files.slice(0, 5).join(', ')}${m.files.length > 5 ? ` ... +${m.files.length - 5}` : ''}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
