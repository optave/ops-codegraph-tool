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
  initSchema(ctx.db);

  // Detect whether native engine is available, but defer opening NativeDatabase.
  // The native orchestrator opens it on demand; the JS pipeline defers until
  // after change detection — avoiding ~5ms open+initSchema+close on no-op rebuilds.
  const enginePref = ctx.opts.engine || 'auto';
  ctx.nativeAvailable = enginePref !== 'wasm' && !!loadNative()?.NativeDatabase;

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
  /** Full changed files including reverse-dep files — used by JS structure fallback. */
  structureScope?: string[];
  /** Whether the Rust pipeline handled the structure phase (small-incremental fast path). */
  structureHandled?: boolean;
}

// ── Native orchestrator helpers ───────────────────────────────────────

/** Determine whether the native orchestrator should be skipped. Returns a reason string, or null if it should run. */
function shouldSkipNativeOrchestrator(ctx: PipelineContext): string | null {
  if (process.env.CODEGRAPH_FORCE_JS_PIPELINE === '1') return 'CODEGRAPH_FORCE_JS_PIPELINE=1';
  if (ctx.forceFullRebuild) return 'forceFullRebuild';
  const orchestratorBuggy = !!ctx.engineVersion && semverCompare(ctx.engineVersion, '3.10.0') < 0;
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

/** Run AST/complexity/CFG/dataflow analysis after native orchestrator. */
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

  try {
    const { runAnalyses: runAnalysesFn } = await import('../../../ast-analysis/engine.js');
    const result = await runAnalysesFn(
      ctx.db,
      analysisFileSymbols,
      ctx.rootDir,
      ctx.opts,
      ctx.engineOpts,
    );
    timing.astMs = result.astMs ?? 0;
    timing.complexityMs = result.complexityMs ?? 0;
    timing.cfgMs = result.cfgMs ?? 0;
    timing.dataflowMs = result.dataflowMs ?? 0;
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

  // Open NativeDatabase on demand for the orchestrator.
  // Deferred from setupPipeline so no-op JS pipeline rebuilds skip the overhead.
  if (!ctx.nativeDb && ctx.nativeAvailable) {
    const native = loadNative();
    if (native?.NativeDatabase) {
      try {
        ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath);
        ctx.nativeDb.initSchema();
        ctx.nativeDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      } catch (err) {
        warn(`NativeDatabase setup failed, falling back to JS: ${toErrorMessage(err)}`);
        try {
          ctx.nativeDb?.close();
        } catch (e) {
          debug(`tryNativeOrchestrator: close failed during fallback: ${toErrorMessage(e)}`);
        }
        ctx.nativeDb = undefined;
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

  // ── Post-native structure + analysis ──────────────────────────────
  let analysisTiming = { astMs: 0, complexityMs: 0, cfgMs: 0, dataflowMs: 0 };
  let structurePatchMs = 0;
  const needsAnalysis =
    ctx.opts.ast !== false ||
    ctx.opts.complexity !== false ||
    ctx.opts.cfg !== false ||
    ctx.opts.dataflow !== false;
  // Skip JS structure when the Rust pipeline's small-incremental fast path
  // already handled it. For full builds and large incrementals where Rust
  // skipped structure, we must run the JS fallback.
  const needsStructure = !result.structureHandled;

  if (needsAnalysis || needsStructure) {
    if (!handoffWalAfterNativeBuild(ctx)) {
      // DB reopen failed — return partial result
      return formatNativeTimingResult(p, 0, analysisTiming);
    }

    // When structure was handled by Rust, we only need changed files for
    // analysis — no need to load the entire graph from DB. When structure
    // was NOT handled, we need all files to build the complete directory tree.
    const scopeFiles = needsStructure ? undefined : result.changedFiles;
    const fileSymbols = reconstructFileSymbolsFromDb(ctx, scopeFiles);

    if (needsStructure) {
      structurePatchMs = await runPostNativeStructure(
        ctx,
        fileSymbols,
        !!result.isFullBuild,
        result.structureScope ?? result.changedFiles,
      );
    }

    if (needsAnalysis) {
      analysisTiming = await runPostNativeAnalysis(ctx, fileSymbols, result.changedFiles);
    }
  }

  closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
  return formatNativeTimingResult(p, structurePatchMs, analysisTiming);
}

// ── Pipeline stages execution ───────────────────────────────────────────

async function runPipelineStages(ctx: PipelineContext): Promise<void> {
  // NativeDatabase is deferred — not opened during setup. collectFiles and
  // detectChanges only need better-sqlite3. If no files changed, we exit
  // early without ever opening the native connection, saving ~5ms.
  // If nativeDb was opened by tryNativeOrchestrator (which fell through),
  // suspend it now to avoid dual-connection WAL corruption during stages.
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
  if (ctx.nativeAvailable && ctx.engineName === 'native') {
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
  if (ctx.nativeAvailable) {
    reopenNativeDb(ctx, 'analyses');
    if (ctx.nativeDb && ctx.engineOpts) {
      ctx.engineOpts.nativeDb = ctx.nativeDb;
      ctx.engineOpts.suspendJsDb = () => {
        ctx.db.pragma('wal_checkpoint(TRUNCATE)');
      };
      ctx.engineOpts.resumeJsDb = () => {
        try {
          ctx.nativeDb?.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        } catch (e) {
          debug(
            `resumeJsDb: WAL checkpoint failed (nativeDb may already be closed): ${toErrorMessage(e)}`,
          );
        }
      };
    }
    if (!ctx.nativeDb && ctx.engineOpts) {
      ctx.engineOpts.nativeDb = undefined;
      ctx.engineOpts.suspendJsDb = undefined;
      ctx.engineOpts.resumeJsDb = undefined;
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
    try {
      const nativeResult = await tryNativeOrchestrator(ctx);
      if (nativeResult === 'early-exit') return;
      if (nativeResult) return nativeResult;
    } catch (err) {
      warn(`Native build orchestrator failed, falling back to JS pipeline: ${toErrorMessage(err)}`);
      // Fall through to JS pipeline
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
