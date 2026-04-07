/**
 * Stage: finalize
 *
 * WASM cleanup, stats logging, drift detection, build metadata, registry, journal.
 */
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  closeDbPair,
  closeDbPairDeferred,
  getBuildMeta,
  setBuildMeta,
} from '../../../../db/index.js';
import { debug, info, warn } from '../../../../infrastructure/logger.js';
import { CODEGRAPH_VERSION } from '../../../../shared/version.js';
import { writeJournalHeader } from '../../journal.js';
import type { PipelineContext } from '../context.js';

/** Release cached WASM parse trees to free memory. */
function releaseWasmTrees(allSymbols: PipelineContext['allSymbols']): void {
  for (const [, symbols] of allSymbols) {
    const tree = symbols._tree as { delete?: () => void } | undefined;
    if (tree && typeof tree.delete === 'function') {
      try {
        tree.delete();
      } catch {
        /* ignore cleanup errors */
      }
    }
    symbols._tree = undefined;
    symbols._langId = undefined;
  }
}

/**
 * Detect significant drift between current and previous node/edge counts.
 * Skipped for small incremental changes where count fluctuation is expected.
 */
function detectIncrementalDrift(
  ctx: PipelineContext,
  nodeCount: number,
  actualEdgeCount: number,
): void {
  const { db, allSymbols, config } = ctx;
  const useNativeDb = ctx.engineName === 'native' && !!ctx.nativeDb;
  if (ctx.isFullBuild || allSymbols.size <= 3) return;

  const prevNodes = useNativeDb
    ? ctx.nativeDb!.getBuildMeta('node_count')
    : getBuildMeta(db, 'node_count');
  const prevEdges = useNativeDb
    ? ctx.nativeDb!.getBuildMeta('edge_count')
    : getBuildMeta(db, 'edge_count');
  if (!prevNodes || !prevEdges) return;

  const prevN = Number(prevNodes);
  const prevE = Number(prevEdges);
  if (prevN <= 0) return;

  const nodeDrift = Math.abs(nodeCount - prevN) / prevN;
  const edgeDrift = prevE > 0 ? Math.abs(actualEdgeCount - prevE) / prevE : 0;
  const driftThreshold =
    (config as { build?: { driftThreshold?: number } }).build?.driftThreshold ?? 0.2;
  if (nodeDrift > driftThreshold || edgeDrift > driftThreshold) {
    warn(
      `Incremental build diverged significantly from previous counts (nodes: ${prevN}\u2192${nodeCount} [${(nodeDrift * 100).toFixed(1)}%], edges: ${prevE}\u2192${actualEdgeCount} [${(edgeDrift * 100).toFixed(1)}%], threshold: ${(driftThreshold * 100).toFixed(0)}%). Consider rebuilding with --no-incremental.`,
    );
  }
}

/**
 * Persist build metadata (engine, version, counts, timestamp).
 * Skipped for small incremental builds to avoid WAL fsync cost.
 */
function persistBuildMetadata(
  ctx: PipelineContext,
  nodeCount: number,
  actualEdgeCount: number,
  buildNow: Date,
): void {
  const useNativeDb = ctx.engineName === 'native' && !!ctx.nativeDb;
  if (!ctx.isFullBuild && ctx.allSymbols.size <= 3) return;
  try {
    if (useNativeDb) {
      ctx.nativeDb!.setBuildMeta(
        Object.entries({
          engine: ctx.engineName,
          engine_version: CODEGRAPH_VERSION,
          codegraph_version: CODEGRAPH_VERSION,
          schema_version: String(ctx.schemaVersion),
          built_at: buildNow.toISOString(),
          node_count: String(nodeCount),
          edge_count: String(actualEdgeCount),
        }).map(([key, value]) => ({ key, value: String(value) })),
      );
    } else {
      setBuildMeta(ctx.db, {
        engine: ctx.engineName,
        engine_version: CODEGRAPH_VERSION,
        codegraph_version: CODEGRAPH_VERSION,
        schema_version: String(ctx.schemaVersion),
        built_at: buildNow.toISOString(),
        node_count: nodeCount,
        edge_count: actualEdgeCount,
      });
    }
  } catch (err) {
    warn(`Failed to write build metadata: ${(err as Error).message}`);
  }
}

/**
 * Run advisory checks on full builds: orphaned embeddings, stale embeddings,
 * and unused exports. Informational only — does not affect correctness.
 */
