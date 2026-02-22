/**
 * Unit tests for src/config.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONFIG_FILES, DEFAULTS, loadConfig } from '../../src/config.js';

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
});
