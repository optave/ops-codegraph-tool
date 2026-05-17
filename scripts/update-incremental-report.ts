#!/usr/bin/env node

/**
 * Update incremental benchmark report — reads benchmark JSON and updates:
 *   generated/benchmarks/INCREMENTAL-BENCHMARKS.md (historical table + raw JSON in HTML comment)
 *
 * Usage:
 *   node scripts/update-incremental-report.js incremental-benchmark-result.json
 *   node scripts/incremental-benchmark.js | node scripts/update-incremental-report.js
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
const reportPath =
	process.env.CODEGRAPH_INCREMENTAL_REPORT_PATH ??
	path.join(root, 'generated', 'benchmarks', 'INCREMENTAL-BENCHMARKS.md');

// ── Load existing history + manual NOTES block ───────────────────────────
let history = [];
let notesBlock = '';
if (fs.existsSync(reportPath)) {
	const content = fs.readFileSync(reportPath, 'utf8');
	const match = content.match(/<!--\s*INCREMENTAL_BENCHMARK_DATA\s*([\s\S]*?)\s*-->/);
	if (match) {
		try {
			history = JSON.parse(match[1]);
		} catch {
			/* start fresh if corrupt */
		}
	}
	// Use matchAll so multiple NOTES blocks (annotating different anomalous releases)
	// are all preserved. The exact data-loss bug this fix targets stemmed from silently
	// dropping a NOTES block; we must not reintroduce that failure mode for additional blocks.
	const notesMatches = content.matchAll(
		/<!--\s*NOTES_START\s*-->[\s\S]*?<!--\s*NOTES_END\s*-->/g,
	);
	notesBlock = Array.from(notesMatches, (m) => m[0]).join('\n\n');
}

// Add new entry — dev entries are rolling, releases replace dev
const isDev = entry.version === 'dev';
const idx = history.findIndex((h) => h.version === entry.version);
if (idx >= 0) history.splice(idx, 1);
if (!isDev) {
	const devIdx = history.findIndex((h) => h.version === 'dev');
	if (devIdx >= 0) history.splice(devIdx, 1);
}
history.unshift(entry);

