/**
 * WASM parse worker pool with crash recovery.
 *
 * The WASM grammar can trigger uncatchable V8 fatal errors (#965) that kill
 * whichever thread is running it. Running parses in a worker_thread means the
 * crash kills only the worker — the pool detects the exit, marks the in-flight
 * file as skipped, respawns the worker, and continues with the rest.
 *
 * This is a single-worker pool; dispatch is sequential. Multi-worker parallelism
 * is a future optimization — correctness of crash isolation does not depend on
 * it. Sequential dispatch also simplifies attribution of a crash to a single
 * "in-flight" file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { debug, warn } from '../infrastructure/logger.js';
import type { ASTNodeRow, ExtractorOutput, TypeMapEntry } from '../types.js';
import type {
  SerializedExtractorOutput,
  WorkerAnalysisOpts,
  WorkerRequest,
  WorkerResponse,
} from './wasm-worker-protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the path to the compiled worker entry script.
 *
 * The worker is always loaded from compiled `.js` — Node's worker_threads
 * loader does not apply vitest/ts-node transforms or rewrite `.js` specifiers
 * to `.ts`, so even under `--experimental-strip-types` the worker's
 * relative `.js` imports (e.g. `../ast-analysis/metrics.js`) would fail to
 * resolve inside the src/ tree.
 *
 * Resolution order:
 *   1. Sibling `.js` (dist build — `dist/domain/wasm-worker-entry.js`).
 *   2. Corresponding `dist/` file when running from `src/` (tests/dev).
 * If neither exists, surface a clear error instead of silently exiting the
 * worker with "module not found".
 */
function resolveWorkerEntry(): URL {
  const selfUrl = import.meta.url;
  const selfPath = fileURLToPath(selfUrl);

  // Prefer the sibling .js first (dist build — fast path).
  const siblingJs = path.join(path.dirname(selfPath), 'wasm-worker-entry.js');
  if (fs.existsSync(siblingJs)) return pathToFileURL(siblingJs);

  // Running from src/ — fall back to the compiled dist/ copy. Walk up to the
  // package root (parent of `src/`) and look for `dist/domain/wasm-worker-entry.js`.
  // This lets vitest import parser.ts while the worker still runs real .js.
  const srcIdx = selfPath.lastIndexOf(`${path.sep}src${path.sep}`);
  if (srcIdx !== -1) {
    const repoRoot = selfPath.slice(0, srcIdx);
    const distJs = path.join(repoRoot, 'dist', 'domain', 'wasm-worker-entry.js');
    if (fs.existsSync(distJs)) return pathToFileURL(distJs);
  }

  throw new Error(
    `wasm-worker-entry.js not found — run \`npm run build\` to generate dist/. Searched: ${siblingJs}`,
  );
}

interface PendingJob {
  id: number;
  filePath: string;
  code: string;
  opts: WorkerAnalysisOpts;
  resolve: (out: ExtractorOutput | null) => void;
  /** setTimeout handle — fires if the worker hangs in a non-crashing loop. */
  timeoutHandle: NodeJS.Timeout | null;
}

/**
 * Per-file watchdog deadline. A parse that takes longer than this is assumed
 * to be hung (e.g. WASM grammar stuck in an infinite loop rather than
 * crashing). We terminate the worker, skip the file, and continue.
 *
 * 60s is comfortably above worst-case real parses seen in CI (~12s for the
 * slowest fixture) while still giving the build a definite upper bound
 * instead of stalling forever.
 */
const WORKER_PARSE_TIMEOUT_MS = 60_000;

function deserializeResult(ser: SerializedExtractorOutput | null): ExtractorOutput | null {
  if (!ser) return null;
  const typeMap = new Map<string, TypeMapEntry>();
  for (const [k, v] of ser.typeMap) typeMap.set(k, v);
  const out: ExtractorOutput = {
    definitions: ser.definitions,
    calls: ser.calls,
    imports: ser.imports,
    classes: ser.classes,
    exports: ser.exports,
    typeMap,
  };
  if (ser._langId !== undefined) out._langId = ser._langId;
  if (ser._lineCount !== undefined) out._lineCount = ser._lineCount;
  if (ser.dataflow !== undefined) out.dataflow = ser.dataflow;
  // Pre-existing type mismatch: ExtractorOutput.astNodes is typed ASTNodeRow[]
  // (DB-row shape with node_id), but all producers/consumers use the simpler
  // {line, kind, name, text?, receiver?} shape — see engine.ts:822 where the
  // visitor output is cast the same way.
  if (ser.astNodes !== undefined) out.astNodes = ser.astNodes as unknown as ASTNodeRow[];
  return out;
}

