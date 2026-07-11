#!/usr/bin/env node

/**
 * Token savings benchmark — measures codegraph's navigation advantage.
 *
 * Runs controlled experiments: same Next.js issues, same model — one agent
 * navigates with codegraph (via MCP), one without. Outputs JSON to stdout
 * with per-issue and aggregate token/cost savings.
 *
 * Prerequisites:
 *   npm install @anthropic-ai/claude-agent-sdk
 *   ANTHROPIC_API_KEY set in environment
 *
 * Usage:
 *   node --experimental-strip-types --import ./scripts/ts-resolve-loader.js scripts/token-benchmark.ts > result.json
 *   node --experimental-strip-types --import ./scripts/ts-resolve-loader.js scripts/token-benchmark.ts --runs 1 --issues csrf-case-insensitive
 *   node --experimental-strip-types --import ./scripts/ts-resolve-loader.js scripts/token-benchmark.ts --nextjs-dir /tmp/next.js --skip-graph
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ISSUES, extractAgentOutput, validateResult } from './token-benchmark-issues.js';
import { getBenchmarkVersion } from './bench-version.js';
import { median, round1, timeMedian } from './lib/bench-timing.js';
import { extractUsageMetrics, tallyToolCalls } from './lib/session-metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const benchVersion = getBenchmarkVersion(pkg.version, root);

// Redirect console.log to stderr so only JSON goes to stdout
const origLog = console.log;
console.log = (...args) => console.error(...args);

// ── CLI flags ─────────────────────────────────────────────────────────────

const { values: flags } = parseArgs({
	options: {
		runs: { type: 'string', default: '3' },
		model: { type: 'string', default: 'sonnet' },
		issues: { type: 'string', default: '' },
		'nextjs-dir': { type: 'string', default: '' },
		'skip-graph': { type: 'boolean', default: false },
		'max-turns': { type: 'string', default: '50' },
		'max-budget': { type: 'string', default: '2.00' },
		perf: { type: 'boolean', default: false },
	},
	strict: false,
});

const RUNS = parseInt(flags.runs, 10) || 3;
const MODEL = flags.model;
const MAX_TURNS = parseInt(flags['max-turns'], 10) || 50;
const MAX_BUDGET = parseFloat(flags['max-budget']) || 2.0;
const SKIP_GRAPH = flags['skip-graph'];
const RUN_PERF = flags.perf;

const selectedIssueIds = flags.issues
	? flags.issues.split(',').map((s) => s.trim())
	: ISSUES.map((i) => i.id);

const selectedIssues = selectedIssueIds.map((id) => {
	const issue = ISSUES.find((i) => i.id === id);
	if (!issue) {
		console.error(`Unknown issue: ${id}`);
		console.error(`Available: ${ISSUES.map((i) => i.id).join(', ')}`);
		process.exit(1);
	}
	return issue;
});

// ── Helpers ───────────────────────────────────────────────────────────────

function round2(n) {
	return Math.round(n * 100) / 100;
}

/** Percentage reduction from `a` to `b` (e.g. token/cost savings). Returns 0 when `a <= 0`. */
function pct(a, b) {
	return a > 0 ? Math.round(((a - b) / a) * 100) : 0;
}

function git(args, cwd) {
	return execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
}

// ── Prompts ───────────────────────────────────────────────────────────────

const BASELINE_PROMPT = `You are an expert debugging agent navigating a large codebase.
You have access to Glob, Grep, Read, and Bash tools to explore the code.
Use these to search for relevant files, read their contents, and trace
call chains. Be systematic and thorough.`;

const CODEGRAPH_PROMPT = `You are an expert debugging agent navigating a large codebase.
You have access to a codegraph MCP server that provides structural code
navigation tools (symbol search, dependency tracking, impact analysis,
call chains). Use these tools to efficiently find relevant code.
You also have Glob, Grep, Read, and Bash tools for additional exploration.
Prefer codegraph tools for structural navigation — they are faster than
manual grep/read exploration.`;

function makeIssuePrompt(issue) {
	return `You are debugging a bug in the Next.js codebase (vercel/next.js).

**Bug:** ${issue.title}

**Description:** ${issue.description}

Your task: Identify which source files need to be modified to fix this bug.
Explain the root cause and the fix approach.

IMPORTANT: Output your answer as a JSON code block with this exact format:
\`\`\`json
{
  "files": ["path/to/file1.ts", "path/to/file2.ts"],
  "explanation": "Brief explanation of the root cause and fix approach"
}
\`\`\`

Only include source files that need modification — not test files.`;
}

