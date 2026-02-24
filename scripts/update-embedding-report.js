#!/usr/bin/env node

/**
 * Update embedding benchmark report — reads benchmark JSON and updates:
 *   generated/EMBEDDING-BENCHMARKS.md (historical table + raw JSON in HTML comment)
 *
 * Usage:
 *   node scripts/update-embedding-report.js embedding-benchmark-result.json
 *   node scripts/embedding-benchmark.js | node scripts/update-embedding-report.js
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
const reportPath = path.join(root, 'generated', 'EMBEDDING-BENCHMARKS.md');

// ── Load existing history ────────────────────────────────────────────────
let history = [];
if (fs.existsSync(reportPath)) {
	const content = fs.readFileSync(reportPath, 'utf8');
	const match = content.match(/<!--\s*EMBEDDING_BENCHMARK_DATA\s*([\s\S]*?)\s*-->/);
	if (match) {
		try {
			history = JSON.parse(match[1]);
		} catch {
			/* start fresh if corrupt */
		}
	}
}

// Add new entry (deduplicate by version)
const idx = history.findIndex((h) => h.version === entry.version);
if (idx >= 0) {
	history[idx] = entry;
} else {
	history.unshift(entry);
}

// ── Helpers ──────────────────────────────────────────────────────────────
function pct(n, total) {
	return `${((n / total) * 100).toFixed(1)}%`;
}

function trend(current, previous) {
	if (previous == null) return '';
	const diff = current - previous;
	if (Math.abs(diff) < 0.5) return ' ~';
	return diff > 0 ? ` ↑${diff.toFixed(1)}pp` : ` ↓${Math.abs(diff).toFixed(1)}pp`;
}

function pctVal(n, total) {
	return (n / total) * 100;
}

function formatMs(ms) {
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

// ── Build EMBEDDING-BENCHMARKS.md ────────────────────────────────────────
let md = '# Codegraph Embedding Benchmarks\n\n';
md += 'Self-measured on every release using auto-generated queries from symbol names.\n';
md += 'Each symbol\'s name is split into words (e.g. `buildGraph` → `"build graph"`) and used as the search query.\n';
md += 'Hit@N = expected symbol found in top N results.\n\n';

md +=
	'| Version | Model | Symbols | Hit@1 | Hit@3 | Hit@5 | Misses | Embed Time |\n';
md +=
	'|---------|-------|--------:|------:|------:|------:|-------:|-----------:|\n';

for (let i = 0; i < history.length; i++) {
	const h = history[i];
	const prev = history[i + 1] || null;

	for (const [modelKey, m] of Object.entries(h.models)) {
		const pm = prev?.models?.[modelKey] || null;

		const h1 = pctVal(m.hits1, m.total);
		const h3 = pctVal(m.hits3, m.total);
		const h5 = pctVal(m.hits5, m.total);
		const ph1 = pm ? pctVal(pm.hits1, pm.total) : null;
		const ph3 = pm ? pctVal(pm.hits3, pm.total) : null;
		const ph5 = pm ? pctVal(pm.hits5, pm.total) : null;

		md += `| ${h.version} | ${modelKey} | ${m.total} `;
		md += `| ${pct(m.hits1, m.total)}${trend(h1, ph1)} `;
		md += `| ${pct(m.hits3, m.total)}${trend(h3, ph3)} `;
		md += `| ${pct(m.hits5, m.total)}${trend(h5, ph5)} `;
		md += `| ${m.misses} `;
		md += `| ${formatMs(m.embedTimeMs)} |\n`;
	}
}

// ── Latest summary ───────────────────────────────────────────────────────
const latest = history[0];
md += '\n### Latest results\n\n';
md += `**Version:** ${latest.version} | **Strategy:** ${latest.strategy} | **Symbols:** ${latest.symbols} | **Date:** ${latest.date}\n\n`;

md += '| Model | Dim | Context | Hit@1 | Hit@3 | Hit@5 | Hit@10 | Misses | Embed | Search |\n';
md += '|-------|----:|--------:|------:|------:|------:|-------:|-------:|------:|-------:|\n';

for (const [modelKey, m] of Object.entries(latest.models)) {
	md += `| ${modelKey} `;
	md += `| ${m.dim} `;
	md += `| ${m.contextWindow} `;
	md += `| ${pct(m.hits1, m.total)} `;
	md += `| ${pct(m.hits3, m.total)} `;
	md += `| ${pct(m.hits5, m.total)} `;
	md += `| ${pct(m.hits10, m.total)} `;
	md += `| ${m.misses} `;
	md += `| ${formatMs(m.embedTimeMs)} `;
	md += `| ${formatMs(m.searchTimeMs)} |\n`;
}

md += `\n<!-- EMBEDDING_BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, md);
console.error(`Updated ${path.relative(root, reportPath)}`);

// ── Regression detection ─────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 0.15; // 15% regression triggers a warning
const prev = history[1] || null;

function checkRegression(label, current, previous, lowerIsBetter = true) {
	if (previous == null || previous === 0) return;
	const pct = (current - previous) / previous;
	const regressed = lowerIsBetter ? pct > REGRESSION_THRESHOLD : pct < -REGRESSION_THRESHOLD;
	if (regressed) {
		const delta = lowerIsBetter ? `+${Math.round(pct * 100)}%` : `${Math.round(pct * 100)}%`;
		const msg = `${label}: ${previous} → ${current} (${delta}, threshold ${Math.round(REGRESSION_THRESHOLD * 100)}%)`;
		if (process.env.GITHUB_ACTIONS) {
			console.error(`::warning title=Benchmark Regression::${msg}`);
		} else {
			console.error(`⚠ REGRESSION: ${msg}`);
		}
	}
}

if (prev) {
	for (const [modelKey, m] of Object.entries(latest.models)) {
		const pm = prev.models?.[modelKey];
		if (!pm) continue;
		const tag = `[${modelKey}]`;
		// Hit rates: higher is better (regression = drop)
		checkRegression(`${tag} Hit@1`, m.hits1 / m.total, pm.hits1 / pm.total, false);
		checkRegression(`${tag} Hit@5`, m.hits5 / m.total, pm.hits5 / pm.total, false);
		// Embed time: lower is better (regression = increase)
		checkRegression(`${tag} Embed time`, m.embedTimeMs, pm.embedTimeMs);
	}
}
