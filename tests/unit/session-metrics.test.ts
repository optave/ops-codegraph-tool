/**
 * Unit tests for scripts/lib/session-metrics.ts
 *
 * Regression coverage for #1906: `runSession` in scripts/token-benchmark.ts
 * exceeded codegraph's cognitive/cyclomatic/maxNesting complexity
 * thresholds. These pure helpers were extracted out of it; this suite pins
 * their behavior (including the snake_case/camelCase field-fallback
 * semantics of `firstTruthy`, which must match `a || b || ... || z`, not
 * `??`) so a future refactor can't silently change it.
 */

import { describe, expect, it } from 'vitest';
import {
  collectToolUseBlocks,
  extractUsageMetrics,
  firstTruthy,
  tallyToolCalls,
} from '../../scripts/lib/session-metrics.js';

describe('firstTruthy', () => {
  it('returns the first truthy value', () => {
    expect(firstTruthy(0, 5, 10)).toBe(5);
    expect(firstTruthy(undefined, undefined, 3)).toBe(3);
  });

  it('treats 0 as falsy, matching `||` chain semantics (not `??`)', () => {
    expect(firstTruthy(0, 0, 7)).toBe(7);
  });

  it('falls back to the last value when nothing is truthy', () => {
    expect(firstTruthy(0, undefined, 0)).toBe(0);
  });
});

describe('extractUsageMetrics', () => {
  it('prefers snake_case (raw API) field names', () => {
    const metrics = extractUsageMetrics({
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        total_cost_usd: 0.1234,
      },
      num_turns: 3,
    });
    expect(metrics).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      totalCostUsd: 0.12,
      numTurns: 3,
    });
  });

  it('falls back to camelCase (SDK-normalized) field names', () => {
    const metrics = extractUsageMetrics({
      usage: { inputTokens: 200, outputTokens: 75, cacheReadInputTokens: 5, totalCostUsd: 0.5 },
      numTurns: 4,
    });
    expect(metrics).toEqual({
      inputTokens: 200,
      outputTokens: 75,
      cacheReadInputTokens: 5,
      totalCostUsd: 0.5,
      numTurns: 4,
    });
  });

  it('defaults every field to 0 when usage/turns are absent', () => {
    expect(extractUsageMetrics({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      totalCostUsd: 0,
      numTurns: 0,
    });
  });

  it('rounds totalCostUsd to 2 decimal places', () => {
    const metrics = extractUsageMetrics({ usage: { total_cost_usd: 1.23456 } });
    expect(metrics.totalCostUsd).toBe(1.23);
  });
});

describe('collectToolUseBlocks', () => {
  it('collects only tool_use blocks from assistant messages, in order', () => {
    const messages = [
      { role: 'user', content: [{ type: 'tool_use', name: 'Read' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', name: 'Glob' },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] },
    ];
    const blocks = collectToolUseBlocks(messages as never);
    expect(blocks.map((b) => b.name)).toEqual(['Glob', 'Read', 'Bash']);
  });

  it('tolerates non-array content', () => {
    const messages = [{ role: 'assistant', content: 'plain text' }];
    expect(collectToolUseBlocks(messages as never)).toEqual([]);
  });

  it('returns an empty array for no messages', () => {
    expect(collectToolUseBlocks([])).toEqual([]);
  });
});

describe('tallyToolCalls', () => {
  it('counts tool calls by name and dedupes files read', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/a.ts' } },
          { type: 'tool_use', name: 'Read', input: { file_path: '/b.ts' } },
          { type: 'tool_use', name: 'Grep' },
        ],
      },
    ];
    const { toolCalls, uniqueFilesRead } = tallyToolCalls(messages as never);
    expect(toolCalls).toEqual({ Read: 3, Grep: 1 });
    expect(uniqueFilesRead).toBe(2);
  });

  it('names unnamed tool_use blocks "unknown"', () => {
    const messages = [{ role: 'assistant', content: [{ type: 'tool_use' }] }];
    const { toolCalls } = tallyToolCalls(messages as never);
    expect(toolCalls).toEqual({ unknown: 1 });
  });

  it('returns zero tallies for no messages', () => {
    expect(tallyToolCalls([])).toEqual({ toolCalls: {}, uniqueFilesRead: 0 });
  });
});
