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
  detectWorkspaces,
  loadConfig,
  mergeConfig,
  resolveSecrets,
} from '../../src/infrastructure/config.js';

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
    expect(DEFAULTS.embeddings).toEqual({ model: 'nomic-v1.5', llmProvider: null });
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
    expect(DEFAULTS.search).toEqual({
      defaultMinScore: 0.2,
      rrfK: 60,
      topK: 15,
      similarityWarnThreshold: 0.85,
    });
  });

  it('has ci defaults', () => {
    expect(DEFAULTS.ci).toEqual({ failOnCycles: false, impactThreshold: null });
  });

  it('has analysis defaults', () => {
    expect(DEFAULTS.analysis).toEqual({
      impactDepth: 3,
      fnImpactDepth: 5,
      auditDepth: 3,
      sequenceDepth: 10,
      falsePositiveCallers: 20,
      briefCallerDepth: 5,
      briefImporterDepth: 5,
      briefHighRiskCallers: 10,
      briefMediumRiskCallers: 3,
    });
  });

  it('has risk defaults', () => {
    expect(DEFAULTS.risk.weights).toEqual({
      fanIn: 0.25,
      complexity: 0.3,
      churn: 0.2,
      role: 0.15,
      mi: 0.1,
    });
    expect(DEFAULTS.risk.defaultRoleWeight).toBe(0.5);
    expect(DEFAULTS.risk.roleWeights.core).toBe(1.0);
  });

  it('has display defaults', () => {
    expect(DEFAULTS.display).toEqual({
      maxColWidth: 40,
      excerptLines: 50,
      summaryMaxChars: 100,
      jsdocEndScanLines: 10,
      jsdocOpenScanLines: 20,
      signatureGatherLines: 5,
    });
  });

  it('has community defaults', () => {
    expect(DEFAULTS.community).toEqual({ resolution: 1.0, maxLevels: 50, maxLocalPasses: 20 });
  });

  it('has structure defaults', () => {
    expect(DEFAULTS.structure).toEqual({ cohesionThreshold: 0.3 });
  });

  it('has mcp defaults', () => {
    expect(DEFAULTS.mcp.defaults.list_functions).toBe(100);
    expect(DEFAULTS.mcp.defaults.fn_impact).toBe(5);
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

  it('deep-merges nested objects recursively (2+ levels)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'deep-merge-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ risk: { weights: { complexity: 0.4, churn: 0.1 } } }),
    );
    const config = loadConfig(dir);
    // User overrides applied
    expect(config.risk.weights.complexity).toBe(0.4);
    expect(config.risk.weights.churn).toBe(0.1);
    // Sibling keys preserved (not dropped)
    expect(config.risk.weights.fanIn).toBe(0.25);
    expect(config.risk.weights.role).toBe(0.15);
    expect(config.risk.weights.mi).toBe(0.1);
    // Sibling sections preserved
    expect(config.risk.defaultRoleWeight).toBe(0.5);
    expect(config.risk.roleWeights.core).toBe(1.0);
  });

  it('loads analysis overrides from config', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'analysis-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ analysis: { fnImpactDepth: 8, falsePositiveCallers: 30 } }),
    );
    const config = loadConfig(dir);
    expect(config.analysis.fnImpactDepth).toBe(8);
    expect(config.analysis.falsePositiveCallers).toBe(30);
    // Defaults preserved
    expect(config.analysis.impactDepth).toBe(3);
    expect(config.analysis.auditDepth).toBe(3);
  });
});

describe('mergeConfig', () => {
  it('recursively merges nested objects', () => {
    const defaults = { a: { b: { c: 1, d: 2 }, e: 3 } };
    const overrides = { a: { b: { c: 10 } } };
    const result = mergeConfig(defaults, overrides);
    expect(result.a.b.c).toBe(10);
    expect(result.a.b.d).toBe(2);
    expect(result.a.e).toBe(3);
  });

  it('replaces arrays instead of merging', () => {
    const defaults = { a: [1, 2, 3] };
    const overrides = { a: [4] };
    const result = mergeConfig(defaults, overrides);
    expect(result.a).toEqual([4]);
  });

  it('handles overrides with keys not in defaults', () => {
    const defaults = { a: 1 };
    const overrides = { b: 2 };
    const result = mergeConfig(defaults, overrides);
    expect(result.a).toBe(1);
    expect(result.b).toBe(2);
  });

  it('does not mutate defaults', () => {
    const defaults = { a: { b: 1 } };
    const overrides = { a: { b: 2 } };
    mergeConfig(defaults, overrides);
    expect(defaults.a.b).toBe(1);
  });
});

