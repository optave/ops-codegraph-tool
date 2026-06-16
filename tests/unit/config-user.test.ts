/**
 * Unit tests for user-level (global) config: §5 location resolution,
 * §8 merge pipeline, §8.1 sanitizeUserLayer, §10 config hash.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  clearConfigCache,
  computeConfigHash,
  loadConfig,
  loadConfigWithProvenance,
  resolveUserConfigPath,
  setUserConfigOverride,
} from '../../src/infrastructure/config.js';
import { setUserConfigConsent } from '../../src/infrastructure/registry.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-user-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  clearConfigCache();
  setUserConfigOverride(undefined);
  // Clean env overrides
  delete process.env.CODEGRAPH_USER_CONFIG;
  delete process.env.XDG_CONFIG_HOME;
});

// ── resolveUserConfigPath ──────────────────────────────────────────────

describe('resolveUserConfigPath', () => {
  it('returns null when no global file exists', () => {
    // Redirect env to a temp dir that has nothing in it
    const emptyHome = fs.mkdtempSync(path.join(tmpDir, 'home-'));
    process.env.CODEGRAPH_USER_CONFIG = path.join(emptyHome, 'nonexistent.json');
    expect(resolveUserConfigPath()).toBeNull();
  });

  it('returns CODEGRAPH_USER_CONFIG when file exists', () => {
    const cfgPath = path.join(tmpDir, 'explicit.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ query: { defaultLimit: 99 } }));
    process.env.CODEGRAPH_USER_CONFIG = cfgPath;
    expect(resolveUserConfigPath()).toBe(cfgPath);
  });

  it('uses XDG_CONFIG_HOME when set', () => {
    const xdgDir = fs.mkdtempSync(path.join(tmpDir, 'xdg-'));
    const cfgDir = path.join(xdgDir, 'codegraph');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), '{}');
    process.env.XDG_CONFIG_HOME = xdgDir;
    const result = resolveUserConfigPath();
    expect(result).toBe(path.join(cfgDir, 'config.json'));
  });
});

// ── loadConfig with global layer ──────────────────────────────────────

describe('loadConfig — global layer', () => {
  it('skips global layer when --no-user-config (override=false)', () => {
    const globalFile = path.join(tmpDir, 'global.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 99 } }));
    process.env.CODEGRAPH_USER_CONFIG = globalFile;

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const config = loadConfig(repoDir, { userConfig: false });
    expect(config.query.defaultLimit).toBe(20); // DEFAULTS value
  });

  it('applies global layer when --user-config <path>', () => {
    const globalFile = path.join(tmpDir, 'global2.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 77 } }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.defaultLimit).toBe(77);
  });

  it('applies global layer via recorded "enabled" consent', () => {
    const globalFile = path.join(tmpDir, 'global3.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 55 } }));
    process.env.CODEGRAPH_USER_CONFIG = globalFile;

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const regPath = path.join(tmpDir, 'registry3.json');
    setUserConfigConsent(repoDir, 'enabled', regPath);

    const config = loadConfig(repoDir, { registryPath: regPath });
    expect(config.query.defaultLimit).toBe(55);
  });

  it('skips global layer when consent is "disabled"', () => {
    const globalFile = path.join(tmpDir, 'global4.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 88 } }));
    process.env.CODEGRAPH_USER_CONFIG = globalFile;

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const regPath = path.join(tmpDir, 'registry4.json');
    setUserConfigConsent(repoDir, 'disabled', regPath);

    const config = loadConfig(repoDir, { registryPath: regPath });
    expect(config.query.defaultLimit).toBe(20); // DEFAULTS
  });

  it('project layer overrides global layer', () => {
    const globalFile = path.join(tmpDir, 'global5.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 99 } }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.writeFileSync(
      path.join(repoDir, '.codegraphrc.json'),
      JSON.stringify({ query: { defaultLimit: 10 } }),
    );

    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.defaultLimit).toBe(10); // project wins
  });

  it('global layer preserves sibling keys when project partially overrides', () => {
    const globalFile = path.join(tmpDir, 'global6.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 50, defaultDepth: 7 } }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    fs.writeFileSync(
      path.join(repoDir, '.codegraphrc.json'),
      JSON.stringify({ query: { defaultLimit: 5 } }),
    );

    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.defaultLimit).toBe(5); // project overrides
    expect(config.query.defaultDepth).toBe(7); // global contrib survives
  });

  it('handles malformed global JSON gracefully — falls back to project+defaults', () => {
    const globalFile = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(globalFile, '{ bad json ');

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.defaultLimit).toBe(20); // DEFAULTS
  });

  it('reads appliesTo wrapper format', () => {
    const globalFile = path.join(tmpDir, 'wrapped.json');
    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-applies-'));
    const absRepo = path.resolve(repoDir);
    fs.writeFileSync(
      globalFile,
      JSON.stringify({
        appliesTo: [absRepo],
        config: { query: { defaultLimit: 42 } },
      }),
    );
    process.env.CODEGRAPH_USER_CONFIG = globalFile;
    const regPath = path.join(tmpDir, 'registry-applies.json');
    // No consent recorded — appliesTo glob should match
    const config = loadConfig(repoDir, { registryPath: regPath });
    expect(config.query.defaultLimit).toBe(42);
  });

  it('disabled consent overrides appliesTo glob match', () => {
    const globalFile = path.join(tmpDir, 'wrapped2.json');
    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-disabled-'));
    const absRepo = path.resolve(repoDir);
    fs.writeFileSync(
      globalFile,
      JSON.stringify({
        appliesTo: [absRepo],
        config: { query: { defaultLimit: 42 } },
      }),
    );
    process.env.CODEGRAPH_USER_CONFIG = globalFile;
    const regPath = path.join(tmpDir, 'registry-disabled.json');
    setUserConfigConsent(repoDir, 'disabled', regPath);
    // disabled beats appliesTo
    const config = loadConfig(repoDir, { registryPath: regPath });
    expect(config.query.defaultLimit).toBe(20); // DEFAULTS
  });
});

// ── sanitizeUserLayer (absolute dbPath) ───────────────────────────────

describe('sanitizeUserLayer via loadConfig', () => {
  it('drops absolute build.dbPath from global layer', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const globalFile = path.join(tmpDir, 'absolute-db.json');
    fs.writeFileSync(
      globalFile,
      JSON.stringify({ build: { dbPath: '/shared/graph.db', incremental: false } }),
    );

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-san-'));
    const config = loadConfig(repoDir, { userConfig: globalFile });
    // Absolute dbPath was dropped; relative fallback from DEFAULTS applies
    expect(path.isAbsolute(config.build.dbPath)).toBe(false);
    // But incremental:false should still come through (only dbPath was dropped)
    expect(config.build.incremental).toBe(false);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('absolute'));
    stderrSpy.mockRestore();
  });

  it('allows relative build.dbPath from global layer', () => {
    const globalFile = path.join(tmpDir, 'rel-db.json');
    fs.writeFileSync(globalFile, JSON.stringify({ build: { dbPath: '.cg/graph.db' } }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-rel-'));
    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.build.dbPath).toBe('.cg/graph.db');
  });
});

// ── excludeTests shorthand from global layer ─────────────────────────

describe('excludeTests shorthand in global layer', () => {
  it('hoists top-level excludeTests from global layer', () => {
    const globalFile = path.join(tmpDir, 'excl-global.json');
    fs.writeFileSync(globalFile, JSON.stringify({ excludeTests: true }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-excl-'));
    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.excludeTests).toBe(true);
  });

  it('project-level excludeTests overrides global', () => {
    const globalFile = path.join(tmpDir, 'excl-global2.json');
    fs.writeFileSync(globalFile, JSON.stringify({ excludeTests: true }));

    const repoDir = fs.mkdtempSync(path.join(tmpDir, 'repo-excl2-'));
    fs.writeFileSync(
      path.join(repoDir, '.codegraphrc.json'),
      JSON.stringify({ excludeTests: false }),
    );
    const config = loadConfig(repoDir, { userConfig: globalFile });
    expect(config.query.excludeTests).toBe(false);
  });
});

// ── computeConfigHash ─────────────────────────────────────────────────

describe('computeConfigHash', () => {
  it('returns a 16-char hex string', () => {
    const config = loadConfig(fs.mkdtempSync(path.join(tmpDir, 'hash-')));
    const h = computeConfigHash(config);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable for identical configs', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'hash-stable-'));
    const c1 = loadConfig(dir);
    const c2 = loadConfig(dir);
    expect(computeConfigHash(c1)).toBe(computeConfigHash(c2));
  });

  it('differs when include changes', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'hash-diff-'));
    const c1 = loadConfig(dir);
    const c2 = { ...c1, include: ['src/**'] };
    expect(computeConfigHash(c1)).not.toBe(computeConfigHash(c2));
  });

  it('differs when build settings change', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'hash-build-'));
    const c1 = loadConfig(dir);
    const c2 = { ...c1, build: { ...c1.build, incremental: false } };
    expect(computeConfigHash(c1)).not.toBe(computeConfigHash(c2));
  });
});

// ── loadConfigWithProvenance ──────────────────────────────────────────

describe('loadConfigWithProvenance', () => {
  it('returns default provenance when no files exist', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'prov-empty-'));
    const { provenance, appliedGlobalPath, consentDecision } = loadConfigWithProvenance(dir);
    expect(provenance.include).toBe('default');
    expect(provenance.build).toBe('default');
    expect(appliedGlobalPath).toBeNull();
    expect(consentDecision).toBeUndefined();
  });

  it('marks project keys as "project" source', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'prov-proj-'));
    fs.writeFileSync(
      path.join(dir, '.codegraphrc.json'),
      JSON.stringify({ ignoreDirs: ['vendor'] }),
    );
    const { provenance } = loadConfigWithProvenance(dir);
    expect(provenance.ignoreDirs).toBe('project');
    expect(provenance.include).toBe('default');
  });

  it('marks user-layer keys as "user" source', () => {
    const globalFile = path.join(tmpDir, 'prov-global.json');
    fs.writeFileSync(globalFile, JSON.stringify({ exclude: ['**/*.gen.*'] }));

    const dir = fs.mkdtempSync(path.join(tmpDir, 'prov-user-'));
    const { provenance, appliedGlobalPath } = loadConfigWithProvenance(dir, {
      userConfig: globalFile,
    });
    expect(provenance.exclude).toBe('user');
    expect(appliedGlobalPath).toBe(globalFile);
  });

  it('project overwrites user provenance for same key', () => {
    const globalFile = path.join(tmpDir, 'prov-both.json');
    fs.writeFileSync(globalFile, JSON.stringify({ exclude: ['**/*.gen.*'] }));

    const dir = fs.mkdtempSync(path.join(tmpDir, 'prov-both-'));
    fs.writeFileSync(path.join(dir, '.codegraphrc.json'), JSON.stringify({ exclude: ['dist/**'] }));
    const { provenance } = loadConfigWithProvenance(dir, { userConfig: globalFile });
    expect(provenance.exclude).toBe('project');
  });

  it('returns correct user provenance even when loadConfig was called first (cache-hit path)', () => {
    const globalFile = path.join(tmpDir, 'prov-cache-hit.json');
    fs.writeFileSync(globalFile, JSON.stringify({ exclude: ['**/*.gen.*'] }));

    const dir = fs.mkdtempSync(path.join(tmpDir, 'prov-cache-'));
    const opts = { userConfig: globalFile };

    // Prime the cache
    loadConfig(dir, opts);
    // Second call hits the cache — _lastAppliedGlobalConfig must be restored
    const { provenance } = loadConfigWithProvenance(dir, opts);
    expect(provenance.exclude).toBe('user');
  });
});

// ── setUserConfigOverride integration ────────────────────────────────

describe('setUserConfigOverride', () => {
  it('false forces the global layer off', () => {
    const globalFile = path.join(tmpDir, 'override-off.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 99 } }));
    process.env.CODEGRAPH_USER_CONFIG = globalFile;

    setUserConfigOverride(false);
    const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-override-'));
    const config = loadConfig(dir);
    expect(config.query.defaultLimit).toBe(20); // DEFAULTS — global suppressed
  });

  it('string forces a specific global file', () => {
    const globalFile = path.join(tmpDir, 'override-path.json');
    fs.writeFileSync(globalFile, JSON.stringify({ query: { defaultLimit: 33 } }));

    setUserConfigOverride(globalFile);
    const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-override-path-'));
    const config = loadConfig(dir);
    expect(config.query.defaultLimit).toBe(33);
  });
});
