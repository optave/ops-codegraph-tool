/**
 * Stage: buildStructure + classifyRoles
 *
 * Builds directory structure, containment edges, metrics, and classifies node roles.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import type { ExtractorOutput } from '../../../../types.js';
import type { PipelineContext } from '../context.js';
import { readFileSafe } from '../helpers.js';

export async function buildStructure(ctx: PipelineContext): Promise<void> {
  const { db, fileSymbols, rootDir, discoveredDirs, allSymbols, isFullBuild } = ctx;

  // Build line count map (prefer cached _lineCount from parser)
  ctx.lineCountMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const lineCount =
      (symbols as ExtractorOutput & { lineCount?: number }).lineCount ?? symbols._lineCount;
    if (lineCount) {
      ctx.lineCountMap.set(relPath, lineCount);
    } else {
      const absPath = path.join(rootDir, relPath);
      try {
        const content = readFileSafe(absPath);
        ctx.lineCountMap.set(relPath, content.split('\n').length);
      } catch {
        ctx.lineCountMap.set(relPath, 0);
      }
    }
  }

  // For incremental builds, load unchanged files from DB for complete structure
  if (!isFullBuild) {
    const existingFiles = db
      .prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'")
      .all() as Array<{ file: string }>;

    // Batch load: all definitions, import counts, and line counts in single queries
    const allDefs = db
      .prepare(
        "SELECT file, name, kind, line FROM nodes WHERE kind != 'file' AND kind != 'directory'",
      )
      .all() as Array<{ file: string; name: string; kind: string; line: number }>;
    const defsByFileMap = new Map<string, Array<{ name: string; kind: string; line: number }>>();
    for (const row of allDefs) {
      let arr = defsByFileMap.get(row.file);
      if (!arr) {
        arr = [];
        defsByFileMap.set(row.file, arr);
      }
      arr.push({ name: row.name, kind: row.kind, line: row.line });
    }

    const allImportCounts = db
      .prepare(
        `SELECT n1.file, COUNT(DISTINCT n2.file) AS cnt FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'imports'
         GROUP BY n1.file`,
      )
      .all() as Array<{ file: string; cnt: number }>;
    const importCountMap = new Map<string, number>();
    for (const row of allImportCounts) {
      importCountMap.set(row.file, row.cnt);
    }

    const cachedLineCounts = new Map<string, number>();
    for (const row of db
      .prepare(
        `SELECT n.name AS file, m.line_count
         FROM node_metrics m JOIN nodes n ON m.node_id = n.id
         WHERE n.kind = 'file'`,
      )
      .all() as Array<{ file: string; line_count: number }>) {
      cachedLineCounts.set(row.file, row.line_count);
    }

    let loadedFromDb = 0;
    for (const { file: relPath } of existingFiles) {
      if (!fileSymbols.has(relPath)) {
        const importCount = importCountMap.get(relPath) || 0;
        fileSymbols.set(relPath, {
          definitions: defsByFileMap.get(relPath) || [],
          imports: new Array(importCount) as unknown as ExtractorOutput['imports'],
          exports: [],
        } as unknown as ExtractorOutput);
        loadedFromDb++;
      }
      if (!ctx.lineCountMap.has(relPath)) {
        const cached = cachedLineCounts.get(relPath);
        if (cached != null) {
          ctx.lineCountMap.set(relPath, cached);
        } else {
          const absPath = path.join(rootDir, relPath);
          try {
            const content = readFileSafe(absPath);
            ctx.lineCountMap.set(relPath, content.split('\n').length);
          } catch {
            ctx.lineCountMap.set(relPath, 0);
          }
        }
      }
    }
    debug(`Structure: ${fileSymbols.size} files (${loadedFromDb} loaded from DB)`);
  }

  // Build directory structure
  const t0 = performance.now();
  const relDirs = new Set<string>();
  for (const absDir of discoveredDirs) {
    relDirs.add(normalizePath(path.relative(rootDir, absDir)));
  }
  try {
    const { buildStructure: buildStructureFn } = (await import(
      '../../../../features/structure.js'
    )) as {
      buildStructure: (
        db: PipelineContext['db'],
        fileSymbols: Map<string, ExtractorOutput>,
        rootDir: string,
        lineCountMap: Map<string, number>,
        directories: Set<string>,
        changedFiles: string[] | null,
      ) => void;
    };
    const changedFilePaths = isFullBuild ? null : [...allSymbols.keys()];
    buildStructureFn(db, fileSymbols, rootDir, ctx.lineCountMap, relDirs, changedFilePaths);
  } catch (err) {
    debug(`Structure analysis failed: ${(err as Error).message}`);
  }
  ctx.timing.structureMs = performance.now() - t0;

  // Classify node roles (incremental: only reclassify changed files' nodes)
  const t1 = performance.now();
  try {
    const { classifyNodeRoles } = (await import('../../../../features/structure.js')) as {
      classifyNodeRoles: (
        db: PipelineContext['db'],
        changedFiles?: string[] | null,
      ) => Record<string, number>;
    };
    const changedFileList = isFullBuild ? null : [...allSymbols.keys()];
    const roleSummary = classifyNodeRoles(db, changedFileList);
    debug(
      `Roles${changedFileList ? ` (incremental, ${changedFileList.length} files)` : ''}: ${Object.entries(
        roleSummary,
      )
        .map(([r, c]) => `${r}=${c}`)
        .join(', ')}`,
    );
  } catch (err) {
    debug(`Role classification failed: ${(err as Error).message}`);
  }
  ctx.timing.rolesMs = performance.now() - t1;
}