export class WasmWorkerPool {
  private worker: Worker | null = null;
  private nextId = 1;
  private queue: PendingJob[] = [];
  private inFlight: PendingJob | null = null;
  private disposed = false;
  /** filePaths that already caused one worker crash — skipped rather than retried. */
  private crashedFiles = new Set<string>();
  /**
   * Tracks the id of the job whose timeout fired and triggered `terminate()`.
   * Node timers are delivered before poll-phase I/O, so `onTimeout` can fire in
   * the same loop iteration that already has the worker's response queued. In
   * that race, `onMessage` resolves the timed-out job and starts the next one
   * BEFORE `onExit` arrives for the earlier `terminate()` — so the `inFlight`
   * job `onExit` sees is the innocent next job, not the one that actually hung.
   * `onExit` uses this field to detect the mismatch and re-queue the new job
   * instead of silently discarding it.
   */
  private timedOutJobId: number | null = null;

  /**
   * Parse a single file via the worker. Returns the fully pre-computed
   * ExtractorOutput, or `null` if the worker crashed on this file or
   * reported a soft error.
   */
  parse(filePath: string, code: string, opts: WorkerAnalysisOpts): Promise<ExtractorOutput | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.crashedFiles.has(filePath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const job: PendingJob = {
        id: this.nextId++,
        filePath,
        code,
        opts,
        resolve,
        timeoutHandle: null,
      };
      this.queue.push(job);
      this.pump();
    });
  }

  /** Terminate the worker and drain pending jobs with null results. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = this.queue.splice(0);
    const inFlight = this.inFlight;
    this.inFlight = null;
    this.timedOutJobId = null;
    for (const j of pending) j.resolve(null);
    if (inFlight) {
      if (inFlight.timeoutHandle) clearTimeout(inFlight.timeoutHandle);
      inFlight.resolve(null);
    }
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch (e: unknown) {
        debug(`WasmWorkerPool dispose: terminate failed: ${(e as Error).message}`);
      }
      this.worker = null;
    }
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.inFlight) return;
    const next = this.queue.shift();
    if (!next) return;
    this.inFlight = next;
    const worker = this.ensureWorker();
    const req: WorkerRequest = {
      type: 'parse',
      id: next.id,
      filePath: next.filePath,
      code: next.code,
      opts: next.opts,
    };
    // Arm the hang watchdog BEFORE posting so we can't race a fast reply.
    next.timeoutHandle = setTimeout(() => this.onTimeout(next.id), WORKER_PARSE_TIMEOUT_MS);
    worker.postMessage(req);
  }

  /**
   * Called when the per-job watchdog fires. Terminate the worker so the
   * hang stops consuming CPU; `onExit` will then resolve the in-flight job
   * with `null` and blacklist the file via `crashedFiles`.
   */
  private onTimeout(jobId: number): void {
    const job = this.inFlight;
    if (!job || job.id !== jobId) return; // already resolved
    warn(
      `WASM worker parse timed out after ${WORKER_PARSE_TIMEOUT_MS}ms on ${job.filePath} — terminating worker and skipping file`,
    );
    this.crashedFiles.add(job.filePath);
    // Record which job we're terminating so onExit can distinguish this
    // terminate-induced exit from a crash on a different (innocent) job that
    // got pumped in between — see `timedOutJobId` field comment.
    this.timedOutJobId = jobId;
    const w = this.worker;
    if (w) {
      w.terminate().catch((e: unknown) => {
        debug(`WasmWorkerPool onTimeout: terminate failed: ${(e as Error).message}`);
      });
      // onExit will fire and clean up `inFlight` + resolve the job.
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const w = new Worker(resolveWorkerEntry());
    this.worker = w;
    w.on('message', (msg: WorkerResponse) => this.onMessage(msg));
    w.on('error', (err: unknown) => this.onError(err));
    w.on('exit', (code) => this.onExit(code));
    return w;
  }

  private onMessage(msg: WorkerResponse): void {
    const job = this.inFlight;
    if (!job || job.id !== msg.id) {
      debug(`WasmWorkerPool: stale or unmatched response id=${msg.id}`);
      return;
    }
    if (job.timeoutHandle) {
      clearTimeout(job.timeoutHandle);
      job.timeoutHandle = null;
    }
    // If a terminate() is pending for this same job (response + timeout raced
    // in the same loop tick — timers fire before poll-phase I/O), delay
    // pumping the next job until `onExit` runs. Otherwise the upcoming exit
    // would land on an innocent follow-up job. `onExit` clears
    // `timedOutJobId` and calls pump() itself once the worker is fully gone.
    const terminatePending = this.timedOutJobId === job.id;
    this.inFlight = null;
    if (msg.ok) {
      job.resolve(deserializeResult(msg.result));
    } else {
      warn(`WASM worker soft error on ${job.filePath}: ${msg.error}`);
      job.resolve(null);
    }
    if (!terminatePending) this.pump();
  }

  private onError(err: unknown): void {
    // 'error' fires for uncaught exceptions inside the worker — not always fatal
    // (Node may still follow with 'exit'). Log and let 'exit' handle cleanup.
    const msg = err instanceof Error ? err.message : String(err);
    debug(`WASM worker 'error' event: ${msg}`);
  }

  private onExit(code: number): void {
    const crashed = this.inFlight;
    this.worker = null;
    const timedOutJobId = this.timedOutJobId;
    this.timedOutJobId = null;
    if (!crashed) {
      // Clean exit with no in-flight job — e.g. shutdown, or the race where
      // `onMessage` already resolved the timed-out job (and deferred pump()
      // because a terminate was in flight). Nothing to crash; just pump the
      // queue so any waiting jobs get dispatched on a fresh worker.
      if (code !== 0) {
        debug(`WASM worker exited with code ${code}, no job in flight`);
      }
      if (timedOutJobId !== null) this.pump();
      return;
    }
    if (timedOutJobId !== null && crashed.id !== timedOutJobId) {
      // Defensive: a terminate() we issued for a different (earlier) job is
      // what triggered this exit, but somehow an innocent follow-up job ended
      // up in-flight. `onMessage` normally defers pumping when a terminate is
      // pending, so this path should not trigger — but if it does, re-queue
      // the follow-up rather than silently discarding a valid parse.
      if (crashed.timeoutHandle) {
        clearTimeout(crashed.timeoutHandle);
        crashed.timeoutHandle = null;
      }
      this.inFlight = null;
      this.queue.unshift(crashed);
      this.pump();
      return;
    }
    if (crashed.timeoutHandle) {
      clearTimeout(crashed.timeoutHandle);
      crashed.timeoutHandle = null;
    }
    this.inFlight = null;
    if (code === 0) {
      // Clean exit mid-job — could be our own terminate() from onTimeout,
      // or an unexpected worker shutdown. In either case the file is
      // skipped (crashedFiles was already set in onTimeout if that was the cause).
      warn(`WASM worker exited cleanly mid-job on ${crashed.filePath} — skipping`);
    } else {
      warn(
        `WASM worker crashed (exit ${code}) parsing ${crashed.filePath} — skipping file and restarting worker`,
      );
    }
    this.crashedFiles.add(crashed.filePath);
    crashed.resolve(null);
    // Respawn lazily on the next pump()
    this.pump();
  }
}

let _sharedPool: WasmWorkerPool | null = null;

/** Shared pool instance for the process. Callers share the worker across builds. */
export function getWasmWorkerPool(): WasmWorkerPool {
  if (!_sharedPool) _sharedPool = new WasmWorkerPool();
  return _sharedPool;
}

/** Dispose the shared pool (used by tests + `disposeParsers`). */
export async function disposeWasmWorkerPool(): Promise<void> {
  if (!_sharedPool) return;
  const p = _sharedPool;
  _sharedPool = null;
  await p.dispose();
}