// ── Next.js setup ─────────────────────────────────────────────────────────

async function ensureNextjsClone(targetDir) {
	if (fs.existsSync(path.join(targetDir, '.git'))) {
		console.error(`Reusing existing Next.js clone at ${targetDir}`);
		git(['fetch', 'origin'], targetDir);
		return;
	}

	console.error(`Cloning Next.js to ${targetDir} (shallow)...`);
	fs.mkdirSync(targetDir, { recursive: true });
	execFileSync(
		'git',
		['clone', '--filter=blob:none', 'https://github.com/vercel/next.js.git', targetDir],
		{ stdio: 'inherit' },
	);
}

function checkoutCommit(nextjsDir, sha) {
	console.error(`Checking out ${sha.slice(0, 10)}...`);
	git(['checkout', sha, '--force'], nextjsDir);
}

// ── Graph building ────────────────────────────────────────────────────────

async function buildCodegraph(nextjsDir) {
	const cliPath = path.join(root, 'src', 'cli.js');
	console.error('Building codegraph graph for Next.js...');
	const start = performance.now();
	execFileSync('node', [cliPath, 'build', nextjsDir], {
		cwd: nextjsDir,
		stdio: 'pipe',
		timeout: 600_000, // 10 min
	});
	const elapsed = Math.round(performance.now() - start);
	console.error(`Graph built in ${elapsed}ms`);
}

// ── Session runner ────────────────────────────────────────────────────────

/**
 * Build the Agent SDK `options` for a single session.
 * Codegraph mode additionally wires up the codegraph MCP server against
 * the graph already built for `nextjsDir`.
 *
 * @param {'baseline'|'codegraph'} mode
 * @param {string} nextjsDir
 * @returns {object} Agent SDK options
 */
function buildSessionOptions(mode, nextjsDir) {
	const options = {
		cwd: nextjsDir,
		model: MODEL,
		allowedTools: ['Glob', 'Grep', 'Read', 'Bash'],
		permissionMode: 'bypassPermissions',
		maxTurns: MAX_TURNS,
		maxBudgetUsd: MAX_BUDGET,
		systemPrompt: mode === 'codegraph' ? CODEGRAPH_PROMPT : BASELINE_PROMPT,
	};

	if (mode === 'codegraph') {
		const dbPath = path.join(nextjsDir, '.codegraph', 'graph.db');
		const cliPath = path.join(root, 'src', 'cli.js');
		options.mcpServers = {
			codegraph: {
				type: 'stdio',
				command: 'node',
				args: [cliPath, 'mcp', '-d', dbPath],
			},
		};
	}

	return options;
}

/**
 * Run a single agent session using the Claude Agent SDK.
 *
 * @param {'baseline'|'codegraph'} mode
 * @param {import('./token-benchmark-issues.js').BenchmarkIssue} issue
 * @param {string} nextjsDir
 * @returns {Promise<object>} session metrics
 */
async function runSession(mode, issue, nextjsDir) {
	// Lazy-load the SDK
	const { query } = await import('@anthropic-ai/claude-agent-sdk');

	const options = buildSessionOptions(mode, nextjsDir);
	const issuePrompt = makeIssuePrompt(issue);

	const start = performance.now();
	const result = await query({ prompt: issuePrompt, options });
	const durationMs = Math.round(performance.now() - start);

	const usage = extractUsageMetrics(result);
	const messages = result.messages || [];
	const { toolCalls, uniqueFilesRead } = tallyToolCalls(messages);

	// Extract identified files from agent output
	const agentOutput = extractAgentOutput(messages);
	const filesIdentified = agentOutput?.files || [];
	const validation = validateResult(issue.id, filesIdentified);

	return {
		...usage,
		durationMs,
		toolCalls,
		uniqueFilesRead,
		filesIdentified,
		hitRate: validation.hitRate,
		matched: validation.matched,
		missed: validation.missed,
	};
}

// ── Performance benchmarks (build/query on the large graph) ──────────────

const PERF_RUNS = 3;

/**
 * Run full-build and no-op-rebuild benchmarks for each available engine.
 * Returns a map of engine name -> { fullBuildMs, noopRebuildMs }.
 */
