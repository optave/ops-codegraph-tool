/**
 * Catch-suppression helpers for intentional error swallowing.
 *
 * Lives in `infrastructure/` (not `shared/`) because it depends on the
 * structured logger — keeping `shared/errors.ts` dependency-free.
 */

import { toErrorMessage } from '../shared/errors.js';
import { debug } from './logger.js';

/**
 * Run `fn` and return its result. If it throws, log a debug message and
 * return `fallback` instead. Use this for intentional catch suppression
 * where the error is expected and non-fatal (e.g. optional file reads,
 * graceful feature probes, cleanup that may fail).
 *
 * @example
 *   const version = suppressError(() => readPkgVersion(), 'read package version', '');
 */
export function suppressError<T>(fn: () => T, context: string, fallback: T): T {
  try {
    return fn();
  } catch (e: unknown) {
    debug(`${context}: ${toErrorMessage(e)}`);
    return fallback;
  }
}

/**
 * Async variant of {@link suppressError}. Awaits `fn()` and returns `fallback`
 * on rejection, logging the error via `debug()`.
 *
 * @example
 *   const data = await suppressErrorAsync(() => fetchOptionalData(), 'fetch data', null);
 */
export async function suppressErrorAsync<T>(
  fn: () => Promise<T>,
  context: string,
  fallback: T,
): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    debug(`${context}: ${toErrorMessage(e)}`);
    return fallback;
  }
}
