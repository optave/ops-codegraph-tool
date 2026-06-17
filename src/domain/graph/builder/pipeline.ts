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
  closeDb,
  closeDbPair,
  getBuildMeta,
  initSchema,
  MIGRATIONS,
  openDb,
} from '../../../db/index.js';
import {
  computeConfigHash,
  detectWorkspaces,
  getLastAppliedGlobalConfig,
  getLastAppliedGlobalPath,
  loadConfig,
  promptForConsentIfNeeded,
} from '../../../infrastructure/config.js';
import { debug, info, warn } from '../../../infrastructure/logger.js';
import { loadNative } from '../../../infrastructure/native.js';
import { toErrorMessage } from '../../../shared/errors.js';
import { CODEGRAPH_VERSION } from '../../../shared/version.js';
import type { BuildGraphOpts, BuildResult } from '../../../types.js';
import { getActiveEngine } from '../../parser.js';
import { writeJournalHeader } from '../journal.js';
import { setWorkspaces } from '../resolve.js';
import { PipelineContext } from './context.js';
import { loadPathAliases } from './helpers.js';
import { buildEdges } from './stages/build-edges.js';
import { buildStructure } from './stages/build-structure.js';
// Pipeline stages
import { collectFiles } from './stages/collect-files.js';
import { detectChanges, detectNoChanges } from './stages/detect-changes.js';
import { finalize } from './stages/finalize.js';
import { insertNodes } from './stages/insert-nodes.js';
import {
  closeNativeDb,
  refreshJsDb,
  reopenNativeDb,
  suspendNativeDb,
} from './stages/native-db-lifecycle.js';
import { tryNativeOrchestrator } from './stages/native-orchestrator.js';
import { parseFiles } from './stages/parse-files.js';
import { resolveImports } from './stages/resolve-imports.js';
import { runAnalyses } from './stages/run-analyses.js';

