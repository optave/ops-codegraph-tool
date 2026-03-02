#!/usr/bin/env node

/**
 * Update incremental benchmark report — reads benchmark JSON and updates:
 *   generated/INCREMENTAL-BENCHMARKS.md (historical table + raw JSON in HTML comment)
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
const reportPath = path.join(root, 'generated', 'INCREMENTAL-BENCHMARKS.md');

// ── Load existing history ────────────────────────────────────────────────
let history = [];
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

function findPrevRelease(hist, fromIdx) {
	for (let i = fromIdx + 1; i < hist.length; i++) {
		if (hist[i].version !== 'dev') return hist[i];
	}
	return null;
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

function engineRow(h, prev, engineKey) {
	const e = h[engineKey];
	const p = prev?.[engineKey] || null;
	if (!e) return null;

	const fullT = trend(e.fullBuildMs, p?.fullBuildMs);
	const noopT = trend(e.noopRebuildMs, p?.noopRebuildMs);
	const oneT = trend(e.oneFileRebuildMs, p?.oneFileRebuildMs);

	const r = h.resolve;
	const pr = prev?.resolve || null;
	const natT = r.nativeBatchMs != null ? trend(r.nativeBatchMs, pr?.nativeBatchMs) : '';
	const jsT = trend(r.jsFallbackMs, pr?.jsFallbackMs);

	return (
		`| ${h.version} | ${engineKey} | ${h.files} ` +
		`| ${formatMs(e.fullBuildMs)}${fullT} ` +
		`| ${formatMs(e.noopRebuildMs)}${noopT} ` +
		`| ${formatMs(e.oneFileRebuildMs)}${oneT} ` +
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
	const h = history[i];
	const prev = findPrevRelease(history, i);

	const nativeRow = engineRow(h, prev, 'native');
	const wasmRow = engineRow(h, prev, 'wasm');
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
	md += `| No-op rebuild | ${formatMs(e.noopRebuildMs)} |\n`;
	md += `| 1-file rebuild | ${formatMs(e.oneFileRebuildMs)} |\n\n`;
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

md += `<!-- INCREMENTAL_BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, md);
console.error(`Updated ${path.relative(root, reportPath)}`);

// ── Regression detection ─────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 0.15; // 15% regression triggers a warning
const prev = findPrevRelease(history, 0);

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
		checkRegression(`${tag} Full build`, e.fullBuildMs, p.fullBuildMs);
		checkRegression(`${tag} No-op rebuild`, e.noopRebuildMs, p.noopRebuildMs);
		checkRegression(`${tag} 1-file rebuild`, e.oneFileRebuildMs, p.oneFileRebuildMs);
	}
	const re = latest.resolve;
	const rp = prev.resolve;
	if (re && rp) {
		checkRegression(`[resolve] JS fallback`, re.jsFallbackMs, rp.jsFallbackMs);
		if (re.nativeBatchMs != null && rp.nativeBatchMs != null) {
			checkRegression(`[resolve] Native batch`, re.nativeBatchMs, rp.nativeBatchMs);
		}
	}
}
