/**
 * Pure helpers for parsing Claude Agent SDK session results.
 *
 * Extracted out of `runSession` in token-benchmark.ts (#1906), which
 * exceeded codegraph's cognitive/cyclomatic/maxNesting complexity
 * thresholds. The usage-metric field-fallback logic (the SDK returns
 * snake_case or camelCase field names depending on version) and the
 * nested tool_use-block scan were the biggest contributors — both are
 * pure functions of the SDK result, so they're unit-testable here without
 * mocking the Agent SDK itself.
 */

/**
 * First truthy value among `values` (falsy values, including 0, are
 * skipped), else the last value. Equivalent to `a || b || ... || z`.
 */
export function firstTruthy<T>(...values: T[]): T {
	for (const v of values) {
		if (v) return v;
	}
	return values[values.length - 1];
}

export interface UsageMetrics {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	totalCostUsd: number;
	numTurns: number;
}

export interface SessionResult {
	usage?: Record<string, number>;
	num_turns?: number;
	numTurns?: number;
}

/**
 * Extract usage/turn metrics from an Agent SDK query result, tolerating
 * both snake_case (raw API) and camelCase (SDK-normalized) field names.
 */
export function extractUsageMetrics(result: SessionResult): UsageMetrics {
	const usage = result.usage || {};
	return {
		inputTokens: firstTruthy(usage.input_tokens, usage.inputTokens, 0),
		outputTokens: firstTruthy(usage.output_tokens, usage.outputTokens, 0),
		cacheReadInputTokens: firstTruthy(
			usage.cache_read_input_tokens,
			usage.cacheReadInputTokens,
			0,
		),
		totalCostUsd:
			Math.round(firstTruthy(usage.total_cost_usd, usage.totalCostUsd, 0) * 100) / 100,
		numTurns: firstTruthy(result.num_turns, result.numTurns, 0),
	};
}

export interface ToolUseBlock {
	type: string;
	name?: string;
	input?: { file_path?: string };
}

export interface AssistantMessage {
	role: string;
	content?: unknown;
}

/**
 * Collect all `tool_use` content blocks from a session's assistant
 * messages, in message order.
 */
export function collectToolUseBlocks(messages: AssistantMessage[]): ToolUseBlock[] {
	const blocks: ToolUseBlock[] = [];
	for (const msg of messages) {
		if (msg.role !== 'assistant') continue;
		const msgBlocks = Array.isArray(msg.content) ? (msg.content as ToolUseBlock[]) : [];
		for (const block of msgBlocks) {
			if (block.type === 'tool_use') blocks.push(block);
		}
	}
	return blocks;
}

export interface ToolCallTally {
	toolCalls: Record<string, number>;
	uniqueFilesRead: number;
}

/**
 * Tally tool-call counts by name and the set of unique files read, from a
 * session's `tool_use` blocks.
 */
export function tallyToolCalls(messages: AssistantMessage[]): ToolCallTally {
	const toolCalls: Record<string, number> = {};
	const uniqueFilesRead = new Set<string>();

	for (const block of collectToolUseBlocks(messages)) {
		const name = block.name || 'unknown';
		toolCalls[name] = (toolCalls[name] || 0) + 1;
		if (name === 'Read' && block.input?.file_path) {
			uniqueFilesRead.add(block.input.file_path);
		}
	}

	return { toolCalls, uniqueFilesRead: uniqueFilesRead.size };
}