async function runBuildBenchmarks(engines, dbPath, nextjsDir, buildGraph) {
	const buildResults = {};
	for (const engine of engines) {
		console.error(`  Full build (${engine})...`);
		const fullBuildMs = Math.round(
			await timeMedian(async () => {
				if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
				await buildGraph(nextjsDir, { engine, incremental: false });
			}, PERF_RUNS),
		);

		// No-op rebuild
		console.error(`  No-op rebuild (${engine})...`);
		const noopRebuildMs = Math.round(
			await timeMedian(() => buildGraph(nextjsDir, { engine, incremental: true }), PERF_RUNS),
		);

		buildResults[engine] = { fullBuildMs, noopRebuildMs };
		console.error(`    full=${fullBuildMs}ms noop=${noopRebuildMs}ms`);
	}
	return buildResults;
}

/**
 * Run fnDeps/fnImpact query benchmarks at depths 1/3/5 against `hubName`.
 * Returns an empty object when there's no hub to query against.
 */
async function runQueryBenchmarks(hubName, dbPath, fnDepsData, fnImpactData) {
	const queryResults = {};
	if (!hubName) return queryResults;

	console.error(`  Query target (hub): ${hubName}`);

	for (const depth of [1, 3, 5]) {
		// fnDeps
		queryResults[`fnDeps_depth${depth}Ms`] = round1(
			await timeMedian(() => fnDepsData(hubName, dbPath, { depth, noTests: true }), PERF_RUNS),
		);

		// fnImpact
		queryResults[`fnImpact_depth${depth}Ms`] = round1(
			await timeMedian(() => fnImpactData(hubName, dbPath, { depth, noTests: true }), PERF_RUNS),
		);
	}

	console.error(
		`    fnDeps: d1=${queryResults.fnDeps_depth1Ms}ms d3=${queryResults.fnDeps_depth3Ms}ms d5=${queryResults.fnDeps_depth5Ms}ms`,
	);
	console.error(
		`    fnImpact: d1=${queryResults.fnImpact_depth1Ms}ms d3=${queryResults.fnImpact_depth3Ms}ms d5=${queryResults.fnImpact_depth5Ms}ms`,
	);

	return queryResults;
}

/**
 * Run build/query/stats benchmarks against the Next.js graph.
 * Reuses the same codegraph APIs as the existing benchmark scripts.
 */
async function runPerfBenchmarks(nextjsDir) {
	const { pathToFileURL } = await import('node:url');
	const { buildGraph } = await import(
		pathToFileURL(path.join(root, 'src', 'builder.js')).href
	);
	const { fnDepsData, fnImpactData, statsData } = await import(
		pathToFileURL(path.join(root, 'src', 'queries.js')).href
	);
	const { isNativeAvailable } = await import(
		pathToFileURL(path.join(root, 'src', 'native.js')).href
	);
	const { isWasmAvailable } = await import(
		pathToFileURL(path.join(root, 'src', 'parser.js')).href
	);

	const dbPath = path.join(nextjsDir, '.codegraph', 'graph.db');

	console.error('\n── Performance benchmarks ──');

	// ── Build benchmarks ──────────────────────────────────────────────
	const engines = [
		...(isWasmAvailable() ? ['wasm'] : []),
		...(isNativeAvailable() ? ['native'] : []),
	];
	if (engines.length === 0) {
		console.error('  No engines available — skipping perf benchmarks');
		return null;
	}
	if (!isWasmAvailable()) {
		console.error('  WASM grammars not built — skipping WASM perf benchmark');
	}
	if (!isNativeAvailable()) {
		console.error('  Native engine not available — skipping native perf benchmark');
	}
	const buildResults = await runBuildBenchmarks(engines, dbPath, nextjsDir, buildGraph);

	// ── Stats ─────────────────────────────────────────────────────────
	// Ensure we have a graph (rebuild with first available engine if needed)
	if (!fs.existsSync(dbPath)) {
		await buildGraph(nextjsDir, { engine: engines[0], incremental: false });
	}
	const stats = statsData(dbPath);
	const graphStats = {
		files: stats.files.total,
		nodes: stats.nodes.total,
		edges: stats.edges.total,
		dbSizeBytes: fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0,
	};
	console.error(
		`  Stats: ${graphStats.files} files, ${graphStats.nodes} nodes, ${graphStats.edges} edges`,
	);

	// ── Query benchmarks ──────────────────────────────────────────────
	// Find a hub node (most connected) for query benchmarks
	const { default: Database } = await import('better-sqlite3');
	const db = new Database(dbPath, { readonly: true });
	const hubRow = db
		.prepare(
			`SELECT n.name, COUNT(e.id) AS cnt
			 FROM nodes n
			 JOIN edges e ON e.source_id = n.id OR e.target_id = n.id
			 WHERE n.file NOT LIKE '%test%' AND n.file NOT LIKE '%spec%'
			 GROUP BY n.id
			 ORDER BY cnt DESC
			 LIMIT 1`,
		)
		.get();
	db.close();

	const hubName = hubRow?.name || null;
	const queryResults = await runQueryBenchmarks(hubName, dbPath, fnDepsData, fnImpactData);

	return {
		repo: 'vercel/next.js',
		stats: graphStats,
		build: buildResults,
		query: { hub: hubName, ...queryResults },
	};
}

