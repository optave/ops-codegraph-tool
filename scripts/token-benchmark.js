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
 *   node scripts/token-benchmark.js > result.json
 *   node scripts/token-benchmark.js --runs 1 --issues csrf-case-insensitive
 *   node scripts/token-benchmark.js --nextjs-dir /tmp/next.js --skip-graph
 */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { ISSUES, extractAgentOutput, validateResult } from './token-benchmark-issues.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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

function median(arr) {
	if (arr.length === 0) return 0;
	const sorted = [...arr].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round2(n) {
	return Math.round(n * 100) / 100;
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

	const dbPath = path.join(nextjsDir, '.codegraph', 'graph.db');
	const cliPath = path.join(root, 'src', 'cli.js');
	const issuePrompt = makeIssuePrompt(issue);

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
		options.mcpServers = {
			codegraph: {
				type: 'stdio',
				command: 'node',
				args: [cliPath, 'mcp', '-d', dbPath],
			},
		};
	}

	const start = performance.now();
	const result = await query({ prompt: issuePrompt, options });
	const durationMs = Math.round(performance.now() - start);

	// Extract metrics from the SDK result
	const usage = result.usage || {};
	const inputTokens = usage.input_tokens || usage.inputTokens || 0;
	const outputTokens = usage.output_tokens || usage.outputTokens || 0;
	const cacheReadInputTokens =
		usage.cache_read_input_tokens || usage.cacheReadInputTokens || 0;
	const totalCostUsd = usage.total_cost_usd || usage.totalCostUsd || 0;
	const numTurns = result.num_turns || result.numTurns || 0;

	// Count tool calls by type
	const messages = result.messages || [];
	const toolCalls = {};
	let uniqueFilesRead = new Set();

	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		for (const block of blocks) {
			if (block.type === 'tool_use') {
				const name = block.name || 'unknown';
				toolCalls[name] = (toolCalls[name] || 0) + 1;
				// Track unique files read
				if (name === 'Read' && block.input?.file_path) {
					uniqueFilesRead.add(block.input.file_path);
				}
			}
		}
	}

	// Extract identified files from agent output
	const agentOutput = extractAgentOutput(messages);
	const filesIdentified = agentOutput?.files || [];
	const validation = validateResult(issue.id, filesIdentified);

	return {
		inputTokens,
		outputTokens,
		cacheReadInputTokens,
		totalCostUsd: round2(totalCostUsd),
		numTurns,
		durationMs,
		toolCalls,
		uniqueFilesRead: uniqueFilesRead.size,
		filesIdentified,
		hitRate: validation.hitRate,
		matched: validation.matched,
		missed: validation.missed,
	};
}

// ── Performance benchmarks (build/query on the large graph) ──────────────

const PERF_RUNS = 3;

