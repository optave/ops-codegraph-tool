#!/usr/bin/env node
/**
 * Engine parity gate — runs after the release build benchmark.
 *
 * Reads the merged benchmark-result.json (contains `wasm` and `native` blocks)
 * and fails the workflow if the gap between engines breaches a documented
 * threshold. A failure here doesn't block the release (benchmark runs *after*
 * Publish completes); it surfaces regressions to maintainers via the workflow's
 * red status and writes a summary to $GITHUB_STEP_SUMMARY.
 *
 * Thresholds reference the parity bugs open against v3.9.5:
 *   - #1010 DB size / excess ast_nodes
 *   - #1011 Native orchestrator drops files
 *   - #1012 Native 1-file incremental runs globally
 *   - #1013 Native full-build edges/roles phases
 *
 * Each threshold fires only when BOTH engines produced results. If one engine
 * failed, we leave the gate passing so the rest of the workflow (doc PR,
 * artifact upload) still runs, and a separate "both engines ran" check flags
 * the missing engine.
 */
import fs from 'node:fs';

const resultFile = process.argv[2];
if (!resultFile) {
	console.error('Usage: benchmark-parity-gate.mjs <benchmark-result.json>');
	process.exit(2);
}

let result;
try {
	result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
} catch (err) {
	console.error(`Failed to read ${resultFile}: ${err.message}`);
	process.exit(2);
}
const { wasm, native, version } = result;

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
const writeSummary = (text) => {
	if (summaryFile) fs.appendFileSync(summaryFile, text);
};

function line(s = '') {
	console.log(s);
	writeSummary(`${s}\n`);
}

line(`## Engine parity gate — v${version}`);
line('');

if (!wasm || !native) {
	const missing = [!wasm && 'wasm', !native && 'native'].filter(Boolean).join(', ');
	line(`**SKIP:** missing engine result for: ${missing}. Cannot assert parity — gate passes.`);
	process.exit(0);
}

// ── Thresholds ─────────────────────────────────────────────────────────
// Each entry:
//   name       — human-readable label
//   actual     — computed metric
//   limit      — ceiling; actual must be ≤ limit
//   formatter  — how to render the value
//   tracks     — related issue link shown on failure
const checks = [
	{
		name: 'File-set gap (|wasm − native|)',
		actual: Math.abs((wasm.files ?? 0) - (native.files ?? 0)),
		limit: 2,
		formatter: (v) => String(v),
		tracks: '#1011',
	},
	{
		name: 'DB size ratio (native / wasm)',
		actual: (native.dbSizeBytes ?? 0) / Math.max(wasm.dbSizeBytes ?? 1, 1),
		limit: 1.02,
		formatter: (v) => v.toFixed(3),
		tracks: '#1010',
	},
	{
		name: 'Full-build edges-phase ratio',
		actual: (native.phases?.edgesMs ?? 0) / Math.max(wasm.phases?.edgesMs ?? 1, 1),
		limit: 1.3,
		formatter: (v) => v.toFixed(2),
		tracks: '#1013',
	},
	{
		name: 'Full-build roles-phase ratio',
		actual: (native.phases?.rolesMs ?? 0) / Math.max(wasm.phases?.rolesMs ?? 1, 1),
		limit: 1.3,
		formatter: (v) => v.toFixed(2),
		tracks: '#1013',
	},
	{
		name: '1-file incremental ratio',
		actual:
			(native.oneFileRebuildMs ?? 0) /
			Math.max(wasm.oneFileRebuildMs ?? 1, 1),
		limit: 1.5,
		formatter: (v) => v.toFixed(2),
		tracks: '#1012',
	},
];

line('| Check | Actual | Limit | Status | Tracks |');
line('|---|---:|---:|---|---|');

let failed = 0;
for (const c of checks) {
	const ok = c.actual <= c.limit;
	if (!ok) failed++;
	const status = ok ? ':white_check_mark: pass' : ':x: **fail**';
	line(
		`| ${c.name} | ${c.formatter(c.actual)} | ${c.formatter(c.limit)} | ${status} | ${c.tracks} |`,
	);
}

line('');
if (failed > 0) {
	line(
		`**${failed} parity check(s) failed.** See linked issues for root-cause tracking; the benchmark doc PR (if opened) captures the raw numbers.`,
	);
	process.exit(1);
}

line('All parity checks passed.');
