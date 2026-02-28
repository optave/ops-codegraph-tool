#!/usr/bin/env node

/**
 * Update query benchmark report — reads benchmark JSON and updates:
 *   generated/QUERY-BENCHMARKS.md (historical table + raw JSON in HTML comment)
 *
 * Usage:
 *   node scripts/update-query-report.js query-benchmark-result.json
 *   node scripts/query-benchmark.js | node scripts/update-query-report.js
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
const reportPath = path.join(root, 'generated', 'QUERY-BENCHMARKS.md');

// ── Load existing history ────────────────────────────────────────────────
let history = [];
if (fs.existsSync(reportPath)) {
	const content = fs.readFileSync(reportPath, 'utf8');
	const match = content.match(/<!--\s*QUERY_BENCHMARK_DATA\s*([\s\S]*?)\s*-->/);
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
	return `${Math.round(ms * 10) / 10}ms`;
}

function engineRow(h, prev, engineKey) {
	const e = h[engineKey];
	const p = prev?.[engineKey] || null;
	if (!e) return null;

	const d1t = trend(e.fnDeps.depth1Ms, p?.fnDeps?.depth1Ms);
	const d3t = trend(e.fnDeps.depth3Ms, p?.fnDeps?.depth3Ms);
	const d5t = trend(e.fnDeps.depth5Ms, p?.fnDeps?.depth5Ms);
	const i1t = trend(e.fnImpact.depth1Ms, p?.fnImpact?.depth1Ms);
	const i3t = trend(e.fnImpact.depth3Ms, p?.fnImpact?.depth3Ms);
	const i5t = trend(e.fnImpact.depth5Ms, p?.fnImpact?.depth5Ms);
	const dit = trend(e.diffImpact.latencyMs, p?.diffImpact?.latencyMs);

	return (
		`| ${h.version} | ${engineKey} ` +
		`| ${e.fnDeps.depth1Ms}${d1t} ` +
		`| ${e.fnDeps.depth3Ms}${d3t} ` +
		`| ${e.fnDeps.depth5Ms}${d5t} ` +
		`| ${e.fnImpact.depth1Ms}${i1t} ` +
		`| ${e.fnImpact.depth3Ms}${i3t} ` +
		`| ${e.fnImpact.depth5Ms}${i5t} ` +
		`| ${formatMs(e.diffImpact.latencyMs)}${dit} |`
	);
}

// ── Build QUERY-BENCHMARKS.md ────────────────────────────────────────────
let md = '# Codegraph Query Benchmarks\n\n';
md += 'Self-measured on every release by running codegraph queries on its own graph.\n';
md += 'Latencies are median over 5 runs. Hub target = most-connected node.\n\n';

md +=
	'| Version | Engine | fnDeps d1 | fnDeps d3 | fnDeps d5 | fnImpact d1 | fnImpact d3 | fnImpact d5 | diffImpact |\n';
md +=
	'|---------|--------|----------:|----------:|----------:|------------:|------------:|------------:|-----------:|\n';

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
md += `**Version:** ${latest.version} | **Date:** ${latest.date}\n\n`;

for (const engineKey of ['native', 'wasm']) {
	const e = latest[engineKey];
	if (!e) continue;

	md += `#### ${engineKey === 'native' ? 'Native (Rust)' : 'WASM'}\n\n`;
	md += `**Targets:** hub=\`${e.targets.hub}\`, mid=\`${e.targets.mid}\`, leaf=\`${e.targets.leaf}\`\n\n`;

	md += '| Metric | Value |\n';
	md += '|--------|------:|\n';
	md += `| fnDeps depth 1 | ${formatMs(e.fnDeps.depth1Ms)} |\n`;
	md += `| fnDeps depth 3 | ${formatMs(e.fnDeps.depth3Ms)} |\n`;
	md += `| fnDeps depth 5 | ${formatMs(e.fnDeps.depth5Ms)} |\n`;
	md += `| fnImpact depth 1 | ${formatMs(e.fnImpact.depth1Ms)} |\n`;
	md += `| fnImpact depth 3 | ${formatMs(e.fnImpact.depth3Ms)} |\n`;
	md += `| fnImpact depth 5 | ${formatMs(e.fnImpact.depth5Ms)} |\n`;
	md += `| diffImpact latency | ${formatMs(e.diffImpact.latencyMs)} |\n`;
	md += `| diffImpact affected functions | ${e.diffImpact.affectedFunctions} |\n`;
	md += `| diffImpact affected files | ${e.diffImpact.affectedFiles} |\n\n`;
}

md += `<!-- QUERY_BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

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
		checkRegression(`${tag} fnDeps d1`, e.fnDeps.depth1Ms, p.fnDeps.depth1Ms);
		checkRegression(`${tag} fnDeps d3`, e.fnDeps.depth3Ms, p.fnDeps.depth3Ms);
		checkRegression(`${tag} fnDeps d5`, e.fnDeps.depth5Ms, p.fnDeps.depth5Ms);
		checkRegression(`${tag} fnImpact d1`, e.fnImpact.depth1Ms, p.fnImpact.depth1Ms);
		checkRegression(`${tag} fnImpact d3`, e.fnImpact.depth3Ms, p.fnImpact.depth3Ms);
		checkRegression(`${tag} fnImpact d5`, e.fnImpact.depth5Ms, p.fnImpact.depth5Ms);
		checkRegression(`${tag} diffImpact`, e.diffImpact.latencyMs, p.diffImpact.latencyMs);
	}
}
