#!/usr/bin/env node

/**
 * Update token savings report — reads benchmark JSON and generates
 * docs/benchmarks/TOKEN-SAVINGS.md with summary tables, per-issue
 * breakdowns, difficulty averages, and historical trends.
 *
 * Usage:
 *   node scripts/update-token-report.js token-result.json
 *   node scripts/token-benchmark.js | node scripts/update-token-report.js
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
const reportPath = path.join(root, 'docs', 'benchmarks', 'TOKEN-SAVINGS.md');

// ── Load existing history ────────────────────────────────────────────────
let history = [];
if (fs.existsSync(reportPath)) {
	const content = fs.readFileSync(reportPath, 'utf8');
	const match = content.match(/<!--\s*TOKEN_BENCHMARK_DATA\s*([\s\S]*?)\s*-->/);
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

function trend(current, previous, lowerIsBetter = true) {
	if (previous == null) return '';
	const pct = ((current - previous) / previous) * 100;
	if (Math.abs(pct) < 2) return ' ~';
	if (lowerIsBetter) {
		return pct < 0 ? ` ↓${Math.abs(Math.round(pct))}%` : ` ↑${Math.round(pct)}%`;
	}
	return pct > 0 ? ` ↑${Math.round(pct)}%` : ` ↓${Math.abs(Math.round(pct))}%`;
}

function formatTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function formatCost(n) {
	return `$${n.toFixed(2)}`;
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

function difficultyEmoji(d) {
	if (d === 'easy') return '🟢';
	if (d === 'medium') return '🟡';
	return '🔴';
}

// ── Build report ─────────────────────────────────────────────────────────

const latest = history[0];
const prev = history[1] || null;

let md = '# Token Savings Benchmark: codegraph vs Raw Navigation\n\n';
md += 'Measures how much codegraph reduces token usage when an AI agent navigates\n';
md += 'the [Next.js](https://github.com/vercel/next.js) codebase (~4,000 TypeScript files).\n\n';
md += `**Model:** ${latest.model} | **Runs per issue:** ${latest.runsPerIssue} | `;
md += `**codegraph version:** ${latest.version} | **Date:** ${latest.date}\n\n`;

// ── Summary table ────────────────────────────────────────────────────────

if (latest.aggregate) {
	md += '## Summary\n\n';
	md += '| Metric | Baseline | Codegraph | Savings |\n';
	md += '|--------|--------:|---------:|--------:|\n';

	const validIssues = latest.issues.filter((i) => i.baseline?.median && i.codegraph?.median);

	if (validIssues.length > 0) {
		const totalBaselineTokens = validIssues.reduce(
			(s, i) => s + i.baseline.median.inputTokens,
			0,
		);
		const totalCodegraphTokens = validIssues.reduce(
			(s, i) => s + i.codegraph.median.inputTokens,
			0,
		);
		const totalBaselineCost = validIssues.reduce(
			(s, i) => s + i.baseline.median.totalCostUsd,
			0,
		);
		const totalCodegraphCost = validIssues.reduce(
			(s, i) => s + i.codegraph.median.totalCostUsd,
			0,
		);
		const avgBaselineTurns =
			validIssues.reduce((s, i) => s + i.baseline.median.numTurns, 0) / validIssues.length;
		const avgCodegraphTurns =
			validIssues.reduce((s, i) => s + i.codegraph.median.numTurns, 0) / validIssues.length;

		md += `| Input tokens (total) | ${formatTokens(totalBaselineTokens)} | ${formatTokens(totalCodegraphTokens)} | **${latest.aggregate.savings.inputTokensPct}%** |\n`;
		md += `| Cost (total) | ${formatCost(totalBaselineCost)} | ${formatCost(totalCodegraphCost)} | **${latest.aggregate.savings.costPct}%** |\n`;
		md += `| Avg turns/issue | ${avgBaselineTurns.toFixed(1)} | ${avgCodegraphTurns.toFixed(1)} | — |\n`;
		md += `| Avg hit rate | ${latest.aggregate.baselineAvgHitRate}% | ${latest.aggregate.codegraphAvgHitRate}% | — |\n`;
	}

	md += '\n';
}

// ── Per-issue breakdown ──────────────────────────────────────────────────

md += '## Per-Issue Breakdown\n\n';
md += '| Issue | Diff | Baseline tokens | CG tokens | Token savings | Baseline cost | CG cost | Cost savings | Hit rate (B/CG) |\n';
md += '|-------|:----:|----------------:|----------:|--------------:|--------------:|--------:|-------------:|----------------:|\n';

for (const issue of latest.issues) {
	const emoji = difficultyEmoji(issue.difficulty);
	const b = issue.baseline?.median;
	const c = issue.codegraph?.median;

	if (!b || !c) {
		md += `| ${issue.id} | ${emoji} | — | — | — | — | — | — | — |\n`;
		continue;
	}

	const savingsStr = issue.savings
		? `**${issue.savings.inputTokensPct}%**`
		: '—';
	const costSavingsStr = issue.savings
		? `**${issue.savings.costPct}%**`
		: '—';

	md += `| ${issue.id} | ${emoji} | ${formatTokens(b.inputTokens)} | ${formatTokens(c.inputTokens)} | ${savingsStr} | ${formatCost(b.totalCostUsd)} | ${formatCost(c.totalCostUsd)} | ${costSavingsStr} | ${b.hitRate}% / ${c.hitRate}% |\n`;
}

md += '\n';
md += 'Difficulty: 🟢 Easy (1 file) · 🟡 Medium (1-2 files) · 🔴 Hard (5-7 files)\n\n';

// ── By-difficulty averages ───────────────────────────────────────────────

md += '## By Difficulty\n\n';
md += '| Difficulty | Issues | Avg token savings | Avg cost savings | Avg hit rate (B/CG) |\n';
md += '|------------|-------:|------------------:|-----------------:|--------------------:|\n';

for (const difficulty of ['easy', 'medium', 'hard']) {
	const issues = latest.issues.filter(
		(i) => i.difficulty === difficulty && i.savings,
	);

	if (issues.length === 0) {
		md += `| ${difficulty} | 0 | — | — | — |\n`;
		continue;
	}

	const avgTokenSavings = Math.round(
		issues.reduce((s, i) => s + i.savings.inputTokensPct, 0) / issues.length,
	);
	const avgCostSavings = Math.round(
		issues.reduce((s, i) => s + i.savings.costPct, 0) / issues.length,
	);
	const avgBaselineHit = Math.round(
		issues.reduce((s, i) => s + i.baseline.median.hitRate, 0) / issues.length,
	);
	const avgCgHit = Math.round(
		issues.reduce((s, i) => s + i.codegraph.median.hitRate, 0) / issues.length,
	);

	md += `| ${difficulty} | ${issues.length} | **${avgTokenSavings}%** | **${avgCostSavings}%** | ${avgBaselineHit}% / ${avgCgHit}% |\n`;
}

md += '\n';

// ── Historical trend ─────────────────────────────────────────────────────

if (history.length > 1) {
	md += '## Historical Trend\n\n';
	md += '| Version | Date | Model | Token savings | Cost savings | Trend |\n';
	md += '|---------|------|-------|-------------:|------------:|------:|\n';

	for (let i = 0; i < history.length; i++) {
		const h = history[i];
		const p = history[i + 1] || null;
		if (!h.aggregate) continue;

		const tokenTrend = p?.aggregate
			? trend(h.aggregate.savings.inputTokensPct, p.aggregate.savings.inputTokensPct, false)
			: '';

		md += `| ${h.version} | ${h.date} | ${h.model} | ${h.aggregate.savings.inputTokensPct}% | ${h.aggregate.savings.costPct}% | ${tokenTrend} |\n`;
	}

	md += '\n';
}

// ── Performance benchmarks (if present) ──────────────────────────────────

if (latest.perfBenchmarks) {
	const perf = latest.perfBenchmarks;
	md += '## Codegraph Performance on Next.js\n\n';
	md += `Measured on the **${perf.repo}** codebase during the benchmark run.\n\n`;

	// Graph stats
	if (perf.stats) {
		const s = perf.stats;
		md += '### Graph Stats\n\n';
		md += '| Metric | Value |\n';
		md += '|--------|------:|\n';
		md += `| Files | ${s.files.toLocaleString()} |\n`;
		md += `| Nodes | ${s.nodes.toLocaleString()} |\n`;
		md += `| Edges | ${s.edges.toLocaleString()} |\n`;
		md += `| DB size | ${formatBytes(s.dbSizeBytes)} |\n`;
		md += `| Nodes/file | ${s.files > 0 ? (s.nodes / s.files).toFixed(1) : '—'} |\n`;
		md += `| Edges/file | ${s.files > 0 ? (s.edges / s.files).toFixed(1) : '—'} |\n`;
		md += '\n';
	}

	// Build benchmarks
	if (perf.build) {
		md += '### Build Performance\n\n';
		md += '| Engine | Full build | No-op rebuild |\n';
		md += '|--------|----------:|-------------:|\n';
		for (const [engine, data] of Object.entries(perf.build)) {
			md += `| ${engine} | ${formatMs(data.fullBuildMs)} | ${formatMs(data.noopRebuildMs)} |\n`;
		}
		if (perf.stats?.files > 0) {
			md += '\n*Per-file:*\n\n';
			md += '| Engine | Build ms/file |\n';
			md += '|--------|--------------:|\n';
			for (const [engine, data] of Object.entries(perf.build)) {
				const perFile = (data.fullBuildMs / perf.stats.files).toFixed(1);
				md += `| ${engine} | ${perFile} |\n`;
			}
		}
		md += '\n';
	}

	// Query benchmarks
	if (perf.query?.hub) {
		md += '### Query Performance\n\n';
		md += `Hub node: \`${perf.query.hub}\`\n\n`;
		md += '| Query | Depth 1 | Depth 3 | Depth 5 |\n';
		md += '|-------|--------:|--------:|--------:|\n';
		md += `| fnDeps | ${formatMs(perf.query.fnDeps_depth1Ms || 0)} | ${formatMs(perf.query.fnDeps_depth3Ms || 0)} | ${formatMs(perf.query.fnDeps_depth5Ms || 0)} |\n`;
		md += `| fnImpact | ${formatMs(perf.query.fnImpact_depth1Ms || 0)} | ${formatMs(perf.query.fnImpact_depth3Ms || 0)} | ${formatMs(perf.query.fnImpact_depth5Ms || 0)} |\n`;
		md += '\n';
	}
}

// ── Methodology ──────────────────────────────────────────────────────────

md += '## Methodology\n\n';
md += '- Each issue is a real closed Next.js PR with known affected files\n';
md += '- Agent is checked out to the commit *before* the fix (no answer in git history)\n';
md += '- Baseline: agent uses Glob/Grep/Read/Bash only\n';
md += '- Codegraph: agent has access to codegraph MCP server (symbol search, deps, impact)\n';
md += '- Same model, same prompt, same budget cap for both conditions\n';
md += '- Metrics are median of N runs to handle non-determinism\n';
md += '- Hit rate = percentage of ground-truth files the agent identified\n\n';
md += 'See [docs/benchmarks/README.md](README.md) for full details.\n\n';

// ── Embedded data ────────────────────────────────────────────────────────

md += `<!-- TOKEN_BENCHMARK_DATA\n${JSON.stringify(history, null, 2)}\n-->\n`;

// ── Write report ─────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, md);
console.error(`Updated ${path.relative(root, reportPath)}`);

// ── Regression detection ─────────────────────────────────────────────────
const REGRESSION_THRESHOLD = 0.15; // 15%

if (prev?.aggregate && latest.aggregate) {
	const currentSavings = latest.aggregate.savings.inputTokensPct;
	const previousSavings = prev.aggregate.savings.inputTokensPct;
	const drop = previousSavings - currentSavings;

	if (drop > REGRESSION_THRESHOLD * 100) {
		const msg = `Token savings dropped: ${previousSavings}% → ${currentSavings}% (-${drop}pp, threshold ${Math.round(REGRESSION_THRESHOLD * 100)}pp)`;
		if (process.env.GITHUB_ACTIONS) {
			console.error(`::warning title=Token Benchmark Regression::${msg}`);
		} else {
			console.error(`⚠ REGRESSION: ${msg}`);
		}
	}
}
