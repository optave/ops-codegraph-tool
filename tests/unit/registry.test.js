import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listRepos,
  loadRegistry,
  pruneRegistry,
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

  it('auto-suffixes when basename collides with different path', () => {
    const dir1 = path.join(tmpDir, 'workspace1', 'api');
    const dir2 = path.join(tmpDir, 'workspace2', 'api');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const { name: name1 } = registerRepo(dir1, undefined, registryPath);
    const { name: name2 } = registerRepo(dir2, undefined, registryPath);

    expect(name1).toBe('api');
    expect(name2).toBe('api-2');

    const reg = loadRegistry(registryPath);
    expect(reg.repos.api.path).toBe(dir1);
    expect(reg.repos['api-2'].path).toBe(dir2);
  });

  it('auto-suffix increments past existing suffixes', () => {
    const dir1 = path.join(tmpDir, 'a', 'app');
    const dir2 = path.join(tmpDir, 'b', 'app');
    const dir3 = path.join(tmpDir, 'c', 'app');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    fs.mkdirSync(dir3, { recursive: true });

    registerRepo(dir1, undefined, registryPath);
    registerRepo(dir2, undefined, registryPath);
    const { name: name3 } = registerRepo(dir3, undefined, registryPath);

    expect(name3).toBe('app-3');
  });

  it('re-registering same path with no explicit name updates in place', () => {
    const dir = path.join(tmpDir, 'mylib');
    fs.mkdirSync(dir, { recursive: true });

    const { name: first } = registerRepo(dir, undefined, registryPath);
    const { name: second } = registerRepo(dir, undefined, registryPath);

    expect(first).toBe('mylib');
    expect(second).toBe('mylib');
    expect(Object.keys(loadRegistry(registryPath).repos)).toHaveLength(1);
  });

  it('explicit name always overwrites (no suffix)', () => {
    const dir1 = path.join(tmpDir, 'one');
    const dir2 = path.join(tmpDir, 'two');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    registerRepo(dir1, 'shared', registryPath);
    const { name } = registerRepo(dir2, 'shared', registryPath);

    expect(name).toBe('shared');
    const reg = loadRegistry(registryPath);
    expect(reg.repos.shared.path).toBe(dir2);
    expect(Object.keys(reg.repos)).toHaveLength(1);
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

// ─── pruneRegistry ─────────────────────────────────────────────────

describe('pruneRegistry', () => {
  it('removes entries whose directories no longer exist', () => {
    const dir1 = path.join(tmpDir, 'exists');
    const dir2 = path.join(tmpDir, 'gone');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    registerRepo(dir1, 'exists', registryPath);
    registerRepo(dir2, 'gone', registryPath);

    // Remove the directory to make it stale
    fs.rmSync(dir2, { recursive: true, force: true });

    const pruned = pruneRegistry(registryPath);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].name).toBe('gone');
    expect(pruned[0].path).toBe(dir2);

    const reg = loadRegistry(registryPath);
    expect(reg.repos.exists).toBeDefined();
    expect(reg.repos.gone).toBeUndefined();
  });

  it('returns empty array when nothing to prune', () => {
    const dir = path.join(tmpDir, 'healthy');
    fs.mkdirSync(dir, { recursive: true });
    registerRepo(dir, 'healthy', registryPath);

    const pruned = pruneRegistry(registryPath);
    expect(pruned).toEqual([]);
  });

  it('does not write file when nothing pruned', () => {
    const dir = path.join(tmpDir, 'ok');
    fs.mkdirSync(dir, { recursive: true });
    registerRepo(dir, 'ok', registryPath);

    const mtimeBefore = fs.statSync(registryPath).mtimeMs;
    pruneRegistry(registryPath);
    const mtimeAfter = fs.statSync(registryPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('returns empty array for empty registry', () => {
    const pruned = pruneRegistry(registryPath);
    expect(pruned).toEqual([]);
  });
});
