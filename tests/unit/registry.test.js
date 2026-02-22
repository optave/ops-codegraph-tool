import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listRepos,
  loadRegistry,
  REGISTRY_PATH,
  registerRepo,
  resolveRepoDbPath,
  saveRegistry,
  unregisterRepo,
} from '../../src/registry.js';

let tmpDir;
let registryPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-registry-'));
  registryPath = path.join(tmpDir, '.codegraph', 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── REGISTRY_PATH ──────────────────────────────────────────────────

describe('REGISTRY_PATH', () => {
  it('points to ~/.codegraph/registry.json', () => {
    expect(REGISTRY_PATH).toBe(path.join(os.homedir(), '.codegraph', 'registry.json'));
  });
});

// ─── loadRegistry ───────────────────────────────────────────────────

describe('loadRegistry', () => {
  it('returns empty repos on missing file', () => {
    const reg = loadRegistry(registryPath);
    expect(reg).toEqual({ repos: {} });
  });

  it('parses valid JSON', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({
        repos: {
          myapp: {
            path: '/tmp/myapp',
            dbPath: '/tmp/myapp/.codegraph/graph.db',
            addedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const reg = loadRegistry(registryPath);
    expect(reg.repos.myapp.path).toBe('/tmp/myapp');
  });

  it('returns empty repos on corrupt JSON', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, 'not json {{{');
    const reg = loadRegistry(registryPath);
    expect(reg).toEqual({ repos: {} });
  });

  it('returns empty repos when "repos" key is missing', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: 1 }));
    const reg = loadRegistry(registryPath);
    expect(reg).toEqual({ repos: {} });
  });
});

// ─── saveRegistry ───────────────────────────────────────────────────

describe('saveRegistry', () => {
  it('creates directory and writes valid JSON', () => {
    const registry = {
      repos: {
        test: {
          path: '/test',
          dbPath: '/test/.codegraph/graph.db',
          addedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };
    saveRegistry(registry, registryPath);

    expect(fs.existsSync(registryPath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(data.repos.test.path).toBe('/test');
  });

  it('overwrites existing file atomically', () => {
    const reg1 = {
      repos: { a: { path: '/a', dbPath: '/a/db', addedAt: '2026-01-01T00:00:00.000Z' } },
    };
    const reg2 = {
      repos: { b: { path: '/b', dbPath: '/b/db', addedAt: '2026-01-02T00:00:00.000Z' } },
    };
    saveRegistry(reg1, registryPath);
    saveRegistry(reg2, registryPath);

    const data = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    expect(data.repos.b).toBeDefined();
    expect(data.repos.a).toBeUndefined();
  });
});

// ─── registerRepo ───────────────────────────────────────────────────

describe('registerRepo', () => {
  it('defaults name from basename', () => {
    const dir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(dir, { recursive: true });

    const { name, entry } = registerRepo(dir, undefined, registryPath);
    expect(name).toBe('my-project');
    expect(entry.path).toBe(dir);
    expect(entry.dbPath).toBe(path.join(dir, '.codegraph', 'graph.db'));
  });

  it('uses custom name when provided', () => {
    const dir = path.join(tmpDir, 'my-project');
    fs.mkdirSync(dir, { recursive: true });

    const { name } = registerRepo(dir, 'custom-name', registryPath);
    expect(name).toBe('custom-name');
  });

  it('is idempotent (re-registering updates entry)', () => {
    const dir = path.join(tmpDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });

    registerRepo(dir, 'proj', registryPath);
    registerRepo(dir, 'proj', registryPath);

    const reg = loadRegistry(registryPath);
    expect(Object.keys(reg.repos)).toHaveLength(1);
  });

  it('sets addedAt as ISO string', () => {
    const dir = path.join(tmpDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });

    const { entry } = registerRepo(dir, 'proj', registryPath);
    expect(entry.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

// ─── unregisterRepo ─────────────────────────────────────────────────

describe('unregisterRepo', () => {
  it('removes and returns true', () => {
    const dir = path.join(tmpDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });
    registerRepo(dir, 'proj', registryPath);

    const removed = unregisterRepo('proj', registryPath);
    expect(removed).toBe(true);

    const reg = loadRegistry(registryPath);
    expect(reg.repos.proj).toBeUndefined();
  });

  it('returns false if not found', () => {
    const removed = unregisterRepo('nonexistent', registryPath);
    expect(removed).toBe(false);
  });
});

// ─── listRepos ──────────────────────────────────────────────────────

describe('listRepos', () => {
  it('returns empty array when no repos registered', () => {
    const repos = listRepos(registryPath);
    expect(repos).toEqual([]);
  });

  it('returns repos sorted by name', () => {
    const dirA = path.join(tmpDir, 'aaa');
    const dirZ = path.join(tmpDir, 'zzz');
    const dirM = path.join(tmpDir, 'mmm');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirZ, { recursive: true });
    fs.mkdirSync(dirM, { recursive: true });

    registerRepo(dirZ, 'zzz', registryPath);
    registerRepo(dirA, 'aaa', registryPath);
    registerRepo(dirM, 'mmm', registryPath);

    const repos = listRepos(registryPath);
    expect(repos.map((r) => r.name)).toEqual(['aaa', 'mmm', 'zzz']);
  });
});

// ─── resolveRepoDbPath ──────────────────────────────────────────────

describe('resolveRepoDbPath', () => {
  it('returns dbPath when DB exists', () => {
    const dir = path.join(tmpDir, 'proj');
    const dbDir = path.join(dir, '.codegraph');
    const dbFile = path.join(dbDir, 'graph.db');
    fs.mkdirSync(dbDir, { recursive: true });
    fs.writeFileSync(dbFile, '');

    registerRepo(dir, 'proj', registryPath);
    const result = resolveRepoDbPath('proj', registryPath);
    expect(result).toBe(dbFile);
  });

  it('returns undefined when name not found', () => {
    const result = resolveRepoDbPath('nonexistent', registryPath);
    expect(result).toBeUndefined();
  });

  it('returns undefined and warns when DB is missing', () => {
    const dir = path.join(tmpDir, 'proj');
    fs.mkdirSync(dir, { recursive: true });

    registerRepo(dir, 'proj', registryPath);
    const result = resolveRepoDbPath('proj', registryPath);
    expect(result).toBeUndefined();
  });
});
