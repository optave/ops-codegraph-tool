/**
 * Native build orchestrator stage — runs the full Rust pipeline when available,
 * with WASM fallback for files the native engine drops.
 *
 * Extracted from `pipeline.ts` to break the name-collision cycle between
 * `buildGraph()` (this module's caller) and `ctx.nativeDb.buildGraph()` (the
 * Rust orchestrator entry point invoked here). Codegraph's name-based call
 * resolver previously conflated the two and reported a false-positive
 * function-level cycle (`buildGraph ↔ tryNativeOrchestrator`).
 *
 * The orchestrator-selection strategy lives here so `pipeline.ts` stays a thin
 * top-level controller: detect changes, try native, fall back to JS stages.
 */
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  acquireAdvisoryLock,
  closeDbPair,
  openDb,
  purgeFilesData,
  releaseAdvisoryLock,
  setBuildMeta,
} from '../../../../db/index.js';
import { debug, info, warn } from '../../../../infrastructure/logger.js';
import { loadNative } from '../../../../infrastructure/native.js';
import { semverCompare } from '../../../../infrastructure/update-check.js';
import { normalizePath } from '../../../../shared/constants.js';
import { toErrorMessage } from '../../../../shared/errors.js';
import { CODEGRAPH_VERSION } from '../../../../shared/version.js';
import type {
  BetterSqlite3Database,
  BuildResult,
  Definition,
  ExtractorOutput,
  SqliteStatement,
} from '../../../../types.js';
import {
  classifyNativeDrops,
  formatDropExtensionSummary,
  getInstalledWasmExtensions,
  NATIVE_SUPPORTED_EXTENSIONS,
  parseFilesWasmForBackfill,
} from '../../../parser.js';
import { computeConfidence } from '../../resolve.js';
import type { CallNodeLookup } from '../call-resolver.js';
import type { ChaContext } from '../cha.js';
import { resolveThisDispatch } from '../cha.js';
import type { PipelineContext } from '../context.js';
import {
  batchInsertEdges,
  batchInsertNodes,
  CHA_DISPATCH_PENALTY,
  CHA_TYPED_DISPATCH_CONFIDENCE,
  collectFiles as collectFilesUtil,
  fileHash,
  fileStat,
  readFileSafe,
} from '../helpers.js';
import { NativeDbProxy } from '../native-db-proxy.js';
import { closeNativeDb } from './native-db-lifecycle.js';

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

/** Files the native orchestrator silently dropped — the working set for backfill. */
interface DroppedLanguageGap {
  /** Relative paths (normalized) of files missing from `nodes` or `file_hashes`. */
  missingRel: string[];
  /** Absolute paths, aligned by index with `missingRel`. */
  missingAbs: string[];
  /**
   * Relative paths of WASM-only files present in DB but absent from disk (#1073).
   * Rust's `detect_removed_files` filter (#1070) skips these, so the JS-side
   * backfill must purge them. Always disjoint from `missingRel`.
   */
  staleRel: string[];
}

/**
 * Inputs to {@link computeWasmOnlyStaleFiles}. Sets are passed in so the helper
 * is pure and unit-testable independently of `getInstalledWasmExtensions` and
 * the `NATIVE_SUPPORTED_EXTENSIONS` global state.
 */