// ── Issue experiment ──────────────────────────────────────────────────────

/** Run RUNS sessions for one mode, logging per-run metrics. */
async function runSessionsForMode(mode, issue, nextjsDir) {
	const runs = [];
	const label = mode === 'baseline' ? 'Baseline' : 'Codegraph';
	for (let r = 0; r < RUNS; r++) {
		console.error(`  ${label} run ${r + 1}/${RUNS}...`);
		try {
			const metrics = await runSession(mode, issue, nextjsDir);
			runs.push(metrics);
			console.error(
				`    ${metrics.inputTokens} input tokens, $${metrics.totalCostUsd}, ` +
					`${metrics.numTurns} turns, hit rate: ${metrics.hitRate}%`,
			);
		} catch (err) {
			console.error(`    ERROR: ${err.message}`);
			runs.push({ error: err.message });
		}
	}
	return runs;
}

/** Compute median metrics for a run-set (or null when no valid runs). */
function medianForRuns(runs) {
	const valid = runs.filter((r) => !r.error);
	if (valid.length === 0) return null;
	const medianOf = (key) => median(valid.map((r) => r[key]));
	return {
		inputTokens: medianOf('inputTokens'),
		outputTokens: medianOf('outputTokens'),
		cacheReadInputTokens: medianOf('cacheReadInputTokens'),
		totalCostUsd: round2(medianOf('totalCostUsd')),
		numTurns: medianOf('numTurns'),
		durationMs: medianOf('durationMs'),
		uniqueFilesRead: medianOf('uniqueFilesRead'),
		hitRate: medianOf('hitRate'),
	};
}

/** Token + cost savings (% reduction) between two median objects. */
function computeSavings(baselineMedian, codegraphMedian) {
	if (!baselineMedian || !codegraphMedian || baselineMedian.inputTokens <= 0) return null;
	return {
		inputTokensPct: pct(baselineMedian.inputTokens, codegraphMedian.inputTokens),
		costPct: pct(baselineMedian.totalCostUsd, codegraphMedian.totalCostUsd),
	};
}

/** Run baseline + codegraph experiments for a single issue and aggregate. */
async function runIssueExperiment(issue, nextjsDir) {
	console.error(`\n── ${issue.id} (${issue.difficulty}) ──`);
	console.error(`PR #${issue.pr}: ${issue.title}`);

	checkoutCommit(nextjsDir, issue.commitBefore);
	if (!SKIP_GRAPH) {
		await buildCodegraph(nextjsDir);
	}

	const baselineRuns = await runSessionsForMode('baseline', issue, nextjsDir);
	const codegraphRuns = await runSessionsForMode('codegraph', issue, nextjsDir);

	const baselineMedian = medianForRuns(baselineRuns);
	const codegraphMedian = medianForRuns(codegraphRuns);
	const savings = computeSavings(baselineMedian, codegraphMedian);

	if (savings) {
		console.error(
			`  Savings: ${savings.inputTokensPct}% tokens, ${savings.costPct}% cost`,
		);
	}

	return {
		id: issue.id,
		difficulty: issue.difficulty,
		pr: issue.pr,
		baseline: { median: baselineMedian, runs: baselineRuns },
		codegraph: { median: codegraphMedian, runs: codegraphRuns },
		savings,
	};
}

