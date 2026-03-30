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

export async function finalize(ctx: PipelineContext): Promise<void> {
  const { db, allSymbols, rootDir, isFullBuild, hasEmbeddings, config, opts, schemaVersion } = ctx;
  const useNativeDb = ctx.engineName === 'native' && !!ctx.nativeDb;

  const t0 = performance.now();

  // Release cached WASM trees
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

  // Capture a single wall-clock timestamp for the current build — used for
  // both the stale-embeddings comparison and the persisted built_at metadata.
  const buildNow = new Date();

  const nodeCount = (db.prepare('SELECT COUNT(*) as c FROM nodes').get() as { c: number }).c;
  const actualEdgeCount = (db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;
  info(`Graph built: ${nodeCount} nodes, ${actualEdgeCount} edges`);
  info(`Stored in ${ctx.dbPath}`);

  // Incremental drift detection — skip for small incremental changes where
  // count fluctuation is expected (reverse-dep edge churn).
  if (!isFullBuild && allSymbols.size > 3) {
    const prevNodes = useNativeDb
      ? ctx.nativeDb!.getBuildMeta('node_count')
      : getBuildMeta(db, 'node_count');
    const prevEdges = useNativeDb
      ? ctx.nativeDb!.getBuildMeta('edge_count')
      : getBuildMeta(db, 'edge_count');
    if (prevNodes && prevEdges) {
      const prevN = Number(prevNodes);
      const prevE = Number(prevEdges);
      if (prevN > 0) {
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
    }
  }

  // For small incremental builds, skip persisting build metadata — the
  // engine/version/schema haven't changed (would have triggered a full rebuild),
  // built_at is only used by stale-embeddings check (skipped for incremental),
  // and counts are only used by drift detection (skipped for ≤3 files).
  // This avoids a transaction commit + WAL fsync (~15-30ms).
  // Threshold aligned with drift detection gate (allSymbols.size > 3) so stored
  // counts stay fresh whenever drift detection reads them.
  if (isFullBuild || allSymbols.size > 3) {
    try {
      if (useNativeDb) {
        ctx.nativeDb!.setBuildMeta(
          Object.entries({
            engine: ctx.engineName,
            engine_version: ctx.engineVersion || '',
            codegraph_version: CODEGRAPH_VERSION,
            schema_version: String(schemaVersion),
            built_at: buildNow.toISOString(),
            node_count: String(nodeCount),
            edge_count: String(actualEdgeCount),
          }).map(([key, value]) => ({ key, value: String(value) })),
        );
      } else {
        setBuildMeta(db, {
          engine: ctx.engineName,
          engine_version: ctx.engineVersion || '',
          codegraph_version: CODEGRAPH_VERSION,
          schema_version: String(schemaVersion),
          built_at: buildNow.toISOString(),
          node_count: nodeCount,
          edge_count: actualEdgeCount,
        });
      }
    } catch (err) {
      warn(`Failed to write build metadata: ${(err as Error).message}`);
    }
  }

  // Skip expensive advisory queries for incremental builds — these are
  // informational warnings that don't affect correctness and cost ~40-60ms.
  if (!isFullBuild) {
    debug(
      'Finalize: skipping advisory queries (orphaned/stale embeddings, unused exports) for incremental build',
    );
  } else {
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

  // Intentionally measured before closeDb / writeJournalHeader / auto-registration:
  // for the deferred-close path the close is async (setImmediate), and for full
  // builds the metric captures finalize logic only — DB close cost is tracked
  // separately via timing.closeDbMs when available.
  ctx.timing.finalizeMs = performance.now() - t0;

  // Close NativeDatabase (fast, ~1ms) then better-sqlite3 (WAL checkpoint).
  // For small incremental builds, defer the expensive WAL checkpoint to the
  // next event loop tick. Skip for temp directories (tests) — they rmSync
  // immediately after build.
  const pair = { db, nativeDb: ctx.nativeDb };
  const isTempDir = path.resolve(rootDir).startsWith(path.resolve(tmpdir()));
  if (!isFullBuild && allSymbols.size <= 5 && !isTempDir) {
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
