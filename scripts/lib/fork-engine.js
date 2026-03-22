/**
 * Child-process isolation for benchmarks.
 *
 * Runs each engine benchmark in a subprocess so that segfaults (e.g. from the
 * native Rust addon) only kill the child — the parent survives and collects
 * partial results from whichever engines succeeded.
 *
 * Usage (in a benchmark script):
 *
 *   import { forkEngines, isWorker, workerEngine } from './lib/fork-engine.js';
 *
 *   if (isWorker()) {
 *     // Child path — run a single engine, write JSON to stdout, then exit.
 *     const engine = workerEngine();
 *     const result = await runBenchmarkForEngine(engine);
 *     process.stdout.write(JSON.stringify(result));
 *     process.exit(0);
 *   }
 *
 *   // Parent path — fork one child per engine, collect results.
 *   const { wasm, native } = await forkEngines(import.meta.url, process.argv.slice(2));
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WORKER_ENV_KEY = '__BENCH_ENGINE__';

/**
 * Returns true when running inside a forked worker process.
 */
export function isWorker() {
	return !!process.env[WORKER_ENV_KEY];
}

/**
 * Returns the engine name ('wasm' | 'native') assigned to this worker.
 * Throws if called outside a worker.
 */
export function workerEngine() {
	const engine = process.env[WORKER_ENV_KEY];
	if (!engine) throw new Error('workerEngine() called outside a worker process');
	return engine;
}

/**
 * Fork the calling script once per available engine, collect JSON results.
 *
 * @param {string} scriptUrl   import.meta.url of the calling benchmark script
 * @param {string[]} argv      CLI args to forward (e.g. ['--version', '1.0.0', '--npm'])
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=600_000]  Per-engine timeout (default 10 min)
 * @returns {Promise<{ wasm: object|null, native: object|null }>}
 */
export async function forkEngines(scriptUrl, argv = [], opts = {}) {
	const scriptPath = fileURLToPath(scriptUrl);
	const timeoutMs = opts.timeoutMs ?? 600_000;

	// Detect available engines by importing the check functions in-process.
	// These are lightweight checks (no parsing), safe to run in the parent.
	let hasWasm = false;
	let hasNative = false;

	// We need srcDir to resolve the imports. Re-use bench-config for this.
	const { resolveBenchmarkSource, srcImport } = await import('./bench-config.js');
	const { srcDir, cleanup } = await resolveBenchmarkSource();

	try {
		const { isWasmAvailable } = await import(srcImport(srcDir, 'parser.js'));
		hasWasm = isWasmAvailable();
	} catch { /* unavailable */ }

	try {
		const { isNativeAvailable } = await import(srcImport(srcDir, 'native.js'));
		hasNative = isNativeAvailable();
	} catch { /* unavailable */ }

	cleanup();

	if (!hasWasm && !hasNative) {
		console.error('Error: Neither WASM grammars nor native engine are available.');
		console.error('Run "npm run build:wasm" to build WASM grammars, or install the native platform package.');
		process.exit(1);
	}

	/**
	 * Fork a single engine worker and collect its JSON output.
	 * @param {string} engine
	 * @returns {Promise<object|null>}
	 */
	function runWorker(engine) {
		return new Promise((resolve) => {
			console.error(`\n[fork] Spawning ${engine} worker (pid isolation)...`);

			const child = fork(scriptPath, argv, {
				env: { ...process.env, [WORKER_ENV_KEY]: engine },
				stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
				timeout: timeoutMs,
			});

			let stdout = '';
			child.stdout.on('data', (chunk) => { stdout += chunk; });

			const timer = setTimeout(() => {
				console.error(`[fork] ${engine} worker timed out after ${timeoutMs / 1000}s — killing`);
				child.kill('SIGKILL');
			}, timeoutMs);

			child.on('close', (code, signal) => {
				clearTimeout(timer);

				if (signal) {
					console.error(`[fork] ${engine} worker killed by signal ${signal}`);
					resolve(null);
					return;
				}

				if (code !== 0) {
					console.error(`[fork] ${engine} worker exited with code ${code}`);
					// Try to parse partial output anyway
					try {
						const parsed = JSON.parse(stdout);
						console.error(`[fork] ${engine} worker produced partial results despite non-zero exit`);
						resolve(parsed);
					} catch {
						resolve(null);
					}
					return;
				}

				try {
					resolve(JSON.parse(stdout));
				} catch (err) {
					console.error(`[fork] ${engine} worker produced invalid JSON: ${err.message}`);
					resolve(null);
				}
			});

			child.on('error', (err) => {
				clearTimeout(timer);
				console.error(`[fork] ${engine} worker failed to start: ${err.message}`);
				resolve(null);
			});
		});
	}

	const results = { wasm: null, native: null };

	// Run engines sequentially — they share the DB file and filesystem state.
	if (hasWasm) {
		results.wasm = await runWorker('wasm');
	} else {
		console.error('WASM grammars not built — skipping WASM benchmark');
	}

	if (hasNative) {
		results.native = await runWorker('native');
	} else {
		console.error('Native engine not available — skipping native benchmark');
	}

	return results;
}
