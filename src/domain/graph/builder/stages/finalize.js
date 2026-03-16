/**
 * Stage: finalize
 *
 * WASM cleanup, stats logging, drift detection, build metadata, registry, journal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDb, getBuildMeta, setBuildMeta } from '../../../../db/index.js';
import { writeJournalHeader } from '../../../../journal.js';
import { debug, info, warn } from '../../../../logger.js';

const __builderDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const CODEGRAPH_VERSION = JSON.parse(
  fs.readFileSync(path.join(__builderDir, '..', '..', '..', '..', '..', 'package.json'), 'utf-8'),
).version;

/**
 * @param {import('../context.js').PipelineContext} ctx
 */
export async function finalize(ctx) {
  const { db, allSymbols, rootDir, isFullBuild, hasEmbeddings, config, opts, schemaVersion } = ctx;

  const t0 = performance.now();

  // Release cached WASM trees
  for (const [, symbols] of allSymbols) {
    if (symbols._tree && typeof symbols._tree.delete === 'function') {
      try {
        symbols._tree.delete();
      } catch {}
    }
    symbols._tree = null;
    symbols._langId = null;
  }

  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  const actualEdgeCount = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
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
        const driftThreshold = config.build?.driftThreshold ?? 0.2;
        if (nodeDrift > driftThreshold || edgeDrift > driftThreshold) {
          warn(
            `Incremental build diverged significantly from previous counts (nodes: ${prevN}→${nodeCount} [${(nodeDrift * 100).toFixed(1)}%], edges: ${prevE}→${actualEdgeCount} [${(edgeDrift * 100).toFixed(1)}%], threshold: ${(driftThreshold * 100).toFixed(0)}%). Consider rebuilding with --no-incremental.`,
          );
        }
      }
    }
  }

  // Orphaned embeddings warning
  if (hasEmbeddings) {
    try {
      const orphaned = db
        .prepare('SELECT COUNT(*) as c FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)')
        .get().c;
      if (orphaned > 0) {
        warn(
          `${orphaned} embeddings are orphaned (nodes changed). Run "codegraph embed" to refresh.`,
        );
      }
    } catch {
      /* ignore — embeddings table may have been dropped */
    }
  }

  // Unused exports warning
  try {
    const unusedCount = db
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
      .get().c;
    if (unusedCount > 0) {
      warn(
        `${unusedCount} exported symbol${unusedCount > 1 ? 's have' : ' has'} zero cross-file consumers. Run "codegraph exports <file> --unused" to inspect.`,
      );
    }
  } catch {
    /* exported column may not exist on older DBs */
  }

  // Persist build metadata
  try {
    setBuildMeta(db, {
      engine: ctx.engineName,
      engine_version: ctx.engineVersion || '',
      codegraph_version: CODEGRAPH_VERSION,
      schema_version: String(schemaVersion),
      built_at: new Date().toISOString(),
      node_count: nodeCount,
      edge_count: actualEdgeCount,
    });
  } catch (err) {
    warn(`Failed to write build metadata: ${err.message}`);
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
        const { registerRepo } = await import('../../../../registry.js');
        registerRepo(rootDir);
      } catch (err) {
        debug(`Auto-registration failed: ${err.message}`);
      }
    }
  }

  ctx.timing.finalizeMs = performance.now() - t0;
}
