/**
 * Structure query functions — read-only DB queries for directory structure,
 * hotspots, and module boundaries.
 *
 * Split from structure.ts to separate query-time concerns (DB reads, sorting,
 * pagination) from build-time concerns (directory insertion, metrics computation,
 * role classification).
 */

import { openReadonlyOrFail, openReadonlyWithNative, testFilterSQL } from '../db/index.js';
import { loadConfig } from '../infrastructure/config.js';
import { isTestFile } from '../infrastructure/test-filter.js';
import { normalizePath } from '../shared/constants.js';
import { paginateResult } from '../shared/paginate.js';
import type { CodegraphConfig } from '../types.js';

// ─── Query functions (read-only) ──────────────────────────────────────

interface DirRow {
  id: number;
  name: string;
  file: string;
  symbol_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
  cohesion: number | null;
  file_count: number | null;
}

interface FileMetricRow {
  name: string;
  line_count: number | null;
  symbol_count: number | null;
  import_count: number | null;
  export_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
}

interface StructureDataOpts {
  directory?: string;
  depth?: number;
  sort?: string;
  noTests?: boolean;
  full?: boolean;
  fileLimit?: number;
  limit?: number;
  offset?: number;
}

interface DirectoryEntry {
  directory: string;
  fileCount: number;
  symbolCount: number;
  fanIn: number;
  fanOut: number;
  cohesion: number | null;
  density: number;
  files: {
    file: string;
    lineCount: number;
    symbolCount: number;
    importCount: number;
    exportCount: number;
    fanIn: number;
    fanOut: number;
  }[];
  subdirectories: string[];
}

