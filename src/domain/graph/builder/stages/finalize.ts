/**
 * Stage: finalize
 *
 * WASM cleanup, stats logging, drift detection, build metadata, registry, journal.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb, getBuildMeta, setBuildMeta } from '../../../../db/index.js';
import { debug, info, warn } from '../../../../infrastructure/logger.js';
import { CODEGRAPH_VERSION } from '../../../../shared/version.js';
import { writeJournalHeader } from '../../journal.js';
import type { PipelineContext } from '../context.js';

export async function finalize(ctx: PipelineContext): Promise<void> {
  const { db, allSymbols, rootDir, isFullBuild, hasEmbeddings, config, opts, schemaVersion } = ctx;

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

  // Incremental drift detection
  if (!isFullBuild) {
    const prevNodes = getBuildMeta(db, 'node_count');
    const prevEdges = getBuildMeta(db, 'edge_count');
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

  // Persist build metadata early so downstream checks (e.g. stale-embeddings)
  // can read the *current* build's built_at rather than the previous one.
  try {
    setBuildMeta(db, {
      engine: ctx.engineName,
      engine_version: ctx.engineVersion || '',
      codegraph_version: CODEGRAPH_VERSION,
      schema_version: String(schemaVersion),
      built_at: buildNow.toISOString(),
      node_count: nodeCount,
      edge_count: actualEdgeCount,
    });
  } catch (err) {
    warn(`Failed to write build metadata: ${(err as Error).message}`);
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

  closeDb(db);

  // Write journal header after successful build
  writeJournalHeader(rootDir, Date.now());

  // Auto-registration
  if (!opts.skipRegistry) {
    const { tmpdir } = await import('node:os');
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

  ctx.timing.finalizeMs = performance.now() - t0;
}
