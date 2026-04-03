/**
 * Pipeline orchestrator — runs build stages sequentially through a shared PipelineContext.
 *
 * This is the heart of the builder refactor (ROADMAP 3.9): the monolithic buildGraph()
 * is decomposed into independently testable stages that communicate via PipelineContext.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  closeDbPair,
  getBuildMeta,
  initSchema,
  MIGRATIONS,
  openDb,
  setBuildMeta,
} from '../../../db/index.js';
import { detectWorkspaces, loadConfig } from '../../../infrastructure/config.js';
import { debug, info, warn } from '../../../infrastructure/logger.js';
import { loadNative } from '../../../infrastructure/native.js';
import { semverCompare } from '../../../infrastructure/update-check.js';
import { toErrorMessage } from '../../../shared/errors.js';
import { CODEGRAPH_VERSION } from '../../../shared/version.js';
import type { BuildGraphOpts, BuildResult, Definition, ExtractorOutput } from '../../../types.js';
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
          } catch (e) {
            debug(
              `resumeJsDb: WAL checkpoint failed (nativeDb may already be closed): ${toErrorMessage(e)}`,
            );
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
      warn(`NativeDatabase setup failed, falling back to JS: ${toErrorMessage(err)}`);
      try {
        ctx.nativeDb?.close();
      } catch (e) {
        debug(`setupNativeDb: close failed during fallback: ${toErrorMessage(e)}`);
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

// ── NativeDb lifecycle helpers ──────────────────────────────────────────

/** Checkpoint WAL through rusqlite and close the native connection. */
function closeNativeDb(ctx: PipelineContext, label: string): void {
  if (!ctx.nativeDb) return;
  try {
    ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    debug(`${label} WAL checkpoint failed: ${toErrorMessage(e)}`);
  }
  try {
    ctx.nativeDb.close();
  } catch (e) {
    debug(`${label} nativeDb close failed: ${toErrorMessage(e)}`);
  }
  ctx.nativeDb = undefined;
}

/** Try to reopen the native connection for a given pipeline phase. */
function reopenNativeDb(ctx: PipelineContext, label: string): void {
  const native = loadNative();
  if (!native?.NativeDatabase) return;
  try {
    ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
  } catch (e) {
    debug(`reopen nativeDb for ${label} failed: ${toErrorMessage(e)}`);
    ctx.nativeDb = undefined;
  }
}

/** Close nativeDb and clear stale references in engineOpts. */
function suspendNativeDb(ctx: PipelineContext, label: string): void {
  closeNativeDb(ctx, label);
  if (ctx.engineOpts?.nativeDb) {
    ctx.engineOpts.nativeDb = undefined;
  }
}

/**
 * After native writes, reopen the JS db connection to get a fresh page cache.
 * Rusqlite WAL truncation invalidates better-sqlite3's internal WAL index,
 * causing SQLITE_CORRUPT on the next read (#715, #736).
 */
