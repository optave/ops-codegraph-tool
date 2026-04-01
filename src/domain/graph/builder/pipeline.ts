/**
 * Pipeline orchestrator — runs build stages sequentially through a shared PipelineContext.
 *
 * This is the heart of the builder refactor (ROADMAP 3.9): the monolithic buildGraph()
 * is decomposed into independently testable stages that communicate via PipelineContext.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { closeDbPair, getBuildMeta, initSchema, MIGRATIONS, openDb } from '../../../db/index.js';
import { detectWorkspaces, loadConfig } from '../../../infrastructure/config.js';
import { info, warn } from '../../../infrastructure/logger.js';
import { loadNative } from '../../../infrastructure/native.js';
import { CODEGRAPH_VERSION } from '../../../shared/version.js';
import type { BuildGraphOpts, BuildResult } from '../../../types.js';
import { getActiveEngine } from '../../parser.js';
import { setWorkspaces } from '../resolve.js';
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

// ── Setup helpers ───────────────────────────────────────────────────────

function initializeEngine(ctx: PipelineContext): void {
  ctx.engineOpts = {
    engine: ctx.opts.engine || 'auto',
    dataflow: ctx.opts.dataflow !== false,
    ast: ctx.opts.ast !== false,
    nativeDb: ctx.nativeDb,
    // WAL checkpoint callbacks for dual-connection WAL guard (#696, #715).
    // Feature modules (ast, cfg, complexity, dataflow) receive `db` as a
    // parameter and cannot tolerate close/reopen (stale reference). Instead,
    // checkpoint the WAL so native writes start with a clean slate.
    // After native writes, resumeJsDb checkpoints through rusqlite so
    // better-sqlite3 never reads WAL frames from a different SQLite library.
    suspendJsDb: ctx.nativeDb
      ? () => {
          ctx.db.pragma('wal_checkpoint(TRUNCATE)');
        }
      : undefined,
    resumeJsDb: ctx.nativeDb
      ? () => {
          try {
            ctx.nativeDb?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          } catch {
            /* ignore — nativeDb may already be closed */
          }
        }
      : undefined,
  };
  const { name: engineName, version: engineVersion } = getActiveEngine(ctx.engineOpts);
  ctx.engineName = engineName as 'native' | 'wasm';
  ctx.engineVersion = engineVersion;
  info(`Using ${engineName} engine${engineVersion ? ` (v${engineVersion})` : ''}`);
}

function checkEngineSchemaMismatch(ctx: PipelineContext): void {
  const lastMigration = MIGRATIONS[MIGRATIONS.length - 1] as { version: number } | undefined;
  ctx.schemaVersion = lastMigration?.version ?? 0;
  ctx.forceFullRebuild = false;
  if (!ctx.incremental) return;

  // Route metadata reads through NativeDatabase only when using the native engine,
  // to avoid dual-SQLite WAL conflicts (rusqlite + better-sqlite3 on same file).
  const useNativeDb = ctx.engineName === 'native' && !!ctx.nativeDb;
  const meta = (key: string): string | null =>
    useNativeDb ? ctx.nativeDb!.getBuildMeta(key) : getBuildMeta(ctx.db, key);

  const prevEngine = meta('engine');
  if (prevEngine && prevEngine !== ctx.engineName) {
    info(`Engine changed (${prevEngine} → ${ctx.engineName}), promoting to full rebuild.`);
    ctx.forceFullRebuild = true;
  }
  const prevSchema = meta('schema_version');
  if (prevSchema && Number(prevSchema) !== ctx.schemaVersion) {
    info(
      `Schema version changed (${prevSchema} → ${ctx.schemaVersion}), promoting to full rebuild.`,
    );
    ctx.forceFullRebuild = true;
  }
  const prevVersion = meta('codegraph_version');
  if (prevVersion && prevVersion !== CODEGRAPH_VERSION) {
    info(
      `Codegraph version changed (${prevVersion} → ${CODEGRAPH_VERSION}), promoting to full rebuild.`,
    );
    ctx.forceFullRebuild = true;
  }
}