// Walk back through release history to find the most recent non-null value
// for a specific metric. Lets trend annotations skip past releases whose
// workers crashed and stored null, instead of hiding regressions behind an
// empty cell.
function findPrevMetric(hist, fromIdx, getter) {
	for (let i = fromIdx + 1; i < hist.length; i++) {
		if (hist[i].version === 'dev') continue;
		const v = getter(hist[i]);
		if (v != null) return v;
	}
	return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function trend(current, previous, lowerIsBetter = true) {
	// Guard against null/undefined and a zero baseline — dividing by zero would
	// emit `↑Infinity%`. Matches the `previous === 0` guard in checkRegression.
	if (current == null || previous == null || previous === 0) return '';
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

function engineRow(hist, i, engineKey, prevResolveNative, prevResolveJs) {
	const h = hist[i];
	const e = h[engineKey];
	if (!e) return null;

	const fullT = trend(e.fullBuildMs, findPrevMetric(hist, i, (r) => r[engineKey]?.fullBuildMs));
	const noopT = trend(e.noopRebuildMs, findPrevMetric(hist, i, (r) => r[engineKey]?.noopRebuildMs));
	const oneT = trend(
		e.oneFileRebuildMs,
		findPrevMetric(hist, i, (r) => r[engineKey]?.oneFileRebuildMs),
	);

	const r = h.resolve;
	const natT = r.nativeBatchMs != null ? trend(r.nativeBatchMs, prevResolveNative) : '';
	const jsT = trend(r.jsFallbackMs, prevResolveJs);

	const noopCell = e.noopRebuildMs != null ? `${formatMs(e.noopRebuildMs)}${noopT}` : 'n/a';
	const oneFileCell = e.oneFileRebuildMs != null ? `${formatMs(e.oneFileRebuildMs)}${oneT}` : 'n/a';

	return (
		`| ${h.version} | ${engineKey} | ${h.files} ` +
		`| ${formatMs(e.fullBuildMs)}${fullT} ` +
		`| ${noopCell} ` +
		`| ${oneFileCell} ` +
		`| ${r.nativeBatchMs != null ? formatMs(r.nativeBatchMs) + natT : 'n/a'} ` +
		`| ${formatMs(r.jsFallbackMs)}${jsT} |`
	);
}

// ── Build INCREMENTAL-BENCHMARKS.md ──────────────────────────────────────
let md = '# Codegraph Incremental Build Benchmarks\n\n';
md += 'Self-measured on every release by running codegraph on its own codebase.\n';
md += 'Build tiers: full (cold), no-op (nothing changed), 1-file (single file modified).\n';
md += 'Import resolution: native batch vs JS fallback throughput.\n\n';

md +=
	'| Version | Engine | Files | Full Build | No-op | 1-File | Resolve (native) | Resolve (JS) |\n';
md +=
	'|---------|--------|------:|-----------:|------:|-------:|------------------:|-------------:|\n';

for (let i = 0; i < history.length; i++) {
	// Resolve metrics are release-level (not engine-specific), so pre-compute
	// their fallback baselines once per release instead of having engineRow walk
	// history twice (once per engine type).
	const prevResolveNative = findPrevMetric(history, i, (x) => x.resolve?.nativeBatchMs);
	const prevResolveJs = findPrevMetric(history, i, (x) => x.resolve?.jsFallbackMs);
	const nativeRow = engineRow(history, i, 'native', prevResolveNative, prevResolveJs);
	const wasmRow = engineRow(history, i, 'wasm', prevResolveNative, prevResolveJs);
	if (nativeRow) md += nativeRow + '\n';
	if (wasmRow) md += wasmRow + '\n';
}

// ── Latest summary ───────────────────────────────────────────────────────
const latest = history[0];
md += '\n### Latest results\n\n';
md += `**Version:** ${latest.version} | **Files:** ${latest.files} | **Date:** ${latest.date}\n\n`;

for (const engineKey of ['native', 'wasm']) {
	const e = latest[engineKey];
	if (!e) continue;

	md += `#### ${engineKey === 'native' ? 'Native (Rust)' : 'WASM'}\n\n`;
	md += '| Metric | Value |\n';
	md += '|--------|------:|\n';
	md += `| Full build | ${formatMs(e.fullBuildMs)} |\n`;
	md += `| No-op rebuild | ${e.noopRebuildMs != null ? formatMs(e.noopRebuildMs) : 'n/a'} |\n`;
	md += `| 1-file rebuild | ${e.oneFileRebuildMs != null ? formatMs(e.oneFileRebuildMs) : 'n/a'} |\n\n`;
}

const r = latest.resolve;
md += '#### Import Resolution\n\n';
md += '| Metric | Value |\n';
md += '|--------|------:|\n';
md += `| Import pairs | ${r.imports} |\n`;
md += `| Native batch | ${r.nativeBatchMs != null ? formatMs(r.nativeBatchMs) : 'n/a'} |\n`;
md += `| JS fallback | ${formatMs(r.jsFallbackMs)} |\n`;
md += `| Per-import (native) | ${r.perImportNativeMs != null ? `${r.perImportNativeMs}ms` : 'n/a'} |\n`;
md += `| Per-import (JS) | ${r.perImportJsMs}ms |\n`;
if (r.nativeBatchMs != null && r.jsFallbackMs > 0) {
	md += `| Speedup ratio | ${(r.jsFallbackMs / r.nativeBatchMs).toFixed(1)}x |\n`;
}
md += '\n';

if (notesBlock) md += `${notesBlock}\n\n`;

md += `<!-- INCREMENTAL_BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, md);
console.error(`Updated ${path.relative(root, reportPath)}`);

// ── Regression detection ─────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 0.15; // 15% regression triggers a warning

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

for (const engineKey of ['native', 'wasm']) {
	const e = latest[engineKey];
	if (!e) continue;
	const tag = `[${engineKey}]`;
	checkRegression(
		`${tag} Full build`,
		e.fullBuildMs,
		findPrevMetric(history, 0, (r) => r[engineKey]?.fullBuildMs),
	);
	if (e.noopRebuildMs != null) {
		checkRegression(
			`${tag} No-op rebuild`,
			e.noopRebuildMs,
			findPrevMetric(history, 0, (r) => r[engineKey]?.noopRebuildMs),
		);
	}
	if (e.oneFileRebuildMs != null) {
		checkRegression(
			`${tag} 1-file rebuild`,
			e.oneFileRebuildMs,
			findPrevMetric(history, 0, (r) => r[engineKey]?.oneFileRebuildMs),
		);
	}
}
const re = latest.resolve;
if (re) {
	checkRegression(
		`[resolve] JS fallback`,
		re.jsFallbackMs,
		findPrevMetric(history, 0, (r) => r.resolve?.jsFallbackMs),
	);
	if (re.nativeBatchMs != null) {
		checkRegression(
			`[resolve] Native batch`,
			re.nativeBatchMs,
			findPrevMetric(history, 0, (r) => r.resolve?.nativeBatchMs),
		);
	}
}