export function structureData(
  customDbPath?: string,
  opts: StructureDataOpts = {},
): {
  directories: DirectoryEntry[];
  count: number;
  suppressed?: number;
  warning?: string;
} {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const rawDir = opts.directory || null;
    const filterDir = rawDir && normalizePath(rawDir) !== '.' ? rawDir : null;
    const maxDepth = opts.depth || null;
    const sortBy = opts.sort || 'files';
    const noTests = opts.noTests || false;
    const full = opts.full || false;
    const fileLimit = opts.fileLimit || 25;

    // Get all directory nodes with their metrics
    let dirs = db
      .prepare(`
        SELECT n.id, n.name, n.file, nm.symbol_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n
        LEFT JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory'
      `)
      .all() as DirRow[];

    if (filterDir) {
      const norm = normalizePath(filterDir);
      dirs = dirs.filter((d) => d.name === norm || d.name.startsWith(`${norm}/`));
    }

    if (maxDepth) {
      const baseDepth = filterDir ? normalizePath(filterDir).split('/').length : 0;
      dirs = dirs.filter((d) => {
        const depth = d.name.split('/').length - baseDepth;
        return depth <= maxDepth;
      });
    }

    // Sort
    const sortFn = getSortFn(sortBy);
    dirs.sort(sortFn);

    // Get file metrics for each directory
    const result: DirectoryEntry[] = dirs.map((d) => {
      let files = db
        .prepare(`
          SELECT n.name, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count, nm.fan_in, nm.fan_out
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          LEFT JOIN node_metrics nm ON n.id = nm.node_id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
        .all(d.id) as FileMetricRow[];
      if (noTests) files = files.filter((f) => !isTestFile(f.name));

      const subdirs = db
        .prepare(`
          SELECT n.name
          FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'directory'
        `)
        .all(d.id) as { name: string }[];

      const fileCount = noTests ? files.length : d.file_count || 0;
      return {
        directory: d.name,
        fileCount,
        symbolCount: d.symbol_count || 0,
        fanIn: d.fan_in || 0,
        fanOut: d.fan_out || 0,
        cohesion: d.cohesion,
        density: fileCount > 0 ? (d.symbol_count || 0) / fileCount : 0,
        files: files.map((f) => ({
          file: f.name,
          lineCount: f.line_count || 0,
          symbolCount: f.symbol_count || 0,
          importCount: f.import_count || 0,
          exportCount: f.export_count || 0,
          fanIn: f.fan_in || 0,
          fanOut: f.fan_out || 0,
        })),
        subdirectories: subdirs.map((s) => s.name),
      };
    });

    // Apply global file limit unless full mode
    if (!full) {
      const totalFiles = result.reduce((sum, d) => sum + d.files.length, 0);
      if (totalFiles > fileLimit) {
        let shown = 0;
        for (const d of result) {
          const remaining = fileLimit - shown;
          if (remaining <= 0) {
            d.files = [];
          } else if (d.files.length > remaining) {
            d.files = d.files.slice(0, remaining);
            shown = fileLimit;
          } else {
            shown += d.files.length;
          }
        }
        const suppressed = totalFiles - fileLimit;
        return {
          directories: result,
          count: result.length,
          suppressed,
          warning: `${suppressed} files omitted (showing ${fileLimit}/${totalFiles}). Use --full to show all files, or narrow with --directory.`,
        };
      }
    }

    const base = { directories: result, count: result.length };
    return paginateResult(base, 'directories', { limit: opts.limit, offset: opts.offset });
  } finally {
    db.close();
  }
}

interface HotspotRow {
  name: string;
  kind: string;
  line_count: number | null;
  symbol_count: number | null;
  import_count: number | null;
  export_count: number | null;
  fan_in: number | null;
  fan_out: number | null;
  cohesion: number | null;
  file_count: number | null;
}

interface HotspotsDataOpts {
  metric?: string;
  level?: string;
  limit?: number;
  offset?: number;
  noTests?: boolean;
}

export function hotspotsData(
  customDbPath?: string,
  opts: HotspotsDataOpts = {},
): {
  metric: string;
  level: string;
  limit: number;
  hotspots: unknown[];
} {
  const { db, nativeDb, close } = openReadonlyWithNative(customDbPath);
  try {
    const metric = opts.metric || 'fan-in';
    const level = opts.level || 'file';
    const limit = opts.limit || 10;
    const noTests = opts.noTests || false;

    const kind = level === 'directory' ? 'directory' : 'file';

    const mapRow = (r: {
      name: string;
      kind: string;
      lineCount: number | null;
      symbolCount: number | null;
      importCount: number | null;
      exportCount: number | null;
      fanIn: number | null;
      fanOut: number | null;
      cohesion: number | null;
      fileCount: number | null;
    }) => ({
      name: r.name,
      kind: r.kind,
      lineCount: r.lineCount,
      symbolCount: r.symbolCount,
      importCount: r.importCount,
      exportCount: r.exportCount,
      fanIn: r.fanIn,
      fanOut: r.fanOut,
      cohesion: r.cohesion,
      fileCount: r.fileCount,
      density:
        (r.fileCount ?? 0) > 0
          ? (r.symbolCount || 0) / (r.fileCount ?? 1)
          : (r.lineCount ?? 0) > 0
            ? (r.symbolCount || 0) / (r.lineCount ?? 1)
            : 0,
      coupling: (r.fanIn || 0) + (r.fanOut || 0),
    });

    // ── Native fast path: single query instead of 4 eagerly prepared ──
    if (nativeDb?.getHotspots) {
      const rows = nativeDb.getHotspots(kind, metric, noTests, limit);
      const hotspots = rows.map(mapRow);
      const base = { metric, level, limit, hotspots };
      return paginateResult(base, 'hotspots', { limit: opts.limit, offset: opts.offset });
    }

    // ── JS fallback ───────────────────────────────────────────────────
    const testFilter = testFilterSQL('n.name', noTests && kind === 'file');

    const HOTSPOT_QUERIES: Record<string, { all(...params: unknown[]): HotspotRow[] }> = {
      'fan-in': db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.fan_in DESC NULLS LAST LIMIT ?`),
      'fan-out': db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.fan_out DESC NULLS LAST LIMIT ?`),
      density: db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY nm.symbol_count DESC NULLS LAST LIMIT ?`),
      coupling: db.prepare(`
        SELECT n.name, n.kind, nm.line_count, nm.symbol_count, nm.import_count, nm.export_count,
               nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = ? ${testFilter} ORDER BY (COALESCE(nm.fan_in, 0) + COALESCE(nm.fan_out, 0)) DESC NULLS LAST LIMIT ?`),
    };

    const stmt = HOTSPOT_QUERIES[metric] ?? HOTSPOT_QUERIES['fan-in'];
    const rows = stmt!.all(kind, limit);

    const hotspots = rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      lineCount: r.line_count,
      symbolCount: r.symbol_count,
      importCount: r.import_count,
      exportCount: r.export_count,
      fanIn: r.fan_in,
      fanOut: r.fan_out,
      cohesion: r.cohesion,
      fileCount: r.file_count,
      density:
        (r.file_count ?? 0) > 0
          ? (r.symbol_count || 0) / (r.file_count ?? 1)
          : (r.line_count ?? 0) > 0
            ? (r.symbol_count || 0) / (r.line_count ?? 1)
            : 0,
      coupling: (r.fan_in || 0) + (r.fan_out || 0),
    }));

    const base = { metric, level, limit, hotspots };
    return paginateResult(base, 'hotspots', { limit: opts.limit, offset: opts.offset });
  } finally {
    close();
  }
}