function runAdvisoryChecks(ctx: PipelineContext, hasEmbeddings: boolean, buildNow: Date): void {
  // Batched native path: single napi call for all 3 advisory checks
  if (ctx.engineName === 'native' && ctx.nativeDb?.runAdvisoryChecks) {
    const result = ctx.nativeDb.runAdvisoryChecks(hasEmbeddings);
    if (result.orphanedEmbeddings > 0) {
      warn(
        `${result.orphanedEmbeddings} embeddings are orphaned (nodes changed). Run "codegraph embed" to refresh.`,
      );
    }
    if (result.embedBuiltAt) {
      const embedTime = new Date(result.embedBuiltAt).getTime();
      if (!Number.isNaN(embedTime) && embedTime < buildNow.getTime()) {
        warn(
          'Embeddings were built before the last graph rebuild. Run "codegraph embed" to update.',
        );
      }
    }
    if (result.unusedExports > 0) {
      warn(
        `${result.unusedExports} exported symbol${result.unusedExports > 1 ? 's have' : ' has'} zero cross-file consumers. Run "codegraph exports <file> --unused" to inspect.`,
      );
    }
    return;
  }

  const { db } = ctx;

  // Orphaned embeddings warning
  if (hasEmbeddings) {
    try {
      const orphaned = (
        db
          .prepare(
            'SELECT COUNT(*) as c FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)',
          )
          .get() as { c: number }
      ).c;
      if (orphaned > 0) {
        warn(
          `${orphaned} embeddings are orphaned (nodes changed). Run "codegraph embed" to refresh.`,
        );
      }
    } catch {
      /* ignore - embeddings table may have been dropped */
    }
  }

  // Stale embeddings warning (built before current graph rebuild)
  if (hasEmbeddings) {
    try {
      const embedBuiltAt = (
        db.prepare("SELECT value FROM embedding_meta WHERE key = 'built_at'").get() as
          | { value: string }
          | undefined
      )?.value;
      if (embedBuiltAt) {
        const embedTime = new Date(embedBuiltAt).getTime();
        if (!Number.isNaN(embedTime) && embedTime < buildNow.getTime()) {
          warn(
            'Embeddings were built before the last graph rebuild. Run "codegraph embed" to update.',
          );
        }
      }
    } catch {
      /* ignore - embedding_meta table may not exist */
    }
  }

  // Unused exports warning
  try {
    const unusedCount = (
      db
        .prepare(
          `SELECT COUNT(*) as c FROM nodes
         WHERE exported = 1 AND kind != 'file'
           AND id NOT IN (
             SELECT DISTINCT e.target_id FROM edges e
             JOIN nodes caller ON e.source_id = caller.id
             JOIN nodes target ON e.target_id = target.id
             WHERE e.kind = 'calls' AND caller.file != target.file
           )`,
        )
        .get() as { c: number }
    ).c;
    if (unusedCount > 0) {
      warn(
        `${unusedCount} exported symbol${unusedCount > 1 ? 's have' : ' has'} zero cross-file consumers. Run "codegraph exports <file> --unused" to inspect.`,
      );
    }
  } catch {
    /* exported column may not exist on older DBs */
  }
}

export async function finalize(ctx: PipelineContext): Promise<void> {
  const { allSymbols, rootDir, isFullBuild, hasEmbeddings, opts } = ctx;

  const t0 = performance.now();

  releaseWasmTrees(allSymbols);

  // Capture a single wall-clock timestamp for the current build — used for
  // both the stale-embeddings comparison and the persisted built_at metadata.
  const buildNow = new Date();

  const useNative = ctx.engineName === 'native' && !!ctx.nativeDb?.getFinalizeCounts;
  let nodeCount: number;
  let actualEdgeCount: number;
  if (useNative) {
    const counts = ctx.nativeDb!.getFinalizeCounts!();
    nodeCount = counts.nodeCount;
    actualEdgeCount = counts.edgeCount;
  } else {
    nodeCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
    actualEdgeCount = (ctx.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
  }
  info(`Graph built: ${nodeCount} nodes, ${actualEdgeCount} edges`);
  info(`Stored in ${ctx.dbPath}`);

  detectIncrementalDrift(ctx, nodeCount, actualEdgeCount);
  persistBuildMetadata(ctx, nodeCount, actualEdgeCount, buildNow);

  // Skip expensive advisory queries for incremental builds — these are
  // informational warnings that don't affect correctness and cost ~40-60ms.
  if (!isFullBuild) {
    debug(
      'Finalize: skipping advisory queries (orphaned/stale embeddings, unused exports) for incremental build',
    );
  } else {
    runAdvisoryChecks(ctx, hasEmbeddings, buildNow);
  }

  // Intentionally measured before closeDb / writeJournalHeader / auto-registration:
  // for the deferred-close path the close is async (setImmediate), and for full
  // builds the metric captures finalize logic only — DB close cost is tracked
  // separately via timing.closeDbMs when available.
  ctx.timing.finalizeMs = performance.now() - t0;

  // Close NativeDatabase (fast, ~1ms) then better-sqlite3 (WAL checkpoint).
  // For small incremental builds, defer the expensive WAL checkpoint to the
  // next event loop tick. Skip for temp directories (tests) — they rmSync
  // immediately after build.
  const pair = { db: ctx.db, nativeDb: ctx.nativeDb };
  const isTempDir = path.resolve(rootDir).startsWith(path.resolve(tmpdir()));
  if (!isFullBuild && allSymbols.size <= ctx.config.build.smallFilesThreshold && !isTempDir) {
    closeDbPairDeferred(pair);
  } else {
    closeDbPair(pair);
  }

  // Write journal header after successful build
  writeJournalHeader(rootDir, Date.now());

  // Skip auto-registration for incremental builds — the repo was already
  // registered during the initial full build. The dynamic import + file I/O
  // costs ~100ms which dominates incremental finalize time.
  if (!opts.skipRegistry && isFullBuild) {
    const tmpDir = path.resolve(tmpdir());
    const resolvedRoot = path.resolve(rootDir);
    if (resolvedRoot.startsWith(tmpDir)) {
      debug(`Skipping auto-registration for temp directory: ${resolvedRoot}`);
    } else {
      try {
        const { registerRepo } = (await import('../../../../infrastructure/registry.js')) as {
          registerRepo: (rootDir: string) => void;
        };
        registerRepo(rootDir);
      } catch (err) {
        debug(`Auto-registration failed: ${(err as Error).message}`);
      }
    }
  }
}
