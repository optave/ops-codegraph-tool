import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Import } from '../../../../types.js';
import { parseFilesAuto } from '../../../parser.js';
import { resolveImportPath, resolveImportsBatch } from '../../resolve.js';
import type { PipelineContext } from '../context.js';

interface ReexportEntry {
  source: string;
  names: string[];
  wildcardReexport: boolean;
}

export async function resolveImports(ctx: PipelineContext): Promise<void> {
  const { db, fileSymbols, rootDir, aliases, allFiles, isFullBuild, engineOpts } = ctx;
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

  ctx.reexportMap = new Map<string, ReexportEntry[]>();
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

  ctx.barrelOnlyFiles = new Set<string>();
  if (!isFullBuild) {
    const barrelCandidates = db
      .prepare(`SELECT DISTINCT n1.file FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         WHERE e.kind = 'reexports' AND n1.kind = 'file'`)
      .all() as Array<{ file: string }>;
    for (const { file: relPath } of barrelCandidates) {
      if (fileSymbols.has(relPath)) continue;
      const absPath = path.join(rootDir, relPath);
      try {
        const symbols = await parseFilesAuto([absPath], rootDir, engineOpts);
        const fileSym = symbols.get(relPath);
        if (fileSym) {
          fileSymbols.set(relPath, fileSym);
          ctx.barrelOnlyFiles.add(relPath);
          const reexports = fileSym.imports.filter((imp: Import) => imp.reexport);
          if (reexports.length > 0) {
            ctx.reexportMap.set(
              relPath,
              reexports.map((imp: Import) => ({
                source: getResolved(ctx, absPath, imp.source),
                names: imp.names,
                wildcardReexport: imp.wildcardReexport || false,
              })),
            );
          }
        }
      } catch {
        /* skip if unreadable */
      }
    }
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
