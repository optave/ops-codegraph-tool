/**
 * Pipeline orchestrator — runs build stages sequentially through a shared PipelineContext.
 *
 * This is the heart of the builder refactor (ROADMAP 3.9): the monolithic buildGraph()
 * is decomposed into independently testable stages that communicate via PipelineContext.
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  acquireAdvisoryLock,
  closeDbPair,
  getBuildMeta,
  initSchema,
  MIGRATIONS,
  openDb,
  releaseAdvisoryLock,
  setBuildMeta,
} from '../../../db/index.js';
import { detectWorkspaces, loadConfig } from '../../../infrastructure/config.js';
import { debug, info, warn } from '../../../infrastructure/logger.js';
import { loadNative } from '../../../infrastructure/native.js';
import { semverCompare } from '../../../infrastructure/update-check.js';
import { normalizePath } from '../../../shared/constants.js';
import { toErrorMessage } from '../../../shared/errors.js';
import { CODEGRAPH_VERSION } from '../../../shared/version.js';
import type {
  BetterSqlite3Database,
  BuildGraphOpts,
  BuildResult,
  Definition,
  ExtractorOutput,
  SqliteStatement,
} from '../../../types.js';
import { getActiveEngine, getInstalledWasmExtensions, parseFilesAuto } from '../../parser.js';
import { setWorkspaces } from '../resolve.js';
import { PipelineContext } from './context.js';
import { batchInsertNodes, collectFiles as collectFilesUtil, loadPathAliases } from './helpers.js';
import { NativeDbProxy } from './native-db-proxy.js';
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
    // nativeDb and WAL callbacks are set later when NativeDatabase is opened
    // (deferred to skip overhead on no-op rebuilds).
    nativeDb: undefined,
    suspendJsDb: undefined,
    resumeJsDb: undefined,
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

  // NativeDatabase is deferred until after change detection, so always use
  // better-sqlite3 for metadata reads here. Reads are safe — WAL conflicts
  // only arise from concurrent writes.
  const meta = (key: string): string | null => getBuildMeta(ctx.db, key);

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
  // When the native engine is active, the Rust addon's version (ctx.engineVersion)
  // is written into codegraph_version by setBuildMeta after a native orchestrator
  // build. The check must compare against the same version, otherwise JS and Rust
  // fight over which version to record — causing every incremental build to be
  // promoted to a full rebuild when npm and crate versions diverge.
  const effectiveVersion =
    ctx.engineName === 'native' && ctx.engineVersion ? ctx.engineVersion : CODEGRAPH_VERSION;
  const prevVersion = meta('codegraph_version');
  if (prevVersion && prevVersion !== effectiveVersion) {
    info(
      `Codegraph version changed (${prevVersion} → ${effectiveVersion}), promoting to full rebuild.`,
    );
    ctx.forceFullRebuild = true;
  }
}

function warnOnEmbeddingsWipe(ctx: PipelineContext): void {
  const willBeFullBuild = !ctx.incremental || ctx.forceFullRebuild;
  if (!willBeFullBuild) return;
  let count = 0;
  try {
    count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM embeddings').get() as { c: number }).c;
  } catch {
    return; // embeddings table missing — nothing to warn about
  }
  if (count === 0) return;
  warn(
    `Full rebuild will discard ${count} embedding${count === 1 ? '' : 's'}; re-run \`codegraph embed\` after the build.`,
  );
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

  // Detect whether native engine is available.
  const enginePref = ctx.opts.engine || 'auto';
  const native = enginePref !== 'wasm' ? loadNative() : null;
  ctx.nativeAvailable = !!native?.NativeDatabase;

  // Always use better-sqlite3 for setup — it's cheap (~4ms) and only needed
  // for metadata reads (schema mismatch check). NativeDatabase.openReadWrite
  // is deferred to tryNativeOrchestrator, saving ~60ms on incremental builds
  // where the Rust orchestrator handles the full pipeline, and avoiding the
  // cost entirely on no-op builds that exit before reaching the orchestrator.
  const dir = path.dirname(ctx.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  ctx.db = openDb(ctx.dbPath);
  initSchema(ctx.db);

  ctx.config = loadConfig(ctx.rootDir);
  ctx.incremental =
    ctx.opts.incremental !== false && ctx.config.build && ctx.config.build.incremental !== false;

  initializeEngine(ctx);
  checkEngineSchemaMismatch(ctx);
  warnOnEmbeddingsWipe(ctx);
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
  if ((ctx.opts.engine ?? 'auto') === 'wasm') return;
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

// ── Native orchestrator types ──────────────────────────────────────────

interface NativeOrchestratorResult {
  phases: Record<string, number>;
  earlyExit?: boolean;
  nodeCount?: number;
  edgeCount?: number;
  fileCount?: number;
  changedFiles?: string[];
  changedCount?: number;
  removedCount?: number;
  isFullBuild?: boolean;
  /** Whether the Rust pipeline handled the structure phase (small-incremental fast path). */
  structureHandled?: boolean;
  /** Whether the Rust pipeline wrote AST/complexity/CFG/dataflow to DB. */
  analysisComplete?: boolean;
}

