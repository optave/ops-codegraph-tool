/**
 * End-to-end CLI smoke tests — spawns the actual codegraph binary
 * and verifies commands produce correct output/exit codes.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// All tests spawn child processes that load .ts files — requires Node >= 22.6
const [_major, _minor] = process.versions.node.split('.').map(Number);
const canStripTypes = _major > 22 || (_major === 22 && _minor >= 6);

import { pathToFileURL } from 'node:url';

const CLI = path.resolve('src/cli.ts');
const LOADER = pathToFileURL(path.resolve('scripts/ts-resolve-loader.js')).href;

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

let tmpDir, tmpHome, dbPath;

/** Run the CLI and return stdout as a string. Throws on non-zero exit. */
function run(...args) {
  return execFileSync('node', ['--import', LOADER, CLI, ...args], {
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

describe.skipIf(!canStripTypes)('CLI smoke tests', () => {
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

  // ─── Fn-Impact ───────────────────────────────────────────────────────
  test('fn-impact --json returns valid JSON with results', () => {
    const out = run('fn-impact', 'add', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('results');
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
  test('triage --level file --json returns valid JSON with hotspots', () => {
    const out = run('triage', '--level', 'file', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data).toHaveProperty('hotspots');
    expect(data).toHaveProperty('metric');
    expect(data).toHaveProperty('level');
  });

  test('triage --level directory --json returns directory hotspots', () => {
    const out = run('triage', '--level', 'directory', '--db', dbPath, '--json');
    const data = JSON.parse(out);
    expect(data.level).toBe('directory');
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
      [CLI, 'query', 'sumOfSquares', '--path', 'add', '--db', dbPath, '--json'],
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

describe.skipIf(!canStripTypes)('Registry CLI commands', () => {
  let tmpHome;

  /** Run CLI with isolated HOME to avoid touching real registry */
  function runReg(...args) {
    return execFileSync('node', ['--import', LOADER, CLI, ...args], {
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
