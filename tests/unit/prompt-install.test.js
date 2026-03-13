/**
 * Unit tests for the interactive install prompt in src/embedder.js.
 *
 * Tests the promptInstall() + loadTransformers() flow when
 * @huggingface/transformers is missing.
 *
 * Each test uses vi.resetModules() + vi.doMock() + dynamic import()
 * so every test gets a fresh embedder module with its own mocks.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('loadTransformers install prompt', () => {
  let exitSpy;
  let errorSpy;
  let logSpy;
  let origTTY;

  beforeEach(() => {
    vi.resetModules();
    origTTY = process.stdin.isTTY;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.stdin.isTTY = origTTY;
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test('non-TTY: throws EngineError without prompting', async () => {
    process.stdin.isTTY = undefined;

    const rlFactory = vi.fn();
    vi.doMock('node:readline', () => ({ createInterface: rlFactory }));
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error('Cannot find package');
    });

    const { embed } = await import('../../src/embeddings/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'Semantic search requires @huggingface/transformers',
    );
    await expect(embed(['test'], 'minilm')).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ENGINE_UNAVAILABLE',
    });
    // readline should NOT have been called — no prompt in non-TTY
    expect(rlFactory).not.toHaveBeenCalled();
  });

  test('TTY + user declines: throws EngineError', async () => {
    process.stdin.isTTY = true;

    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_prompt, cb) => cb('n'),
        close: vi.fn(),
      }),
    }));
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error('Cannot find package');
    });

    const { embed } = await import('../../src/embeddings/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'Semantic search requires @huggingface/transformers',
    );
    await expect(embed(['test'], 'minilm')).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ENGINE_UNAVAILABLE',
    });
  });

  test('TTY + user accepts but npm install fails: throws EngineError', async () => {
    process.stdin.isTTY = true;

    const execMock = vi.fn(() => {
      throw new Error('npm ERR!');
    });
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_prompt, cb) => cb('y'),
        close: vi.fn(),
      }),
    }));
    vi.doMock('node:child_process', () => ({ execFileSync: execMock }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error('Cannot find package');
    });

    const { embed } = await import('../../src/embeddings/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'Semantic search requires @huggingface/transformers',
    );
    await expect(embed(['test'], 'minilm')).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ENGINE_UNAVAILABLE',
    });
    expect(execMock).toHaveBeenCalledWith(
      'npm',
      ['install', '@huggingface/transformers'],
      expect.objectContaining({ stdio: 'inherit', timeout: 300_000 }),
    );
  });

  test('TTY + install succeeds: retries import and loads module', async () => {
    process.stdin.isTTY = true;

    let importCount = 0;
    vi.doMock('node:readline', () => ({
      createInterface: () => ({
        question: (_prompt, cb) => cb('y'),
        close: vi.fn(),
      }),
    }));
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('@huggingface/transformers', () => {
      importCount++;
      if (importCount <= 1) throw new Error('Cannot find package');
      return {
        pipeline: async () => async (batch) => ({
          data: new Float32Array(384 * batch.length),
        }),
        cos_sim: () => 0,
      };
    });

    const { embed } = await import('../../src/embeddings/index.js');

    const result = await embed(['test text'], 'minilm');
    expect(result.vectors).toHaveLength(1);
    expect(result.dim).toBe(384);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
