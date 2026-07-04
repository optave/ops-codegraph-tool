/**
 * Shared timing helpers for benchmark scripts.
 *
 * `median`/`round1` were independently duplicated (byte-for-byte, in most
 * cases) across token-benchmark.ts, query-benchmark.ts,
 * incremental-benchmark.ts (twice — once per process: parent and worker),
 * and benchmark.ts. `timeMedian` wraps the "run N times, time each run,
 * return the median" loop that recurred at every call site measuring a
 * single scalar latency.
 *
 * Usage (in a benchmark script):
 *
 *   import { median, round1, timeMedian } from './lib/bench-timing.js';
 *
 *   const fullBuildMs = Math.round(
 *     await timeMedian(() => buildGraph(root, { engine, incremental: false }), RUNS),
 *   );
 */

/**
 * Returns the median of `arr`. `arr` is not mutated (sorted on a copy).
 * Returns 0 for an empty array.
 */
export function median(arr: number[]): number {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Rounds `n` to 1 decimal place.
 */
export function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

/**
 * Runs `fn` `runs` times, recording the elapsed milliseconds per run, and
 * returns the median duration. Awaits `fn()` each iteration, so both sync
 * and async `fn` work — pass an async closure when `fn` itself needs to
 * `await` (e.g. wrapping `buildGraph`).
 */
export async function timeMedian(fn: () => unknown, runs: number): Promise<number> {
	const timings: number[] = [];
	for (let i = 0; i < runs; i++) {
		const start = performance.now();
		await fn();
		timings.push(performance.now() - start);
	}
	return median(timings);
}
