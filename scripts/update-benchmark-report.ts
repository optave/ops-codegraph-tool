#!/usr/bin/env node

/**
 * Update benchmark report — reads benchmark JSON and updates:
 *   1. generated/benchmarks/BUILD-BENCHMARKS.md  (historical table + raw JSON in HTML comment)
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
const benchmarkPath = path.join(root, 'generated', 'benchmarks', 'BUILD-BENCHMARKS.md');
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

// Add new entry — dev entries are rolling, releases replace dev
const isDev = entry.version === 'dev';
const idx = history.findIndex((h) => h.version === entry.version);
if (idx >= 0) history.splice(idx, 1);
// If this is a release, also remove any "dev" entry
if (!isDev) {
	const devIdx = history.findIndex((h) => h.version === 'dev');
	if (devIdx >= 0) history.splice(devIdx, 1);
}
history.unshift(entry);

/**
 * Find the next non-dev entry after index `idx` for trend comparison.
 * Dev trends compare against the latest release; release trends skip dev.
 */
function findPrevRelease(hist, fromIdx) {
	for (let i = fromIdx + 1; i < hist.length; i++) {
		if (hist[i].version !== 'dev') return hist[i];
	}
	return null;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function trend(current, previous, lowerIsBetter = true) {
	if (current == null || previous == null) return '';
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
	const prev = findPrevRelease(history, i);

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

// ── Shared phase definitions ──────────────────────────────────────────
const PHASE_KEYS = ['parseMs', 'insertMs', 'resolveMs', 'edgesMs', 'structureMs', 'rolesMs', 'astMs', 'complexityMs', 'cfgMs', 'dataflowMs'];
const PHASE_LABELS = {
	parseMs: 'Parse',
	insertMs: 'Insert nodes',
	resolveMs: 'Resolve imports',
	edgesMs: 'Build edges',
	structureMs: 'Structure',
	rolesMs: 'Roles',
	astMs: 'AST nodes',
	complexityMs: 'Complexity',
	cfgMs: 'CFG',
	dataflowMs: 'Dataflow',
};

function fmtPhase(val) {
	return val != null ? val + ' ms' : 'n/a';
}

// ── Build Phase Breakdown (latest) ────────────────────────────────────
const hasPhases = latest.native?.phases || latest.wasm?.phases;
const hasOneFilePhases = latest.native?.oneFilePhases || latest.wasm?.oneFilePhases;
if (hasPhases) {
	md += '### Build Phase Breakdown (latest)\n\n';
	if (hasOneFilePhases) {
		md += '| Phase | Native (build) | WASM (build) | Native (1-file) | WASM (1-file) |\n';
		md += '|-------|---------------:|-------------:|----------------:|--------------:|\n';
		for (const key of PHASE_KEYS) {
			const nb = fmtPhase(latest.native?.phases?.[key]);
			const wb = fmtPhase(latest.wasm?.phases?.[key]);
			const nr = fmtPhase(latest.native?.oneFilePhases?.[key]);
			const wr = fmtPhase(latest.wasm?.oneFilePhases?.[key]);
			md += `| ${PHASE_LABELS[key]} | ${nb} | ${wb} | ${nr} | ${wr} |\n`;
		}
	} else {
		md += '| Phase | Native | WASM |\n';
		md += '|-------|-------:|-----:|\n';
		for (const key of PHASE_KEYS) {
			md += `| ${PHASE_LABELS[key]} | ${fmtPhase(latest.native?.phases?.[key])} | ${fmtPhase(latest.wasm?.phases?.[key])} |\n`;
		}
	}
	md += '\n';
}

// ── Extrapolated estimate for large repos ────────────────────────────────
const ESTIMATE_FILES = 50_000;
md += `### Estimated performance at ${(ESTIMATE_FILES).toLocaleString()} files\n\n`;
md += 'Extrapolated linearly from per-file metrics above.\n\n';
md += '| Metric | Native (Rust) | WASM |\n';
md += '|--------|---:|---:|\n';

const estNative = latest.native?.perFile;
const estWasm = latest.wasm?.perFile;
md += `| Build time | ${estNative ? formatMs(estNative.buildTimeMs * ESTIMATE_FILES) : 'n/a'} | ${estWasm ? formatMs(estWasm.buildTimeMs * ESTIMATE_FILES) : 'n/a'} |\n`;
md += `| DB size | ${estNative ? formatBytes(estNative.dbSizeBytes * ESTIMATE_FILES) : 'n/a'} | ${estWasm ? formatBytes(estWasm.dbSizeBytes * ESTIMATE_FILES) : 'n/a'} |\n`;
md += `| Nodes | ${estNative ? Math.round(estNative.nodes * ESTIMATE_FILES).toLocaleString() : 'n/a'} | ${estWasm ? Math.round(estWasm.nodes * ESTIMATE_FILES).toLocaleString() : 'n/a'} |\n`;
md += `| Edges | ${estNative ? Math.round(estNative.edges * ESTIMATE_FILES).toLocaleString() : 'n/a'} | ${estWasm ? Math.round(estWasm.edges * ESTIMATE_FILES).toLocaleString() : 'n/a'} |\n\n`;

// ── Incremental Rebuilds section ──────────────────────────────────────────
const hasIncremental = history.some(
	(h) =>
		h.wasm?.noopRebuildMs != null ||
		h.native?.noopRebuildMs != null ||
		h.wasm?.oneFileRebuildMs != null ||
		h.native?.oneFileRebuildMs != null,
);
if (hasIncremental) {
	md += '### Incremental Rebuilds\n\n';
	md += '| Version | Engine | No-op (ms) | 1-file (ms) |\n';
	md += '|---------|--------|----------:|-----------:|\n';

	for (let i = 0; i < history.length; i++) {
		const h = history[i];
		const prev = findPrevRelease(history, i);

		for (const engineKey of ['native', 'wasm']) {
			const e = h[engineKey];
			if (!e || (e.noopRebuildMs == null && e.oneFileRebuildMs == null)) continue;
			const p = prev?.[engineKey] || null;

			const noopTrend = trend(e.noopRebuildMs, p?.noopRebuildMs);
			const noopCell = e.noopRebuildMs != null ? `${e.noopRebuildMs}${noopTrend}` : 'n/a';
			const oneFileTrend = trend(e.oneFileRebuildMs, p?.oneFileRebuildMs);
			const oneFileCell = e.oneFileRebuildMs != null ? `${e.oneFileRebuildMs}${oneFileTrend}` : 'n/a';

			md += `| ${h.version} | ${engineKey} | ${noopCell} | ${oneFileCell} |\n`;
		}
	}
	md += '\n';
}

// ── Query Latency section ─────────────────────────────────────────────────
const hasQueries = history.some((h) => h.wasm?.queries != null || h.native?.queries != null);
if (hasQueries) {
	md += '### Query Latency\n\n';
	md += '| Version | Engine | fn-deps (ms) | fn-impact (ms) | path (ms) | roles (ms) |\n';
	md += '|---------|--------|------------:|--------------:|----------:|----------:|\n';

	for (let i = 0; i < history.length; i++) {
		const h = history[i];
		const prev = findPrevRelease(history, i);

		for (const engineKey of ['native', 'wasm']) {
			const e = h[engineKey];
			if (!e?.queries) continue;
			const p = prev?.[engineKey]?.queries || null;

			const depsTrend = trend(e.queries.fnDepsMs, p?.fnDepsMs);
			const impactTrend = trend(e.queries.fnImpactMs, p?.fnImpactMs);
			const pathTrend = trend(e.queries.pathMs, p?.pathMs);
			const rolesTrend = trend(e.queries.rolesMs, p?.rolesMs);

			md += `| ${h.version} | ${engineKey} | ${e.queries.fnDepsMs}${depsTrend} | ${e.queries.fnImpactMs}${impactTrend} | ${e.queries.pathMs}${pathTrend} | ${e.queries.rolesMs}${rolesTrend} |\n`;
		}
	}
	md += '\n';
}

// ── Preserve hand-written notes from existing file ────────────────────
let notes = '';
if (fs.existsSync(benchmarkPath)) {
	const existing = fs.readFileSync(benchmarkPath, 'utf8');
	const notesMatch = existing.match(/<!-- NOTES_START -->\n([\s\S]*?)<!-- NOTES_END -->/);
	if (notesMatch) {
		notes = notesMatch[1];
	}
}
if (notes) {
	md += `<!-- NOTES_START -->\n${notes}<!-- NOTES_END -->\n\n`;
}

md += `<!-- BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

fs.mkdirSync(path.dirname(benchmarkPath), { recursive: true });
fs.writeFileSync(benchmarkPath, md);
console.error(`Updated ${path.relative(root, benchmarkPath)}`);

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
		checkRegression(`${tag} Build ms/file`, e.perFile.buildTimeMs, p.perFile.buildTimeMs);
		checkRegression(`${tag} Query time`, e.queryTimeMs, p.queryTimeMs);
		checkRegression(`${tag} DB bytes/file`, e.perFile.dbSizeBytes, p.perFile.dbSizeBytes);
		if (e.noopRebuildMs != null && p.noopRebuildMs != null) {
			checkRegression(`${tag} No-op rebuild`, e.noopRebuildMs, p.noopRebuildMs);
		}
		if (e.oneFileRebuildMs != null && p.oneFileRebuildMs != null) {
			checkRegression(`${tag} 1-file rebuild`, e.oneFileRebuildMs, p.oneFileRebuildMs);
		}
	}
}

// ── Resolution regression detection ─────────────────────────────────────
// Resolution metrics are "higher is better" — warn when they DROP.
// SYNC: These must match PRECISION_DROP_PP / RECALL_DROP_PP in
// tests/benchmarks/regression-guard.test.ts (the hard-fail gate side).
const PRECISION_DROP_THRESHOLD = 0.05; // warn if precision drops >5pp
const RECALL_DROP_THRESHOLD = 0.10;    // warn if recall drops >10pp

if (prev && latest.resolution && prev.resolution) {
	for (const lang of Object.keys(latest.resolution)) {
		const cur = latest.resolution[lang];
		const prv = prev.resolution?.[lang];
		if (!cur || !prv) continue;

		const precDrop = prv.precision - cur.precision;
		if (precDrop > PRECISION_DROP_THRESHOLD) {
			const msg = `[resolution] ${lang} precision: ${(prv.precision * 100).toFixed(1)}% → ${(cur.precision * 100).toFixed(1)}% (−${(precDrop * 100).toFixed(1)}pp, threshold ${(PRECISION_DROP_THRESHOLD * 100).toFixed(0)}pp)`;
			if (process.env.GITHUB_ACTIONS) {
				console.error(`::warning title=Resolution Regression::${msg}`);
			} else {
				console.error(`⚠ REGRESSION: ${msg}`);
			}
		}

		const recDrop = prv.recall - cur.recall;
		if (recDrop > RECALL_DROP_THRESHOLD) {
			const msg = `[resolution] ${lang} recall: ${(prv.recall * 100).toFixed(1)}% → ${(cur.recall * 100).toFixed(1)}% (−${(recDrop * 100).toFixed(1)}pp, threshold ${(RECALL_DROP_THRESHOLD * 100).toFixed(0)}pp)`;
			if (process.env.GITHUB_ACTIONS) {
				console.error(`::warning title=Resolution Regression::${msg}`);
			} else {
				console.error(`⚠ REGRESSION: ${msg}`);
			}
		}
	}
}

// ── Patch README.md ──────────────────────────────────────────────────────
if (fs.existsSync(readmePath)) {
	let readme = fs.readFileSync(readmePath, 'utf8');

	// Show both engines side-by-side when both are available;
	// fall back to native-only or WASM-only single-column layout otherwise.
	const hasNative = latest.native != null;
	const hasBoth = hasNative && latest.wasm != null;

	let rows = '';
	if (hasBoth) {
		rows += `| Build speed | **${latest.native.perFile.buildTimeMs} ms/file** | **${latest.wasm.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Query time | **${formatMs(latest.native.queryTimeMs)}** | **${formatMs(latest.wasm.queryTimeMs)}** |\n`;
	} else if (hasNative) {
		rows += `| Build speed | **${latest.native.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Query time | **${formatMs(latest.native.queryTimeMs)}** |\n`;
	} else {
		rows += `| Build speed | **${latest.wasm.perFile.buildTimeMs} ms/file** |\n`;
		rows += `| Query time | **${formatMs(latest.wasm.queryTimeMs)}** |\n`;
	}

	// Incremental rebuild rows
	if (hasBoth) {
		const nativeNoop = latest.native.noopRebuildMs != null ? `**${formatMs(latest.native.noopRebuildMs)}**` : 'n/a';
		const wasmNoop = latest.wasm.noopRebuildMs != null ? `**${formatMs(latest.wasm.noopRebuildMs)}**` : 'n/a';
		if (latest.native.noopRebuildMs != null || latest.wasm.noopRebuildMs != null) {
			rows += `| No-op rebuild | ${nativeNoop} | ${wasmNoop} |\n`;
		}
		const nativeOneFile = latest.native.oneFileRebuildMs != null ? `**${formatMs(latest.native.oneFileRebuildMs)}**` : 'n/a';
		const wasmOneFile = latest.wasm.oneFileRebuildMs != null ? `**${formatMs(latest.wasm.oneFileRebuildMs)}**` : 'n/a';
		if (latest.native.oneFileRebuildMs != null || latest.wasm.oneFileRebuildMs != null) {
			rows += `| 1-file rebuild | ${nativeOneFile} | ${wasmOneFile} |\n`;
		}
	} else {
		const pref = latest.native || latest.wasm;
		if (pref.noopRebuildMs != null) {
			rows += `| No-op rebuild | **${formatMs(pref.noopRebuildMs)}** |\n`;
		}
		if (pref.oneFileRebuildMs != null) {
			rows += `| 1-file rebuild | **${formatMs(pref.oneFileRebuildMs)}** |\n`;
		}
	}

	// Query latency rows (pick two representative queries)
	if (hasBoth) {
		const nq = latest.native.queries;
		const wq = latest.wasm.queries;
		if (nq?.fnDepsMs != null || wq?.fnDepsMs != null) {
			rows += `| Query: fn-deps | **${nq?.fnDepsMs ?? 'n/a'}ms** | **${wq?.fnDepsMs ?? 'n/a'}ms** |\n`;
		}
		if (nq?.pathMs != null || wq?.pathMs != null) {
			rows += `| Query: path | **${nq?.pathMs ?? 'n/a'}ms** | **${wq?.pathMs ?? 'n/a'}ms** |\n`;
		}
	} else {
		const pref = latest.native || latest.wasm;
		if (pref.queries?.fnDepsMs != null) rows += `| Query: fn-deps | **${pref.queries.fnDepsMs}ms** |\n`;
		if (pref.queries?.pathMs != null) rows += `| Query: path | **${pref.queries.pathMs}ms** |\n`;
	}

	// 50k-file estimate
	if (hasBoth) {
		const estNativeBuild = formatMs(latest.native.perFile.buildTimeMs * ESTIMATE_FILES);
		const estWasmBuild = formatMs(latest.wasm.perFile.buildTimeMs * ESTIMATE_FILES);
		rows += `| ~${(ESTIMATE_FILES).toLocaleString()} files (est.) | **~${estNativeBuild} build** | **~${estWasmBuild} build** |\n`;
	} else {
		const pref = latest.native || latest.wasm;
		const estBuild = formatMs(pref.perFile.buildTimeMs * ESTIMATE_FILES);
		rows += `| ~${(ESTIMATE_FILES).toLocaleString()} files (est.) | **~${estBuild} build** |\n`;
	}

	// Preserve existing benchmark link line from README rather than hardcoding.
	// Fall back to a default if we can't find it.
	let benchmarkLinks = '[build benchmarks](generated/benchmarks/BUILD-BENCHMARKS.md) | [embedding benchmarks](generated/benchmarks/EMBEDDING-BENCHMARKS.md)';
	const linksMatch = readme.match(/Self-measured on every release via CI \((.+?)\):/);
	if (linksMatch) {
		benchmarkLinks = linksMatch[1];
	}

	// Resolution precision/recall — aggregate row in the main table
	let resolutionTable = '';
	if (latest.resolution) {
		const langEntries = Object.entries(latest.resolution);
		if (langEntries.length > 0) {
			const totalResolved = langEntries.reduce((s, [, l]) => s + l.totalResolved, 0);
			const totalExpected = langEntries.reduce((s, [, l]) => s + l.totalExpected, 0);
			const totalTP = langEntries.reduce((s, [, l]) => s + l.truePositives, 0);
			const aggPrecision = totalResolved > 0 ? `${((totalTP / totalResolved) * 100).toFixed(1)}%` : 'n/a';
			const aggRecall = totalExpected > 0 ? `${((totalTP / totalExpected) * 100).toFixed(1)}%` : 'n/a';
			if (hasBoth) {
				rows += `| Resolution precision | **${aggPrecision}** | — |\n`;
				rows += `| Resolution recall | **${aggRecall}** | — |\n`;
			} else {
				rows += `| Resolution precision | **${aggPrecision}** |\n`;
				rows += `| Resolution recall | **${aggRecall}** |\n`;
			}

			// Per-language resolution breakdown table
			// Sort: JS/TS first, then alphabetical
			const sortOrder = ['javascript', 'typescript'];
			const sorted = langEntries.sort(([a], [b]) => {
				const ai = sortOrder.indexOf(a);
				const bi = sortOrder.indexOf(b);
				if (ai !== -1 && bi !== -1) return ai - bi;
				if (ai !== -1) return -1;
				if (bi !== -1) return 1;
				return a.localeCompare(b);
			});

			resolutionTable += '\n<details><summary>Per-language resolution precision/recall</summary>\n\n';
			resolutionTable += '| Language | Precision | Recall | TP | FP | FN | Edges | Dynamic |\n';
			resolutionTable += '|----------|----------:|-------:|---:|---:|---:|------:|--------:|\n';
			for (const [lang, m] of sorted) {
				const p = (m.precision * 100).toFixed(1);
				const r = (m.recall * 100).toFixed(1);
				const dyn = m.dynamicEdges != null ? `${m.dynamicConfirmed}/${m.dynamicEdges}` : '—';
				resolutionTable += `| ${lang} | ${p}% | ${r}% | ${m.truePositives} | ${m.falsePositives} | ${m.falseNegatives} | ${m.totalExpected} | ${dyn} |\n`;
			}

			// Per-mode breakdown across all languages
			const allModes: Record<string, { expected: number; resolved: number }> = {};
			for (const [, m] of langEntries) {
				if (!m.byMode) continue;
				for (const [mode, data] of Object.entries(m.byMode)) {
					if (!allModes[mode]) allModes[mode] = { expected: 0, resolved: 0 };
					allModes[mode].expected += data.expected;
					allModes[mode].resolved += data.resolved;
				}
			}
			if (Object.keys(allModes).length > 0) {
				resolutionTable += '\n**By resolution mode (all languages):**\n\n';
				resolutionTable += '| Mode | Resolved | Expected | Recall |\n';
				resolutionTable += '|------|--------:|---------:|-------:|\n';
				for (const [mode, data] of Object.entries(allModes).sort(([, a], [, b]) => b.expected - a.expected)) {
					const recall = data.expected > 0 ? ((data.resolved / data.expected) * 100).toFixed(1) : 'n/a';
					resolutionTable += `| ${mode} | ${data.resolved} | ${data.expected} | ${recall}% |\n`;
				}
			}

			resolutionTable += '\n</details>\n';
		}
	}

	const tableHeader = hasBoth
		? `| Metric | Native | WASM |\n|---|---|---|`
		: `| Metric | Latest |\n|---|---|`;

	const perfSection = `## 📊 Performance

Self-measured on every release via CI (${benchmarkLinks}):

*Last updated: v${latest.version} (${latest.date})*

${tableHeader}
${rows}
Metrics are normalized per file for cross-version comparability. Times above are for a full initial build — incremental rebuilds only re-parse changed files.
${resolutionTable}`;

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