function round1(n) {
	return Math.round(n * 10) / 10;
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

	const dbPath = path.join(nextjsDir, '.codegraph', 'graph.db');

	console.error('\n── Performance benchmarks ──');

	// ── Build benchmarks ──────────────────────────────────────────────
	const buildResults = {};
	for (const engine of ['wasm', ...(isNativeAvailable() ? ['native'] : [])]) {
		console.error(`  Full build (${engine})...`);
		const timings = [];
		for (let i = 0; i < PERF_RUNS; i++) {
			if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
			const start = performance.now();
			await buildGraph(nextjsDir, { engine, incremental: false });
			timings.push(performance.now() - start);
		}
		const fullBuildMs = Math.round(median(timings));

		// No-op rebuild
		console.error(`  No-op rebuild (${engine})...`);
		const noopTimings = [];
		for (let i = 0; i < PERF_RUNS; i++) {
			const start = performance.now();
			await buildGraph(nextjsDir, { engine, incremental: true });
			noopTimings.push(performance.now() - start);
		}
		const noopRebuildMs = Math.round(median(noopTimings));

		buildResults[engine] = { fullBuildMs, noopRebuildMs };
		console.error(`    full=${fullBuildMs}ms noop=${noopRebuildMs}ms`);
	}

	// ── Stats ─────────────────────────────────────────────────────────
	// Ensure we have a graph (rebuild with wasm if needed)
	if (!fs.existsSync(dbPath)) {
		await buildGraph(nextjsDir, { engine: 'wasm', incremental: false });
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
	const queryResults = {};

	if (hubName) {
		console.error(`  Query target (hub): ${hubName}`);

		for (const depth of [1, 3, 5]) {
			// fnDeps
			const depsTimings = [];
			for (let i = 0; i < PERF_RUNS; i++) {
				const start = performance.now();
				fnDepsData(hubName, dbPath, { depth, noTests: true });
				depsTimings.push(performance.now() - start);
			}

			// fnImpact
			const impactTimings = [];
			for (let i = 0; i < PERF_RUNS; i++) {
				const start = performance.now();
				fnImpactData(hubName, dbPath, { depth, noTests: true });
				impactTimings.push(performance.now() - start);
			}

			queryResults[`fnDeps_depth${depth}Ms`] = round1(median(depsTimings));
			queryResults[`fnImpact_depth${depth}Ms`] = round1(median(impactTimings));
		}

		console.error(
			`    fnDeps: d1=${queryResults.fnDeps_depth1Ms}ms d3=${queryResults.fnDeps_depth3Ms}ms d5=${queryResults.fnDeps_depth5Ms}ms`,
		);
		console.error(
			`    fnImpact: d1=${queryResults.fnImpact_depth1Ms}ms d3=${queryResults.fnImpact_depth3Ms}ms d5=${queryResults.fnImpact_depth5Ms}ms`,
		);
	}

	return {
		repo: 'vercel/next.js',
		stats: graphStats,
		build: buildResults,
		query: { hub: hubName, ...queryResults },
	};
}

// ── Main ──────────────────────────────────────────────────────────────────

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

	// Clone / fetch Next.js
	await ensureNextjsClone(nextjsDir);

	const results = [];

	for (const issue of selectedIssues) {
		console.error(`\n── ${issue.id} (${issue.difficulty}) ──`);
		console.error(`PR #${issue.pr}: ${issue.title}`);

		// Checkout the commit before the fix
		checkoutCommit(nextjsDir, issue.commitBefore);

		// Build codegraph (unless skipped)
		if (!SKIP_GRAPH) {
			await buildCodegraph(nextjsDir);
		}

		const baselineRuns = [];
		const codegraphRuns = [];

		// Run baseline sessions
		for (let r = 0; r < RUNS; r++) {
			console.error(`  Baseline run ${r + 1}/${RUNS}...`);
			try {
				const metrics = await runSession('baseline', issue, nextjsDir);
				baselineRuns.push(metrics);
				console.error(
					`    ${metrics.inputTokens} input tokens, $${metrics.totalCostUsd}, ` +
						`${metrics.numTurns} turns, hit rate: ${metrics.hitRate}%`,
				);
			} catch (err) {
				console.error(`    ERROR: ${err.message}`);
				baselineRuns.push({ error: err.message });
			}
		}

		// Run codegraph sessions
		for (let r = 0; r < RUNS; r++) {
			console.error(`  Codegraph run ${r + 1}/${RUNS}...`);
			try {
				const metrics = await runSession('codegraph', issue, nextjsDir);
				codegraphRuns.push(metrics);
				console.error(
					`    ${metrics.inputTokens} input tokens, $${metrics.totalCostUsd}, ` +
						`${metrics.numTurns} turns, hit rate: ${metrics.hitRate}%`,
				);
			} catch (err) {
				console.error(`    ERROR: ${err.message}`);
				codegraphRuns.push({ error: err.message });
			}
		}

		// Compute medians (filter out errored runs)
		const validBaseline = baselineRuns.filter((r) => !r.error);
		const validCodegraph = codegraphRuns.filter((r) => !r.error);

		const medianOf = (runs, key) => median(runs.map((r) => r[key]));

		const baselineMedian =
			validBaseline.length > 0
				? {
						inputTokens: medianOf(validBaseline, 'inputTokens'),
						outputTokens: medianOf(validBaseline, 'outputTokens'),
						cacheReadInputTokens: medianOf(validBaseline, 'cacheReadInputTokens'),
						totalCostUsd: round2(medianOf(validBaseline, 'totalCostUsd')),
						numTurns: medianOf(validBaseline, 'numTurns'),
						durationMs: medianOf(validBaseline, 'durationMs'),
						uniqueFilesRead: medianOf(validBaseline, 'uniqueFilesRead'),
						hitRate: medianOf(validBaseline, 'hitRate'),
					}
				: null;

		const codegraphMedian =
			validCodegraph.length > 0
				? {
						inputTokens: medianOf(validCodegraph, 'inputTokens'),
						outputTokens: medianOf(validCodegraph, 'outputTokens'),
						cacheReadInputTokens: medianOf(validCodegraph, 'cacheReadInputTokens'),
						totalCostUsd: round2(medianOf(validCodegraph, 'totalCostUsd')),
						numTurns: medianOf(validCodegraph, 'numTurns'),
						durationMs: medianOf(validCodegraph, 'durationMs'),
						uniqueFilesRead: medianOf(validCodegraph, 'uniqueFilesRead'),
						hitRate: medianOf(validCodegraph, 'hitRate'),
					}
				: null;

		// Compute savings
		let savings = null;
		if (baselineMedian && codegraphMedian && baselineMedian.inputTokens > 0) {
			const tokenSavings =
				((baselineMedian.inputTokens - codegraphMedian.inputTokens) /
					baselineMedian.inputTokens) *
				100;
			const costSavings =
				baselineMedian.totalCostUsd > 0
					? ((baselineMedian.totalCostUsd - codegraphMedian.totalCostUsd) /
							baselineMedian.totalCostUsd) *
						100
					: 0;
			savings = {
				inputTokensPct: Math.round(tokenSavings),
				costPct: Math.round(costSavings),
			};
		}

		results.push({
			id: issue.id,
			difficulty: issue.difficulty,
			pr: issue.pr,
			baseline: { median: baselineMedian, runs: baselineRuns },
			codegraph: { median: codegraphMedian, runs: codegraphRuns },
			savings,
		});

		if (savings) {
			console.error(
				`  Savings: ${savings.inputTokensPct}% tokens, ${savings.costPct}% cost`,
			);
		}
	}

	// ── Aggregate ───────────────────────────────────────────────────────

	const validResults = results.filter(
		(r) => r.baseline.median && r.codegraph.median && r.savings,
	);

	let aggregate = null;
	if (validResults.length > 0) {
		const totalBaselineTokens = validResults.reduce(
			(s, r) => s + r.baseline.median.inputTokens,
			0,
		);
		const totalCodegraphTokens = validResults.reduce(
			(s, r) => s + r.codegraph.median.inputTokens,
			0,
		);
		const totalBaselineCost = validResults.reduce(
			(s, r) => s + r.baseline.median.totalCostUsd,
			0,
		);
		const totalCodegraphCost = validResults.reduce(
			(s, r) => s + r.codegraph.median.totalCostUsd,
			0,
		);

		aggregate = {
			savings: {
				inputTokensPct:
					totalBaselineTokens > 0
						? Math.round(
								((totalBaselineTokens - totalCodegraphTokens) / totalBaselineTokens) * 100,
							)
						: 0,
				costPct:
					totalBaselineCost > 0
						? Math.round(
								((totalBaselineCost - totalCodegraphCost) / totalBaselineCost) * 100,
							)
						: 0,
			},
			baselineAvgHitRate: Math.round(
				validResults.reduce((s, r) => s + r.baseline.median.hitRate, 0) /
					validResults.length,
			),
			codegraphAvgHitRate: Math.round(
				validResults.reduce((s, r) => s + r.codegraph.median.hitRate, 0) /
					validResults.length,
			),
		};
	}

	// ── Performance benchmarks (optional) ────────────────────────────────

	let perfBenchmarks = null;
	if (RUN_PERF) {
		// Checkout latest commit from the first issue for a stable snapshot
		checkoutCommit(nextjsDir, selectedIssues[0].commitBefore);
		perfBenchmarks = await runPerfBenchmarks(nextjsDir);
	}

	// ── Output ──────────────────────────────────────────────────────────

	// Restore console.log for JSON output
	console.log = origLog;

	const output = {
		version: pkg.version,
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
}

main().catch((err) => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