// ── Native orchestrator helpers ───────────────────────────────────────

/** Determine whether the native orchestrator should be skipped. Returns a reason string, or null if it should run. */
function shouldSkipNativeOrchestrator(ctx: PipelineContext): string | null {
  if (ctx.forceFullRebuild) return 'forceFullRebuild';
  // v3.9.0 addon had buggy incremental purge (wrong SQL on analysis tables,
  // scoped removal over-detection). Fixed in v3.9.1 by PR #865. Gate on
  // < 3.9.1 so v3.9.1+ uses the fast Rust orchestrator path.
  const orchestratorBuggy = !!ctx.engineVersion && semverCompare(ctx.engineVersion, '3.9.1') < 0;
  if (orchestratorBuggy) return `buggy addon ${ctx.engineVersion}`;
  if (ctx.engineName !== 'native') return `engine=${ctx.engineName}`;
  return null;
}

/** Checkpoint WAL through rusqlite, close nativeDb, and reopen better-sqlite3.
 *  Returns false if the DB reopen fails (caller should return partial result). */
function handoffWalAfterNativeBuild(ctx: PipelineContext): boolean {
  closeNativeDb(ctx, 'post-native-build');
  try {
    ctx.db.close();
  } catch (e) {
    debug(`handoffWal JS db close failed: ${toErrorMessage(e)}`);
  }
  try {
    ctx.db = openDb(ctx.dbPath);
    return true;
  } catch (reopenErr) {
    warn(`Failed to reopen DB after native build: ${(reopenErr as Error).message}`);
    return false;
  }
}

/**
 * Reconstruct fileSymbols from the DB after a native orchestrator build.
 * When `scopeFiles` is provided, only loads those files (for analysis-only).
 * When omitted, loads all files (needed for structure rebuilds).
 */
