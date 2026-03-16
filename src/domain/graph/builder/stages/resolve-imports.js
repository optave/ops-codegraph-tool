/**
 * Stage: resolveImports
 *
 * Batch import resolution + barrel/re-export map construction.
 * For incremental builds, loads unchanged barrel files for resolution.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseFilesAuto } from '../../../../parser.js';
import { resolveImportPath, resolveImportsBatch } from '../../resolve.js';

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function resolveImports(ctx) {
  const { db, fileSymbols, rootDir, aliases, allFiles, isFullBuild, engineOpts } = ctx;

  // Collect all (fromFile, importSource) pairs and resolve in one native call
  const t0 = performance.now();
  const batchInputs = [];
  for (const [relPath, symbols] of fileSymbols) {
    const absFile = path.join(rootDir, relPath);
    for (const imp of symbols.imports) {
      batchInputs.push({ fromFile: absFile, importSource: imp.source });
    }
  }
  ctx.batchResolved = resolveImportsBatch(batchInputs, rootDir, aliases, allFiles);
  ctx.timing.resolveMs = performance.now() - t0;

  // Build re-export map for barrel resolution
  ctx.reexportMap = new Map();
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

  // For incremental builds, load unchanged barrel files into reexportMap
  ctx.barrelOnlyFiles = new Set();
  if (!isFullBuild) {
    const barrelCandidates = db
      .prepare(
        `SELECT DISTINCT n1.file FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         WHERE e.kind = 'reexports' AND n1.kind = 'file'`,
      )
      .all();
    for (const { file: relPath } of barrelCandidates) {
      if (fileSymbols.has(relPath)) continue;
      const absPath = path.join(rootDir, relPath);
      try {
        const symbols = await parseFilesAuto([absPath], rootDir, engineOpts);
        const fileSym = symbols.get(relPath);
        if (fileSym) {
          fileSymbols.set(relPath, fileSym);
          ctx.barrelOnlyFiles.add(relPath);
          const reexports = fileSym.imports.filter((imp) => imp.reexport);
          if (reexports.length > 0) {
            ctx.reexportMap.set(
              relPath,
              reexports.map((imp) => ({
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

/**
 * Resolve an import source, preferring batch results.
 * Exported so other stages (build-edges) can reuse it.
 */
export function getResolved(ctx, absFile, importSource) {
  if (ctx.batchResolved) {
    const key = `${absFile}|${importSource}`;
    const hit = ctx.batchResolved.get(key);
    if (hit !== undefined) return hit;
  }
  return resolveImportPath(absFile, importSource, ctx.rootDir, ctx.aliases);
}

/**
 * Check if a file is a barrel (re-export hub).
 */
export function isBarrelFile(ctx, relPath) {
  const symbols = ctx.fileSymbols.get(relPath);
  if (!symbols) return false;
  const reexports = symbols.imports.filter((imp) => imp.reexport);
  if (reexports.length === 0) return false;
  const ownDefs = symbols.definitions.length;
  return reexports.length >= ownDefs;
}

/**
 * Resolve a symbol through barrel re-export chains.
 */
export function resolveBarrelExport(ctx, barrelPath, symbolName, visited = new Set()) {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);
  const reexports = ctx.reexportMap.get(barrelPath);
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
