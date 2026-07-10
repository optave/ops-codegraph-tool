/**
 * End-to-end CLI smoke tests — spawns the actual codegraph binary
 * and verifies commands produce correct output/exit codes.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const CLI = path.resolve('src/cli.ts');
const LOADER = new URL('../../scripts/ts-resolve-loader.ts', import.meta.url).href;
const NODE_TS_FLAGS = ['--experimental-strip-types', '--import', LOADER];

const FIXTURE_FILES = {
  'math.js': `
export function add(a, b) { return a + b; }
export function multiply(a, b) { return a * b; }
export function square(x) { return multiply(x, x); }
`.trimStart(),
  'utils.js': `
import { add, square } from './math.js';
export function sumOfSquares(a, b) { return add(square(a), square(b)); }
export class Calculator {
  compute(x, y) { return sumOfSquares(x, y); }
}
`.trimStart(),
  'index.js': `
import { sumOfSquares, Calculator } from './utils.js';
import { add } from './math.js';
export function main() {
  console.log(add(1, 2));
  console.log(sumOfSquares(3, 4));
  const calc = new Calculator();
  console.log(calc.compute(5, 6));
}
`.trimStart(),
};

let tmpDir: string, tmpHome: string, dbPath: string;

/** Run the CLI and return stdout as a string. Throws on non-zero exit. */
function run(...args) {
  return execFileSync('node', [...NODE_TS_FLAGS, CLI, ...args], {
    cwd: tmpDir,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
  });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cli-'));
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-clihome-'));
  for (const [name, content] of Object.entries(FIXTURE_FILES)) {
    fs.writeFileSync(path.join(tmpDir, name), content);
  }

  // Build the graph via CLI (also tests the build command itself)
  run('build', tmpDir, '--engine', 'wasm');
  dbPath = path.join(tmpDir, '.codegraph', 'graph.db');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('CLI smoke tests', () => {
  // ─── Build ───────────────────────────────────────────────────────────
  test('build creates graph.db', () => {
    expect(fs.existsSync(dbPath)).toBe(true);
  });

  // ─── Query ───────────────────────────────────────────────────────────
  test('query --json returns valid JSON with results', () => {
    const out = run('query', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  // ─── Impact ──────────────────────────────────────────────────────────
  test('impact --json returns valid JSON with sources', () => {
    const out = run('impact', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('sources');
  });

  // ─── Map ─────────────────────────────────────────────────────────────
  test('map --json returns valid JSON with topNodes and stats', () => {
    const out = run('map', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('topNodes');
    expect(data).toHaveProperty('stats');
  });

  // ─── Deps ────────────────────────────────────────────────────────────
  test('deps --json returns valid JSON with results', () => {
    const out = run('deps', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
  });

  // ─── Query (deps mode, formerly fn) ──────────────────────────────────
  test('query --json returns fnDeps-style results', () => {
    const out = run('query', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
  });

  // Regression test for #1726: `-f/--file` is a repeatable Commander option
  // (collectFile) that always produces a string[], even for a single use.
  // query's native composite path used to forward that array straight into
  // a napi binding typed for a single String and crash.
  test('query -f scopes results to a single file without crashing', () => {
    const out = run('query', 'add', '-f', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) expect(r.file).toContain('math.js');
  });

  test('query --file (long form) scopes results to a single file without crashing', () => {
    const out = run('query', 'add', '--file', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) expect(r.file).toContain('math.js');
  });

  test('query with a single -f excludes non-matching files', () => {
    // `add` is only defined in math.js, so scoping to utils.js must be empty.
    const out = run('query', 'add', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results).toHaveLength(0);
  });

  test('query supports repeated -f (multi-file scoping)', () => {
    // "square" substring-matches square() in math.js and sumOfSquares() in utils.js.
    const out = run('query', 'square', '-f', 'math.js', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    const names = data.results.map((r) => r.name);
    expect(names).toContain('square');
    expect(names).toContain('sumOfSquares');
  });

  // ─── Fn-Impact ───────────────────────────────────────────────────────
  test('fn-impact --json returns valid JSON with results', () => {
    const out = run('fn-impact', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
  });

  // Regression test for #1726 (see query -f test above for full context).
  test('fn-impact -f scopes results to a single file without crashing', () => {
    const out = run('fn-impact', 'add', '-f', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) expect(r.file).toContain('math.js');
  });

  test('fn-impact --file (long form) scopes results to a single file without crashing', () => {
    const out = run('fn-impact', 'add', '--file', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) expect(r.file).toContain('math.js');
  });

  test('fn-impact with a single -f excludes non-matching files', () => {
    const out = run('fn-impact', 'add', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.results).toHaveLength(0);
  });

  test('fn-impact supports repeated -f (multi-file scoping)', () => {
    const out = run(
      'fn-impact',
      'square',
      '-f',
      'math.js',
      '-f',
      'utils.js',
      '--db',
      dbPath,
      '--json',
    );
    const data = JSON.parse(out);
    const names = data.results.map((r) => r.name);
    expect(names).toContain('square');
    expect(names).toContain('sumOfSquares');
  });

  // ─── Query (path mode, formerly path) ────────────────────────────────
  test('query --path --json returns valid JSON with path info', () => {
    const out = run('query', 'sumOfSquares', '--path', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('found');
    expect(data).toHaveProperty('path');
    expect(data).toHaveProperty('hops');
  });

  // ─── Cycles ──────────────────────────────────────────────────────────
  test('cycles --json returns valid JSON', () => {
    const out = run('cycles', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('cycles');
    expect(data).toHaveProperty('count');
  });

  // ─── Export (DOT) ────────────────────────────────────────────────────
  test('export -f dot outputs a digraph', () => {
    const out = run('export', '--db', dbPath, '-f', 'dot');
    expect(out).toContain('digraph');
  });

  // ─── Export (Mermaid) ────────────────────────────────────────────────
  test('export -f mermaid outputs flowchart LR', () => {
    const out = run('export', '--db', dbPath, '-f', 'mermaid');
    expect(out).toContain('flowchart LR');
  });

  // ─── Export (JSON) ───────────────────────────────────────────────────
  test('export -f json returns valid JSON with nodes and edges', () => {
    const out = run('export', '--db', dbPath, '-f', 'json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('nodes');
    expect(data).toHaveProperty('edges');
  });

  // ─── Structure ──────────────────────────────────────────────────────
  test('structure --json returns valid JSON with directories', () => {
    const out = run('structure', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('directories');
    expect(data).toHaveProperty('count');
  });

  // ─── Triage --level (formerly hotspots) ─────────────────────────────
  test('triage --level file --json returns valid JSON with items', () => {
    const out = run('triage', '--level', 'file', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('metric');
    expect(data).toHaveProperty('level');
  });

  test('triage --level directory --json returns directory hotspots', () => {
    const out = run('triage', '--level', 'directory', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.level).toBe('directory');
  });

  // Regression tests for #1815: `-f/--file` is a repeatable Commander option
  // (collectFile) that always produces a string[], even for a single use.
  // triage's native composite path (findNodesForTriage) used to forward that
  // array straight into a napi binding typed for a single String; the failure
  // was silently swallowed into an empty result with exit code 0 instead of
  // crashing or surfacing an error (see query -f test above for #1726 context
  // on the underlying array-vs-String bug class).
  test('triage -f scopes results to a single file without crashing or silently emptying', () => {
    const out = run('triage', '-f', 'math.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.items.length).toBeGreaterThan(0);
    for (const it of data.items) expect(it.file).toContain('math.js');
  });

  test('triage with a single -f excludes non-matching files', () => {
    const out = run('triage', '-f', 'math.js', '--kind', 'function', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    const names = data.items.map((it) => it.name);
    expect(names).toContain('add');
    expect(names).not.toContain('sumOfSquares');
  });

  test('triage supports repeated -f (multi-file scoping)', () => {
    const out = run('triage', '-f', 'math.js', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    const files = new Set(data.items.map((it) => it.file));
    expect([...files].some((f) => f.includes('math.js'))).toBe(true);
    expect([...files].some((f) => f.includes('utils.js'))).toBe(true);
    expect([...files].some((f) => f.includes('index.js'))).toBe(false);
  });

  // ─── Interfaces / Implementations ───────────────────────────────────
  test('interfaces -f does not crash when scoping by file', () => {
    const out = run('interfaces', 'Calculator', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  test('implementations -f does not crash when scoping by file', () => {
    const out = run('implementations', 'Calculator', '-f', 'utils.js', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
    expect(Array.isArray(data.results)).toBe(true);
  });

  // ─── Audit --quick (formerly explain) ──────────────────────────────
  test('audit --quick --json returns structural summary', () => {
    const out = run('audit', 'math.js', '--quick', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('target');
  });

  // ─── Path (standalone) ─────────────────────────────────────────────
  test('path --json returns valid JSON with path info', () => {
    const out = run('path', 'sumOfSquares', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('found');
    expect(data).toHaveProperty('path');
    expect(data).toHaveProperty('hops');
  });

  // ─── Query --path deprecation ──────────────────────────────────────
  test('query --path prints deprecation warning to stderr', () => {
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      'node',
      [...NODE_TS_FLAGS, CLI, 'query', 'sumOfSquares', '--path', 'add', '--db', dbPath, '--json'],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        timeout: 30_000,
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
      },
    );
    expect(result.stderr).toContain('deprecated');
  });

  // ─── Check (manifesto mode) ────────────────────────────────────────
  test('check --json with no ref/staged runs manifesto rules', () => {
    const out = run('check', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('rules');
    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('passed');
  });

  // ─── Info ────────────────────────────────────────────────────────────
  test('info outputs engine diagnostics', () => {
    const out = run('info');
    expect(out).toContain('engine');
  });

  // ─── Version ─────────────────────────────────────────────────────────
  test('--version outputs semver', () => {
    const out = run('--version');
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  // ─── Help ────────────────────────────────────────────────────────────
  test('--help outputs usage', () => {
    const out = run('--help');
    expect(out).toContain('Usage');
  });
});

// ─── Registry CLI ───────────────────────────────────────────────────────

describe('Registry CLI commands', () => {
  let tmpHome: string;

  /** Run CLI with isolated HOME to avoid touching real registry */
  function runReg(...args) {
    return execFileSync('node', [...NODE_TS_FLAGS, CLI, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome },
    });
  }

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-reghome-'));
  });

  afterAll(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('registry list shows empty when no repos registered', () => {
    const out = runReg('registry', 'list');
    expect(out).toContain('No repositories registered');
  });

  test('registry add + list --json shows added repo', () => {
    runReg('registry', 'add', tmpDir, '-n', 'test-proj');
    const out = runReg('registry', 'list', '--json');
    const repos = JSON.parse(out);
    expect(repos).toHaveLength(1);
    expect(repos[0].name).toBe('test-proj');
    expect(repos[0].path).toBe(tmpDir);
  });

  test('registry remove removes a repo', () => {
    // Ensure it exists from previous test (or add it)
    try {
      runReg('registry', 'add', tmpDir, '-n', 'to-remove');
    } catch {
      /* already exists */
    }

    const out = runReg('registry', 'remove', 'to-remove');
    expect(out).toContain('Removed');
  });

  test('registry remove nonexistent exits with error', () => {
    try {
      runReg('registry', 'remove', 'nonexistent-repo');
      throw new Error('Expected command to fail');
    } catch (err) {
      expect(err.status).toBe(1);
      expect(err.stderr || err.stdout).toContain('not found');
    }
  });

  test('registry prune removes stale entries', () => {
    const staleDir = path.join(tmpHome, 'stale-project');
    fs.mkdirSync(staleDir, { recursive: true });

    runReg('registry', 'add', staleDir, '-n', 'stale');
    // Remove the directory to make it stale
    fs.rmSync(staleDir, { recursive: true, force: true });

    const out = runReg('registry', 'prune');
    expect(out).toContain('Pruned');
    expect(out).toContain('stale');
  });

  test('registry prune reports nothing when no stale entries', () => {
    // Add a valid repo
    runReg('registry', 'add', tmpDir, '-n', 'valid-proj');

    const out = runReg('registry', 'prune');
    expect(out).toContain('No stale entries found');
  });

  test('registry add auto-suffixes on basename collision', () => {
    const dir1 = path.join(tmpHome, 'ws1', 'api');
    const dir2 = path.join(tmpHome, 'ws2', 'api');
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });

    const out1 = runReg('registry', 'add', dir1);
    expect(out1).toContain('"api"');

    const out2 = runReg('registry', 'add', dir2);
    expect(out2).toContain('"api-2"');
  });
});

// ─── Config CLI ───────────────────────────────────────────────────────

describe('Config CLI commands', () => {
  let tmpHome: string;
  let userConfigPath: string;

  /**
   * Run CLI with isolated HOME *and* an explicit CODEGRAPH_USER_CONFIG so
   * --init doesn't touch the real global config. HOME/USERPROFILE alone
   * aren't sufficient: getDefaultUserConfigPath() prefers XDG_CONFIG_HOME
   * (ambiently set on GitHub Actions ubuntu-latest runners) and, on Windows,
   * APPDATA (always set) ahead of the HOME-derived fallback — so on CI the
   * scaffolded file can land outside tmpHome unless the path is pinned
   * explicitly, same as tests/unit/config-user.test.ts does.
   */
  function runCfg(...args) {
    return execFileSync('node', [...NODE_TS_FLAGS, CLI, ...args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        CODEGRAPH_USER_CONFIG: userConfigPath,
        XDG_CONFIG_HOME: undefined,
        APPDATA: undefined,
      },
    });
  }

  beforeAll(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cfghome-'));
    userConfigPath = path.join(tmpHome, '.config', 'codegraph', 'config.json');
  });

  afterAll(() => {
    if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  test('config --init scaffolds an embeddings section alongside llm', () => {
    runCfg('config', '--init');
    const scaffolded = JSON.parse(fs.readFileSync(userConfigPath, 'utf-8'));

    expect(scaffolded.embeddings).toEqual({ model: null, llmProvider: null, provider: null });
    expect(scaffolded.llm).toHaveProperty('baseUrl');
    expect(scaffolded.llm).toHaveProperty('apiKeyCommand');
  });
});