/** Aggregate per-issue results into corpus-wide token/cost savings + hit rates. */
function computeAggregate(results) {
	const validResults = results.filter(
		(r) => r.baseline.median && r.codegraph.median && r.savings,
	);
	if (validResults.length === 0) return null;

	const sum = (sel) => validResults.reduce((s, r) => s + sel(r), 0);
	const totalBaselineTokens = sum((r) => r.baseline.median.inputTokens);
	const totalCodegraphTokens = sum((r) => r.codegraph.median.inputTokens);
	const totalBaselineCost = sum((r) => r.baseline.median.totalCostUsd);
	const totalCodegraphCost = sum((r) => r.codegraph.median.totalCostUsd);

	return {
		savings: {
			inputTokensPct: pct(totalBaselineTokens, totalCodegraphTokens),
			costPct: pct(totalBaselineCost, totalCodegraphCost),
		},
		baselineAvgHitRate: Math.round(
			sum((r) => r.baseline.median.hitRate) / validResults.length,
		),
		codegraphAvgHitRate: Math.round(
			sum((r) => r.codegraph.median.hitRate) / validResults.length,
		),
	};
}

// ── Main ──────────────────────────────────────────────────────────────────

/** Where in-progress results are (re)written after each issue completes. */
const PARTIAL_RESULTS_PATH = path.join(root, 'token-benchmark.partial.json');

/**
 * Overwrite the partial-results snapshot with the results collected so far.
 * Called after each issue completes so a later crash (another issue
 * throwing, or `runPerfBenchmarks` failing) doesn't discard the
 * already-computed results for the issues that already finished (#1757).
 */
function writePartialResults(results, totalIssues) {
	const partialOutput = {
		version: benchVersion,
		date: new Date().toISOString().slice(0, 10),
		model: MODEL,
		runsPerIssue: RUNS,
		maxTurns: MAX_TURNS,
		maxBudgetUsd: MAX_BUDGET,
		partial: true,
		completedIssues: results.length,
		totalIssues,
		issues: results,
		aggregate: computeAggregate(results),
		perfBenchmarks: null,
	};
	try {
		fs.writeFileSync(PARTIAL_RESULTS_PATH, JSON.stringify(partialOutput, null, 2));
		console.error(
			`  Partial results written to ${PARTIAL_RESULTS_PATH} (${results.length}/${totalIssues} issues)`,
		);
	} catch (err) {
		console.error(`  Warning: could not write partial results — ${err.message}`);
	}
}

async function main() {
	// Resolve Next.js directory
	const nextjsDir = flags['nextjs-dir']
		? path.resolve(flags['nextjs-dir'])
		: path.join(os.tmpdir(), 'codegraph-bench-nextjs');

	console.error(`Token Savings Benchmark`);
	console.error(`  Model: ${MODEL}`);
	console.error(`  Runs per issue: ${RUNS}`);
	console.error(`  Issues: ${selectedIssues.map((i) => i.id).join(', ')}`);
	console.error(`  Max turns: ${MAX_TURNS}`);
	console.error(`  Max budget: $${MAX_BUDGET}`);
	console.error(`  Next.js dir: ${nextjsDir}`);
	console.error('');

	await ensureNextjsClone(nextjsDir);

	const results = [];
	for (const issue of selectedIssues) {
		results.push(await runIssueExperiment(issue, nextjsDir));
		writePartialResults(results, selectedIssues.length);
	}

	const aggregate = computeAggregate(results);

	let perfBenchmarks = null;
	if (RUN_PERF) {
		// Checkout latest commit from the first issue for a stable snapshot
		checkoutCommit(nextjsDir, selectedIssues[0].commitBefore);
		perfBenchmarks = await runPerfBenchmarks(nextjsDir);
	}

	// Restore console.log for JSON output
	console.log = origLog;

	const output = {
		version: benchVersion,
		date: new Date().toISOString().slice(0, 10),
		model: MODEL,
		runsPerIssue: RUNS,
		maxTurns: MAX_TURNS,
		maxBudgetUsd: MAX_BUDGET,
		issues: results,
		aggregate,
		perfBenchmarks,
	};

	console.log(JSON.stringify(output, null, 2));

	// Full run (including perf benchmarks, if requested) succeeded — the
	// complete results are now in the stdout output above, so the partial
	// snapshot is no longer needed.
	fs.rmSync(PARTIAL_RESULTS_PATH, { force: true });
}

main().catch((err) => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