describe('excludeTests hoisting', () => {
  it('hoists top-level excludeTests into query.excludeTests', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'exclude-top-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), JSON.stringify({ excludeTests: true }));
    const config = loadConfig(dir);
    expect(config.query.excludeTests).toBe(true);
    expect(config.excludeTests).toBeUndefined();
  });

  it('nested query.excludeTests takes precedence over top-level', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'exclude-nested-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ excludeTests: true, query: { excludeTests: false } }),
    );
    const config = loadConfig(dir);
    expect(config.query.excludeTests).toBe(false);
  });

  it('hoists top-level excludeTests: false correctly', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'exclude-false-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), JSON.stringify({ excludeTests: false }));
    const config = loadConfig(dir);
    expect(config.query.excludeTests).toBe(false);
    expect(config.excludeTests).toBeUndefined();
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

// ─── detectWorkspaces ────────────────────────────────────────────────

describe('detectWorkspaces', () => {
  /** Helper: create a minimal workspace package */
  function makeWorkspacePackage(dir, name, entryContent = 'export default 1;') {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'index.js'), entryContent);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name }));
  }

  it('returns empty map when no workspace config exists', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'no-ws-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
    const ws = detectWorkspaces(dir);
    expect(ws).toBeInstanceOf(Map);
    expect(ws.size).toBe(0);
  });

  it('detects npm workspaces from package.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'npm-ws-'));
    fs.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'utils'), { recursive: true });
    makeWorkspacePackage(path.join(dir, 'packages', 'core'), '@myorg/core');
    makeWorkspacePackage(path.join(dir, 'packages', 'utils'), '@myorg/utils');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(2);
    expect(ws.has('@myorg/core')).toBe(true);
    expect(ws.has('@myorg/utils')).toBe(true);
    expect(ws.get('@myorg/core').dir).toBe(path.join(dir, 'packages', 'core'));
    expect(ws.get('@myorg/core').entry).toContain('index.js');
  });

  it('detects yarn classic workspaces format', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'yarn-ws-'));
    fs.mkdirSync(path.join(dir, 'packages', 'lib'), { recursive: true });
    makeWorkspacePackage(path.join(dir, 'packages', 'lib'), 'my-lib');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'] } }),
    );

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(1);
    expect(ws.has('my-lib')).toBe(true);
  });

  it('detects pnpm workspaces from pnpm-workspace.yaml', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'pnpm-ws-'));
    fs.mkdirSync(path.join(dir, 'packages', 'shared'), { recursive: true });
    makeWorkspacePackage(path.join(dir, 'packages', 'shared'), '@myorg/shared');
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(1);
    expect(ws.has('@myorg/shared')).toBe(true);
  });

  it('detects lerna workspaces from lerna.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'lerna-ws-'));
    fs.mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
    makeWorkspacePackage(path.join(dir, 'packages', 'app'), '@myorg/app');
    fs.writeFileSync(path.join(dir, 'lerna.json'), JSON.stringify({ packages: ['packages/*'] }));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'root' }));

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(1);
    expect(ws.has('@myorg/app')).toBe(true);
  });

  it('resolves entry via main field', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'main-entry-'));
    fs.mkdirSync(path.join(dir, 'packages', 'lib', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'lib', 'dist', 'lib.js'), 'module.exports = 1;');
    fs.writeFileSync(
      path.join(dir, 'packages', 'lib', 'package.json'),
      JSON.stringify({ name: 'my-lib', main: './dist/lib.js' }),
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );

    const ws = detectWorkspaces(dir);
    expect(ws.get('my-lib').entry).toBe(path.join(dir, 'packages', 'lib', 'dist', 'lib.js'));
  });

  it('handles direct path patterns (no glob)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'direct-path-'));
    fs.mkdirSync(path.join(dir, 'apps', 'web', 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'apps', 'web', 'src', 'index.ts'), 'export default 1;');
    fs.writeFileSync(
      path.join(dir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: '@myorg/web' }),
    );
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['apps/web'] }),
    );

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(1);
    expect(ws.has('@myorg/web')).toBe(true);
  });

  it('skips directories without package.json', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'no-pkg-'));
    fs.mkdirSync(path.join(dir, 'packages', 'no-pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'packages', 'no-pkg', 'index.js'), 'export default 1;');
    fs.mkdirSync(path.join(dir, 'packages', 'has-pkg', 'src'), { recursive: true });
    makeWorkspacePackage(path.join(dir, 'packages', 'has-pkg'), 'has-pkg');
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    );

    const ws = detectWorkspaces(dir);
    expect(ws.size).toBe(1);
    expect(ws.has('has-pkg')).toBe(true);
  });
});
