#!/usr/bin/env node

/**
 * Update benchmark report — reads benchmark JSON and updates:
 *   1. generated/BUILD-BENCHMARKS.md  (historical table + raw JSON in HTML comment)
 *   2. README.md                (performance section with latest numbers)
 *
 * Usage:
 *   node scripts/update-benchmark-report.js benchmark-result.json
 *   node scripts/benchmark.js | node scripts/update-benchmark-report.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── Read benchmark JSON from file arg or stdin ───────────────────────────
let jsonText;
const arg = process.argv[2];
if (arg) {
	jsonText = fs.readFileSync(path.resolve(arg), 'utf8');
} else {
	jsonText = fs.readFileSync('/dev/stdin', 'utf8');
}
const entry = JSON.parse(jsonText);

// ── Paths ────────────────────────────────────────────────────────────────
const benchmarkPath = path.join(root, 'generated', 'BUILD-BENCHMARKS.md');
const readmePath = path.join(root, 'README.md');

// ── Load existing history from BUILD-BENCHMARKS.md ─────────────────────────────
let history = [];
if (fs.existsSync(benchmarkPath)) {
	const content = fs.readFileSync(benchmarkPath, 'utf8');
	const match = content.match(/<!--\s*BENCHMARK_DATA\s*([\s\S]*?)\s*-->/);
	if (match) {
		try {
			history = JSON.parse(match[1]);
		} catch {
			/* start fresh if corrupt */
		}
	}
}

// Add new entry (deduplicate by version — replace if same version exists)
const idx = history.findIndex((h) => h.version === entry.version);
if (idx >= 0) {
	history[idx] = entry;
} else {
	history.unshift(entry);
}

// ── Helpers ──────────────────────────────────────────────────────────────
function trend(current, previous, lowerIsBetter = true) {
	if (previous == null) return '';
	const pct = ((current - previous) / previous) * 100;
	if (Math.abs(pct) < 2) return ' ~';
	if (lowerIsBetter) {
		return pct < 0 ? ` ↓${Math.abs(Math.round(pct))}%` : ` ↑${Math.round(pct)}%`;
	}
	return pct > 0 ? ` ↑${Math.round(pct)}%` : ` ↓${Math.abs(Math.round(pct))}%`;
}