function reconstructFileSymbolsFromDb(
  ctx: PipelineContext,
  scopeFiles?: string[],
): Map<string, ExtractorOutput> {
  let query =
    'SELECT file, name, kind, line, end_line as endLine FROM nodes WHERE file IS NOT NULL';
  const params: string[] = [];
  if (scopeFiles && scopeFiles.length > 0) {
    const placeholders = scopeFiles.map(() => '?').join(',');
    query += ` AND file IN (${placeholders})`;
    params.push(...scopeFiles);
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

  // Populate import/export counts from DB edges so buildStructure
  // computes correct import_count/export_count in node_metrics.
  // The extractor arrays aren't persisted to the DB, so we derive
  // counts from edge data instead (#804).
  const importCountRows = ctx.db
    .prepare(
      `SELECT n.file, COUNT(*) AS cnt
       FROM edges e JOIN nodes n ON e.source_id = n.id
       WHERE e.kind IN ('imports', 'imports-type', 'dynamic-imports')
         AND n.file IS NOT NULL
       GROUP BY n.file`,
    )
    .all() as { file: string; cnt: number }[];
  for (const row of importCountRows) {
    const entry = fileSymbols.get(row.file);
    if (entry) entry.imports = new Array(row.cnt) as ExtractorOutput['imports'];
  }

  const exportCountRows = ctx.db
    .prepare(
      `SELECT n_tgt.file, COUNT(DISTINCT n_tgt.id) AS cnt
       FROM edges e
       JOIN nodes n_tgt ON e.target_id = n_tgt.id
       JOIN nodes n_src ON e.source_id = n_src.id
       WHERE e.kind IN ('imports', 'imports-type', 'reexports')
         AND n_tgt.file IS NOT NULL
         AND n_src.file != n_tgt.file
       GROUP BY n_tgt.file`,
    )
    .all() as { file: string; cnt: number }[];
  for (const row of exportCountRows) {
    const entry = fileSymbols.get(row.file);
    if (entry) entry.exports = new Array(row.cnt) as ExtractorOutput['exports'];
  }

  return fileSymbols;
}

/**
 * Run JS buildStructure() after native orchestrator to fill directory nodes + contains edges.
 * For full builds, passes changedFiles=null (full rebuild).
 * For incremental builds, passes the changed file list to scope the update.
 */
async function runPostNativeStructure(
  ctx: PipelineContext,
  allFileSymbols: Map<string, ExtractorOutput>,
  isFullBuild: boolean,
  changedFiles: string[] | undefined,
): Promise<number> {
  const structureStart = performance.now();
  try {
    const directories = new Set<string>();
    for (const relPath of allFileSymbols.keys()) {
      const parts = relPath.split('/');
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join('/'));
      }
    }

    const lineCountMap = new Map<string, number>();
    const cachedLineCounts = ctx.db
      .prepare(
        `SELECT n.name AS file, m.line_count
         FROM node_metrics m JOIN nodes n ON m.node_id = n.id
         WHERE n.kind = 'file'`,
      )
      .all() as Array<{ file: string; line_count: number }>;
    for (const row of cachedLineCounts) {
      lineCountMap.set(row.file, row.line_count);
    }

    // Full builds need null (rebuild everything). Incremental builds pass the
    // changed file list so buildStructure only updates those files' metrics
    // and contains edges — matching the JS pipeline's medium-incremental path.
    const changedFilePaths = isFullBuild || !changedFiles?.length ? null : changedFiles;
    const { buildStructure: buildStructureFn } = (await import(
      '../../../features/structure.js'
    )) as {
      buildStructure: (
        db: typeof ctx.db,
        fileSymbols: Map<string, ExtractorOutput>,
        rootDir: string,
        lineCountMap: Map<string, number>,
        directories: Set<string>,
        changedFiles: string[] | null,
      ) => void;
    };
    buildStructureFn(
      ctx.db,
      allFileSymbols,
      ctx.rootDir,
      lineCountMap,
      directories,
      changedFilePaths,
    );
    debug(
      `Structure phase completed after native orchestrator${changedFilePaths ? ` (${changedFilePaths.length} files)` : ' (full)'}`,
    );
  } catch (err) {
    warn(`Structure phase failed after native build: ${toErrorMessage(err)}`);
  }
  return performance.now() - structureStart;
}

/**
 * JS fallback for AST/complexity/CFG/dataflow analysis after native orchestrator.
 * Used when the Rust addon doesn't include analysis persistence (older addon
 * version) or when analysis failed on the Rust side.
 */