export interface WasmOnlyStaleFilesInput {
  /** Distinct `file` values from the `nodes` table. */
  existingNodes: ReadonlySet<string>;
  /** Distinct `file` values from the `file_hashes` table. */
  existingHashes: ReadonlySet<string>;
  /** Relative paths currently on disk (from `collectFilesUtil`). */
  expected: ReadonlySet<string>;
  /** Lowercased extensions whose WASM grammar is installed. */
  installedExts: ReadonlySet<string>;
  /** Extensions covered by the Rust addon — Rust owns deletion for these. */
  nativeSupported: ReadonlySet<string>;
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
      '../../../../features/structure.js'
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
    const { runAnalyses: runAnalysesFn } = (await import('../../../../ast-analysis/engine.js')) as {
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

/**
 * Phase 8.5: CHA expansion post-pass for the native orchestrator path.
 *
 * The Rust build pipeline resolves typed receiver calls (e.g. `worker.doWork()`
 * where `worker: IWorker`) to the interface method declaration only.  This
 * post-pass reads the class hierarchy (via `implements`/`extends` edges) and
 * instantiated types (via `calls` edges to class nodes) from the DB and expands
 * each call to an interface/abstract method to ALL RTA-filtered concrete
 * implementations.
 *
 * Note: `this`/`super` dispatch is handled separately by `runPostNativeThisDispatch`,
 * which WASM-re-parses JS/TS files to obtain raw call site receiver info.
 *
 * `changedFiles` controls candidate scoping on incremental builds:
 *   - null  → full build; scan all call→method edges (existing behaviour).
 *   - array → incremental; two cheap gate queries decide scope:
 *       Gate A: any class/interface/trait/struct/record nodes in changed files?
 *               If yes, a new implementor may have appeared — full scan required.
 *       Gate B: any `calls` edges from changed-file sources targeting
 *               class/constructor/function-kind nodes? If yes, the RTA set may
 *               have grown (also covers the older-schema fallback where
 *               constructor calls target `constructor`/`function` nodes instead
 *               of `class` nodes) — full scan required.
 *       If neither gate fires: scope `callToMethods` to `src.file IN changedFiles`
 *       (safe because no hierarchy or RTA evidence changed).
 *
 * Returns the count of newly inserted CHA edges plus the set of files containing
 * the new edges' endpoints, so the caller can scope role re-classification to the
 * nodes whose fan-in/out actually changed. A zero count means no edges were added
 * and role re-classification is unnecessary.
 */
function runPostNativeCha(
  db: BetterSqlite3Database,
  changedFiles: string[] | null,
): {
  newEdgeCount: number;
  affectedFiles: Set<string>;
} {
  const affectedFiles = new Set<string>();
  const empty = { newEdgeCount: 0, affectedFiles };
  // Fast guard: no hierarchy edges → no CHA work
  const hasHierarchy = db
    .prepare(`SELECT 1 FROM edges WHERE kind IN ('extends', 'implements') LIMIT 1`)
    .get();
  if (!hasHierarchy) return empty;

  // Build implementors map: parent/interface name → [child/implementing class names]
  const hierarchyRows = db
    .prepare(`
      SELECT src.name AS child_name, tgt.name AS parent_name
      FROM edges e
      JOIN nodes src ON e.source_id = src.id
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind IN ('extends', 'implements')
    `)
    .all() as Array<{ child_name: string; parent_name: string }>;

  const implementors = new Map<string, string[]>();
  for (const row of hierarchyRows) {
    let list = implementors.get(row.parent_name);
    if (!list) {
      list = [];
      implementors.set(row.parent_name, list);
    }
    if (!list.includes(row.child_name)) list.push(row.child_name);
  }
  if (implementors.size === 0) return empty;

  // RTA: collect class names that are actually instantiated via `new X()`.
  // Primary query targets `class`-kind nodes (the canonical schema).
  // Fallback also matches `constructor`/`function`-kind nodes because some native
  // engine versions record constructor calls against those kinds instead of `class`.
  let rtaRows = db
    .prepare(`
      SELECT DISTINCT tgt.name
      FROM edges e
      JOIN nodes tgt ON e.target_id = tgt.id
      WHERE e.kind = 'calls' AND tgt.kind = 'class'
    `)
    .all() as Array<{ name: string }>;
  if (rtaRows.length === 0) {
    // Fallback: try constructor/function-kind nodes for older native engine schemas
    rtaRows = db
      .prepare(`
        SELECT DISTINCT tgt.name
        FROM edges e
        JOIN nodes tgt ON e.target_id = tgt.id
        WHERE e.kind = 'calls' AND tgt.kind IN ('constructor', 'function')
        AND INSTR(tgt.name, '.') = 0
      `)
      .all() as Array<{ name: string }>;
  }
  const instantiated = new Set(rtaRows.map((r) => r.name));
  // noRtaEvidence: true when no constructor-call evidence exists in the DB (e.g. graph
  // built by an older native engine that doesn't emit constructor call edges at all).
  // In that case we skip RTA filtering so interface dispatch still produces edges —
  // all instantiated implementors are admitted rather than silently dropping everything.
  const noRtaEvidence = instantiated.size === 0;
  if (noRtaEvidence) {
    debug('runPostNativeCha: no constructor-call evidence found — proceeding without RTA filter');
  }

  // ── Incremental candidate scoping ──────────────────────────────────────────
  // On incremental builds, two gate queries decide whether to restrict the
  // candidate scan to changed-file call sites or run the full graph scan.
  //
  // Gate A: did a changed file add/change a class hierarchy node?
  //   A new `extends`/`implements` edge means a previously-untracked implementor
  //   is now in the hierarchy — unchanged call sites in OTHER files may gain new
  //   valid expansions, so the full scan is required.
  //   Note: *removed* class nodes are safe — Rust's `purge_changed_files` runs
  //   before this post-pass and deletes stale nodes and their hierarchy edges, so
  //   Gate A queries the post-purge DB. A deleted class returns no row here, which
  //   is correct: its stale CHA edges were already cleaned up by the Rust purge.
  //
  // Gate B: did a changed file add new RTA evidence (`new ConcreteX()`)?
  //   A new `calls` edge to a class/constructor/function-kind target means the
  //   instantiated set grew — previously RTA-filtered expansions in unchanged
  //   caller files become admissible, so the full scan is required.
  //   (`constructor`/`function` cover the older native engine fallback schema.)
  //
  // If neither gate fires, the hierarchy and RTA set are unchanged for all files
  // outside changedFiles, so restricting to changed-file sources is safe.
  let scopeToChangedFiles = false; // true → add WHERE src.file IN changedFiles
  if (changedFiles !== null && changedFiles.length > 0) {
    // Gate A: class/interface/trait/struct/record nodes in changed files?
    const CHUNK_SIZE = 500;
    let gateAFired = false;
    for (let i = 0; i < changedFiles.length && !gateAFired; i += CHUNK_SIZE) {
      const chunk = changedFiles.slice(i, i + CHUNK_SIZE);
      const ph = chunk.map(() => '?').join(',');
      const row = db
        .prepare(
          `SELECT 1 FROM nodes
           WHERE file IN (${ph})
           AND kind IN ('class', 'interface', 'trait', 'struct', 'record')
           LIMIT 1`,
        )
        .get(...chunk);
      if (row) gateAFired = true;
    }

    // Gate B: calls from changed-file sources to class/instantiable-kind targets
    // (also covers older-schema fallback and future CHA extensions to struct/record).
    // Includes class/interface/trait/struct/record (future CHA extension safety) and
    // constructor/function (older native engine schema fallback).
    let gateBFired = false;
    if (!gateAFired) {
      for (let i = 0; i < changedFiles.length && !gateBFired; i += CHUNK_SIZE) {
        const chunk = changedFiles.slice(i, i + CHUNK_SIZE);
        const ph = chunk.map(() => '?').join(',');
        const row = db
          .prepare(
            `SELECT 1 FROM edges e
             JOIN nodes src ON e.source_id = src.id
             JOIN nodes tgt ON e.target_id = tgt.id
             WHERE e.kind = 'calls'
             AND tgt.kind IN ('class', 'interface', 'trait', 'struct', 'record', 'constructor', 'function')
             AND src.file IN (${ph})
             LIMIT 1`,
          )
          .get(...chunk);
        if (row) gateBFired = true;
      }
    }

    if (!gateAFired && !gateBFired) {
      scopeToChangedFiles = true;
      debug(
        `runPostNativeCha: neither gate fired — scoping candidate scan to ${changedFiles.length} changed file(s)`,
      );
    } else {
      debug(
        `runPostNativeCha: ${gateAFired ? 'Gate A (hierarchy)' : 'Gate B (RTA)'} fired — running full scan`,
      );
    }
  }

  // Find existing call edges targeting qualified methods (e.g., 'IWorker.doWork').
  // Include caller_file and method_file so affectedFiles can be populated for
  // incremental role reclassification; confidence uses CHA_TYPED_DISPATCH_CONFIDENCE matching runChaPostPass.
  // When scopeToChangedFiles is true, restrict to call sites in the changed files
  // (safe because no hierarchy or RTA evidence changed outside those files).
  let callToMethods: Array<{ source_id: number; method_name: string; caller_file: string | null }>;
  if (scopeToChangedFiles && changedFiles && changedFiles.length > 0) {
    const CHUNK_SIZE = 500;
    const rows: Array<{ source_id: number; method_name: string; caller_file: string | null }> = [];
    for (let i = 0; i < changedFiles.length; i += CHUNK_SIZE) {
      const chunk = changedFiles.slice(i, i + CHUNK_SIZE);
      const ph = chunk.map(() => '?').join(',');
      const chunkRows = db
        .prepare(
          `SELECT e.source_id, tgt.name AS method_name, src.file AS caller_file
           FROM edges e
           JOIN nodes tgt ON e.target_id = tgt.id
           JOIN nodes src ON e.source_id = src.id
           WHERE e.kind = 'calls' AND tgt.kind = 'method'
           AND INSTR(tgt.name, '.') > 0
           AND (e.technique IS NULL OR e.technique != 'cha')
           AND src.file IN (${ph})`,
        )
        .all(...chunk) as Array<{
        source_id: number;
        method_name: string;
        caller_file: string | null;
      }>;
      rows.push(...chunkRows);
    }
    callToMethods = rows;
  } else {
    callToMethods = db
      .prepare(`
        SELECT e.source_id, tgt.name AS method_name, src.file AS caller_file
        FROM edges e
        JOIN nodes tgt ON e.target_id = tgt.id
        JOIN nodes src ON e.source_id = src.id
        WHERE e.kind = 'calls' AND tgt.kind = 'method'
        AND INSTR(tgt.name, '.') > 0
        AND (e.technique IS NULL OR e.technique != 'cha')
      `)
      .all() as Array<{ source_id: number; method_name: string; caller_file: string | null }>;
  }

  // Seed seen-pairs only from the source_ids we'll be expanding — avoids loading every
  // call edge in the DB (which would be O(all edges)) for large codebases.
  const seen = new Set<string>();
  if (callToMethods.length > 0) {
    const sourceIds = [...new Set(callToMethods.map((r) => r.source_id))];
    const CHUNK_SIZE = 500;
    for (let i = 0; i < sourceIds.length; i += CHUNK_SIZE) {
      const chunk = sourceIds.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const existingPairs = db
        .prepare(
          `SELECT source_id, target_id FROM edges WHERE kind = 'calls' AND source_id IN (${placeholders})`,
        )
        .all(...chunk) as Array<{ source_id: number; target_id: number }>;
      for (const e of existingPairs) seen.add(`${e.source_id}|${e.target_id}`);
    }
  }

  // No LIMIT: multiple files can define the same qualified name in a monorepo.
  const findMethodStmt = db.prepare(
    `SELECT id, file AS method_file FROM nodes WHERE name = ? AND kind = 'method'`,
  );
  const newEdges: Array<[number, number, string, number, number, string]> = [];
  let newEdgeCount = 0;

  for (const { source_id, method_name, caller_file } of callToMethods) {
    const dotIdx = method_name.indexOf('.');
    if (dotIdx === -1) continue;
    const typeName = method_name.slice(0, dotIdx);
    const methodSuffix = method_name.slice(dotIdx + 1);

    // BFS over the implementors map — handles multi-level hierarchies where
    // abstract/non-instantiated classes sit between the call-site type and
    // the concrete leaf implementations (issue #1311).
    const bfsQueue: string[] = [typeName];
    const bfsVisited = new Set<string>([typeName]);
    while (bfsQueue.length > 0) {
      const current = bfsQueue.shift()!;
      const children = implementors.get(current);
      if (!children?.length) continue;

      for (const cls of children) {
        if (bfsVisited.has(cls)) continue;
        bfsVisited.add(cls);

        if (noRtaEvidence || instantiated.has(cls)) {
          const qualifiedName = `${cls}.${methodSuffix}`;
          const methodNodes = findMethodStmt.all(qualifiedName) as Array<{
            id: number;
            method_file: string | null;
          }>;
          for (const methodNode of methodNodes) {
            if (methodNode.id === source_id) continue; // skip self-loops
            const key = `${source_id}|${methodNode.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const conf = CHA_TYPED_DISPATCH_CONFIDENCE;
            newEdges.push([source_id, methodNode.id, 'calls', conf, 0, 'cha']);
            newEdgeCount++;
            if (caller_file) affectedFiles.add(caller_file);
            if (methodNode.method_file) affectedFiles.add(methodNode.method_file);
          }
        }

        // Always traverse children — non-instantiated classes may have instantiated subclasses.
        bfsQueue.push(cls);
      }
    }
  }

  if (newEdges.length > 0) {
    db.transaction(() => batchInsertEdges(db, newEdges))();
    // Account for post-pass edges excluded from the build summary line (#1452),
    // mirroring the this/super dispatch post-pass insertion log.
    debug(`CHA expansion post-pass: inserted ${newEdgeCount} edge(s)`);
  }
  return { newEdgeCount, affectedFiles };
}

// Extensions where `this`/`super` dispatch can occur (JS/TS family)
const THIS_DISPATCH_EXTS = new Set(['.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);

/**
 * Phase 8.5: this/super dispatch post-pass for the native orchestrator path.
 *
 * The Rust build pipeline resolves typed receiver calls but does NOT persist raw
 * unresolved call site receiver info (e.g. `this`, `super`) to the DB. This
 * hybrid post-pass re-parses JS/TS/TSX files via WASM to collect call sites with
 * `this`/`super` receivers, then resolves them through the class hierarchy stored
 * in DB `extends` edges — mirroring what `buildChaPostPass` does on the WASM path.
 *
 * Also handles function-as-object-property methods (`f.h = function() { this.g() }`):
 * these use `this` to reference sibling properties on the same object (`f`), so
 * `resolveThisDispatch` resolves them by treating the dot-prefix of the caller name
 * (`f` from `f.h`) as the class and looking up `f.g` directly — no `extends` edge needed.
 *
 * Runs when either `extends` edges exist (class inheritance) OR dot-named `method`
 * nodes exist (func-prop assignments); skips only when neither is present.
 */
async function runPostNativeThisDispatch(
  db: BetterSqlite3Database,
  rootDir: string,
  changedFiles: string[] | undefined,
  isFullBuild: boolean,
): Promise<{ elapsedMs: number; targetIds: Set<number>; affectedFiles: Set<string> }> {
  const t0 = performance.now();
  const targetIds = new Set<number>();
  // Files containing endpoints of newly inserted edges — lets the caller scope
  // role re-classification to the nodes whose fan-in/out actually changed.
  const affectedFiles = new Set<string>();

  // Fast guard: need at least one extends edge (class inheritance) OR a dot-named
  // method node (func-prop assignment: `f.h = function() { this.g() }`) for
  // this/super dispatch to produce any edges.
  const hasExtends = db.prepare(`SELECT 1 FROM edges WHERE kind = 'extends' LIMIT 1`).get();
  const hasFuncPropMethod = db
    .prepare(`SELECT 1 FROM nodes WHERE kind = 'method' AND INSTR(name, '.') > 0 LIMIT 1`)
    .get();
  if (!hasExtends && !hasFuncPropMethod) return { elapsedMs: 0, targetIds, affectedFiles };

  // Build parents map: child class → direct parent class (from `extends` edges).
  // May be empty when only func-prop methods exist (no class inheritance) —
  // resolveThisDispatch handles that case via direct class-prefix lookup.
  const parentRows = hasExtends
    ? (db
        .prepare(`
          SELECT src.name AS child_name, tgt.name AS parent_name
          FROM edges e
          JOIN nodes src ON e.source_id = src.id
          JOIN nodes tgt ON e.target_id = tgt.id
          WHERE e.kind = 'extends'
        `)
        .all() as Array<{ child_name: string; parent_name: string }>)
    : [];

  const parents = new Map<string, string>();
  for (const row of parentRows) {
    if (!parents.has(row.child_name)) parents.set(row.child_name, row.parent_name);
  }
  // Note: parents may be empty when hasFuncPropMethod but !hasExtends — that is
  // intentional. resolveThisDispatch still resolves `this.g()` inside `f.h` by
  // treating `f` (the dot-prefix of callerName `f.h`) as the class and looking
  // up `f.g` directly via lookup.byName(), without traversing the parents chain.

  const chaCtx: ChaContext = {
    implementors: new Map(), // not needed for this/super resolution
    parents,
    instantiatedTypes: new Set(), // not needed for this/super resolution
  };

  // Determine which files to re-parse.
  //
  // On a full build we do NOT re-parse every JS/TS file — that would WASM-parse
  // the entire project on top of the native pass, causing a massive regression
  // (measured: +358% ms/file on codegraph itself). Instead we restrict to files
  // that are part of the class inheritance hierarchy (both subclass files with
  // `super.X()` calls and parent-class files with `this.X()` calls) OR that
  // contain dot-named method nodes (func-prop assignments whose bodies may call
  // `this.sibling()`). Any file not in either set has no class or object context
  // where `this`/`super` dispatch would produce new edges.
  let relFiles: string[];
  if (isFullBuild || !changedFiles) {
    const rows = db
      .prepare(`
        SELECT DISTINCT file FROM (
          SELECT src.file AS file
          FROM edges e
          JOIN nodes src ON e.source_id = src.id
          WHERE e.kind = 'extends' AND src.file IS NOT NULL
          UNION
          SELECT tgt.file AS file
          FROM edges e
          JOIN nodes tgt ON e.target_id = tgt.id
          WHERE e.kind = 'extends' AND tgt.file IS NOT NULL
          UNION
          -- Files with func-prop method definitions (e.g. f.h = function(){this.g()}).
          -- Only include files where the method's owner prefix is NOT a known class name —
          -- this keeps the re-parse set small (func-prop files only, not all class-method files).
          -- AND name IS NOT NULL guards the NOT IN sub-select: if any class node had a NULL
          -- name the entire NOT IN clause would silently return no rows (SQL NULL semantics).
          SELECT n.file AS file
          FROM nodes n
          WHERE n.kind = 'method'
          AND INSTR(n.name, '.') > 0
          AND n.file IS NOT NULL
          AND SUBSTR(n.name, 1, INSTR(n.name, '.') - 1) NOT IN (
            SELECT name FROM nodes WHERE kind IN ('class', 'struct', 'interface', 'type')
            AND name IS NOT NULL
          )
        )
      `)
      .all() as Array<{ file: string }>;
    relFiles = rows
      .map((r) => r.file)
      .filter((f) => THIS_DISPATCH_EXTS.has(path.extname(f).toLowerCase()));
  } else {
    // NOTE: Only files explicitly listed in changedFiles are re-parsed.
    // If a parent-class method is replaced (new node ID) but the child file is
    // unchanged, the stale super.method() edge is not refreshed here. A full
    // rebuild (isFullBuild=true) is required to recover in that scenario.
    relFiles = changedFiles.filter((f) => THIS_DISPATCH_EXTS.has(path.extname(f).toLowerCase()));
  }
  if (relFiles.length === 0) return { elapsedMs: 0, targetIds, affectedFiles };

  // DB-backed CallNodeLookup — resolveThisDispatch only calls byName()
  const findByNameStmt = db.prepare(`SELECT id, file, kind FROM nodes WHERE name = ?`);
  const lookup: CallNodeLookup = {
    byName: (name) => findByNameStmt.all(name) as Array<{ id: number; file: string; kind: string }>,
    byNameAndFile: (name, file) =>
      (findByNameStmt.all(name) as Array<{ id: number; file: string; kind: string }>).filter(
        (n) => n.file === file,
      ),
    isBarrel: () => false,
    resolveBarrel: () => null,
    nodeId: () => undefined,
  };

  // Seed seen-pairs from existing call edges on source nodes in our file set
  const seen = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < relFiles.length; i += CHUNK) {
    const chunk = relFiles.slice(i, i + CHUNK);
    const ph = chunk.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT e.source_id, e.target_id
         FROM edges e
         JOIN nodes n ON e.source_id = n.id
         WHERE e.kind = 'calls' AND n.file IN (${ph})`,
      )
      .all(...chunk) as Array<{ source_id: number; target_id: number }>;
    for (const r of rows) seen.add(`${r.source_id}|${r.target_id}`);
  }

  // Find the innermost containing method/function for a call at `line` in `file`.
  // COALESCE maps NULL end_line to a large sentinel so unbounded nodes sort last
  // (SQLite ASC orders NULLs first, so a raw `end_line - line` would pick them first).
  const findCallerByLineStmt = db.prepare(`
    SELECT id, name FROM nodes
    WHERE file = ? AND kind IN ('method', 'function')
    AND line <= ? AND (end_line IS NULL OR end_line >= ?)
    ORDER BY COALESCE(end_line - line, 999999999) ASC
    LIMIT 1
  `);

  // Re-parse the files to obtain raw call sites with receiver info. Only
  // `calls` (with receivers) are consumed here.
  //
  // The native engine is preferred: this pass only runs after a native
  // orchestrator build, so the addon is already loaded and re-parses the
  // hierarchy file set in single-digit milliseconds with the same
  // receiver-annotated call sites as the WASM extractor. Booting the WASM
  // runtime here instead cost ~40–110ms per full build (in-process
  // web-tree-sitter + grammar init dominated) — part of the v3.12.0
  // publish-gate regression. Files the native engine cannot parse (extension
  // outside NATIVE_SUPPORTED_EXTENSIONS, e.g. .mts/.cts) and native parse
  // failures fall back to the WASM backfill path so the sweep stays complete.
  const absFiles = relFiles.map((f) => path.join(rootDir, f));
  const nativeAbs = absFiles.filter((f) =>
    NATIVE_SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase()),
  );
  const callsByRel = new Map<string, { name: string; receiver?: string; line: number }[]>();
  // Track native-supported files that returned null (per-file parse error) so
  // they can be included in the WASM fallback set below, ensuring no file's
  // this/super call sites are silently discarded.
  const nativeNullFiles = new Set<string>();
  let nativeParsed = false;
  if (nativeAbs.length > 0) {
    const native = loadNative();
    if (native) {
      try {
        const results = native.parseFiles(nativeAbs, rootDir, false, false) as Array<{
          file: string;
          calls?: { name: string; receiver?: string; line: number }[];
        } | null>;
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (!r) {
            // Per-file parse failure — fall back to WASM for this file.
            const abs = nativeAbs[i];
            if (abs) nativeNullFiles.add(abs);
            continue;
          }
          callsByRel.set(normalizePath(path.relative(rootDir, r.file)), r.calls ?? []);
        }
        nativeParsed = true;
      } catch (e) {
        debug(`this-dispatch native re-parse failed, falling back to WASM: ${toErrorMessage(e)}`);
      }
    }
  }
  // WASM handles: (a) non-native extensions (e.g. .mts/.cts), (b) the entire
  // file list when the native batch threw, and (c) individual files where the
  // native addon returned null (per-file parse error).
  const wasmAbs = nativeParsed
    ? [
        ...absFiles.filter((f) => !NATIVE_SUPPORTED_EXTENSIONS.has(path.extname(f).toLowerCase())),
        ...nativeNullFiles,
      ]
    : absFiles;
  const wasmResults =
    wasmAbs.length > 0
      ? await parseFilesWasmForBackfill(wasmAbs, rootDir, { symbolsOnly: true })
      : new Map<string, ExtractorOutput>();
  for (const [relPath, symbols] of wasmResults) {
    callsByRel.set(relPath, symbols.calls ?? []);
  }

  const newEdges: Array<[number, number, string, number, number, string]> = [];

  for (const [relPath, calls] of callsByRel) {
    for (const call of calls) {
      // Only 'this' and 'super' are class-instance receivers in JS/TS.
      // 'self' refers to WindowOrWorkerGlobalScope — not a class instance — so
      // filtering it here prevents spurious dispatch edges from Worker call sites.
      if (call.receiver !== 'this' && call.receiver !== 'super') continue;

      const callerRow = findCallerByLineStmt.get(relPath, call.line, call.line) as
        | { id: number; name: string }
        | undefined;
      if (!callerRow) continue;

      const targets = resolveThisDispatch(
        call.name,
        callerRow.name,
        call.receiver as 'this' | 'super',
        chaCtx,
        lookup,
        relPath,
      );

      for (const t of targets) {
        if (t.id === callerRow.id) continue; // skip self-loops
        const key = `${callerRow.id}|${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const conf = computeConfidence(relPath, t.file, null) - CHA_DISPATCH_PENALTY;
        if (conf <= 0) continue;
        newEdges.push([callerRow.id, t.id, 'calls', conf, 0, 'cha']);
        targetIds.add(t.id);
        affectedFiles.add(relPath);
        if (t.file) affectedFiles.add(t.file);
      }
    }
  }

  if (newEdges.length > 0) {
    db.transaction(() => batchInsertEdges(db, newEdges))();
    debug(`this/super dispatch post-pass: inserted ${newEdges.length} edge(s)`);
  }

  // Free WASM parse trees — mirrors the cleanup in backfillNativeDroppedFiles
  for (const [, symbols] of wasmResults) {
    const tree = (symbols as { _tree?: { delete?: () => void } })._tree;
    if (tree && typeof tree.delete === 'function') {
      try {
        tree.delete();
      } catch {
        /* ignore cleanup errors */
      }
    }
    (symbols as { _tree?: unknown; _langId?: unknown })._tree = undefined;
    (symbols as { _tree?: unknown; _langId?: unknown })._langId = undefined;
  }

  return { elapsedMs: performance.now() - t0, targetIds, affectedFiles };
}

interface PostPassTimings {
  gapDetectMs: number;
  chaMs: number;
  thisDispatchMs: number;
  reclassifyMs: number;
  techniqueBackfillMs: number;
}

/** Format timing result from native orchestrator phases + JS post-processing. */
function formatNativeTimingResult(
  p: Record<string, number>,
  structurePatchMs: number,
  analysisTiming: { astMs: number; complexityMs: number; cfgMs: number; dataflowMs: number },
  postPass: PostPassTimings,
): BuildResult {
  return {
    phases: {
      setupMs: +(p.setupMs ?? 0).toFixed(1),
      collectMs: +(p.collectMs ?? 0).toFixed(1),
      detectMs: +(p.detectMs ?? 0).toFixed(1),
      parseMs: +(p.parseMs ?? 0).toFixed(1),
      insertMs: +(p.insertMs ?? 0).toFixed(1),
      resolveMs: +(p.resolveMs ?? 0).toFixed(1),
      edgesMs: +(p.edgesMs ?? 0).toFixed(1),
      structureMs: +((p.structureMs ?? 0) + structurePatchMs).toFixed(1),
      rolesMs: +(p.rolesMs ?? 0).toFixed(1),
      gapDetectMs: +postPass.gapDetectMs.toFixed(1),
      chaMs: +postPass.chaMs.toFixed(1),
      thisDispatchMs: +postPass.thisDispatchMs.toFixed(1),
      reclassifyMs: +postPass.reclassifyMs.toFixed(1),
      techniqueBackfillMs: +postPass.techniqueBackfillMs.toFixed(1),
      astMs: +(analysisTiming.astMs ?? 0).toFixed(1),
      complexityMs: +(analysisTiming.complexityMs ?? 0).toFixed(1),
      cfgMs: +(analysisTiming.cfgMs ?? 0).toFixed(1),
      dataflowMs: +(analysisTiming.dataflowMs ?? 0).toFixed(1),
      finalizeMs: +(p.finalizeMs ?? 0).toFixed(1),
    },
  };
}

/**
 * Compute the WASM-only files present in the DB but missing from disk (#1073).
 *
 * Returns relative paths that:
 *   - appear in `existingNodes` or `existingHashes` (in DB),
 *   - are absent from `expected` (not on disk),
 *   - have an extension installed for WASM, AND
 *   - have an extension NOT covered by `nativeSupported` — Rust's
 *     `purge_changed_files` handles deletion for natively-supported extensions
 *     via its own `detect_removed_files`, so the caller must not double-purge.
 *
 * Extensions are lowercased before lookup to match the registry and Rust's
 * `LanguageKind::from_extension` (which normalises case for the languages
 * where both cases are conventional, e.g. R's `.r` / `.R`).
 *
 * DB paths are forced to forward slashes before comparison with `expected`
 * (which is always normalised). The on-disk invariant is that DB rows are
 * written with forward slashes, but a stale row written by older code on
 * Windows could carry back-slashes — normalising here makes the comparison
 * platform-safe and prevents false-positive purges of live rows. We replace
 * `\\` explicitly (rather than calling `normalizePath`, which only touches
 * `path.sep`) so the defence works when running on POSIX against a DB that
 * was migrated from Windows.
 *
 * Exported for unit testing.
 */
export function computeWasmOnlyStaleFiles(input: WasmOnlyStaleFilesInput): string[] {
  const { existingNodes, existingHashes, expected, installedExts, nativeSupported } = input;
  const stale: string[] = [];
  const seen = new Set<string>();
  const consider = (rawRel: string): void => {
    const rel = rawRel.replace(/\\/g, '/');
    if (expected.has(rel) || seen.has(rel)) return;
    const ext = path.extname(rel).toLowerCase();
    if (nativeSupported.has(ext)) return;
    if (!installedExts.has(ext)) return;
    seen.add(rel);
    // Push the ORIGINAL raw path (not the normalised form) so the eventual
    // `DELETE FROM nodes WHERE file = ?` predicate in `purgeFilesData`
    // matches the actual stored row. The dedup `seen` set keeps the
    // normalised form so a file written once with `\` and once with `/`
    // is still treated as one entry — but the value the SQL sees has to
    // be byte-identical to what's on disk in the DB.
    stale.push(rawRel);
  };
  for (const rel of existingNodes) consider(rel);
  for (const rel of existingHashes) consider(rel);
  return stale;
}

/**
 * Group relative paths by their lowercased extension. Shape matches the bucket
 * type that `formatDropExtensionSummary` consumes, so callers can render a
 * log-friendly per-extension summary without going through `classifyNativeDrops`
 * when the reason is already known (e.g. the stale-purge path where every path
 * is guaranteed `unsupported-by-native`).
 */
function groupByExtension(relPaths: Iterable<string>): Map<string, string[]> {
  const buckets = new Map<string, string[]>();
  for (const rel of relPaths) {
    const ext = path.extname(rel).toLowerCase();
    let list = buckets.get(ext);
    if (!list) {
      list = [];
      buckets.set(ext, list);
    }
    list.push(rel);
  }
  return buckets;
}

/**
 * Detect files the native orchestrator silently dropped.
 *
 * Walks the filesystem and compares against `nodes` + `file_hashes`. A file
 * is "missing" if it's absent from EITHER table — both must be present for
 * the fast-skip pre-flight (#1054) to work, and the two can diverge (e.g.
 * legacy DBs where `nodes` was populated but `file_hashes` was not).
 *
 * Restricted to files with an installed WASM grammar; extensions in
 * `LANGUAGE_REGISTRY` without a shipped grammar (e.g. groovy on minimal
 * installs) can't be parsed by either engine, so they're not a native
 * regression — excluding them keeps the warn count in
 * `backfillNativeDroppedFiles` meaningful.
 *
 * Also detects WASM-only files deleted from disk (#1073). Rust's
 * `detect_removed_files` filter (#1070) skips files outside its supported
 * extensions, so deletions of WASM-only languages don't reach the native
 * purge path; the rest of the backfill only inserts rows, so without this
 * step stale `nodes`/`file_hashes` rows would linger across incremental
 * rebuilds until the next full rebuild.
 *
 * Cheap (no DB handoff, no parsing): used both to gate the backfill call
 * and as its working set. NativeDbProxy supports `.prepare().all()`, so
 * this works whether `ctx.db` is a proxy or a real better-sqlite3
 * connection — letting us skip the close-native / reopen-better-sqlite3
 * cost when there's nothing to backfill.
 */
function detectDroppedLanguageGap(ctx: PipelineContext): DroppedLanguageGap {
  const collected = collectFilesUtil(ctx.rootDir, [], ctx.config, new Set<string>());
  const expected = new Set(
    collected.files.map((f) => normalizePath(path.relative(ctx.rootDir, f))),
  );

  const existingNodeRows = ctx.db
    .prepare("SELECT DISTINCT file FROM nodes WHERE kind = 'file'")
    .all() as Array<{ file: string }>;
  const existingNodes = new Set(existingNodeRows.map((r) => r.file));

  let existingHashes = new Set<string>();
  try {
    const existingHashRows = ctx.db
      .prepare('SELECT DISTINCT file FROM file_hashes')
      .all() as Array<{ file: string }>;
    existingHashes = new Set(existingHashRows.map((r) => r.file));
  } catch (e) {
    // file_hashes table may not exist on legacy DBs; treat as fully missing
    // so the backfill writes rows on the upsert path below.
    debug(
      `detectDroppedLanguageGap: file_hashes read failed (table may not exist): ${toErrorMessage(e)}`,
    );
  }

  const installedExts = getInstalledWasmExtensions();
  const missingRel: string[] = [];
  const missingAbs: string[] = [];
  for (const rel of expected) {
    if (existingNodes.has(rel) && existingHashes.has(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (!installedExts.has(ext)) continue;
    missingRel.push(rel);
    missingAbs.push(path.join(ctx.rootDir, rel));
  }

  const staleRel = computeWasmOnlyStaleFiles({
    existingNodes,
    existingHashes,
    expected,
    installedExts,
    nativeSupported: NATIVE_SUPPORTED_EXTENSIONS,
  });

  return { missingRel, missingAbs, staleRel };
}

/**
 * Backfill files that the native orchestrator silently dropped during parse.
 * Falls back to WASM + inserts file/symbol nodes so engine counts match (#967).
 *
 * Also purges stale rows for WASM-only files deleted from disk (#1073), which
 * Rust's `detect_removed_files` filter (#1070) skips.
 *
 * Accepts a pre-computed `gap` from `detectDroppedLanguageGap` so the caller
 * can use the same scan for both gating and the actual backfill — avoiding
 * a redundant fs walk when the orchestrator's signals already triggered.
 */
async function backfillNativeDroppedFiles(
  ctx: PipelineContext,
  gap: DroppedLanguageGap,
): Promise<void> {
  const { missingRel, missingAbs, staleRel } = gap;
  if (missingAbs.length === 0 && staleRel.length === 0) return;

  // Now that we know there's work to do, hand off to better-sqlite3 (needed
  // for the INSERT path below).
  if (ctx.nativeFirstProxy) {
    closeNativeDb(ctx, 'pre-parity-backfill');
    ctx.db = openDb(ctx.dbPath);
    ctx.nativeFirstProxy = false;
  }

  const dbConn = ctx.db as unknown as BetterSqlite3Database;

  // Purge WASM-only files that were deleted from disk (#1073). Rust's
  // detect_removed_files skips them and the insert path below never visits
  // them, so without this their rows would persist across rebuilds until the
  // next full rebuild reset the DB.
  if (staleRel.length > 0) {
    // `computeWasmOnlyStaleFiles` guarantees every path here has an extension
    // outside NATIVE_SUPPORTED_EXTENSIONS, so `classifyNativeDrops` would
    // always bucket 100% into `unsupported-by-native`. Build the extension
    // summary directly to avoid a redundant classification pass.
    const staleByExt = groupByExtension(staleRel);
    info(
      `Detected ${staleRel.length} deleted WASM-only file(s) across ${staleByExt.size} extension(s) the native orchestrator skipped; purging stale rows:${formatDropExtensionSummary(staleByExt)}`,
    );
    purgeFilesData(dbConn, staleRel);
  }

  if (missingAbs.length === 0) return;

  // Classify drops so users see per-extension reasons instead of just a count
  // (#1011). `unsupported-by-native` is a legitimate parser limit (no Rust
  // extractor); `native-extractor-failure` indicates a real native bug since
  // the language IS supported by the addon yet the file was dropped anyway.
  const { byReason, totals } = classifyNativeDrops(missingRel);
  if (totals['unsupported-by-native'] > 0) {
    const buckets = byReason['unsupported-by-native'];
    info(
      `Native orchestrator skipped ${totals['unsupported-by-native']} file(s) across ${buckets.size} extension(s) in languages without a Rust extractor; backfilling via WASM:${formatDropExtensionSummary(buckets)}`,
    );
  }
  if (totals['native-extractor-failure'] > 0) {
    const buckets = byReason['native-extractor-failure'];
    warn(
      `Native orchestrator dropped ${totals['native-extractor-failure']} file(s) across ${buckets.size} extension(s) in natively-supported languages — likely a Rust extractor bug. Backfilling via WASM:${formatDropExtensionSummary(buckets)}`,
    );
  }
  const wasmResults = await parseFilesWasmForBackfill(missingAbs, ctx.rootDir);

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
  const db = dbConn;
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

  // Persist file_hashes rows for every backfilled file. The Rust orchestrator
  // only hashes files it parsed itself, so without this step files in
  // optional-language extensions (e.g. .clj when no Rust extractor exists)
  // would be missing from `file_hashes` — permanently breaking the JS-side
  // fast-skip pre-flight (#1054), which rejects on `collected file missing
  // from file_hashes` and forces every no-op rebuild back through the full
  // ~2s native pipeline (#1068).
  //
  // Iterates `missingRel` (every collected file the Rust orchestrator
  // dropped), not `wasmResults`, so files that produced zero symbols still
  // get a row.
  try {
    const upsertHash = db.prepare(
      'INSERT OR REPLACE INTO file_hashes (file, hash, mtime, size) VALUES (?, ?, ?, ?)',
    );
    const writeHashes = db.transaction(() => {
      for (let i = 0; i < missingRel.length; i++) {
        const relPath = missingRel[i];
        const absPath = missingAbs[i];
        if (!relPath || !absPath) continue;
        let code: string | null;
        try {
          code = readFileSafe(absPath);
        } catch (e) {
          debug(`backfillNativeDroppedFiles: read failed for ${relPath}: ${toErrorMessage(e)}`);
          continue;
        }
        if (code === null) continue;
        const stat = fileStat(absPath);
        const mtime = stat ? stat.mtime : 0;
        const size = stat ? stat.size : 0;
        upsertHash.run(relPath, fileHash(code), mtime, size);
      }
    });
    writeHashes();
  } catch (e) {
    debug(
      `backfillNativeDroppedFiles: file_hashes write failed (table may not exist): ${toErrorMessage(e)}`,
    );
  }

  // Free WASM parse trees from the inline backfill path (#1058).
  // `parseFilesWasmInline` sets `symbols._tree` (a live web-tree-sitter Tree
  // backed by WASM linear memory) on every result, but these symbols are
  // consumed locally for DB row construction and never added to
  // `ctx.allSymbols`, so the finalize-stage `releaseWasmTrees` sweep never
  // sees them. Without this, trees leak WASM memory until process exit —
  // bounded per run but cumulative across in-process integration tests.
  // Mirrors the cleanup discipline established for #931.
  for (const [, symbols] of wasmResults) {
    const tree = (symbols as { _tree?: { delete?: () => void } })._tree;
    if (tree && typeof tree.delete === 'function') {
      try {
        tree.delete();
      } catch {
        /* ignore cleanup errors */
      }
    }
    (symbols as { _tree?: unknown; _langId?: unknown })._tree = undefined;
    (symbols as { _tree?: unknown; _langId?: unknown })._langId = undefined;
  }
}

/**
 * Backfill the `technique` column on `calls` edges written by the native Rust
 * orchestrator, which does not write the column itself.
 *
 * For full builds, all `calls` edges in the DB are new so a global UPDATE is
 * correct.  For incremental builds, only changed-file source nodes are updated
 * to avoid overwriting previously-set technique values on unchanged edges.
 */
function backfillEdgeTechniquesAfterNativeOrchestrator(
  db: BetterSqlite3Database,
  isFullBuild: boolean,
  changedFiles: string[] | undefined,
): void {
  // Quiet incremental: no files changed → no new edges inserted, nothing to tag.
  // Running the global UPDATE here would mis-tag pre-migration NULL-technique edges
  // from unchanged files as 'ts-native'.
  if (!isFullBuild && changedFiles && changedFiles.length === 0) {
    return;
  }
  if (isFullBuild || !changedFiles) {
    db.prepare(
      "UPDATE edges SET technique = 'ts-native' WHERE kind = 'calls' AND technique IS NULL",
    ).run();
    return;
  }
  // Incremental: scope to source nodes whose file is one of the changed files.
  // Chunk to stay within SQLite's SQLITE_LIMIT_VARIABLE_NUMBER (999 on older builds).
  const CHUNK_SIZE = 500;
  const tx = db.transaction(() => {
    for (let i = 0; i < changedFiles.length; i += CHUNK_SIZE) {
      const chunk = changedFiles.slice(i, i + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      db.prepare(
        `UPDATE edges SET technique = 'ts-native'
         WHERE kind = 'calls' AND technique IS NULL
         AND source_id IN (
           SELECT id FROM nodes WHERE file IN (${placeholders})
         )`,
      ).run(...chunk);
    }
  });
  tx();
}

/**
 * Try the native build orchestrator.
 *
 * Returns:
 *   - `BuildResult` on success (caller should return it directly).
 *   - `'early-exit'` when the orchestrator detected no changes (caller should return undefined).
 *   - `undefined` when native is unavailable or skipped (caller should fall through to the JS pipeline).
 *
 * Encapsulates the orchestrator-selection strategy: open `NativeDatabase`,
 * invoke `nativeDb.buildGraph()` (the Rust pipeline), and run post-native
 * structure + analysis fallbacks. Lives in its own file to keep the Rust
 * orchestrator entry point separated from the JS-side `buildGraph()` driver
 * in `pipeline.ts`.
 */
export async function tryNativeOrchestrator(
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
    // Even on no-op rebuilds, dropped-language files added since the last
    // full build are still missing from `nodes`/`file_hashes` (#1083), and
    // WASM-only files deleted from disk leave stale rows behind (#1073).
    // The orchestrator's collect_files skipped them, so its earlyExit
    // doesn't imply DB consistency. Run the gap repair before returning.
    const gap = detectDroppedLanguageGap(ctx);
    if (gap.missingAbs.length > 0 || gap.staleRel.length > 0) {
      await backfillNativeDroppedFiles(ctx, gap);
    }
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
  // Use the binary's CARGO_PKG_VERSION (ctx.nativeBinaryVersion), not the
  // platform package.json version (ctx.engineVersion). The Rust side's
  // check_version_mismatch compares against CARGO_PKG_VERSION; writing
  // the package.json value would create a permanent mismatch whenever
  // the binary and platform package.json diverge — e.g., CI hot-swap
  // via ci-install-native.mjs (#1066) — forcing every subsequent build
  // to be a full rebuild.
  //
  // When the native addon doesn't expose engineVersion() (older addon),
  // fall back to CODEGRAPH_VERSION — same fallback used by both
  // checkEngineSchemaMismatch (read path) and persistBuildMetadata
  // (the JS-pipeline write path in finalize.ts). Using ctx.engineVersion
  // here would re-introduce the asymmetry this PR fixes for that case.
  const nativeVersionForMeta = ctx.nativeBinaryVersion || CODEGRAPH_VERSION;
  setBuildMeta(ctx.db, {
    engine: ctx.engineName,
    engine_version: nativeVersionForMeta,
    codegraph_version: nativeVersionForMeta,
    schema_version: String(ctx.schemaVersion),
    built_at: new Date().toISOString(),
  });

  // The build summary is logged after the JS edge-writing post-passes below
  // (dropped-language backfill, CHA, this/super dispatch) so the reported
  // counts include their edges (#1452).

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

  // ── DB handoff ────────────────────────────────────────────────────────────
  // Ensure a proper better-sqlite3 connection is open before any post-pass that
  // writes edges (dropped-language backfill, CHA) and before structure/analysis.
  // When analysis fallback is needed the handoff already happened above; when
  // neither structure nor analysis is needed the proxy conversion is deferred to
  // here so CHA and technique-backfill can still write rows.
  if (needsStructure || needsAnalysisFallback) {
    if (needsAnalysisFallback && ctx.nativeFirstProxy) {
      closeNativeDb(ctx, 'pre-analysis-fallback');
      ctx.db = openDb(ctx.dbPath);
      ctx.nativeFirstProxy = false;
    } else if (!ctx.nativeFirstProxy && !handoffWalAfterNativeBuild(ctx)) {
      // DB reopen failed — return partial result (no post-pass phases completed)
      return formatNativeTimingResult(p, 0, analysisTiming, {
        gapDetectMs: 0,
        chaMs: 0,
        thisDispatchMs: 0,
        reclassifyMs: 0,
        techniqueBackfillMs: 0,
      });
    }
  }

  // ── Edge-writing post-passes (run before structure so roles see full graph) ──

  // Engine parity: the native orchestrator silently drops files whose
  // Rust extractor/grammar is missing or fails (e.g. HCL, Scala, Swift on
  // stale native binaries). WASM handles those — backfill via WASM so both
  // engines process the same file set (#967).
  //
  // Detect the gap once (fs walk + 2 DB queries) and use it for both gating
  // and the backfill itself. On quiet incrementals we still pay the walk so
  // we can detect brand-new files in dropped-language extensions — a gap that
  // the orchestrator's `detect_removed_files` filter (#1070) leaves open
  // (#1083, #1091). The pre-check is cheap because the expensive part (WASM
  // re-parse of the missing set) is gated below.
  const gapDetectStart = performance.now();
  const gap = detectDroppedLanguageGap(ctx);
  const backfillHappened = gap.missingAbs.length > 0 || gap.staleRel.length > 0;
  if (backfillHappened) {
    await backfillNativeDroppedFiles(ctx, gap);
  }
  const gapDetectMs = performance.now() - gapDetectStart;

  // Phase 8.5: expand CHA call edges (interface dispatch → concrete implementations).
  // Returns the affected files so role re-classification below can be scoped to
  // the nodes whose fan-in/out actually changed.
  //
  // Function-as-object-property methods (`fn.method = function() {}`) are extracted
  // natively by the Rust engine (#1432) and resolved in-build by its edge builder, so
  // no WASM re-parse post-pass is needed for them. `Foo.prototype.bar = fn` likewise.
  const chaStart = performance.now();
  const { newEdgeCount: chaEdgeCount, affectedFiles: chaAffectedFiles } = runPostNativeCha(
    ctx.db as unknown as BetterSqlite3Database,
    // null = full build (scan all call→method edges); array = incremental (gate queries decide scope)
    result.isFullBuild ? null : (result.changedFiles ?? null),
  );
  const chaMs = performance.now() - chaStart;

  // Phase 8.5: this/super dispatch — hybrid WASM re-parse to resolve call sites
  // whose raw receiver info the Rust pipeline does not persist to DB.
  const {
    elapsedMs: thisDispatchMs,
    targetIds: thisDispatchTargetIds,
    affectedFiles: thisDispatchAffectedFiles,
  } = await runPostNativeThisDispatch(
    ctx.db as unknown as BetterSqlite3Database,
    ctx.rootDir,
    result.changedFiles,
    !!result.isFullBuild,
  );

  // Role re-classification after JS edge-writing post-passes.
  // The Rust orchestrator classifies roles before these post-passes (CHA,
  // this-dispatch) add edges, so roles for the edge endpoints are stale.
  // Scoped to the files containing those endpoints: a new edge only changes
  // fan-in/out for its own source and target nodes, so re-classifying their
  // files restores correctness without re-running the classifier over the
  // whole graph (which cost ~130ms per build on codegraph itself and was a
  // major part of the v3.12.0 native full-build benchmark regression).
  let reclassifyMs = 0;
  if (chaEdgeCount > 0 || thisDispatchTargetIds.size > 0) {
    const affectedFiles = [...new Set([...chaAffectedFiles, ...thisDispatchAffectedFiles])];
    // When edges were inserted but all their endpoint nodes have null `file`
    // columns (rare but possible), affectedFiles stays empty even though
    // fan-in/out changed. Fall back to full-graph re-classification in that
    // case — scoped classification with an empty set would be a no-op, leaving
    // roles stale for those nodes.
    const scopedFiles = affectedFiles.length > 0 ? affectedFiles : null;
    const reclassifyStart = performance.now();
    try {
      const { classifyNodeRoles } = (await import('../../../../features/structure.js')) as {
        classifyNodeRoles: (
          db: BetterSqlite3Database,
          changedFiles?: string[] | null,
        ) => Record<string, number>;
      };
      classifyNodeRoles(ctx.db as unknown as BetterSqlite3Database, scopedFiles);
      debug(
        scopedFiles
          ? `Post-pass role re-classification complete (${scopedFiles.length} file(s))`
          : 'Post-pass role re-classification complete (full graph — null-file endpoints)',
      );
    } catch (err) {
      debug(`Post-pass role re-classification failed: ${toErrorMessage(err)}`);
    }
    reclassifyMs = performance.now() - reclassifyStart;
  }

  // Backfill the `technique` column on `calls` edges written by the Rust
  // orchestrator, which does not write the column. Runs after all edge-writing
  // phases (including the WASM dropped-language backfill, CHA post-pass, and
  // this/super dispatch) so every new edge in this build cycle gets a label.
  const techniqueBackfillStart = performance.now();
  backfillEdgeTechniquesAfterNativeOrchestrator(ctx.db, !!result.isFullBuild, result.changedFiles);
  const techniqueBackfillMs = performance.now() - techniqueBackfillStart;

  // Re-count nodes/edges now that all edge-writing post-passes have run: the
  // Rust orchestrator captured its counts before the JS post-passes added
  // edges, so both its summary and build_meta under-report (#1452).
  //
  // Fast path: skip the COUNT(*) scan when no post-pass wrote any edges.
  // COUNT(*) on large tables (50K+ edges) is non-trivial, especially via the
  // NativeDbProxy napi-rs round-trip. When all post-passes were no-ops, the
  // Rust orchestrator's counts are still accurate — no re-count needed.
  let finalNodeCount = result.nodeCount ?? 0;
  let finalEdgeCount = result.edgeCount ?? 0;
  const postPassWroteData = backfillHappened || chaEdgeCount > 0 || thisDispatchTargetIds.size > 0;
  if (postPassWroteData) {
    try {
      const counts = (ctx.db as unknown as BetterSqlite3Database)
        .prepare('SELECT (SELECT COUNT(*) FROM nodes) AS n, (SELECT COUNT(*) FROM edges) AS e')
        .get() as { n: number; e: number };
      if (counts.n !== finalNodeCount || counts.e !== finalEdgeCount) {
        finalNodeCount = counts.n;
        finalEdgeCount = counts.e;
        setBuildMeta(ctx.db, { node_count: finalNodeCount, edge_count: finalEdgeCount });
      }
    } catch (err) {
      debug(`Post-pass node/edge re-count failed: ${toErrorMessage(err)}`);
    }
  }
  info(
    `Native build orchestrator completed: ${finalNodeCount} nodes, ${finalEdgeCount} edges, ${result.fileCount ?? 0} files`,
  );

  // ── Structure and analysis fallback (run after edge-writing so roles see full graph) ──
  // Reconstruct fileSymbols once for both structure and analysis to avoid two
  // expensive DB scans. The DB handoff above already ensured ctx.db is a proper
  // better-sqlite3 connection when either flag is set.
  if (needsStructure || needsAnalysisFallback) {
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

  closeDbPair({ db: ctx.db, nativeDb: ctx.nativeDb });
  return formatNativeTimingResult(p, structurePatchMs, analysisTiming, {
    gapDetectMs,
    chaMs,
    thisDispatchMs,
    reclassifyMs,
    techniqueBackfillMs,
  });
}
