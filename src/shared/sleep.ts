/**
 * Synchronous sleep utilities for short retry/backoff loops.
 */

/**
 * Busy-spin sleep for `ms` milliseconds.
 *
 * Deliberately avoids `Atomics.wait`, which blocks the calling thread at the
 * OS level and freezes all libuv I/O and timer callbacks for the duration of
 * the wait — unsafe on hot paths shared with watcher processes. The retry
 * intervals this is used for are short (tens of ms), so the CPU cost of
 * spinning is negligible next to the safety of keeping unrelated callbacks
 * responsive.
 */
export function sleepSync(ms: number): void {
  const end = process.hrtime.bigint() + BigInt(ms) * 1_000_000n;
  while (process.hrtime.bigint() < end) {
    /* spin */
  }
}
