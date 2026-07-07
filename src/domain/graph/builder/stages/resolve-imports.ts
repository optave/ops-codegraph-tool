import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { debug } from '../../../../infrastructure/logger.js';
import { normalizePath } from '../../../../shared/constants.js';
import type { Import } from '../../../../types.js';
import { parseFilesAuto } from '../../../parser.js';
import { resolveImportPath, resolveImportsBatch } from '../../resolve.js';
import type { PipelineContext } from '../context.js';

interface ReexportEntry {
  source: string;
  names: string[];
  wildcardReexport: boolean;
  /**
   * `{ local, imported }` pairs for `export { X as Y } from …` specifiers
   * within this entry: `local` is the external name (Y) a consumer of the
   * barrel imports, `imported` is the name (X) actually declared in `source`.
   * Lets `resolveBarrelExport` translate a consumer's requested name back to
   * X before matching it against `names` (#1823).
   */
  renames: Array<{ local: string; imported: string }>;
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
          renames: imp.renamedImports ?? [],
        })),
      );
    }
  }
}

/**
 * Find barrel files related to `fromRelPaths` for scoped re-parsing.
 * For small frontiers (<=smallFilesThreshold files), only barrels that re-export from
 * or are imported by `fromRelPaths`. For larger frontiers, all barrels.
 *
 * `firstPass` gates the reexport-from DB scan: re-parsed barrels haven't
 * changed content, so subsequent passes can't surface new reexport-from
 * candidates and only need to follow imports of newly-merged barrels
 * (mirrors the Rust orchestrator's seed-only `collect_reexport_from_barrels`).
 */
