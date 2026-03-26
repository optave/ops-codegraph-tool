import path from 'node:path';
import { hotspotsData, moduleBoundariesData, structureData } from '../features/structure.js';

export { hotspotsData, moduleBoundariesData, structureData };

interface DirectoryEntry {
  directory: string;
  cohesion: number | null;
  fileCount: number;
  symbolCount: number;
  fanIn: number;
  fanOut: number;
  files: Array<{
    file: string;
    lineCount: number;
    symbolCount: number;
    fanIn: number;
    fanOut: number;
  }>;
}

interface StructureResult {
  count: number;
  directories: DirectoryEntry[];
  warning?: string;
}

export function formatStructure(data: StructureResult): string {
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
    lines.push(`\u26A0 ${data.warning}`);
  }
  return lines.join('\n');
}

interface HotspotsResult {
  metric: string;
  level: string;
  limit: number;
  hotspots: any[];
}

export function formatHotspots(data: HotspotsResult): string {
  if (data.hotspots.length === 0) return 'No hotspots found. Run "codegraph build" first.';

  const lines = [`\nHotspots by ${data.metric} (${data.level}-level, top ${data.limit}):\n`];
  let rank = 1;
  for (const h of data.hotspots) {
    const extra =
      h.kind === 'directory'
        ? `${h.fileCount} files, cohesion=${h.cohesion !== null ? h.cohesion!.toFixed(2) : 'n/a'}`
        : `${h.lineCount || 0}L, ${h.symbolCount || 0} symbols`;
    lines.push(
      `  ${String(rank++).padStart(2)}. ${h.name}  <-${h.fanIn || 0} ->${h.fanOut || 0}  (${extra})`,
    );
  }
  return lines.join('\n');
}

interface ModuleBoundaryEntry {
  directory: string;
  cohesion: number;
  fileCount: number;
  symbolCount: number;
  fanIn: number;
  fanOut: number;
  files: string[];
}

interface ModuleBoundariesResult {
  threshold: number;
  count: number;
  modules: ModuleBoundaryEntry[];
}

export function formatModuleBoundaries(data: ModuleBoundariesResult): string {
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