function formatMs(ms) {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

function formatBytes(bytes) {
	if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${bytes} B`;
}

function engineRow(h, prev, engineKey) {
	const e = h[engineKey];
	const p = prev?.[engineKey] || null;
	if (!e) return null;

	const buildTrend = trend(e.perFile.buildTimeMs, p?.perFile?.buildTimeMs);
	const queryTrend = trend(e.queryTimeMs, p?.queryTimeMs);
	const nodeTrend = trend(e.perFile.nodes, p?.perFile?.nodes, false);
	const edgeTrend = trend(e.perFile.edges, p?.perFile?.edges, false);
	const dbTrend = trend(e.perFile.dbSizeBytes, p?.perFile?.dbSizeBytes);

	return (
		`| ${h.version} | ${engineKey} | ${h.date} | ${h.files} ` +
		`| ${e.perFile.buildTimeMs}${buildTrend} ` +
		`| ${e.queryTimeMs}${queryTrend} ` +
		`| ${e.perFile.nodes}${nodeTrend} ` +
		`| ${e.perFile.edges}${edgeTrend} ` +
		`| ${e.perFile.dbSizeBytes}${dbTrend} |`
	);
}

// ── Build BUILD-BENCHMARKS.md ──────────────────────────────────────────────────
let md = '# Codegraph Performance Benchmarks\n\n';
md += 'Self-measured on every release by running codegraph on its own codebase.\n';
md += 'Metrics are normalized per file for cross-version comparability.\n\n';

md +=
	'| Version | Engine | Date | Files | Build (ms/file) | Query (ms) | Nodes/file | Edges/file | DB (bytes/file) |\n';
md +=
	'|---------|--------|------|------:|----------------:|-----------:|-----------:|-----------:|----------------:|\n';

for (let i = 0; i < history.length; i++) {
	const h = history[i];
	const prev = history[i + 1] || null;

	const nativeRow = engineRow(h, prev, 'native');
	const wasmRow = engineRow(h, prev, 'wasm');
	if (nativeRow) md += nativeRow + '\n';
	if (wasmRow) md += wasmRow + '\n';
}

md += '\n### Raw totals (latest)\n\n';
const latest = history[0];

for (const engineKey of ['native', 'wasm']) {
	const e = latest[engineKey];
	if (!e) continue;

	md += `#### ${engineKey === 'native' ? 'Native (Rust)' : 'WASM'}\n\n`;
	md += `| Metric | Value |\n`;
	md += `|--------|-------|\n`;
	md += `| Build time | ${formatMs(e.buildTimeMs)} |\n`;
	md += `| Query time | ${formatMs(e.queryTimeMs)} |\n`;
	md += `| Nodes | ${e.nodes.toLocaleString()} |\n`;
	md += `| Edges | ${e.edges.toLocaleString()} |\n`;
	md += `| DB size | ${formatBytes(e.dbSizeBytes)} |\n`;
	md += `| Files | ${latest.files} |\n\n`;
}

// ── Extrapolated estimate for large repos ────────────────────────────────
const ESTIMATE_FILES = 50_000;
md += `### Estimated performance at ${(ESTIMATE_FILES).toLocaleString()} files\n\n`;
md += 'Extrapolated linearly from per-file metrics above.\n\n';
md += '| Metric | Native (Rust) | WASM |\n';
md += '|--------|---:|---:|\n';

const estNative = latest.native?.perFile;
const estWasm = latest.wasm.perFile;
md += `| Build time | ${estNative ? formatMs(estNative.buildTimeMs * ESTIMATE_FILES) : 'n/a'} | ${formatMs(estWasm.buildTimeMs * ESTIMATE_FILES)} |\n`;
md += `| DB size | ${estNative ? formatBytes(estNative.dbSizeBytes * ESTIMATE_FILES) : 'n/a'} | ${formatBytes(estWasm.dbSizeBytes * ESTIMATE_FILES)} |\n`;
md += `| Nodes | ${estNative ? Math.round(estNative.nodes * ESTIMATE_FILES).toLocaleString() : 'n/a'} | ${Math.round(estWasm.nodes * ESTIMATE_FILES).toLocaleString()} |\n`;
md += `| Edges | ${estNative ? Math.round(estNative.edges * ESTIMATE_FILES).toLocaleString() : 'n/a'} | ${Math.round(estWasm.edges * ESTIMATE_FILES).toLocaleString()} |\n\n`;

md += `<!-- BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

fs.mkdirSync(path.dirname(benchmarkPath), { recursive: true });
fs.writeFileSync(benchmarkPath, md);
console.error(`Updated ${path.relative(root, benchmarkPath)}`);

// ── Regression detection ─────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 0.15; // 15% regression triggers a warning
const prev = history[1] || null;

function checkRegression(label, current, previous) {
	if (previous == null || previous === 0) return;
	const pct = (current - previous) / previous;
	if (pct > REGRESSION_THRESHOLD) {
		const msg = `${label}: ${previous} → ${current} (+${Math.round(pct * 100)}%, threshold ${Math.round(REGRESSION_THRESHOLD * 100)}%)`;
		if (process.env.GITHUB_ACTIONS) {
			console.error(`::warning title=Benchmark Regression::${msg}`);
		} else {
			console.error(`⚠ REGRESSION: ${msg}`);
		}
	}
}

if (prev) {
	for (const engineKey of ['native', 'wasm']) {
		const e = latest[engineKey];
		const p = prev[engineKey];
		if (!e || !p) continue;
		const tag = `[${engineKey}]`;
		checkRegression(`${tag} Build ms/file`, e.perFile.buildTimeMs, p.perFile.buildTimeMs);
		checkRegression(`${tag} Query time`, e.queryTimeMs, p.queryTimeMs);
		checkRegression(`${tag} DB bytes/file`, e.perFile.dbSizeBytes, p.perFile.dbSizeBytes);
	}
}

// ── Patch README.md ──────────────────────────────────────────────────────
if (fs.existsSync(readmePath)) {
	let readme = fs.readFileSync(readmePath, 'utf8');

	// Build the table rows — show both engines when native is available
	let rows = '';
	if (latest.native) {
		rows += `| Build speed (native) | **${latest.native.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Build speed (WASM) | **${latest.wasm.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Query time | **${formatMs(latest.native.queryTimeMs)}** |\n`;
	} else {
		rows += `| Build speed | **${latest.wasm.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Query time | **${formatMs(latest.wasm.queryTimeMs)}** |\n`;
	}

	// 50k-file estimate
	const estBuild = latest.native
		? formatMs(latest.native.perFile.buildTimeMs * ESTIMATE_FILES)
		: formatMs(latest.wasm.perFile.buildTimeMs * ESTIMATE_FILES);
	rows += `| ~${(ESTIMATE_FILES).toLocaleString()} files (est.) | **~${estBuild} build** |\n`;

	const perfSection = `## 📊 Performance

Self-measured on every release via CI ([build benchmarks](generated/BUILD-BENCHMARKS.md) | [embedding benchmarks](generated/EMBEDDING-BENCHMARKS.md)):

| Metric | Latest |
|---|---|
${rows}
Metrics are normalized per file for cross-version comparability. Times above are for a full initial build — incremental rebuilds only re-parse changed files.
`;

	// Match the performance section from header to next h2/h3 header or end.
	// The lookahead stops at ## (h2) or ### (h3) so subsections like
	// "### Lightweight Footprint" are preserved and not swallowed.
	const perfRegex = /## 📊 Performance\r?\n[\s\S]*?(?=\r?\n#{2,3} |$)/;
	if (perfRegex.test(readme)) {
		readme = readme.replace(perfRegex, perfSection);
	} else {
		console.error('Warning: could not find performance section in README.md');
	}

	fs.writeFileSync(readmePath, readme);
	console.error(`Updated ${path.relative(root, readmePath)}`);
}
