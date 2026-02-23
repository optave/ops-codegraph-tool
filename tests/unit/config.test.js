/**
 * Unit tests for src/config.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  applyEnvOverrides,
  CONFIG_FILES,
  DEFAULTS,
  loadConfig,
  resolveSecrets,
} from '../../src/config.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-config-'));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CONFIG_FILES', () => {
  it('exports expected config file names', () => {
    expect(CONFIG_FILES).toContain('.codegraphrc.json');
    expect(CONFIG_FILES).toContain('.codegraphrc');
    expect(CONFIG_FILES).toContain('codegraph.config.json');
    expect(CONFIG_FILES).toHaveLength(3);
  });
});

describe('DEFAULTS', () => {
  it('has expected shape', () => {
    expect(DEFAULTS).toHaveProperty('include');
    expect(DEFAULTS).toHaveProperty('exclude');
    expect(DEFAULTS).toHaveProperty('ignoreDirs');
    expect(DEFAULTS).toHaveProperty('extensions');
    expect(DEFAULTS).toHaveProperty('aliases');
    expect(DEFAULTS).toHaveProperty('build');
    expect(DEFAULTS).toHaveProperty('query');
    expect(DEFAULTS.build).toHaveProperty('incremental', true);
    expect(DEFAULTS.query).toHaveProperty('defaultDepth', 3);
  });

  it('has embeddings defaults', () => {
    expect(DEFAULTS.embeddings).toEqual({ model: 'jina-code', llmProvider: null });
  });

  it('has llm defaults', () => {
    expect(DEFAULTS.llm).toEqual({
      provider: null,
      model: null,
      baseUrl: null,
      apiKey: null,
      apiKeyCommand: null,
    });
  });

  it('has search defaults', () => {
    expect(DEFAULTS.search).toEqual({ defaultMinScore: 0.2, rrfK: 60, topK: 15 });
  });

  it('has ci defaults', () => {
    expect(DEFAULTS.ci).toEqual({ failOnCycles: false, impactThreshold: null });
  });
});

describe('loadConfig', () => {
  it('returns defaults when no config files exist', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
    const config = loadConfig(dir);
    expect(config.include).toEqual([]);
    expect(config.build.incremental).toBe(true);
    expect(config.query.defaultDepth).toBe(3);
  });

  it('loads .codegraphrc.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'rc-json-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ ignoreDirs: ['vendor'] }),
    );
    const config = loadConfig(dir);
    expect(config.ignoreDirs).toEqual(['vendor']);
    // defaults preserved
    expect(config.build.incremental).toBe(true);
  });

  it('loads .codegraphrc', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'rc-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc'), JSON.stringify({ extensions: ['.vue'] }));
    const config = loadConfig(dir);
    expect(config.extensions).toEqual(['.vue']);
  });

  it('loads codegraph.config.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'config-json-'));
    fs.writeFileSync(
      path.join(dir, 'codegraph.config.json'),
      JSON.stringify({ exclude: ['generated/'] }),
    );
    const config = loadConfig(dir);
    expect(config.exclude).toEqual(['generated/']);
  });

  it('first-found wins (.codegraphrc.json over .codegraphrc)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'priority-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ ignoreDirs: ['winner'] }),
    );
    fs.writeFileSync(path.join(dir, '.codegraphrc'), JSON.stringify({ ignoreDirs: ['loser'] }));
    const config = loadConfig(dir);
    expect(config.ignoreDirs).toEqual(['winner']);
  });

  it('returns defaults on invalid JSON', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'invalid-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), '{ bad json }}}');
    const config = loadConfig(dir);
    expect(config.include).toEqual([]);
    expect(config.build.incremental).toBe(true);
  });

  it('deep-merges nested objects', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'merge-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ build: { dbPath: 'custom.db' } }),
    );
    const config = loadConfig(dir);
    expect(config.build.dbPath).toBe('custom.db');
    expect(config.build.incremental).toBe(true);
  });

  it('replaces arrays rather than merging', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'array-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), JSON.stringify({ include: ['src/**'] }));
    const config = loadConfig(dir);
    expect(config.include).toEqual(['src/**']);
  });

  it('deep-merges new search section with defaults', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'search-merge-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), JSON.stringify({ search: { topK: 50 } }));
    const config = loadConfig(dir);
    expect(config.search.topK).toBe(50);
    expect(config.search.defaultMinScore).toBe(0.2);
    expect(config.search.rrfK).toBe(60);
  });
});

describe('applyEnvOverrides', () => {
  const ENV_KEYS = ['CODEGRAPH_LLM_PROVIDER', 'CODEGRAPH_LLM_API_KEY', 'CODEGRAPH_LLM_MODEL'];

  afterEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('overrides llm.provider from env', () => {
    process.env.CODEGRAPH_LLM_PROVIDER = 'anthropic';
    const config = applyEnvOverrides({
      llm: { provider: null, model: null, baseUrl: null, apiKey: null },
    });
    expect(config.llm.provider).toBe('anthropic');
  });

  it('overrides llm.apiKey from env', () => {
    process.env.CODEGRAPH_LLM_API_KEY = 'sk-test-123';
    const config = applyEnvOverrides({
      llm: { provider: null, model: null, baseUrl: null, apiKey: null },
    });
    expect(config.llm.apiKey).toBe('sk-test-123');
  });

  it('overrides llm.model from env', () => {
    process.env.CODEGRAPH_LLM_MODEL = 'gpt-4';
    const config = applyEnvOverrides({
      llm: { provider: null, model: null, baseUrl: null, apiKey: null },
    });
    expect(config.llm.model).toBe('gpt-4');
  });

  it('env vars take priority over file config', () => {
    process.env.CODEGRAPH_LLM_PROVIDER = 'anthropic';
    const dir = fs.mkdtempSync(path.join(tmpDir, 'env-priority-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { provider: 'openai' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.provider).toBe('anthropic');
  });

  it('leaves file config intact when env vars are not set', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'env-absent-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { provider: 'openai' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.provider).toBe('openai');
  });
});

describe('resolveSecrets', () => {
  let mockExecFile;

  beforeAll(async () => {
    const cp = await import('node:child_process');
    mockExecFile = cp.execFileSync;
  });

  afterEach(() => {
    mockExecFile.mockReset();
  });

  it('resolves apiKey from command', () => {
    mockExecFile.mockReturnValue('secret-key-123');
    const config = {
      llm: {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyCommand: 'op read secret/key',
      },
    };
    resolveSecrets(config);
    expect(mockExecFile).toHaveBeenCalledWith('op', ['read', 'secret/key'], {
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(config.llm.apiKey).toBe('secret-key-123');
  });

  it('trims whitespace from command output', () => {
    mockExecFile.mockReturnValue('  secret-key  \n');
    const config = {
      llm: {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: null,
        apiKeyCommand: 'cat keyfile',
      },
    };
    resolveSecrets(config);
    expect(config.llm.apiKey).toBe('secret-key');
  });

  it('skips when apiKeyCommand is null', () => {
    const config = {
      llm: { provider: null, model: null, baseUrl: null, apiKey: 'existing', apiKeyCommand: null },
    };
    resolveSecrets(config);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(config.llm.apiKey).toBe('existing');
  });

  it('skips when apiKeyCommand is not a string', () => {
    const config = {
      llm: { provider: null, model: null, baseUrl: null, apiKey: 'existing', apiKeyCommand: 42 },
    };
    resolveSecrets(config);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(config.llm.apiKey).toBe('existing');
  });

  it('warns and preserves existing apiKey on command failure', () => {
    mockExecFile.mockImplementation(() => {
      throw new Error('command not found');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const config = {
      llm: {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: 'keep-me',
        apiKeyCommand: 'bad-cmd',
      },
    };
    resolveSecrets(config);
    expect(config.llm.apiKey).toBe('keep-me');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('apiKeyCommand failed'));
    stderrSpy.mockRestore();
  });

  it('does not overwrite apiKey when command returns empty output', () => {
    mockExecFile.mockReturnValue('   \n');
    const config = {
      llm: {
        provider: null,
        model: null,
        baseUrl: null,
        apiKey: 'original',
        apiKeyCommand: 'echo ""',
      },
    };
    resolveSecrets(config);
    expect(config.llm.apiKey).toBe('original');
  });

  it('handles empty string command gracefully', () => {
    const config = {
      llm: { provider: null, model: null, baseUrl: null, apiKey: 'existing', apiKeyCommand: '  ' },
    };
    resolveSecrets(config);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(config.llm.apiKey).toBe('existing');
  });
});

describe('apiKeyCommand integration', () => {
  const ENV_KEYS = ['CODEGRAPH_LLM_PROVIDER', 'CODEGRAPH_LLM_API_KEY', 'CODEGRAPH_LLM_MODEL'];
  let mockExecFile;

  beforeAll(async () => {
    const cp = await import('node:child_process');
    mockExecFile = cp.execFileSync;
  });

  afterEach(() => {
    mockExecFile.mockReset();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  it('command output beats file apiKey', () => {
    mockExecFile.mockReturnValue('command-key');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'cmd-file-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { apiKey: 'file-key', apiKeyCommand: 'vault get key' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.apiKey).toBe('command-key');
  });

  it('command output beats env var', () => {
    process.env.CODEGRAPH_LLM_API_KEY = 'env-key';
    mockExecFile.mockReturnValue('command-key');
    const dir = fs.mkdtempSync(path.join(tmpDir, 'cmd-env-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { apiKeyCommand: 'vault get key' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.apiKey).toBe('command-key');
  });

  it('env var still works when no apiKeyCommand is set', () => {
    process.env.CODEGRAPH_LLM_API_KEY = 'env-key';
    const dir = fs.mkdtempSync(path.join(tmpDir, 'env-no-cmd-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { provider: 'openai' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.apiKey).toBe('env-key');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('graceful failure falls back to env var value', () => {
    process.env.CODEGRAPH_LLM_API_KEY = 'env-fallback';
    mockExecFile.mockImplementation(() => {
      throw new Error('timeout');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const dir = fs.mkdtempSync(path.join(tmpDir, 'cmd-fail-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ llm: { apiKeyCommand: 'vault get key' } }),
    );
    const config = loadConfig(dir);
    expect(config.llm.apiKey).toBe('env-fallback');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('apiKeyCommand failed'));
    stderrSpy.mockRestore();
  });
});
