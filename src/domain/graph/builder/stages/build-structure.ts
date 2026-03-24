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
    const defsByFile = db.prepare(
      "SELECT name, kind, line FROM nodes WHERE file = ? AND kind != 'file' AND kind != 'directory'",
    );
    const importCountByFile = db.prepare(
      `SELECT COUNT(DISTINCT n2.file) AS cnt FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE n1.file = ? AND e.kind = 'imports'`,
    );
    const lineCountByFile = db.prepare(
      `SELECT n.name AS file, m.line_count
       FROM node_metrics m JOIN nodes n ON m.node_id = n.id
       WHERE n.kind = 'file'`,
    );
    const cachedLineCounts = new Map<string, number>();
    for (const row of lineCountByFile.all() as Array<{ file: string; line_count: number }>) {
      cachedLineCounts.set(row.file, row.line_count);
    }
    let loadedFromDb = 0;
    for (const { file: relPath } of existingFiles) {
      if (!fileSymbols.has(relPath)) {
        const importCount =
          (importCountByFile.get(relPath) as { cnt: number } | undefined)?.cnt || 0;
        fileSymbols.set(relPath, {
          definitions: defsByFile.all(relPath),
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

  // Classify node roles
  const t1 = performance.now();
  try {
    const { classifyNodeRoles } = (await import('../../../../features/structure.js')) as {
      classifyNodeRoles: (db: PipelineContext['db']) => Record<string, number>;
    };
    const roleSummary = classifyNodeRoles(db);
    debug(
      `Roles: ${Object.entries(roleSummary)
        .map(([r, c]) => `${r}=${c}`)
        .join(', ')}`,
    );
  } catch (err) {
    debug(`Role classification failed: ${(err as Error).message}`);
  }
  ctx.timing.rolesMs = performance.now() - t1;
}