interface ModuleBoundariesOpts {
  threshold?: number;
  config?: CodegraphConfig;
}

export function moduleBoundariesData(
  customDbPath?: string,
  opts: ModuleBoundariesOpts = {},
): {
  threshold: number;
  modules: {
    directory: string;
    cohesion: number | null;
    fileCount: number;
    symbolCount: number;
    fanIn: number;
    fanOut: number;
    files: string[];
  }[];
  count: number;
} {
  const db = openReadonlyOrFail(customDbPath);
  try {
    const config = opts.config || loadConfig();
    const threshold =
      opts.threshold ??
      (config as unknown as { structure?: { cohesionThreshold?: number } }).structure
        ?.cohesionThreshold ??
      0.3;

    const dirs = db
      .prepare(`
        SELECT n.id, n.name, nm.symbol_count, nm.fan_in, nm.fan_out, nm.cohesion, nm.file_count
        FROM nodes n
        JOIN node_metrics nm ON n.id = nm.node_id
        WHERE n.kind = 'directory' AND nm.cohesion IS NOT NULL AND nm.cohesion >= ?
        ORDER BY nm.cohesion DESC
      `)
      .all(threshold) as {
      id: number;
      name: string;
      symbol_count: number | null;
      fan_in: number | null;
      fan_out: number | null;
      cohesion: number | null;
      file_count: number | null;
    }[];

    const modules = dirs.map((d) => {
      // Get files inside this directory
      const files = (
        db
          .prepare(`
          SELECT n.name FROM edges e
          JOIN nodes n ON e.target_id = n.id
          WHERE e.source_id = ? AND e.kind = 'contains' AND n.kind = 'file'
        `)
          .all(d.id) as { name: string }[]
      ).map((f) => f.name);

      return {
        directory: d.name,
        cohesion: d.cohesion,
        fileCount: d.file_count || 0,
        symbolCount: d.symbol_count || 0,
        fanIn: d.fan_in || 0,
        fanOut: d.fan_out || 0,
        files,
      };
    });

    return { threshold, modules, count: modules.length };
  } finally {
    db.close();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getSortFn(sortBy: string): (a: DirRow, b: DirRow) => number {
  switch (sortBy) {
    case 'cohesion':
      return (a, b) => (b.cohesion ?? -1) - (a.cohesion ?? -1);
    case 'fan-in':
      return (a, b) => (b.fan_in || 0) - (a.fan_in || 0);
    case 'fan-out':
      return (a, b) => (b.fan_out || 0) - (a.fan_out || 0);
    case 'density':
      return (a, b) => {
        const da = (a.file_count ?? 0) > 0 ? (a.symbol_count || 0) / (a.file_count ?? 1) : 0;
        const db_ = (b.file_count ?? 0) > 0 ? (b.symbol_count || 0) / (b.file_count ?? 1) : 0;
        return db_ - da;
      };
    case 'files':
      return (a, b) => (b.file_count || 0) - (a.file_count || 0);
    default:
      return (a, b) => a.name.localeCompare(b.name);
  }
}
