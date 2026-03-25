/**
 * Issue catalog for the token savings benchmark.
 *
 * Each entry is a real closed Next.js PR, varying in difficulty. The agent
 * is given the bug description (never the solution) and asked to identify
 * which source files need modification.
 *
 * Ground truth (`expectedFiles`) lists only *source* files that were changed
 * in the actual fix — test files are excluded.
 */

/** @typedef {'easy'|'medium'|'hard'} Difficulty */

/**
 * @typedef {object} BenchmarkIssue
 * @property {string}     id
 * @property {Difficulty}  difficulty
 * @property {number}     pr            — Next.js PR number
 * @property {string}     title
 * @property {string}     description   — bug description for the agent prompt
 * @property {string}     commitBefore  — base SHA (before the fix)
 * @property {string[]}   expectedFiles — source files changed in the fix
 */

/** @type {BenchmarkIssue[]} */
export const ISSUES = [
	// ── Easy (1 source file) ──────────────────────────────────────────────
	{
		id: 'csrf-case-insensitive',
		difficulty: 'easy',
		pr: 89127,
		title: 'CSRF origin matching should be case-insensitive',
		description:
			'The isCsrfOriginAllowed function used for Server Actions CSRF protection ' +
			'performs case-sensitive domain matching. However, DNS names are case-insensitive ' +
			'per RFC 1035. Requests with uppercase Origin headers (e.g. sub.VERCEL.com) fail ' +
			'CSRF checks against configured patterns like *.vercel.com, causing legitimate ' +
			'Server Action requests to be rejected when serverActions.allowedOrigins is set ' +
			'in next.config.js.',
		commitBefore: '59c48b73b4a01b4b5b9277eff1e62d75097ba812',
		expectedFiles: ['packages/next/src/server/app-render/csrf-protection.ts'],
	},

	// ── Medium (2 source files) ───────────────────────────────────────────
	{
		id: 'ready-in-time',
		difficulty: 'medium',
		pr: 88589,
		title: 'Fix incorrect "Ready in" time for next start',
		description:
			'Running `next start` displays impossibly large "Ready in" times like ' +
			'"Ready in 29474457.7min" instead of the actual startup duration. The ' +
			'NEXT_PRIVATE_START_TIME environment variable is not being properly set or ' +
			'propagated when startServer() reads it. When the variable is missing, the code ' +
			'defaults to 0, causing the calculation `Date.now() - 0` to equal the entire ' +
			'Unix timestamp. The bug involves two subsystems: the CLI entry point ' +
			'(next-start.ts) which should set the env var, and the server startup ' +
			'(start-server.ts) which consumes it.',
		commitBefore: '52b2b8be6a74b4f65fe595de1d6e3311efd3c446',
		expectedFiles: [
			'packages/next/src/cli/next-start.ts',
			'packages/next/src/server/lib/start-server.ts',
		],
	},
	{
		id: 'aggregate-error-inspect',
		difficulty: 'medium',
		pr: 88999,
		title: 'Include AggregateError.errors in terminal output',
		description:
			'console.error(aggregateError) in Next.js production backends omits the ' +
			'[errors] property entirely. Next.js patches util.inspect to rewrite stack ' +
			'traces, but the patch does not handle AggregateError.errors because it is a ' +
			'non-enumerable property. The existing enumerable-property iteration logic ' +
			'skips it. Additionally, the depth calculation in the patch is miscalculated, ' +
			'causing nested Error.cause chains to truncate at the wrong depth.',
		commitBefore: '1c73ca5a58e3ec8ab6f1b908f2819245a6147469',
		expectedFiles: ['packages/next/src/server/patch-error-inspect.ts'],
	},

	// ── Hard (6-7 source files) ───────────────────────────────────────────
	{
		id: 'otel-propagation',
		difficulty: 'hard',
		pr: 90181,
		title: 'Fix OTEL propagation and add direct entrypoint e2e coverage',
		description:
			'OpenTelemetry trace context propagation is broken when using the Next.js ' +
			'entrypoint handler directly (without the next-server wrapper). The forced ' +
			'trace context extraction in the tracer drops the active context when no ' +
			'remote span context is present in incoming request headers. Upstream trace ' +
			'contexts are not propagated through app pages, app routes, or pages API ' +
			'routes. The bug spans build templates (app-page, app-route, pages-api), the ' +
			'router-server-context, the tracer propagation logic, and next-server ' +
			'initialization across 6 source files in 4 directories.',
		commitBefore: '87f609e710650c5b05664ac1da3b2cd35a643d78',
		expectedFiles: [
			'packages/next/src/build/templates/app-page.ts',
			'packages/next/src/build/templates/app-route.ts',
			'packages/next/src/build/templates/pages-api.ts',
			'packages/next/src/server/lib/router-utils/router-server-context.ts',
			'packages/next/src/server/lib/trace/tracer.ts',
			'packages/next/src/server/next-server.ts',
		],
	},
	{
		id: 'static-rsc-payloads',
		difficulty: 'hard',
		pr: 89202,
		title: 'Fully static pages should emit and serve static RSC payloads',
		description:
			'Navigating to fully static PPR (Partial Pre-Rendering) routes in Cache ' +
			'Components triggers unnecessary function invocations instead of serving ' +
			'cached static content. After the Cache Components refactor, ' +
			'prefetchDataRoute entries are no longer populated with .prefetch.rsc values ' +
			'containing static RSC payloads. Static payloads only exist in the .segments ' +
			'directory. When a non-prefetch RSC request occurs (prefetch not completed or ' +
			'prefetch={false}), it routes to an empty fallback and invokes a function ' +
			'instead of serving static content. The fix requires changes across the build ' +
			'pipeline, export system, build adapter, and incremental cache — 7 source ' +
			'files in 5 directories.',
		commitBefore: '0e457e95a96089eea85159635d7b75838699dd87',
		expectedFiles: [
			'packages/next/src/build/adapter/build-complete.ts',
			'packages/next/src/build/index.ts',
			'packages/next/src/build/templates/app-page.ts',
			'packages/next/src/export/index.ts',
			'packages/next/src/export/routes/app-page.ts',
			'packages/next/src/export/types.ts',
			'packages/next/src/server/lib/incremental-cache/file-system-cache.ts',
		],
	},
];

