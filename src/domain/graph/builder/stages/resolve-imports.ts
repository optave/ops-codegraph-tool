import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import type { Import } from '../../../../types.js';
import { parseFilesAuto } from '../../../parser.js';
import { resolveImportPath, resolveImportsBatch } from '../../resolve.js';
import type { PipelineContext } from '../context.js';

interface ReexportEntry {
  source: string;
  names: string[];
  wildcardReexport: boolean;
}

/** Collect reexport entries from fileSymbols into the reexportMap. */
function buildReexportMap(ctx: PipelineContext): void {
  ctx.reexportMap = new Map<string, ReexportEntry[]>();
  const { fileSymbols, rootDir } = ctx;
  for (const [relPath, symbols] of fileSymbols) {
    const reexports = symbols.imports.filter((imp) => imp.reexport);
    if (reexports.length > 0) {
      ctx.reexportMap.set(
        relPath,
        reexports.map((imp) => ({
          source: getResolved(ctx, path.join(rootDir, relPath), imp.source),
          names: imp.names,
          wildcardReexport: imp.wildcardReexport || false,
        })),
      );
    }
  }
}

/**
 * Find barrel files related to changed files for scoped re-parsing.
 * For small incremental builds (<=5 files), only barrels that re-export from
 * or are imported by the changed files. For larger changes, all barrels.
 */