function refreshJsDb(ctx: PipelineContext): void {
  try {
    ctx.db.close();
  } catch (e) {
    debug(`refreshJsDb close failed: ${toErrorMessage(e)}`);
  }
  ctx.db = openDb(ctx.dbPath);
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
    suspendNativeDb(ctx, 'pre-collect');
  }

  await collectFiles(ctx);
  await detectChanges(ctx);

  if (ctx.earlyExit) return;

  await parseFiles(ctx);

  // Temporarily reopen nativeDb for insertNodes — it uses the WAL checkpoint
  // guard internally (same pattern as feature modules). Closed again before
  // resolveImports/buildEdges which don't yet have the guard (#709).
  if (hadNativeDb && ctx.engineName === 'native') {
    reopenNativeDb(ctx, 'insertNodes');
  }

  await insertNodes(ctx);

  // Close nativeDb after insertNodes — remaining pipeline stages use JS paths.
  if (ctx.nativeDb && ctx.db) {
    closeNativeDb(ctx, 'post-insertNodes');
    refreshJsDb(ctx);
  }

  await resolveImports(ctx);
  await buildEdges(ctx);
  await buildStructure(ctx);

  // Reopen nativeDb for feature modules (ast, cfg, complexity, dataflow)
  // which use suspendJsDb/resumeJsDb WAL checkpoint before native writes.
  if (hadNativeDb) {
    reopenNativeDb(ctx, 'analyses');
    if (ctx.nativeDb && ctx.engineOpts) {
      ctx.engineOpts.nativeDb = ctx.nativeDb;
    }
    if (!ctx.nativeDb && ctx.engineOpts) {
      ctx.engineOpts.nativeDb = undefined;
    }
  }

  await runAnalyses(ctx);

  // Keep nativeDb open through finalize so persistBuildMetadata, advisory
  // checks, and count queries use the native path.  closeDbPair inside
  // finalize handles both connections.  Refresh the JS db so it has a
  // valid page cache in case finalize falls back to JS paths (#751).
  if (ctx.nativeDb) {
    refreshJsDb(ctx);
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
    //
    // Native addon 3.8.0 has a path bug: file_symbols keys are absolute
    // paths but known_files are relative, causing zero import/call edges.
    // Skip the orchestrator for affected versions (fixed in 3.9.0+).
    const orchestratorBuggy = !!ctx.engineVersion && semverCompare(ctx.engineVersion, '3.8.0') <= 0;
    const forceJs =
      process.env.CODEGRAPH_FORCE_JS_PIPELINE === '1' ||
      ctx.forceFullRebuild ||
      orchestratorBuggy ||
      ctx.engineName !== 'native';
    if (forceJs) {
      const reason =
        process.env.CODEGRAPH_FORCE_JS_PIPELINE === '1'
          ? 'CODEGRAPH_FORCE_JS_PIPELINE=1'
          : ctx.forceFullRebuild
            ? 'forceFullRebuild'
            : orchestratorBuggy
              ? `buggy addon ${ctx.engineVersion}`
              : `engine=${ctx.engineName}`;
      debug(`Skipping native orchestrator: ${reason}`);
    }
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
          changedFiles?: string[];
          changedCount?: number;
          removedCount?: number;
          isFullBuild?: boolean;
        };

        if (result.earlyExit) {
          info('No changes detected');
          closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
          return;
        }

        // Log incremental status to match JS pipeline output
        const changed = result.changedCount ?? 0;
        const removed = result.removedCount ?? 0;
        if (!result.isFullBuild && (changed > 0 || removed > 0)) {
          info(`Incremental: ${changed} changed, ${removed} removed`);
        }

        // Map Rust timing fields to the JS BuildResult format.
        // Rust handles collect+detect+parse+insert+resolve+edges+structure+roles.
        const p = result.phases;

        // Sync build_meta so JS-side version/engine checks work on next build.
        // Note: the Rust orchestrator also writes codegraph_version (using
        // CARGO_PKG_VERSION). We intentionally overwrite it here with the npm
        // package version so that the JS-side "version changed → full rebuild"
        // detection (line ~97) compares against the authoritative JS version.
        // The two versions are kept in lockstep by the release process.
        setBuildMeta(ctx.db, {
          engine: ctx.engineName,
          engine_version: ctx.engineVersion || '',
          codegraph_version: CODEGRAPH_VERSION,
          schema_version: String(ctx.schemaVersion),
          built_at: new Date().toISOString(),
          node_count: String(result.nodeCount ?? 0),
          edge_count: String(result.edgeCount ?? 0),
        });

        info(
          `Native build orchestrator completed: ${result.nodeCount ?? 0} nodes, ${result.edgeCount ?? 0} edges, ${result.fileCount ?? 0} files`,
        );

        // ── Run analysis phases (AST, complexity, CFG, dataflow) ──────
        // Not yet ported to Rust. After the native orchestrator finishes,
        // reconstruct a minimal fileSymbols map from the DB and run analyses
        // via the JS engine (native standalone functions + WASM fallback).
        let analysisTiming = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };
        const needsAnalysis =
          opts.ast !== false ||
          opts.complexity !== false ||
          opts.cfg !== false ||
          opts.dataflow !== false;

        if (needsAnalysis) {
          // WAL handoff: checkpoint through rusqlite, close nativeDb,
          // reopen better-sqlite3 with a fresh page cache (#715, #736).
          try {
            ctx.nativeDb!.exec('PRAGMA wal_checkpoint(TRUNCATE)');
          } catch {
            /* ignore checkpoint errors */
          }
          try {
            ctx.nativeDb!.close();
          } catch {
            /* ignore close errors */
          }
          ctx.nativeDb = undefined;
          try {
            ctx.db.close();
          } catch {
            /* ignore close errors */
          }
          ctx.db = null!; // avoid closeDbPair operating on a stale handle
          try {
            ctx.db = openDb(ctx.dbPath);
          } catch (reopenErr) {
            warn(
              `Failed to reopen DB for analysis after native build: ${(reopenErr as Error).message}`,
            );
            // Native build succeeded but we can't run analyses — return partial result
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
          }

          // Reconstruct minimal fileSymbols from DB for analysis visitors.
          // Each entry needs definitions with name/kind/line/endLine so the
          // engine can match complexity/CFG results to the right functions.
          // For incremental builds, scope to only the files that were parsed
          // in this cycle (matching the JS pipeline's behaviour in run-analyses.ts).
          const changedFiles = result.changedFiles;
          let query =
            'SELECT file, name, kind, line, end_line as endLine FROM nodes WHERE file IS NOT NULL';
          const params: string[] = [];
          if (changedFiles && changedFiles.length > 0) {
            const placeholders = changedFiles.map(() => '?').join(',');
            query += ` AND file IN (${placeholders})`;
            params.push(...changedFiles);
          }
          query += ' ORDER BY file, line';
          const rows = ctx.db.prepare(query).all(...params) as {
            file: string;
            name: string;
            kind: string;
            line: number;
            endLine: number | null;
          }[];

          const fileSymbols = new Map<string, ExtractorOutput>();
          for (const row of rows) {
            let entry = fileSymbols.get(row.file);
            if (!entry) {
              entry = {
                definitions: [],
                calls: [],
                imports: [],
                classes: [],
                exports: [],
                typeMap: new Map(),
              };
              fileSymbols.set(row.file, entry);
            }
            entry.definitions.push({
              name: row.name,
              kind: row.kind as Definition['kind'],
              line: row.line,
              endLine: row.endLine ?? undefined,
            });
          }

          // Reopen nativeDb for analysis features (suspend/resume WAL pattern).
          const native = loadNative();
          if (native?.NativeDatabase) {
            try {
              ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
              if (ctx.engineOpts) ctx.engineOpts.nativeDb = ctx.nativeDb;
            } catch {
              ctx.nativeDb = undefined;
              if (ctx.engineOpts) ctx.engineOpts.nativeDb = undefined;
            }
          }

          try {
            const { runAnalyses: runAnalysesFn } = await import('../../../ast-analysis/engine.js');
            analysisTiming = await runAnalysesFn(
              ctx.db,
              fileSymbols,
              ctx.rootDir,
              opts,
              ctx.engineOpts,
            );
          } catch (err) {
            warn(`Analysis phases failed after native build: ${toErrorMessage(err)}`);
          }

          // Close nativeDb after analyses
          if (ctx.nativeDb) {
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
            if (ctx.engineOpts) ctx.engineOpts.nativeDb = undefined;
          }
        }

        closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
        return {
          phases: {
            setupMs: +((p.setupMs ?? 0) + (p.collectMs ?? 0) + (p.detectMs ?? 0)).toFixed(1),
            parseMs: +(p.parseMs ?? 0).toFixed(1),
            insertMs: +(p.insertMs ?? 0).toFixed(1),
            resolveMs: +(p.resolveMs ?? 0).toFixed(1),
            edgesMs: +(p.edgesMs ?? 0).toFixed(1),
            structureMs: +(p.structureMs ?? 0).toFixed(1),
            rolesMs: +(p.rolesMs ?? 0).toFixed(1),
            astMs: +(analysisTiming.astMs ?? 0).toFixed(1),
            complexityMs: +(analysisTiming.complexityMs ?? 0).toFixed(1),
            cfgMs: +(analysisTiming.cfgMs ?? 0).toFixed(1),
            dataflowMs: +(analysisTiming.dataflowMs ?? 0).toFixed(1),
            finalizeMs: +(p.finalizeMs ?? 0).toFixed(1),
          },
        };
      } catch (err) {
        warn(
          `Native build orchestrator failed, falling back to JS pipeline: ${toErrorMessage(err)}`,
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
