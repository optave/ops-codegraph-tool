#!/usr/bin/env node

/**
 * Resolution precision/recall benchmark runner.
 *
 * Builds codegraph for each hand-annotated fixture project, compares resolved
 * call edges against expected-edges.json manifests, and outputs JSON with
 * per-language precision and recall.
 *
 * Usage:
 *   node scripts/resolution-benchmark.ts [--version <v>] [--npm]
 *
 * Output (stdout):
 *   { "javascript": { "precision": 0.92, "recall": 0.67, ... }, ... }
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBenchmarkSource, srcImport } from './lib/bench-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(root, 'tests', 'benchmarks', 'resolution', 'fixtures');

// ── Types ─────────────────────────────────────────────────────────────────

interface ResolvedEdge {
	source_name: string;
	source_file: string;
	target_name: string;
	target_file: string;
	kind: string;
	confidence: number;
}

interface ExpectedEdge {
	source: { name: string; file: string };
	target: { name: string; file: string };
	mode?: string;
}

interface ModeMetrics {
	expected: number;
	resolved: number;
	recall: number;
}

interface DynamicEdge {
	source_name: string;
	source_file: string;
	target_name: string;
	target_file: string;
}

interface LangResult {
	precision: number;
	recall: number;
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	totalResolved: number;
	totalExpected: number;
	byMode: Record<string, ModeMetrics>;
	dynamicEdges?: number;
	dynamicConfirmed?: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────

// Files to skip when copying fixtures (not source code for codegraph)
const SKIP_FILES = new Set(['expected-edges.json', 'driver.mjs', 'dynamic-edges.json']);

function copyFixture(lang: string): string {
	const src = path.join(FIXTURES_DIR, lang);
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `codegraph-resolution-${lang}-`));
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		if (SKIP_FILES.has(entry.name)) continue;
		if (!entry.isFile()) {
			console.error(`  Warning: skipping subdirectory "${entry.name}" in ${lang} fixture (flat copy only)`);
			continue;
		}
		fs.copyFileSync(path.join(src, entry.name), path.join(tmp, entry.name));
	}
	return tmp;
}

function normalizeFile(filePath: string): string {
	return path.basename(filePath);
}

function edgeKey(sourceName: string, sourceFile: string, targetName: string, targetFile: string): string {
	return `${sourceName}@${normalizeFile(sourceFile)} -> ${targetName}@${normalizeFile(targetFile)}`;
}

function computeMetrics(resolvedEdges: ResolvedEdge[], expectedEdges: ExpectedEdge[]): LangResult {
	const resolvedSet = new Set(
		resolvedEdges.map((e) => edgeKey(e.source_name, e.source_file, e.target_name, e.target_file)),
	);
	const expectedSet = new Set(
		expectedEdges.map((e) => edgeKey(e.source.name, e.source.file, e.target.name, e.target.file)),
	);

	const truePositives = new Set([...resolvedSet].filter((k) => expectedSet.has(k)));
	const falsePositives = new Set([...resolvedSet].filter((k) => !expectedSet.has(k)));
	const falseNegatives = new Set([...expectedSet].filter((k) => !resolvedSet.has(k)));

	const precision = resolvedSet.size > 0 ? truePositives.size / resolvedSet.size : 0;
	const recall = expectedSet.size > 0 ? truePositives.size / expectedSet.size : 0;

	const byMode: Record<string, ModeMetrics> = {};
	for (const edge of expectedEdges) {
		const mode = edge.mode || 'unknown';
		if (!byMode[mode]) byMode[mode] = { expected: 0, resolved: 0, recall: 0 };
		byMode[mode].expected++;
		const key = edgeKey(edge.source.name, edge.source.file, edge.target.name, edge.target.file);
		if (resolvedSet.has(key)) byMode[mode].resolved++;
	}
	for (const mode of Object.keys(byMode)) {
		const m = byMode[mode];
		m.recall = m.expected > 0 ? m.resolved / m.expected : 0;
	}

	return {
		precision: Math.round(precision * 1000) / 1000,
		recall: Math.round(recall * 1000) / 1000,
		truePositives: truePositives.size,
		falsePositives: falsePositives.size,
		falseNegatives: falseNegatives.size,
		totalResolved: resolvedSet.size,
		totalExpected: expectedSet.size,
		byMode,
	};
}

function discoverFixtures(): string[] {
	if (!fs.existsSync(FIXTURES_DIR)) return [];
	const languages: string[] = [];
	for (const dir of fs.readdirSync(FIXTURES_DIR)) {
		const manifestPath = path.join(FIXTURES_DIR, dir, 'expected-edges.json');
		if (fs.existsSync(manifestPath)) {
			languages.push(dir);
		}
	}
	return languages;
}

// ── Dynamic tracing ────────────────────────────────────────────────────

const TRACER_SCRIPT = path.join(root, 'tests', 'benchmarks', 'resolution', 'tracer', 'run-tracer.mjs');

/**
 * Attempt to run the dynamic call tracer for a language fixture.
 * Returns captured edges on success, empty array on failure or unavailability.
 */
