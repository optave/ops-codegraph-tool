/**
 * Unit tests for the interactive install prompt in src/embeddings/models.js.
 *
 * Tests the promptInstall() + loadTransformers() flow when
 * @huggingface/transformers is missing.
 *
 * Each test uses vi.resetModules() + vi.doMock() + dynamic import()
 * so every test gets a fresh embedder module with its own mocks.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const expectedNpmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('loadTransformers install prompt', () => {
  let exitSpy: any;
  let errorSpy: any;
  let logSpy: any;
  let origTTY: any;

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

  test('non-TTY: auto-installs without prompting', async () => {
    process.stdin.isTTY = undefined;

    let importCount = 0;
    const rlFactory = vi.fn();
    const execMock = vi.fn();
    vi.doMock('node:readline', () => ({ createInterface: rlFactory }));
    vi.doMock('node:child_process', () => ({ execFileSync: execMock }));
    vi.doMock('@huggingface/transformers', () => {
      importCount++;
      if (importCount <= 1) throw new Error('Cannot find package');
      return {
        pipeline: async () => async (batch: string[]) => ({
          data: new Float32Array(384 * batch.length),
        }),
        cos_sim: () => 0,
      };
    });

    const { embed } = await import('../../src/domain/search/index.js');

    const result = await embed(['test text'], 'minilm');
    expect(result.vectors).toHaveLength(1);
    expect(result.dim).toBe(384);
    // readline should NOT have been called — no prompt in non-TTY
    expect(rlFactory).not.toHaveBeenCalled();
    // npm install should have been called automatically
    expect(execMock).toHaveBeenCalledWith(
      expectedNpmBin,
      ['install', '--no-save', '@huggingface/transformers'],
      expect.objectContaining({ stdio: 'inherit', timeout: 300_000 }),
    );
  });

  test('non-TTY: throws EngineError when auto-install fails', async () => {
    process.stdin.isTTY = undefined;

    const rlFactory = vi.fn();
    const execMock = vi.fn(() => {
      throw new Error('npm ERR!');
    });
    vi.doMock('node:readline', () => ({ createInterface: rlFactory }));
    vi.doMock('node:child_process', () => ({ execFileSync: execMock }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error('Cannot find package');
    });

    const { embed } = await import('../../src/domain/search/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'Semantic search requires @huggingface/transformers',
    );
    await expect(embed(['test'], 'minilm')).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ENGINE_UNAVAILABLE',
    });
    // readline should NOT have been called — no prompt in non-TTY
    expect(rlFactory).not.toHaveBeenCalled();
    // npm install was attempted
    expect(execMock).toHaveBeenCalled();
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

    const { embed } = await import('../../src/domain/search/index.js');

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

    const { embed } = await import('../../src/domain/search/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'Semantic search requires @huggingface/transformers',
    );
    await expect(embed(['test'], 'minilm')).rejects.toMatchObject({
      name: 'EngineError',
      code: 'ENGINE_UNAVAILABLE',
    });
    expect(execMock).toHaveBeenCalledWith(
      expectedNpmBin,
      ['install', '--no-save', '@huggingface/transformers'],
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

    const { embed } = await import('../../src/domain/search/index.js');

    const result = await embed(['test text'], 'minilm');
    expect(result.vectors).toHaveLength(1);
    expect(result.dim).toBe(384);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('resolveNpmInstallCwd', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('returns host directory (4 dirname hops from scoped package.json)', async () => {
    const fakePkg = path.join(
      path.sep,
      'host',
      'node_modules',
      '@optave',
      'codegraph',
      'package.json',
    );
    vi.doMock('node:module', () => ({
      createRequire: () => ({
        resolve: (req: string) => {
          if (req === '@optave/codegraph/package.json') return fakePkg;
          throw new Error(`Cannot find: ${req}`);
        },
      }),
    }));

    const { resolveNpmInstallCwd } = await import('../../src/domain/search/models.js');
    expect(resolveNpmInstallCwd()).toBe(path.join(path.sep, 'host'));
  });

  test('returns undefined when @optave/codegraph cannot be resolved', async () => {
    vi.doMock('node:module', () => ({
      createRequire: () => ({
        resolve: () => {
          throw new Error('Cannot find module @optave/codegraph');
        },
      }),
    }));

    const { resolveNpmInstallCwd } = await import('../../src/domain/search/models.js');
    expect(resolveNpmInstallCwd()).toBeUndefined();
  });
});

describe('isNpmGlobalModulesRoot', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-npm-global-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('returns true when dir contains node_modules/npm (npm global modules root)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'npm'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'npm', 'package.json'), '{}');

    const { isNpmGlobalModulesRoot } = await import('../../src/domain/search/models.js');
    expect(isNpmGlobalModulesRoot(tmpDir)).toBe(true);
  });

  test('returns false for a normal project directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'node_modules', '@optave', 'codegraph'), { recursive: true });

    const { isNpmGlobalModulesRoot } = await import('../../src/domain/search/models.js');
    expect(isNpmGlobalModulesRoot(tmpDir)).toBe(false);
  });

  test('returns false when dir is undefined', async () => {
    const { isNpmGlobalModulesRoot } = await import('../../src/domain/search/models.js');
    expect(isNpmGlobalModulesRoot(undefined)).toBe(false);
  });
});

describe('promptInstall: global codegraph install', () => {
  let tmpDir: string;
  let origTTY: any;

  beforeEach(() => {
    vi.resetModules();
    origTTY = process.stdin.isTTY;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-global-install-'));
    // Simulate npm's own global modules root: <tmpDir>/node_modules/npm + the
    // globally-installed codegraph package living alongside it.
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'npm'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'npm', 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, 'node_modules', '@optave', 'codegraph'), { recursive: true });

    const fakePkg = path.join(tmpDir, 'node_modules', '@optave', 'codegraph', 'package.json');
    vi.doMock('node:module', () => ({
      createRequire: () => ({
        resolve: (req: string) => {
          if (req === '@optave/codegraph/package.json') return fakePkg;
          throw new Error(`Cannot find: ${req}`);
        },
      }),
    }));
  });

  afterEach(() => {
    process.stdin.isTTY = origTTY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  test('never invokes npm install and rejects with -g guidance', async () => {
    process.stdin.isTTY = undefined;

    const execMock = vi.fn();
    vi.doMock('node:child_process', () => ({ execFileSync: execMock }));
    vi.doMock('@huggingface/transformers', () => {
      throw new Error('Cannot find package');
    });

    const { embed } = await import('../../src/domain/search/index.js');

    await expect(embed(['test'], 'minilm')).rejects.toThrow(
      'npm install -g @huggingface/transformers',
    );
    expect(execMock).not.toHaveBeenCalled();
  });
});
