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

import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Resolve the path to the compiled (or source) worker entry script.
 *
 * In dist builds, `import.meta.url` points at a `.js` file and the worker
 * sibling is also `.js`. Under Node's type-stripping runtime (tests,
 * `--experimental-strip-types`) the URL ends in `.ts` — in that case we
 * point the worker at the `.ts` entry, which Node will strip at load time.
 */
function resolveWorkerEntry(): URL {
  const selfUrl = import.meta.url;
  const ext = selfUrl.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./wasm-worker-entry${ext}`, selfUrl);
}

interface PendingJob {
  id: number;
  filePath: string;
  code: string;
  opts: WorkerAnalysisOpts;
  resolve: (out: ExtractorOutput | null) => void;
}

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
  private workerReady: Promise<void> | null = null;
  private nextId = 1;
  private queue: PendingJob[] = [];
  private inFlight: PendingJob | null = null;
  private disposed = false;
  /** filePaths that already caused one worker crash — skipped rather than retried. */
  private crashedFiles = new Set<string>();

  /**
   * Parse a single file via the worker. Returns the fully pre-computed
   * ExtractorOutput, or `null` if the worker crashed on this file or
   * reported a soft error.
   */
  parse(filePath: string, code: string, opts: WorkerAnalysisOpts): Promise<ExtractorOutput | null> {
    if (this.disposed) return Promise.resolve(null);
    if (this.crashedFiles.has(filePath)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const job: PendingJob = { id: this.nextId++, filePath, code, opts, resolve };
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
    for (const j of pending) j.resolve(null);
    if (inFlight) inFlight.resolve(null);
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
    worker.postMessage(req);
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
    this.inFlight = null;
    if (msg.ok) {
      job.resolve(deserializeResult(msg.result));
    } else {
      warn(`WASM worker soft error on ${job.filePath}: ${msg.error}`);
      job.resolve(null);
    }
    this.pump();
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
    this.workerReady = null;
    if (!crashed) {
      // Clean exit with no in-flight job — e.g. shutdown. Nothing to do.
      if (code !== 0) {
        debug(`WASM worker exited with code ${code}, no job in flight`);
      }
      return;
    }
    this.inFlight = null;
    if (code === 0) {
      // Shouldn't happen — worker terminated mid-job without a response.
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