async function runPostNativeAnalysis(
  ctx: PipelineContext,
  allFileSymbols: Map<string, ExtractorOutput>,
  changedFiles: string[] | undefined,
): Promise<{ astMs: number; complexityMs: number; cfgMs: number; dataflowMs: number }> {
  const timing = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };

  // Scope analysis fileSymbols to changed files only
  let analysisFileSymbols: Map<string, ExtractorOutput>;
  if (changedFiles && changedFiles.length > 0) {
    analysisFileSymbols = new Map();
    for (const f of changedFiles) {
      const entry = allFileSymbols.get(f);
      if (entry) analysisFileSymbols.set(f, entry);
    }
  } else {
    analysisFileSymbols = allFileSymbols;
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

  // Flush JS WAL pages once so Rust can see them, then no-op callbacks.
  // Previously each feature called wal_checkpoint(TRUNCATE) individually
  // (~68ms each × 3-4 features). One FULL checkpoint suffices.
  if (ctx.nativeDb && ctx.engineOpts) {
    ctx.db.pragma('wal_checkpoint(FULL)');
    ctx.engineOpts.suspendJsDb = () => {};
    ctx.engineOpts.resumeJsDb = () => {};
  }

  try {
    const { runAnalyses: runAnalysesFn } = (await import('../../../ast-analysis/engine.js')) as {
      runAnalyses: (
        db: BetterSqlite3Database,
        fileSymbols: Map<string, ExtractorOutput>,
        rootDir: string,
        opts: Record<string, unknown>,
        engineOpts?: Record<string, unknown>,
      ) => Promise<{ astMs?: number; complexityMs?: number; cfgMs?: number; dataflowMs?: number }>;
    };
    const result = await runAnalysesFn(
      ctx.db,
      analysisFileSymbols,
      ctx.rootDir,
      ctx.opts as Record<string, unknown>,
      ctx.engineOpts as unknown as Record<string, unknown> | undefined,
    );
    timing.astMs = result.astMs ?? 0;
    timing.complexityMs = result.complexityMs ?? 0;
    timing.cfgMs = result.cfgMs ?? 0;
    timing.dataflowMs = result.dataflowMs ?? 0;
  } catch (err) {
    warn(`Analysis phases failed after native build: ${toErrorMessage(err)}`);
  }

  // Close nativeDb after analyses — TRUNCATE checkpoint flushes all Rust
  // WAL writes so JS and external readers can see them. Runs once after
  // all analysis features complete (not per-feature).
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
    if (ctx.engineOpts) {
      ctx.engineOpts.nativeDb = undefined;
      ctx.engineOpts.suspendJsDb = undefined;
      ctx.engineOpts.resumeJsDb = undefined;
    }
  }

  return timing;
}

/** Format timing result from native orchestrator phases + JS post-processing. */
function formatNativeTimingResult(
  p: Record<string, number>,
  structurePatchMs: number,
  analysisTiming: { astMs: number; complexityMs: number; cfgMs: number; dataflowMs: number },
): BuildResult {
  return {
    phases: {
      setupMs: +((p.setupMs ?? 0) + (p.collectMs ?? 0) + (p.detectMs ?? 0)).toFixed(1),
      parseMs: +(p.parseMs ?? 0).toFixed(1),
      insertMs: +(p.insertMs ?? 0).toFixed(1),
      resolveMs: +(p.resolveMs ?? 0).toFixed(1),
      edgesMs: +(p.edgesMs ?? 0).toFixed(1),
      structureMs: +((p.structureMs ?? 0) + structurePatchMs).toFixed(1),
      rolesMs: +(p.rolesMs ?? 0).toFixed(1),
      astMs: +(analysisTiming.astMs ?? 0).toFixed(1),
      complexityMs: +(analysisTiming.complexityMs ?? 0).toFixed(1),
      cfgMs: +(analysisTiming.cfgMs ?? 0).toFixed(1),
      dataflowMs: +(analysisTiming.dataflowMs ?? 0).toFixed(1),
      finalizeMs: +(p.finalizeMs ?? 0).toFixed(1),
    },
  };
}