function loadAliases(ctx: PipelineContext): void {
  ctx.aliases = loadPathAliases(ctx.rootDir);
  if (ctx.config.aliases) {
    for (const [key, value] of Object.entries(ctx.config.aliases)) {
      if (typeof value !== 'string') {
        warn(`Alias target for "${key}" must be a string, got ${typeof value}. Skipping.`);
        continue;
      }
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
}

function setupPipeline(ctx: PipelineContext): void {
  ctx.rootDir = path.resolve(ctx.rootDir);
  ctx.dbPath = path.join(ctx.rootDir, '.codegraph', 'graph.db');
  ctx.db = openDb(ctx.dbPath);

  // Use NativeDatabase for schema init when native engine is available (Phase 6.13).
  // better-sqlite3 (ctx.db) is still always opened — needed for queries and stages
  // that haven't been migrated to rusqlite yet.
  const native = loadNative();
  if (native?.NativeDatabase) {
    try {
      ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
      ctx.nativeDb.initSchema();
      // Checkpoint WAL through rusqlite so better-sqlite3 sees a clean DB
      // with no cross-library WAL frames (#715, #717).
      ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      warn(`NativeDatabase setup failed, falling back to JS: ${(err as Error).message}`);
      try {
        ctx.nativeDb?.close();
      } catch {
        /* ignore close errors */
      }
      ctx.nativeDb = undefined;
    }
    // Always run JS initSchema so better-sqlite3 sees the schema —
    // nativeDb is closed during pipeline stages and reopened for analyses.
    initSchema(ctx.db);
  } else {
    initSchema(ctx.db);
  }

  ctx.config = loadConfig(ctx.rootDir);
  ctx.incremental =
    ctx.opts.incremental !== false && ctx.config.build && ctx.config.build.incremental !== false;

  initializeEngine(ctx);
  checkEngineSchemaMismatch(ctx);
  loadAliases(ctx);

  // Workspace packages (monorepo)
  const workspaces = detectWorkspaces(ctx.rootDir);
  if (workspaces.size > 0) {
    setWorkspaces(ctx.rootDir, workspaces);
    info(`Detected ${workspaces.size} workspace packages`);
  }

  ctx.timing.setupMs = performance.now() - ctx.buildStart;
}

function formatTimingResult(ctx: PipelineContext): BuildResult {
  const t = ctx.timing;
  return {
    phases: {
      setupMs: +(t.setupMs ?? 0).toFixed(1),
      parseMs: +(t.parseMs ?? 0).toFixed(1),
      insertMs: +(t.insertMs ?? 0).toFixed(1),
      resolveMs: +(t.resolveMs ?? 0).toFixed(1),
      edgesMs: +(t.edgesMs ?? 0).toFixed(1),
      structureMs: +(t.structureMs ?? 0).toFixed(1),
      rolesMs: +(t.rolesMs ?? 0).toFixed(1),
      astMs: +(t.astMs ?? 0).toFixed(1),
      complexityMs: +(t.complexityMs ?? 0).toFixed(1),
      cfgMs: +(t.cfgMs ?? 0).toFixed(1),
      dataflowMs: +(t.dataflowMs ?? 0).toFixed(1),
      finalizeMs: +(t.finalizeMs ?? 0).toFixed(1),
    },
  };
}

// ── Pipeline stages execution ───────────────────────────────────────────

async function runPipelineStages(ctx: PipelineContext): Promise<void> {
  // Prevent dual-connection WAL corruption during pipeline stages: when both
  // better-sqlite3 (ctx.db) and rusqlite (ctx.nativeDb) are open to the same
  // WAL-mode file, native writes corrupt the DB. Close nativeDb so stages
  // use JS fallback paths. Reopened before runAnalyses for feature modules
  // that use suspendJsDb/resumeJsDb WAL checkpoint pattern (#696).
  const hadNativeDb = !!ctx.nativeDb;
  if (ctx.db && ctx.nativeDb) {
    // Checkpoint WAL through rusqlite before closing so better-sqlite3 never
    // needs to apply WAL frames written by a different SQLite library (#715, #717).
    // Separate try/catch blocks ensure close() always runs even if checkpoint throws,
    // preventing a live rusqlite connection from lingering until GC.
    try {
      ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore checkpoint errors */
    }
    try {
      ctx.nativeDb.close();
    } catch {
      /* ignore close errors */
    }
    ctx.nativeDb = undefined;
    // Also clear stale reference in engineOpts to prevent stages from
    // calling methods on the closed NativeDatabase.
    if (ctx.engineOpts?.nativeDb) {
      ctx.engineOpts.nativeDb = undefined;
    }
  }

  await collectFiles(ctx);
  await detectChanges(ctx);

  if (ctx.earlyExit) return;

  await parseFiles(ctx);

  // Temporarily reopen nativeDb for insertNodes — it uses the WAL checkpoint
  // guard internally (same pattern as feature modules). Closed again before
  // resolveImports/buildEdges which don't yet have the guard (#709).
  if (hadNativeDb && ctx.engineName === 'native') {
    const native = loadNative();
    if (native?.NativeDatabase) {
      try {
        ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
      } catch {
        ctx.nativeDb = undefined;
      }
    }
  }

  await insertNodes(ctx);

  // Close nativeDb after insertNodes — remaining pipeline stages use JS paths.
  if (ctx.nativeDb && ctx.db) {
    // Checkpoint WAL through rusqlite before closing so better-sqlite3 never
    // needs to apply WAL frames written by a different SQLite library (#715, #717).
    try {
      ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore checkpoint errors */
    }
    try {
      ctx.nativeDb.close();
    } catch {
      /* ignore close errors */
    }
    ctx.nativeDb = undefined;
    // Reopen better-sqlite3 connection to get a fresh page cache.
    // After rusqlite truncates the WAL, better-sqlite3's internal WAL index
    // (shared-memory mapping) may reference frames that no longer exist,
    // causing SQLITE_CORRUPT on the next read. Closing and reopening
    // forces a clean slate — the only reliable cross-library handoff (#715, #736).
    try {
      ctx.db.close();
    } catch {
      /* ignore close errors */
    }
    ctx.db = openDb(ctx.dbPath);
  }

  await resolveImports(ctx);
  await buildEdges(ctx);
  await buildStructure(ctx);

  // Reopen nativeDb for feature modules (ast, cfg, complexity, dataflow)
  // which use suspendJsDb/resumeJsDb WAL checkpoint before native writes.
  if (hadNativeDb) {
    const native = loadNative();
    if (native?.NativeDatabase) {
      try {
        ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
        if (ctx.engineOpts) {
          ctx.engineOpts.nativeDb = ctx.nativeDb;
        }
      } catch {
        ctx.nativeDb = undefined;
        if (ctx.engineOpts) {
          ctx.engineOpts.nativeDb = undefined;
        }
      }
    }
  }

  await runAnalyses(ctx);

  // Close nativeDb after analyses — finalize uses JS paths for setBuildMeta
  // and closeDbPair handles cleanup. Avoids dual-connection during finalize.
  if (ctx.nativeDb) {
    // Checkpoint WAL through rusqlite before closing so better-sqlite3 never
    // needs to apply WAL frames written by a different SQLite library (#715, #717).
    // Separate try/catch blocks ensure close() always runs even if checkpoint throws.
    try {
      ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore checkpoint errors */
    }
    try {
      ctx.nativeDb.close();
    } catch {
      /* ignore close errors */
    }
    ctx.nativeDb = undefined;
  }

  await finalize(ctx);
}

// ── Main entry point ────────────────────────────────────────────────────

/**
 * Build the dependency graph for a codebase.
 *
 * Signature and return value are identical to the original monolithic buildGraph().
 */
export async function buildGraph(
  rootDir: string,
  opts: BuildGraphOpts = {},
): Promise<BuildResult | undefined> {
  const ctx = new PipelineContext();
  ctx.buildStart = performance.now();
  ctx.opts = opts;
  ctx.rootDir = rootDir;

  try {
    setupPipeline(ctx);

    // ── Rust orchestrator fast path (#695) ────────────────────────────
    // When available, run the entire build pipeline in Rust with zero
    // napi crossings (eliminates WAL dual-connection dance). Falls back
    // to the JS pipeline on failure or when native is unavailable.
    const forceJs = process.env.CODEGRAPH_FORCE_JS_PIPELINE === '1';
    if (!forceJs && ctx.nativeDb?.buildGraph) {
      try {
        const resultJson = ctx.nativeDb.buildGraph(
          ctx.rootDir,
          JSON.stringify(ctx.config),
          JSON.stringify(ctx.aliases),
          JSON.stringify(opts),
        );
        const result = JSON.parse(resultJson) as {
          phases: Record<string, number>;
          earlyExit?: boolean;
          nodeCount?: number;
          edgeCount?: number;
          fileCount?: number;
        };

        if (result.earlyExit) {
          closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
          return;
        }

        // Map Rust timing fields to the JS BuildResult format.
        // Rust handles collect+detect+parse+insert+resolve+edges+structure+roles.
        // AST/complexity/CFG/dataflow analyses are not yet ported to Rust.
        const p = result.phases;
        closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
        info(
          `Native build orchestrator completed: ${result.nodeCount ?? 0} nodes, ${result.edgeCount ?? 0} edges, ${result.fileCount ?? 0} files`,
        );
        return {
          phases: {
            setupMs: +((p.setupMs ?? 0) + (p.collectMs ?? 0) + (p.detectMs ?? 0)).toFixed(1),
            parseMs: +(p.parseMs ?? 0).toFixed(1),
            insertMs: +(p.insertMs ?? 0).toFixed(1),
            resolveMs: +(p.resolveMs ?? 0).toFixed(1),
            edgesMs: +(p.edgesMs ?? 0).toFixed(1),
            structureMs: +(p.structureMs ?? 0).toFixed(1),
            rolesMs: +(p.rolesMs ?? 0).toFixed(1),
            astMs: 0,
            complexityMs: 0,
            cfgMs: 0,
            dataflowMs: 0,
            finalizeMs: +(p.finalizeMs ?? 0).toFixed(1),
          },
        };
      } catch (err) {
        warn(
          `Native build orchestrator failed, falling back to JS pipeline: ${(err as Error).message}`,
        );
        // Fall through to JS pipeline
      }
    }

    await runPipelineStages(ctx);
  } catch (err) {
    if (!ctx.earlyExit && ctx.db) {
      closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
    }
    throw err;
  }

  if (ctx.earlyExit) return;

  return formatTimingResult(ctx);
}
