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
 *
 * `timeMedianWithValue` covers the same loop shape for call sites that also
 * need side data from whichever run turned out to be the median-duration one
 * (e.g. the build-phase breakdown of a "1-file rebuild" measurement) — data
 * `timeMedian`'s bare `Promise<number>` return can't carry.
 */
import { performance } from 'node:perf_hooks';

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

/**
 * Runs `fn` `runs` times, recording elapsed milliseconds and `fn`'s return
 * value per run, and returns the `{ ms, value }` pair for the median-duration
 * run. An optional `beforeEach(i)` hook runs immediately before each timed
 * call — its cost is *not* included in the timed duration — for per-iteration
 * setup like writing a probe file with iteration-varying content ahead of an
 * incremental rebuild.
 *
 * Unlike `median()`, this does not average the two middle samples when `runs`
 * is even — it returns one real sampled run (sorted by `ms`, middle index),
 * so `value` always stays attributable to an actual execution.
 */
export async function timeMedianWithValue<T>(
	fn: (i: number) => T | Promise<T>,
	runs: number,
	beforeEach?: (i: number) => void | Promise<void>,
): Promise<{ ms: number; value: T }> {
	const samples: { ms: number; value: T }[] = [];
	for (let i = 0; i < runs; i++) {
		if (beforeEach) await beforeEach(i);
		const start = performance.now();
		const value = await fn(i);
		samples.push({ ms: performance.now() - start, value });
	}
	samples.sort((a, b) => a.ms - b.ms);
	return samples[Math.floor(samples.length / 2)];
}