function runDynamicTracer(lang: string): DynamicEdge[] {
	if (!fs.existsSync(TRACER_SCRIPT)) return [];

	const fixtureDir = path.join(FIXTURES_DIR, lang);
	try {
		const result = execFileSync(process.execPath, [TRACER_SCRIPT, fixtureDir], {
			encoding: 'utf-8',
			timeout: 60_000,
			env: { ...process.env, NODE_NO_WARNINGS: '1' },
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const parsed = JSON.parse(result);
		if (parsed.error) {
			console.error(`    Dynamic tracer for ${lang}: ${parsed.error}`);
		}
		return Array.isArray(parsed.edges) ? parsed.edges : [];
	} catch {
		return [];
	}
}

/**
 * Merge dynamic edges with expected edges as supplemental ground truth.
 * Dynamic edges that aren't already in expected-edges get added with mode "dynamic".
 */
function mergeWithDynamic(expectedEdges: ExpectedEdge[], dynamicEdges: DynamicEdge[]): {
	merged: ExpectedEdge[];
	dynamicConfirmed: number;
} {
	const expectedSet = new Set(
		expectedEdges.map((e) => edgeKey(e.source.name, e.source.file, e.target.name, e.target.file)),
	);

	let dynamicConfirmed = 0;
	const newEdges: ExpectedEdge[] = [];

	for (const de of dynamicEdges) {
		const key = edgeKey(de.source_name, de.source_file, de.target_name, de.target_file);
		if (expectedSet.has(key)) {
			dynamicConfirmed++;
		} else {
			// New edge discovered only by dynamic tracing
			newEdges.push({
				source: { name: de.source_name, file: de.source_file },
				target: { name: de.target_name, file: de.target_file },
				mode: 'dynamic',
			});
		}
	}

	return {
		merged: [...expectedEdges, ...newEdges],
		dynamicConfirmed,
	};
}

// ── Main ────────────────────────────────────────────────────────────────

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

const { srcDir, cleanup } = await resolveBenchmarkSource();

try {
	const { buildGraph } = await import(srcImport(srcDir, 'domain/graph/builder.js'));
	const { openReadonlyOrFail } = await import(srcImport(srcDir, 'db/index.js'));

	const languages = discoverFixtures();
	const results: Record<string, LangResult> = {};

	for (const lang of languages) {
		console.error(`  Benchmarking resolution for ${lang}...`);

		const fixtureDir = copyFixture(lang);
		try {
			await buildGraph(fixtureDir, {
				incremental: false,
				engine: 'wasm',
				dataflow: false,
				cfg: false,
				ast: false,
			});

			const dbPath = path.join(fixtureDir, '.codegraph', 'graph.db');
			const db = openReadonlyOrFail(dbPath);
			let resolvedEdges: ResolvedEdge[];
			try {
				resolvedEdges = db
					.prepare(`
						SELECT
							src.name  AS source_name,
							src.file  AS source_file,
							tgt.name  AS target_name,
							tgt.file  AS target_file,
							e.kind    AS kind,
							e.confidence AS confidence
						FROM edges e
						JOIN nodes src ON e.source_id = src.id
						JOIN nodes tgt ON e.target_id = tgt.id
						WHERE e.kind = 'calls'
							AND src.kind IN ('function', 'method')
					`)
					.all() as ResolvedEdge[];
			} finally {
				db.close();
			}

			const manifestPath = path.join(FIXTURES_DIR, lang, 'expected-edges.json');
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
			const expectedEdges: ExpectedEdge[] = manifest.edges;

			// Run dynamic tracer if available
			const dynamicEdges = runDynamicTracer(lang);
			const { dynamicConfirmed } = mergeWithDynamic(expectedEdges, dynamicEdges);

			// Use only expected edges for metrics (dynamic edges are supplemental)
			const metrics = computeMetrics(resolvedEdges, expectedEdges);
			if (dynamicEdges.length > 0) {
				metrics.dynamicEdges = dynamicEdges.length;
				metrics.dynamicConfirmed = dynamicConfirmed;
			}
			results[lang] = metrics;

			const dynamicInfo =
				dynamicEdges.length > 0
					? ` dynamic=${dynamicEdges.length} confirmed=${dynamicConfirmed}`
					: '';
			console.error(
				`    ${lang}: precision=${(metrics.precision * 100).toFixed(1)}% recall=${(metrics.recall * 100).toFixed(1)}%${dynamicInfo}`,
			);
		} finally {
			fs.rmSync(fixtureDir, { recursive: true, force: true });
		}
	}

	// Restore console.log for JSON output
	console.log = origLog;
	console.log(JSON.stringify(results, null, 2));
} finally {
	console.log = origLog;
	cleanup();
}