/** Try the native build orchestrator. Returns a BuildResult on success, undefined to fall through to JS pipeline. */
async function tryNativeOrchestrator(
  ctx: PipelineContext,
): Promise<BuildResult | undefined | 'early-exit'> {
  const skipReason = shouldSkipNativeOrchestrator(ctx);
  if (skipReason) {
    debug(`Skipping native orchestrator: ${skipReason}`);
    return undefined;
  }

  // Open NativeDatabase on demand — deferred from setupPipeline to skip the
  // ~60ms cost on no-op/early-exit builds. Close the better-sqlite3 connection
  // first to avoid dual-connection WAL corruption.
  if (!ctx.nativeDb && ctx.nativeAvailable) {
    const native = loadNative();
    if (native?.NativeDatabase) {
      try {
        // Close better-sqlite3 before opening rusqlite to avoid WAL conflicts.
        // Uses raw close() instead of closeDb() intentionally — the advisory lock
        // is kept and transferred to the NativeDbProxy below, not released here.
        ctx.db.close();
        acquireAdvisoryLock(ctx.dbPath);
        ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
        ctx.nativeDb.initSchema();
        // Replace ctx.db with a NativeDbProxy so post-native JS fallback
        // (structure, analysis) can use it without reopening better-sqlite3.
        const proxy = new NativeDbProxy(ctx.nativeDb);
        proxy.__lockPath = `${ctx.dbPath}.lock`;
        ctx.db = proxy as unknown as typeof ctx.db;
        ctx.nativeFirstProxy = true;
      } catch (err) {
        warn(`NativeDatabase setup failed, falling back to JS: ${toErrorMessage(err)}`);
        try {
          ctx.nativeDb?.close();
        } catch (e) {
          debug(`tryNativeOrchestrator: close failed during fallback: ${toErrorMessage(e)}`);
        }
        ctx.nativeDb = undefined;
        ctx.nativeFirstProxy = false; // defensive: reset in case future refactors move the assignment above throwing lines
        releaseAdvisoryLock(`${ctx.dbPath}.lock`);
        // Reopen better-sqlite3 for JS pipeline fallback
        ctx.db = openDb(ctx.dbPath);
      }
    }
  }

  if (!ctx.nativeDb?.buildGraph) return undefined;

  const resultJson = ctx.nativeDb.buildGraph(
    ctx.rootDir,
    JSON.stringify(ctx.config),
    JSON.stringify(ctx.aliases),
    JSON.stringify(ctx.opts),
  );
  const result = JSON.parse(resultJson) as NativeOrchestratorResult;

  if (result.earlyExit) {
    info('No changes detected');
    closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
    return 'early-exit';
  }

  // Log incremental status to match JS pipeline output
  const changed = result.changedCount ?? 0;
  const removed = result.removedCount ?? 0;
  if (!result.isFullBuild && (changed > 0 || removed > 0)) {
    info(`Incremental: ${changed} changed, ${removed} removed`);
  }

  const p = result.phases;

  // Sync build_meta so JS-side version/engine checks work on next build.
  // Use the Rust addon version as codegraph_version when the native
  // orchestrator performed the build — the Rust side's check_version_mismatch
  // compares this value against CARGO_PKG_VERSION.  Writing the JS
  // CODEGRAPH_VERSION here would create a permanent mismatch whenever the
  // npm package version diverges from the Rust crate version, forcing every
  // subsequent native build to be a full rebuild (no incremental).
  setBuildMeta(ctx.db, {
    engine: ctx.engineName,
    engine_version: ctx.engineVersion || '',
    codegraph_version: ctx.engineVersion || CODEGRAPH_VERSION,
    schema_version: String(ctx.schemaVersion),
    built_at: new Date().toISOString(),
  });

  info(
    `Native build orchestrator completed: ${result.nodeCount ?? 0} nodes, ${result.edgeCount ?? 0} edges, ${result.fileCount ?? 0} files`,
  );

  // ── Post-native structure + analysis ──────────────────────────────
  let analysisTiming = {
    astMs: +(p.astMs ?? 0),
    complexityMs: +(p.complexityMs ?? 0),
    cfgMs: +(p.cfgMs ?? 0),
    dataflowMs: +(p.dataflowMs ?? 0),
  };
  let structurePatchMs = 0;
  // Skip JS structure when the Rust pipeline's small-incremental fast path
  // already handled it. For full builds and large incrementals where Rust
  // skipped structure, we must run the JS fallback.
  const needsStructure = !result.structureHandled;
  // When the Rust addon doesn't include analysis persistence (older addon
  // version or analysis failed), fall back to JS-side analysis.
  const needsAnalysisFallback =
    !result.analysisComplete &&
    (ctx.opts.ast !== false ||
      ctx.opts.complexity !== false ||
      ctx.opts.cfg !== false ||
      ctx.opts.dataflow !== false);

  if (needsStructure || needsAnalysisFallback) {
    // When analysis fallback is needed, handoff to better-sqlite3 — the
    // analysis engine uses the suspend/resume WAL pattern that requires a
    // real better-sqlite3 connection, not the NativeDbProxy.
    if (needsAnalysisFallback && ctx.nativeFirstProxy) {
      closeNativeDb(ctx, 'pre-analysis-fallback');
      ctx.db = openDb(ctx.dbPath);
      ctx.nativeFirstProxy = false;
    } else if (!ctx.nativeFirstProxy && !handoffWalAfterNativeBuild(ctx)) {
      // DB reopen failed — return partial result
      return formatNativeTimingResult(p, 0, analysisTiming);
    }

    const fileSymbols = reconstructFileSymbolsFromDb(ctx);

    if (needsStructure) {
      structurePatchMs = await runPostNativeStructure(
        ctx,
        fileSymbols,
        !!result.isFullBuild,
        result.changedFiles,
      );
    }

    if (needsAnalysisFallback) {
      analysisTiming = await runPostNativeAnalysis(ctx, fileSymbols, result.changedFiles);
    }
  }

  // Engine parity: the native orchestrator silently drops files whose
  // Rust extractor/grammar is missing or fails (e.g. HCL, Scala, Swift on
  // stale native binaries). WASM handles those — backfill via WASM so both
  // engines process the same file set (#967).
  //
  // Only runs on full builds: incremental builds only touch changed files,
  // which are parsed through parseFilesAuto (which has its own per-file
  // backfill), so a full filesystem scan here would be wasted work.
  if (result.isFullBuild) {
    await backfillNativeDroppedFiles(ctx);
  }

  closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
  return formatNativeTimingResult(p, structurePatchMs, analysisTiming);
}