/**
 * Compute hit rate — percentage of expected files the agent identified.
 *
 * Uses path suffix matching so the agent doesn't need to get the exact
 * repo-relative path right (e.g. "src/server/tracer.ts" matches
 * "packages/next/src/server/lib/trace/tracer.ts" won't match, but
 * "server/lib/trace/tracer.ts" will).
 *
 * @param {string}   issueId
 * @param {string[]} filesIdentified — files the agent reported
 * @returns {{ hits: number, total: number, hitRate: number, matched: string[], missed: string[] }}
 */
export function validateResult(issueId, filesIdentified) {
	const issue = ISSUES.find((i) => i.id === issueId);
	if (!issue) throw new Error(`Unknown issue: ${issueId}`);

	const normalize = (f) => f.replace(/\\/g, '/');
	const identified = filesIdentified.map(normalize);

	const matched = [];
	const missed = [];

	for (const expected of issue.expectedFiles) {
		const norm = normalize(expected);
		const found = identified.some(
			(f) => f === norm || f.endsWith('/' + norm) || norm.endsWith('/' + f),
		);
		if (found) {
			matched.push(expected);
		} else {
			missed.push(expected);
		}
	}

	const total = issue.expectedFiles.length;
	const hits = matched.length;
	return {
		hits,
		total,
		hitRate: total > 0 ? Math.round((hits / total) * 100) : 0,
		matched,
		missed,
	};
}

/**
 * Extract the agent's structured output from its messages.
 *
 * Looks for a fenced JSON block containing `{ "files": [...] }`.
 *
 * @param {Array<{ role: string, content: string|Array }>} messages
 * @returns {{ files: string[], explanation: string } | null}
 */
export function extractAgentOutput(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== 'assistant') continue;

		const text =
			typeof msg.content === 'string'
				? msg.content
				: Array.isArray(msg.content)
					? msg.content
							.filter((b) => b.type === 'text')
							.map((b) => b.text)
							.join('\n')
					: '';

		// Match ```json ... ``` or bare { "files": ... }
		const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?"files"[\s\S]*?\})\s*```/);
		if (fenced) {
			try {
				return JSON.parse(fenced[1]);
			} catch {
				/* try next pattern */
			}
		}

		const bare = text.match(/(\{[\s\S]*?"files"\s*:\s*\[[\s\S]*?\][\s\S]*?\})/);
		if (bare) {
			try {
				return JSON.parse(bare[1]);
			} catch {
				/* skip */
			}
		}
	}

	return null;
}
