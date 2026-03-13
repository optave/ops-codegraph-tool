#!/usr/bin/env node

/**
 * Embedding benchmark runner — measures search recall across all models.
 *
 * For every function/method/class in the graph, generates a query from the
 * symbol name (splitIdentifier) and checks if search finds that symbol.
 * Tests all available embedding models, outputs JSON to stdout.
 *
 * Skips jina-code when HF_TOKEN is not set (gated model).
 *
 * Usage: node scripts/embedding-benchmark.js > result.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { version, srcDir, cleanup } = await resolveBenchmarkSource();
const dbPath = path.join(root, '.codegraph', 'graph.db');

const { buildEmbeddings, MODELS, searchData, disposeModel } = await import(
	srcImport(srcDir, 'embeddings/index.js')
);

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;

function splitIdentifier(name) {
	return name
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.trim();
}

function loadSymbols() {
	const db = new Database(dbPath, { readonly: true });
	let rows = db
		.prepare(
			`SELECT name, kind, file FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`,
		)
		.all();
	db.close();

	rows = rows.filter((r) => !TEST_PATTERN.test(r.file));

	const seen = new Set();
	const symbols = [];
	for (const row of rows) {
		if (seen.has(row.name)) continue;
		seen.add(row.name);
		const query = splitIdentifier(row.name);
		if (query.length < 4) continue;
		symbols.push({ name: row.name, kind: row.kind, file: row.file, query });
	}
	return symbols;
}

async function benchmarkModel(modelKey, symbols) {
	const embedStart = performance.now();
	await buildEmbeddings(root, modelKey, dbPath, { strategy: 'structured' });
	const embedTimeMs = Math.round(performance.now() - embedStart);

	let hits1 = 0;
	let hits3 = 0;
	let hits5 = 0;
	let hits10 = 0;

	const searchStart = performance.now();
	for (const { name, query } of symbols) {
		const data = await searchData(query, dbPath, { minScore: 0.01, limit: 10 });
		if (!data) continue;

		const names = data.results.map((r) => r.name);
		const rank = names.indexOf(name) + 1;
		if (rank === 1) hits1++;
		if (rank >= 1 && rank <= 3) hits3++;
		if (rank >= 1 && rank <= 5) hits5++;
		if (rank >= 1 && rank <= 10) hits10++;
	}
	const searchTimeMs = Math.round(performance.now() - searchStart);

	const total = symbols.length;
	return {
		dim: MODELS[modelKey].dim,
		contextWindow: MODELS[modelKey].contextWindow,
		hits1,
		hits3,
		hits5,
		hits10,
		misses: total - hits10,
		total,
		embedTimeMs,
		searchTimeMs,
	};
}

// ── Run benchmarks ──────────────────────────────────────────────────────

const symbols = loadSymbols();
console.error(`Loaded ${symbols.length} symbols for benchmark`);

const hasHfToken = !!process.env.HF_TOKEN;
const modelKeys = Object.keys(MODELS);
const results = {};

for (const key of modelKeys) {
	if (key === 'jina-code' && !hasHfToken) {
		console.error(`Skipping ${key} (HF_TOKEN not set)`);
		continue;
	}

	console.error(`\nBenchmarking model: ${key}...`);
	try {
		results[key] = await benchmarkModel(key, symbols);
		const r = results[key];
		console.error(
			`  Hit@1=${r.hits1}/${r.total} Hit@3=${r.hits3}/${r.total} Hit@5=${r.hits5}/${r.total} misses=${r.misses}`,
		);
	} catch (err) {
		console.error(`  FAILED: ${err?.message ?? String(err)}`);
	} finally {
		try {
			await disposeModel();
		} catch (disposeErr) {
			console.error(`  disposeModel failed: ${disposeErr?.message ?? String(disposeErr)}`);
		}
	}
}

// Restore console.log for JSON output
console.log = origLog;

const output = {
	version,
	date: new Date().toISOString().slice(0, 10),
	strategy: 'structured',
	symbols: symbols.length,
	models: results,
};

console.log(JSON.stringify(output, null, 2));

cleanup();