function findBarrelCandidates(
  ctx: PipelineContext,
  fromRelPaths: readonly string[],
  firstPass: boolean,
): Array<{ file: string }> {
  const { db, fileSymbols, rootDir, aliases } = ctx;

  if (fromRelPaths.length <= ctx.config.build.smallFilesThreshold) {
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

    // Find barrels imported by `fromRelPaths` using parsed import data
    // (can't query DB edges -- they were purged for the changed files).
    for (const relPath of fromRelPaths) {
      const symbols = fileSymbols.get(relPath);
      if (!symbols) continue;
      for (const imp of symbols.imports) {
        const resolved = ctx.batchResolved?.get(
          `${normalizePath(path.join(rootDir, relPath))}|${imp.source}`,
        );
        const target =
          resolved ?? resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        if (allBarrelFiles.has(target)) barrels.add(target);
      }
    }

    if (firstPass) {
      const reexportSourceStmt = db.prepare(
        `SELECT DISTINCT n1.file FROM edges e
         JOIN nodes n1 ON e.source_id = n1.id
         JOIN nodes n2 ON e.target_id = n2.id
         WHERE e.kind = 'reexports' AND n1.kind = 'file' AND n2.file = ?`,
      );
      for (const relPath of fromRelPaths) {
        for (const row of reexportSourceStmt.all(relPath) as Array<{ file: string }>) {
          barrels.add(row.file);
        }
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

/**
 * Re-parse barrel files and update fileSymbols/reexportMap with fresh data.
 * Returns the relative paths of newly-merged files so the caller can scan
 * them for the next level of barrel candidates.
 *
 * A re-parsed file is marked `barrel-only` only when it really is one (the
 * `isBarrelFile` check — reexports >= ownDefs). The previous unconditional
 * `.add(relPath)` caused hybrid barrels with many local defs (e.g. a file
 * with one `export type ... from` and dozens of internal functions) to drop
 * all their non-reexport imports in build-edges, since the barrel-only branch
 * skips them (#1174).
 */
async function reparseBarrelFiles(
  ctx: PipelineContext,
  barrelCandidates: Array<{ file: string }>,
): Promise<string[]> {
  const { db, fileSymbols, rootDir, engineOpts } = ctx;

  const barrelPaths: string[] = [];
  for (const { file: relPath } of barrelCandidates) {
    if (!fileSymbols.has(relPath)) {
      barrelPaths.push(path.join(rootDir, relPath));
    }
  }

  if (barrelPaths.length === 0) return [];

  // Preserve `contains` and `parameter_of` — those are emitted by insertNodes,
  // which only runs on the original (changed + reverse-dep) fileSymbols. Barrel
  // candidates are merged here *after* insertNodes, so wiping those kinds
  // would permanently drop them (mirrors the Rust orchestrator's Stage 6b
  // delete in domain/graph/builder/pipeline.rs).
  const deleteOutgoingEdges = db.prepare(
    `DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?)
     AND kind NOT IN ('contains', 'parameter_of')`,
  );

  const added: string[] = [];
  try {
    const barrelSymbols = await parseFilesAuto(barrelPaths, rootDir, engineOpts);
    for (const [relPath, fileSym] of barrelSymbols) {
      deleteOutgoingEdges.run(relPath);
      fileSymbols.set(relPath, fileSym);
      if (isBarrelFile(ctx, relPath)) {
        ctx.barrelOnlyFiles.add(relPath);
      }
      const reexports = fileSym.imports.filter((imp: Import) => imp.reexport);
      if (reexports.length > 0) {
        ctx.reexportMap.set(
          relPath,
          reexports.map((imp: Import) => ({
            source: getResolved(ctx, path.join(rootDir, relPath), imp.source),
            names: imp.names,
            wildcardReexport: imp.wildcardReexport || false,
            renames: imp.renamedImports ?? [],
          })),
        );
      }
      added.push(relPath);
    }
  } catch (e: unknown) {
    debug(`Barrel re-parse failed (non-fatal): ${(e as Error).message}`);
  }
  return added;
}

export interface BarrelExportResolution {
  /** The file that actually defines the symbol. */
  file: string;
  /**
   * The name the symbol is declared under in `file`. Identical to the
   * requested `symbolName` unless one of the barrel hops in the chain
   * renamed it (`export { X as Y } from …`), in which case this is the
   * *original* declared name (X) to search for in `file` (#1823).
   */
  name: string;
}

export function resolveBarrelExportCached(
  ctx: PipelineContext,
  barrelPath: string,
  symbolName: string,
): BarrelExportResolution | null {
  const cacheKey = `${barrelPath}|${symbolName}`;
  if (ctx.barrelExportCache.has(cacheKey))
    return ctx.barrelExportCache.get(cacheKey) as BarrelExportResolution | null;
  const result = resolveBarrelExport(ctx, barrelPath, symbolName);
  ctx.barrelExportCache.set(cacheKey, result);
  return result;
}

export async function resolveImports(ctx: PipelineContext): Promise<void> {
  const { fileSymbols, rootDir, aliases, allFiles, isFullBuild } = ctx;
  const t0 = performance.now();
  ctx.barrelExportCache = new Map();

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
    // Iteratively discover and re-parse barrel chains. A barrel that imports
    // another barrel (e.g. `parser.ts → extractors/index.ts → extractors/<lang>.ts`)
    // needs both loaded so build-edges can emit the barrel-through edges from
    // the first barrel to the leaf targets. Without iteration, only the first
    // level of barrels gets merged into fileSymbols; the deeper chain has no
    // entry in reexportMap and the resolver silently drops the affected edges
    // on every incremental rebuild (#1174).
    //
    // Convergence is guaranteed because fileSymbols grows monotonically and
    // is bounded by the set of barrel files in the project — each iteration
    // either adds a previously-unseen barrel or terminates.
    //
    // Subsequent passes only walk newly-merged barrels' imports (`frontier`
    // = paths returned by reparseBarrelFiles), matching the Rust
    // orchestrator's `&newly_added` slice. Without this, every pass would
    // re-query the DB for every key in `fileSymbols`.
    let frontier: readonly string[] = [...fileSymbols.keys()];
    let firstPass = true;
    while (frontier.length > 0) {
      const barrelCandidates = findBarrelCandidates(ctx, frontier, firstPass);
      const added = await reparseBarrelFiles(ctx, barrelCandidates);
      if (added.length === 0) break;
      frontier = added;
      firstPass = false;
    }
  }
}

export function getResolved(ctx: PipelineContext, absFile: string, importSource: string): string {
  if (ctx.batchResolved) {
    const key = `${normalizePath(absFile)}|${importSource}`;
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

/** Check if a re-export source directly defines the symbol. */
function sourceDefinesSymbol(ctx: PipelineContext, source: string, symbolName: string): boolean {
  const targetSymbols = ctx.fileSymbols.get(source);
  if (!targetSymbols) return false;
  return targetSymbols.definitions.some((d) => d.name === symbolName);
}

/**
 * Translate a consumer-requested name through a single reexport entry's
 * rename table, if it renamed that name (`export { X as Y } from …`
 * records `{ local: Y, imported: X }`). Returns `symbolName` unchanged when
 * the entry doesn't rename it — covers both "not renamed at all" and
 * "requested name isn't one of this entry's external aliases" (#1823).
 */
function translateThroughRename(re: ReexportEntry, symbolName: string): string {
  return re.renames.find((r) => r.local === symbolName)?.imported ?? symbolName;
}

export function resolveBarrelExport(
  ctx: PipelineContext,
  barrelPath: string,
  symbolName: string,
  visited: Set<string> = new Set<string>(),
): BarrelExportResolution | null {
  if (visited.has(barrelPath)) return null;
  visited.add(barrelPath);

  const reexports = ctx.reexportMap.get(barrelPath) as ReexportEntry[] | undefined;
  if (!reexports) return null;

  for (const re of reexports) {
    // Translate the requested external name (Y) back to the name actually
    // declared in `re.source` (X) before matching `re.names`/checking the
    // target's definitions — `re.names` always carries the original
    // declaration name, never the barrel's external alias (#1823).
    const lookupName = translateThroughRename(re, symbolName);

    // Named re-export: only follow if the symbol is in the export list
    if (re.names.length > 0 && !re.wildcardReexport) {
      if (!re.names.includes(lookupName)) continue;
      if (sourceDefinesSymbol(ctx, re.source, lookupName))
        return { file: re.source, name: lookupName };
      const deeper = resolveBarrelExport(ctx, re.source, lookupName, visited);
      return deeper ?? { file: re.source, name: lookupName };
    }

    // Wildcard or namespace re-export: check if target defines the symbol
    if (sourceDefinesSymbol(ctx, re.source, lookupName))
      return { file: re.source, name: lookupName };
    const deeper = resolveBarrelExport(ctx, re.source, lookupName, visited);
    if (deeper) return deeper;
  }

  return null;
}