// Re-export computeWasmOnlyStaleFiles for backward compatibility with tests
// that import from this module path (#1073 unit tests).
export {
  computeWasmOnlyStaleFiles,
  type WasmOnlyStaleFilesInput,
} from './stages/native-orchestrator.js';

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
  const {
    name: engineName,
    version: engineVersion,
    binaryVersion: nativeBinaryVersion,
  } = getActiveEngine(ctx.engineOpts);
  ctx.engineName = engineName as 'native' | 'wasm';
  ctx.engineVersion = engineVersion;
  ctx.nativeBinaryVersion = nativeBinaryVersion;
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
  // When the native engine is active, the Rust orchestrator writes
  // build_meta.codegraph_version = CARGO_PKG_VERSION (the binary's own value).
  // Compare against the same value here so a CI hot-swap that leaves the
  // platform package.json behind doesn't trigger a perpetual full-rebuild
  // loop on every incremental (#1066).
  const effectiveVersion =
    ctx.engineName === 'native' && ctx.nativeBinaryVersion
      ? ctx.nativeBinaryVersion
      : CODEGRAPH_VERSION;
  const prevVersion = meta('codegraph_version');
  if (prevVersion && prevVersion !== effectiveVersion) {
    info(
      `Codegraph version changed (${prevVersion} → ${effectiveVersion}), promoting to full rebuild.`,
    );
    ctx.forceFullRebuild = true;
  }

  // Config hash — promotes to full rebuild when build-relevant config changes
  // (include/exclude/ignoreDirs/extensions/aliases/build.*).
  // This closes the pre-existing config-change gap and covers the new global-config layer.
  const currentConfigHash = computeConfigHash(ctx.config);
  const prevConfigHash = meta('config_hash');
  if (prevConfigHash && prevConfigHash !== currentConfigHash) {
    info('Build-relevant config changed, promoting to full rebuild.');
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
  ctx.dbPath = ctx.opts.dbPath
    ? path.resolve(ctx.opts.dbPath)
    : path.join(ctx.rootDir, '.codegraph', 'graph.db');

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

  ctx.config = loadConfig(ctx.rootDir, { userConfig: ctx.opts.userConfig });
  // Merge caller-supplied excludes on top of the file-config excludes so
  // programmatic callers (e.g. benchmark scripts) can extend exclusion
  // without mutating .codegraphrc.json. Native orchestrator picks this up
  // automatically — it reads exclude off the serialized ctx.config below.
  if (ctx.opts.exclude?.length) {
    ctx.config = {
      ...ctx.config,
      exclude: [...(ctx.config.exclude ?? []), ...ctx.opts.exclude],
    };
  }
  ctx.incremental =
    ctx.opts.incremental !== false && ctx.config.build && ctx.config.build.incremental !== false;

  // ── Build-time global-config notice ──────────────────────────────
  // Use the already-parsed and sanitized global config cached by loadConfig —
  // avoids a second disk read and the TOCTOU window between loadConfig and here.
  const appliedGlobalPath = getLastAppliedGlobalPath();
  if (appliedGlobalPath) {
    const buildAffectingKeys = [
      'include',
      'exclude',
      'ignoreDirs',
      'extensions',
      'aliases',
      'build',
    ];
    const globalData = getLastAppliedGlobalConfig();
    if (globalData) {
      const injectedKeys = buildAffectingKeys.filter((k) => k in globalData);
      if (injectedKeys.length > 0) {
        process.stderr.write(
          `ℹ global config applied (${appliedGlobalPath}) — injecting: ${injectedKeys.join(', ')} · --no-user-config to ignore\n`,
        );
      }
    }
  }

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
      collectMs: +(t.collectMs ?? 0).toFixed(1),
      detectMs: +(t.detectMs ?? 0).toFixed(1),
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

// Native db lifecycle and orchestrator helpers live in dedicated stage
// modules — see `./stages/native-db-lifecycle.ts` and `./stages/native-orchestrator.ts`.

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
    // Interactive consent prompt — only fires when the caller opts in (build
    // command with TTY), a global file exists, and the repo is undecided.
    if (opts.promptForConsent) {
      await promptForConsentIfNeeded(rootDir);
    }

    setupPipeline(ctx);

    // ── JS-side fast-skip for native incremental (#1054) ──────────────
    // The Rust orchestrator's internal early-exit fires reliably locally
    // but not in CI, where every no-op rebuild was paying the full ~2s
    // pipeline cost. A read-only mtime+size check here matches WASM's
    // ~20ms early-exit and skips the orchestrator entirely when no
    // source files have changed. Tier-2 hashing is left to the native
    // side: any mismatch falls through and lets Rust's detect_changes
    // remain the source of truth.
    //
    // Diagnostic logging gated by CODEGRAPH_FAST_SKIP_DIAG (#1066) — when
    // any of the call-site guards short-circuit (forceFullRebuild,
    // engineName, scope, etc.) we log the reason so the bench gate run
    // produces observable output even if `detectNoChanges` is never
    // entered.
    // Reads from config (which applies CODEGRAPH_FAST_SKIP_DIAG via applyEnvOverrides).
    const fastSkipDiag = ctx.config.build.fastSkipDiag;
    if (fastSkipDiag) {
      const reasons: string[] = [];
      if (!ctx.nativeAvailable) reasons.push('nativeAvailable=false');
      if (ctx.engineName !== 'native') reasons.push(`engineName=${ctx.engineName}`);
      if (!ctx.incremental) reasons.push('incremental=false');
      if (ctx.forceFullRebuild) reasons.push('forceFullRebuild=true');
      if ((ctx.opts as Record<string, unknown>).scope) reasons.push('scope=set');
      if (reasons.length > 0) {
        info(`[fast-skip] false: pre-flight gate skipped — ${reasons.join(', ')}`);
      }
    }
    if (
      ctx.nativeAvailable &&
      ctx.engineName === 'native' &&
      ctx.incremental &&
      !ctx.forceFullRebuild &&
      !(ctx.opts as Record<string, unknown>).scope
    ) {
      try {
        await collectFiles(ctx);
        if (
          detectNoChanges(ctx.db, ctx.allFiles, ctx.rootDir, ctx.opts as Record<string, unknown>)
        ) {
          info('No changes detected. Graph is up to date.');
          writeJournalHeader(ctx.rootDir, Date.now());
          closeDb(ctx.db);
          return;
        }
      } catch (err) {
        // Pre-flight is best-effort — any failure falls through to the
        // orchestrator, which performs its own complete detection.
        // Reset ctx.allFiles so runPipelineStages re-collects under its own
        // engine state if we ended up partially populated before throwing.
        ctx.allFiles = undefined as unknown as string[];
        ctx.discoveredDirs = undefined as unknown as Set<string>;
        debug(`native fast-skip pre-flight failed: ${toErrorMessage(err)}`);
      }
    }

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
