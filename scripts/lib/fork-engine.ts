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
const TARGETS_ENV_KEY = '__BENCH_TARGETS__';

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
 * Returns pre-selected targets passed from the parent process, or null if
 * this is the first engine run (no targets yet).
 */
export function workerTargets() {
	const raw = process.env[TARGETS_ENV_KEY];
	if (!raw) return null;
	try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Fork a single worker subprocess and collect its JSON output.
 *
 * @param {string} scriptPath  Absolute path to the script to fork
 * @param {string} envKey      Environment variable name for the worker identifier
 * @param {string} workerName  Human-readable label for logging (e.g. 'wasm', 'gte-small')
 * @param {string[]} argv      CLI args to forward
 * @param {number} [timeoutMs=600_000]  Per-worker timeout (default 10 min)
 * @returns {Promise<object|null>}
 */
export function forkWorker(scriptPath, envKey, workerName, argv = [], timeoutMs = 600_000) {
	return new Promise((resolve) => {
		let settled = false;
		function settle(value) {
			if (settled) return;
			settled = true;
			resolve(value);
		}

		console.error(`\n[fork] Spawning ${workerName} worker (pid isolation)...`);

		const child = fork(scriptPath, argv, {
			env: { ...process.env, [envKey]: workerName, CODEGRAPH_ENGINE: workerName },
			stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
		});

		let stdout = '';
		child.stdout.on('data', (chunk) => { stdout += chunk; });

		const timer = setTimeout(() => {
			console.error(`[fork] ${workerName} worker timed out after ${timeoutMs / 1000}s — killing`);
			child.kill('SIGKILL');
		}, timeoutMs);

		child.on('close', (code, signal) => {
			clearTimeout(timer);

			if (signal) {
				console.error(`[fork] ${workerName} worker killed by signal ${signal}`);
				// A worker can finish its measurements and write valid JSON to
				// stdout before hanging on a non-daemonized handle (e.g. an
				// un-disposed worker_thread pool). SIGKILL from our timeout
				// then discards the result. Try to parse captured stdout first
				// so we don't lose real data to a lingering event-loop keepalive.
				try {
					const parsed = JSON.parse(stdout);
					console.error(`[fork] ${workerName} worker produced results before being killed — salvaging`);
					settle(parsed);
				} catch {
					settle(null);
				}
				return;
			}

			if (code !== 0) {
				console.error(`[fork] ${workerName} worker exited with code ${code}`);
				// Try to parse partial output anyway
				try {
					const parsed = JSON.parse(stdout);
					console.error(`[fork] ${workerName} worker produced partial results despite non-zero exit`);
					settle(parsed);
				} catch {
					settle(null);
				}
				return;
			}

			try {
				settle(JSON.parse(stdout));
			} catch (err) {
				console.error(`[fork] ${workerName} worker produced invalid JSON: ${err.message}`);
				settle(null);
			}
		});

		child.on('error', (err) => {
			clearTimeout(timer);
			console.error(`[fork] ${workerName} worker failed to start: ${err.message}`);
			settle(null);
		});
	});
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
		const { isWasmAvailable } = await import(srcImport(srcDir, 'domain/parser.js'));
		hasWasm = isWasmAvailable();
	} catch { /* unavailable */ }

	try {
		const { isNativeAvailable } = await import(srcImport(srcDir, 'infrastructure/native.js'));
		hasNative = isNativeAvailable();
	} catch { /* unavailable */ }

	cleanup();

	if (!hasWasm && !hasNative) {
		const msg = 'Neither WASM grammars nor native engine are available. ' +
			'Run "npm run build:wasm" to build WASM grammars, or install the native platform package.';
		throw new Error(msg);
	}

	const results = { wasm: null, native: null };

	// Run engines sequentially — they share the DB file and filesystem state.
	// After the first engine completes, extract its targets and pass them to
	// the second engine via TARGETS_ENV_KEY so both benchmark the same symbols.
	if (hasWasm) {
		results.wasm = await forkWorker(scriptPath, WORKER_ENV_KEY, 'wasm', argv, timeoutMs);
	} else {
		console.error('WASM grammars not built — skipping WASM benchmark');
	}

	// Propagate targets from the first engine to the second
	const firstResult = results.wasm;
	if (firstResult?.targets) {
		process.env[TARGETS_ENV_KEY] = JSON.stringify(firstResult.targets);
	}

	if (hasNative) {
		results.native = await forkWorker(scriptPath, WORKER_ENV_KEY, 'native', argv, timeoutMs);
	} else {
		console.error('Native engine not available — skipping native benchmark');
	}

	// Clean up env
	delete process.env[TARGETS_ENV_KEY];

	return results;
}
