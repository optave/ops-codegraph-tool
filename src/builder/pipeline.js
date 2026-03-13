/**
 * Pipeline orchestrator — runs build stages sequentially through a shared PipelineContext.
 *
 * This is the heart of the builder refactor (ROADMAP 3.9): the monolithic buildGraph()
 * is decomposed into independently testable stages that communicate via PipelineContext.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../config.js';
import { closeDb, getBuildMeta, initSchema, MIGRATIONS, openDb } from '../db.js';
import { info } from '../logger.js';
import { getActiveEngine } from '../parser.js';
import { PipelineContext } from './context.js';
import { loadPathAliases } from './helpers.js';
import { buildEdges } from './stages/build-edges.js';
import { buildStructure } from './stages/build-structure.js';
// Pipeline stages
import { collectFiles } from './stages/collect-files.js';
import { detectChanges } from './stages/detect-changes.js';
import { finalize } from './stages/finalize.js';
import { insertNodes } from './stages/insert-nodes.js';
import { parseFiles } from './stages/parse-files.js';
import { resolveImports } from './stages/resolve-imports.js';
import { runAnalyses } from './stages/run-analyses.js';

/**
 * Build the dependency graph for a codebase.
 *
 * Signature and return value are identical to the original monolithic buildGraph().
 *
 * @param {string} rootDir - Root directory to scan
 * @param {object} [opts] - Build options
 * @returns {Promise<{ phases: object } | undefined>}
 */
export async function buildGraph(rootDir, opts = {}) {
  const ctx = new PipelineContext();
  ctx.buildStart = performance.now();
  ctx.opts = opts;

  // ── Setup (creates DB, loads config, selects engine) ──────────────
  ctx.rootDir = path.resolve(rootDir);
  ctx.dbPath = path.join(ctx.rootDir, '.codegraph', 'graph.db');
  ctx.db = openDb(ctx.dbPath);
  try {
    initSchema(ctx.db);

    ctx.config = loadConfig(ctx.rootDir);
    ctx.incremental =
      opts.incremental !== false && ctx.config.build && ctx.config.build.incremental !== false;

    ctx.engineOpts = {
      engine: opts.engine || 'auto',
      dataflow: opts.dataflow !== false,
      ast: opts.ast !== false,
    };
    const { name: engineName, version: engineVersion } = getActiveEngine(ctx.engineOpts);
    ctx.engineName = engineName;
    ctx.engineVersion = engineVersion;
    info(`Using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`);

    // Engine/schema mismatch detection
    ctx.schemaVersion = MIGRATIONS[MIGRATIONS.length - 1].version;
    ctx.forceFullRebuild = false;
    if (ctx.incremental) {
      const prevEngine = getBuildMeta(ctx.db, 'engine');
      if (prevEngine && prevEngine !== engineName) {
        info(`Engine changed (${prevEngine} → ${engineName}), promoting to full rebuild.`);
        ctx.forceFullRebuild = true;
      }
      const prevSchema = getBuildMeta(ctx.db, 'schema_version');
      if (prevSchema && Number(prevSchema) !== ctx.schemaVersion) {
        info(
          `Schema version changed (${prevSchema} → ${ctx.schemaVersion}), promoting to full rebuild.`,
        );
        ctx.forceFullRebuild = true;
      }
    }

    // Path aliases
    ctx.aliases = loadPathAliases(ctx.rootDir);
    if (ctx.config.aliases) {
      for (const [key, value] of Object.entries(ctx.config.aliases)) {
        const pattern = key.endsWith('/') ? `${key}*` : key;
        const target = path.resolve(ctx.rootDir, value);
        ctx.aliases.paths[pattern] = [target.endsWith('/') ? `${target}*` : `${target}/*`];
      }
    }
    if (ctx.aliases.baseUrl || Object.keys(ctx.aliases.paths).length > 0) {
      info(
        `Loaded path aliases: baseUrl=${ctx.aliases.baseUrl || 'none'}, ${Object.keys(ctx.aliases.paths).length} path mappings`,
      );
    }

    ctx.timing.setupMs = performance.now() - ctx.buildStart;

    // ── Pipeline stages ─────────────────────────────────────────────
    await collectFiles(ctx);
    await detectChanges(ctx);

    if (ctx.earlyExit) return;

    await parseFiles(ctx);
    await insertNodes(ctx);
    await resolveImports(ctx);
    await buildEdges(ctx);
    await buildStructure(ctx);
    await runAnalyses(ctx);
    await finalize(ctx);
  } catch (err) {
    if (!ctx.earlyExit) closeDb(ctx.db);
    throw err;
  }

  return {
    phases: {
      setupMs: +ctx.timing.setupMs.toFixed(1),
      parseMs: +(ctx.timing.parseMs ?? 0).toFixed(1),
      insertMs: +(ctx.timing.insertMs ?? 0).toFixed(1),
      resolveMs: +(ctx.timing.resolveMs ?? 0).toFixed(1),
      edgesMs: +(ctx.timing.edgesMs ?? 0).toFixed(1),
      structureMs: +(ctx.timing.structureMs ?? 0).toFixed(1),
      rolesMs: +(ctx.timing.rolesMs ?? 0).toFixed(1),
      astMs: +(ctx.timing.astMs ?? 0).toFixed(1),
      complexityMs: +(ctx.timing.complexityMs ?? 0).toFixed(1),
      ...(ctx.timing.cfgMs != null && { cfgMs: +ctx.timing.cfgMs.toFixed(1) }),
      ...(ctx.timing.dataflowMs != null && { dataflowMs: +ctx.timing.dataflowMs.toFixed(1) }),
      finalizeMs: +(ctx.timing.finalizeMs ?? 0).toFixed(1),
    },
  };
}