function findBarrelCandidates(ctx: PipelineContext): Array<{ file: string }> {
  const { db, fileSymbols, rootDir, aliases } = ctx;
  const changedRelPaths = new Set<string>(fileSymbols.keys());

  const SMALL_CHANGE_THRESHOLD = 5;
  if (changedRelPaths.size <= SMALL_CHANGE_THRESHOLD) {
    const allBarrelFiles = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT n1.file FROM edges e
             JOIN nodes n1 ON e.source_id = n1.id
             WHERE e.kind = 'reexports' AND n1.kind = 'file'`,
          )
          .all() as Array<{ file: string }>
      ).map((r) => r.file),
    );

    const barrels = new Set<string>();

    // Find barrels imported by changed files using parsed import data
    // (can't query DB edges -- they were purged for the changed files).
    for (const relPath of changedRelPaths) {
      const symbols = fileSymbols.get(relPath);
      if (!symbols) continue;
      for (const imp of symbols.imports) {
        const resolved = ctx.batchResolved?.get(`${path.join(rootDir, relPath)}|${imp.source}`);
        const target =
          resolved ?? resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        if (allBarrelFiles.has(target)) barrels.add(target);
      }
    }

    // Also find barrels that re-export from the changed files
    const reexportSourceStmt = db.prepare(
      `SELECT DISTINCT n1.file FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       JOIN nodes n2 ON e.target_id = n2.id
       WHERE e.kind = 'reexports' AND n1.kind = 'file' AND n2.file = ?`,
    );
    for (const relPath of changedRelPaths) {
      for (const row of reexportSourceStmt.all(relPath) as Array<{ file: string }>) {
        barrels.add(row.file);
      }
    }
    return [...barrels].map((file) => ({ file }));
  }

  return db
    .prepare(
      `SELECT DISTINCT n1.file FROM edges e
       JOIN nodes n1 ON e.source_id = n1.id
       WHERE e.kind = 'reexports' AND n1.kind = 'file'`,
    )
    .all() as Array<{ file: string }>;
}

/** Re-parse barrel files and update fileSymbols/reexportMap with fresh data. */
async function reparseBarrelFiles(
  ctx: PipelineContext,
  barrelCandidates: Array<{ file: string }>,
): Promise<void> {
  const { db, fileSymbols, rootDir, engineOpts } = ctx;

  const barrelPaths: string[] = [];
  for (const { file: relPath } of barrelCandidates) {
    if (!fileSymbols.has(relPath)) {
      barrelPaths.push(path.join(rootDir, relPath));
    }
  }

  if (barrelPaths.length === 0) return;

  const deleteOutgoingEdges = db.prepare(
    'DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)',
  );

  try {
    const barrelSymbols = await parseFilesAuto(barrelPaths, rootDir, engineOpts);
    for (const [relPath, fileSym] of barrelSymbols) {
      deleteOutgoingEdges.run(relPath);
      fileSymbols.set(relPath, fileSym);
      ctx.barrelOnlyFiles.add(relPath);
      const reexports = fileSym.imports.filter((imp: Import) => imp.reexport);
      if (reexports.length > 0) {
        ctx.reexportMap.set(
          relPath,
          reexports.map((imp: Import) => ({
            source: getResolved(ctx, path.join(rootDir, relPath), imp.source),
            names: imp.names,
            wildcardReexport: imp.wildcardReexport || false,
          })),
        );
      }
    }
  } catch (e: unknown) {
    debug(`Barrel re-parse failed (non-fatal): ${(e as Error).message}`);
  }
}

export async function resolveImports(ctx: PipelineContext): Promise<void> {
  const { fileSymbols, rootDir, aliases, allFiles, isFullBuild } = ctx;
  const t0 = performance.now();

  const batchInputs: Array<{ fromFile: string; importSource: string }> = [];
  for (const [relPath, symbols] of fileSymbols) {
    const absFile = path.join(rootDir, relPath);
    for (const imp of symbols.imports) {
      batchInputs.push({ fromFile: absFile, importSource: imp.source });
    }
  }
  ctx.batchResolved = resolveImportsBatch(batchInputs, rootDir, aliases, allFiles);
  ctx.timing.resolveMs = performance.now() - t0;

  buildReexportMap(ctx);

  ctx.barrelOnlyFiles = new Set<string>();
  if (!isFullBuild) {
    const barrelCandidates = findBarrelCandidates(ctx);
    await reparseBarrelFiles(ctx, barrelCandidates);
  }
}

export function getResolved(ctx: PipelineContext, absFile: string, importSource: string): string {
  if (ctx.batchResolved) {
    const key = `${absFile}|${importSource}`;
    const hit = ctx.batchResolved.get(key);
    if (hit !== undefined) return hit;
  }
  return resolveImportPath(absFile, importSource, ctx.rootDir, ctx.aliases);
}

export function isBarrelFile(ctx: PipelineContext, relPath: string): boolean {
  const symbols = ctx.fileSymbols.get(relPath);
  if (!symbols) return false;
  const reexports = symbols.imports.filter((imp) => imp.reexport);
  if (reexports.length === 0) return false;
  const ownDefs = symbols.definitions.length;
  return reexports.length >= ownDefs;
}

export function resolveBarrelExport(
  ctx: PipelineContext,
  barrelPath: string,
  symbolName: string,
  visited: Set<string> = new Set<string>(),
): string | null {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);
  const reexports = ctx.reexportMap.get(barrelPath) as ReexportEntry[] | undefined;
  if (!reexports) return null;
  for (const re of reexports) {
    if (re.names.length > 0 && !re.wildcardReexport) {
      if (re.names.includes(symbolName)) {
        const targetSymbols = ctx.fileSymbols.get(re.source);
        if (targetSymbols) {
          const hasDef = targetSymbols.definitions.some((d) => d.name === symbolName);
          if (hasDef) return re.source;
          const deeper = resolveBarrelExport(ctx, re.source, symbolName, visited);
          if (deeper) return deeper;
        }
        return re.source;
      }
      continue;
    }
    if (re.wildcardReexport || re.names.length === 0) {
      const targetSymbols = ctx.fileSymbols.get(re.source);
      if (targetSymbols) {
        const hasDef = targetSymbols.definitions.some((d) => d.name === symbolName);
        if (hasDef) return re.source;
        const deeper = resolveBarrelExport(ctx, re.source, symbolName, visited);
        if (deeper) return deeper;
      }
    }
  }
  return null;
}
