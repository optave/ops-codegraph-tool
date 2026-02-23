#!/usr/bin/env node

/**
 * Benchmark runner — measures codegraph performance on itself (dogfooding).
 *
 * Runs both native (Rust) and WASM engines, outputs JSON to stdout
 * with raw and per-file normalized metrics for each.
 *
 * Usage: node scripts/benchmark.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Read version from package.json
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const dbPath = path.join(root, '.codegraph', 'graph.db');

// Import programmatic API (use file:// URLs for Windows compatibility)
const { buildGraph } = await import(pathToFileURL(path.join(root, 'src', 'builder.js')).href);
const { fnDepsData, statsData } = await import(
	pathToFileURL(path.join(root, 'src', 'queries.js')).href
);
const { isNativeAvailable } = await import(
	pathToFileURL(path.join(root, 'src', 'native.js')).href
);

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

async function benchmarkEngine(engine) {
	// Clean DB for a full build
	if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

	const buildStart = performance.now();
	await buildGraph(root, { engine, incremental: false });
	const buildTimeMs = performance.now() - buildStart;

	const queryStart = performance.now();
	fnDepsData('buildGraph', dbPath);
	const queryTimeMs = performance.now() - queryStart;

	const stats = statsData(dbPath);
	const totalFiles = stats.files.total;
	const totalNodes = stats.nodes.total;
	const totalEdges = stats.edges.total;
	const dbSizeBytes = fs.statSync(dbPath).size;

	return {
		buildTimeMs: Math.round(buildTimeMs),
		queryTimeMs: Math.round(queryTimeMs * 10) / 10,
		nodes: totalNodes,
		edges: totalEdges,
		files: totalFiles,
		dbSizeBytes,
		perFile: {
			buildTimeMs: Math.round((buildTimeMs / totalFiles) * 10) / 10,
			nodes: Math.round((totalNodes / totalFiles) * 10) / 10,
			edges: Math.round((totalEdges / totalFiles) * 10) / 10,
			dbSizeBytes: Math.round(dbSizeBytes / totalFiles),
		},
	};
}

// ── Run benchmarks ───────────────────────────────────────────────────────
const wasm = await benchmarkEngine('wasm');

let native = null;
if (isNativeAvailable()) {
	native = await benchmarkEngine('native');
} else {
	console.error('Native engine not available — skipping native benchmark');
}

// Restore console.log for JSON output
console.log = origLog;

const result = {
	version: pkg.version,
	date: new Date().toISOString().slice(0, 10),
	files: wasm.files,
	wasm: {
		buildTimeMs: wasm.buildTimeMs,
		queryTimeMs: wasm.queryTimeMs,
		nodes: wasm.nodes,
		edges: wasm.edges,
		dbSizeBytes: wasm.dbSizeBytes,
		perFile: wasm.perFile,
	},
	native: native
		? {
				buildTimeMs: native.buildTimeMs,
				queryTimeMs: native.queryTimeMs,
				nodes: native.nodes,
				edges: native.edges,
				dbSizeBytes: native.dbSizeBytes,
				perFile: native.perFile,
			}
		: null,
};

console.log(JSON.stringify(result, null, 2));