/**
 * Backfill files that the native orchestrator silently dropped during parse.
 * Falls back to WASM + inserts file/symbol nodes so engine counts match (#967).
 */
async function backfillNativeDroppedFiles(ctx: PipelineContext): Promise<void> {
  // Needs a real better-sqlite3 connection for INSERT.
  if (ctx.nativeFirstProxy) {
    closeNativeDb(ctx, 'pre-parity-backfill');
    ctx.db = openDb(ctx.dbPath);
    ctx.nativeFirstProxy = false;
  }

  const collected = collectFilesUtil(ctx.rootDir, [], ctx.config, new Set<string>());
  const expected = new Set(
    collected.files.map((f) => normalizePath(path.relative(ctx.rootDir, f))),
  );

  const existingRows = ctx.db
    .prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'")
    .all() as Array<{ file: string }>;
  const existing = new Set(existingRows.map((r) => r.file));

  // Restrict backfill to files with an installed WASM grammar. Extensions in
  // LANGUAGE_REGISTRY without a shipped grammar file (e.g. groovy, erlang on
  // minimal installs) can't be parsed by either engine, so they're not a
  // native regression — excluding them keeps the warn count meaningful.
  const installedExts = getInstalledWasmExtensions();
  const missingAbs: string[] = [];
  for (const rel of expected) {
    if (existing.has(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!installedExts.has(ext)) continue;
    missingAbs.push(path.join(ctx.rootDir, rel));
  }
  if (missingAbs.length === 0) return;

  warn(
    `Native orchestrator dropped ${missingAbs.length} file(s); backfilling via WASM for engine parity`,
  );
  const wasmResults = await parseFilesAuto(missingAbs, ctx.rootDir, { engine: 'wasm' });

  const rows: unknown[][] = [];
  const exportKeys: unknown[][] = [];
  for (const [relPath, symbols] of wasmResults) {
    // File row — mirrors insertDefinitionsAndExports: qualified_name is null.
    rows.push([relPath, 'file', relPath, 0, null, null, null, null, null]);
    for (const def of symbols.definitions ?? []) {
      // Populate qualified_name/scope the same way the JS fallback does so
      // downstream queries (cross-file references, "go to definition") find
      // these symbols.
      const dotIdx = def.name.lastIndexOf('.');
      const scope = dotIdx !== -1 ? def.name.slice(0, dotIdx) : null;
      rows.push([
        def.name,
        def.kind,
        relPath,
        def.line,
        def.endLine ?? null,
        null,
        def.name,
        scope,
        def.visibility ?? null,
      ]);
    }
    // Exports: insert the row (INSERT OR IGNORE — a matching definition row
    // is a no-op) and queue a key for the second-pass exported=1 update, so
    // queries filtering on exported=1 find backfilled symbols (#970).
    for (const exp of symbols.exports ?? []) {
      rows.push([exp.name, exp.kind, relPath, exp.line, null, null, exp.name, null, null]);
      exportKeys.push([exp.name, exp.kind, relPath, exp.line]);
    }
  }
  const db = ctx.db as unknown as BetterSqlite3Database;
  batchInsertNodes(db, rows);

  // Mark exported symbols in batches — mirrors insertDefinitionsAndExports.
  if (exportKeys.length > 0) {
    const EXPORT_CHUNK = 500;
    const exportStmtCache = new Map<number, SqliteStatement>();
    for (let i = 0; i < exportKeys.length; i += EXPORT_CHUNK) {
      const end = Math.min(i + EXPORT_CHUNK, exportKeys.length);
      const chunkSize = end - i;
      let updateStmt = exportStmtCache.get(chunkSize);
      if (!updateStmt) {
        const conditions = Array.from(
          { length: chunkSize },
          () => '(name = ? AND kind = ? AND file = ? AND line = ?)',
        ).join(' OR ');
        updateStmt = db.prepare(`UPDATE nodes SET exported = 1 WHERE ${conditions}`);
        exportStmtCache.set(chunkSize, updateStmt);
      }
      const vals: unknown[] = [];
      for (let j = i; j < end; j++) {
        const k = exportKeys[j] as unknown[];
        vals.push(k[0], k[1], k[2], k[3]);
      }
      updateStmt.run(...vals);
    }
  }
}

// ── Pipeline stages execution ───────────────────────────────────────────

async function runPipelineStages(ctx: PipelineContext): Promise<void> {
  // ── WASM / fallback dual-connection mode ─────────────────────────────
  // NativeDatabase is deferred — not opened during setup. collectFiles and
  // detectChanges only need better-sqlite3. If no files changed, we exit
  // early without ever opening the native connection, saving ~5ms.
  // If nativeDb was opened by tryNativeOrchestrator (which fell through),
  // suspend it now to avoid dual-connection WAL corruption during stages.
  if (ctx.db && ctx.nativeDb) {
    suspendNativeDb(ctx, 'pre-collect');
    // When nativeFirstProxy is true, ctx.db is a NativeDbProxy wrapping the
    // now-closed NativeDatabase. Replace it with a real better-sqlite3
    // connection so the JS pipeline stages can operate normally.
    if (ctx.nativeFirstProxy) {
      ctx.db = openDb(ctx.dbPath);
      ctx.nativeFirstProxy = false;
    }
  }

  await collectFiles(ctx);
  await detectChanges(ctx);

  if (ctx.earlyExit) return;

  await parseFiles(ctx);

  // For small incremental builds (≤smallFilesThreshold files), skip the nativeDb open/close
  // cycle for insertNodes — the WAL checkpoint + connection churn (~5-10ms)
  // exceeds the napi bulk-insert savings on a handful of files. The JS
  // fallback path inside insertNodes handles this case efficiently.
  const smallIncremental =
    !ctx.isFullBuild && ctx.allSymbols.size <= ctx.config.build.smallFilesThreshold;
  if (ctx.nativeAvailable && ctx.engineName === 'native' && !smallIncremental) {
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

  // Reopen nativeDb for feature modules (ast, cfg, complexity, dataflow).
  // Skip for small incremental builds — same rationale as insertNodes above.
  //
  // Perf: do ONE upfront FULL checkpoint to flush JS WAL pages so Rust
  // can see the latest rows, then make suspendJsDb/resumeJsDb no-ops.
  // Previously each feature called wal_checkpoint(TRUNCATE) individually
  // (~68ms each × 3-4 features = ~200-270ms overhead on incremental builds).
  if (ctx.nativeAvailable && !smallIncremental) {
    reopenNativeDb(ctx, 'analyses');
    if (ctx.nativeDb && ctx.engineOpts) {
      ctx.db.pragma('wal_checkpoint(FULL)');
      ctx.engineOpts.nativeDb = ctx.nativeDb;
      ctx.engineOpts.suspendJsDb = () => {};
      ctx.engineOpts.resumeJsDb = () => {};
    }
    if (!ctx.nativeDb && ctx.engineOpts) {
      ctx.engineOpts.nativeDb = undefined;
      ctx.engineOpts.suspendJsDb = undefined;
      ctx.engineOpts.resumeJsDb = undefined;
    }
  }

  await runAnalyses(ctx);

  // Release WASM trees deterministically on the success path — same cleanup
  // as the error-path catch block.  Without this, trees stay allocated until
  // GC collects ctx, holding WASM memory for the rest of the build (#931).
  if (ctx.allSymbols?.size > 0) {
    for (const [, symbols] of ctx.allSymbols) {
      const tree = symbols._tree as { delete?: () => void } | undefined;
      if (tree && typeof tree.delete === 'function') {
        try {
          tree.delete();
        } catch {
          /* ignore cleanup errors */
        }
      }
      symbols._tree = undefined;
    }
  }

  // Flush Rust WAL writes (AST, complexity, CFG, dataflow) so the JS
  // connection and any post-build readers can see them.  One TRUNCATE
  // here replaces the N per-feature resumeJsDb checkpoints (#checkpoint-opt).
  if (ctx.nativeDb) {
    try {
      ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (e) {
      debug(`post-analyses WAL checkpoint failed: ${toErrorMessage(e)}`);
    }
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
    try {
      const nativeResult = await tryNativeOrchestrator(ctx);
      if (nativeResult === 'early-exit') return;
      if (nativeResult) return nativeResult;
    } catch (err) {
      warn(`Native build orchestrator failed, falling back to JS pipeline: ${toErrorMessage(err)}`);
      // The version gate in checkEngineSchemaMismatch was skipped because
      // nativeAvailable was true. Now that we're falling back to the JS
      // pipeline, perform the codegraph_version check here so a version
      // bump still promotes to a full rebuild (#928).
      if (ctx.incremental && !ctx.forceFullRebuild) {
        const prevVersion = getBuildMeta(ctx.db, 'codegraph_version');
        if (prevVersion && prevVersion !== CODEGRAPH_VERSION) {
          info(
            `Codegraph version changed (${prevVersion} → ${CODEGRAPH_VERSION}), promoting to full rebuild.`,
          );
          ctx.forceFullRebuild = true;
          // Re-check embeddings: the initial warnOnEmbeddingsWipe ran before
          // forceFullRebuild was set here, so the silent-data-loss guard
          // would otherwise miss this late-promotion path (#986 follow-up).
          warnOnEmbeddingsWipe(ctx);
        }
      }
    }

    await runPipelineStages(ctx);
  } catch (err) {
    if (!ctx.earlyExit) {
      // Release WASM trees before closing DB to prevent V8 crash during
      // GC cleanup of orphaned WASM objects (#931).
      if (ctx.allSymbols?.size > 0) {
        for (const [, symbols] of ctx.allSymbols) {
          const tree = symbols._tree as { delete?: () => void } | undefined;
          if (tree && typeof tree.delete === 'function') {
            try {
              tree.delete();
            } catch {
              /* ignore cleanup errors */
            }
          }
          symbols._tree = undefined;
        }
      }
      if (ctx.db) {
        closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
      }
    }
    throw err;
  }

  if (ctx.earlyExit) return;

  return formatTimingResult(ctx);
}
