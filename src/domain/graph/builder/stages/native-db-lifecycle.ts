/**
 * NativeDatabase connection lifecycle helpers.
 *
 * The Rust orchestrator and the JS pipeline stages both juggle the same
 * `nativeDb` handle (rusqlite) alongside `ctx.db` (better-sqlite3). These
 * helpers centralise the open/close/reopen sequence so both call sites
 * preserve the same WAL-safety invariants:
 *
 *   - Always checkpoint WAL before closing rusqlite — otherwise better-sqlite3's
 *     internal WAL index can drift and surface as SQLITE_CORRUPT on the next
 *     read (#715, #736).
 *   - Always reopen better-sqlite3 after rusqlite writes to drop the stale
 *     page cache.
 *
 * Lives in its own module so `tryNativeOrchestrator` (in `native-orchestrator.ts`)
 * and the JS pipeline stages driver (in `pipeline.ts`) can share the helpers
 * without either file importing the other.
 */
import { openDb } from '../../../../db/index.js';
import { debug } from '../../../../infrastructure/logger.js';
import { loadNative } from '../../../../infrastructure/native.js';
import { toErrorMessage } from '../../../../shared/errors.js';
import type { PipelineContext } from '../context.js';

/** Checkpoint WAL through rusqlite and close the native connection. */
export function closeNativeDb(ctx: PipelineContext, label: string): void {
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
export function reopenNativeDb(ctx: PipelineContext, label: string): void {
  if ((ctx.opts.engine ?? 'auto') === 'wasm') return;
  const native = loadNative();
  if (!native?.NativeDatabase) return;
  try {
    ctx.nativeDb = native.NativeDatabase.openReadWrite(ctx.dbPath, ctx.config.db.busyTimeoutMs);
  } catch (e) {
    debug(`reopen nativeDb for ${label} failed: ${toErrorMessage(e)}`);
    ctx.nativeDb = undefined;
  }
}

/** Close nativeDb and clear stale references in engineOpts. */
export function suspendNativeDb(ctx: PipelineContext, label: string): void {
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
export function refreshJsDb(ctx: PipelineContext): void {
  try {
    ctx.db.close();
  } catch (e) {
    debug(`refreshJsDb close failed: ${toErrorMessage(e)}`);
  }
  ctx.db = openDb(ctx.dbPath, ctx.config.db.busyTimeoutMs);
}
