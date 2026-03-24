/**
 * Integration tests for branch-compare.
 *
 * Creates a real git repo in a temp directory with two commits,
 * then uses branchCompareData to diff the structure between them.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { branchCompareData, branchCompareMermaid } from '../../src/features/branch-compare.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bc-test-'));

  // Init git repo
  execFileSync('git', ['init'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir, stdio: 'pipe' });

  // ── Base commit ──
  // math.js: add, subtract
  fs.writeFileSync(
    path.join(tmpDir, 'math.js'),
    `export function add(a, b) { return a + b; }
export function subtract(a, b) { return a - b; }
`,
  );

  // utils.js: formatResult calls add
  fs.writeFileSync(
    path.join(tmpDir, 'utils.js'),
    `import { add } from './math.js';
export function formatResult(a, b) {
  return String(add(a, b));
}
`,
  );

  // index.js: main calls formatResult
  fs.writeFileSync(
    path.join(tmpDir, 'index.js'),
    `import { formatResult } from './utils.js';
export function main() {
  console.log(formatResult(1, 2));
}
`,
  );

  // Create package.json so buildGraph works
  fs.writeFileSync(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({ name: 'test-bc', version: '1.0.0', type: 'module' }),
  );

  execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['tag', 'base'], { cwd: tmpDir, stdio: 'pipe' });

  // ── Target commit ──
  // math.js: add (modified — extra line), subtract removed, multiply added
  fs.writeFileSync(
    path.join(tmpDir, 'math.js'),
    `export function add(a, b) {
  // enhanced add
  return a + b;
}
export function multiply(a, b) { return a * b; }
`,
  );

  // utils.js: unchanged
  // index.js: unchanged

  execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'target'], { cwd: tmpDir, stdio: 'pipe' });
  execFileSync('git', ['tag', 'target'], { cwd: tmpDir, stdio: 'pipe' });
}, 60000);

afterAll(() => {
  if (tmpDir) {
    // Prune any leftover worktrees before removing
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: tmpDir, stdio: 'pipe' });
    } catch {
      /* ignore */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('branchCompareData', () => {
  test('detects added, removed, and changed symbols', async () => {
    const data = await branchCompareData('base', 'target', {
      repoRoot: tmpDir,
      engine: 'wasm',
    });

    expect(data.error).toBeUndefined();
    expect(data.baseRef).toBe('base');
    expect(data.targetRef).toBe('target');
    expect(data.baseSha).toBeTruthy();
    expect(data.targetSha).toBeTruthy();
    expect(data.changedFiles.length).toBeGreaterThan(0);

    // multiply was added
    const addedNames = data.added.map((s) => s.name);
    expect(addedNames).toContain('multiply');

    // subtract was removed
    const removedNames = data.removed.map((s) => s.name);
    expect(removedNames).toContain('subtract');

    // add was changed (line count changed)
    const changedNames = data.changed.map((s) => s.name);
    expect(changedNames).toContain('add');

    // Summary
    expect(data.summary.added).toBeGreaterThanOrEqual(1);
    expect(data.summary.removed).toBeGreaterThanOrEqual(1);
    expect(data.summary.changed).toBeGreaterThanOrEqual(1);
  }, 60000);

  test('returns error for invalid ref', async () => {
    const data = await branchCompareData('nonexistent-ref-xyz', 'target', {
      repoRoot: tmpDir,
      engine: 'wasm',
    });
    expect(data.error).toMatch(/Invalid git ref/);
  });

  test('returns error for non-git directory', async () => {
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bc-nogit-'));
    try {
      const data = await branchCompareData('main', 'HEAD', {
        repoRoot: nonGitDir,
        engine: 'wasm',
      });
      expect(data.error).toBe('Not a git repository');
    } finally {
      fs.rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  test('same ref returns empty diff', async () => {
    const data = await branchCompareData('base', 'base', {
      repoRoot: tmpDir,
      engine: 'wasm',
    });

    expect(data.error).toBeUndefined();
    expect(data.added).toHaveLength(0);
    expect(data.removed).toHaveLength(0);
    expect(data.changed).toHaveLength(0);
    expect(data.summary.added).toBe(0);
    expect(data.summary.removed).toBe(0);
    expect(data.summary.changed).toBe(0);
  }, 60000);
});

describe('branchCompareMermaid', () => {
  test('produces valid mermaid output', async () => {
    const data = await branchCompareData('base', 'target', {
      repoRoot: tmpDir,
      engine: 'wasm',
    });
    const mermaid = branchCompareMermaid(data);

    expect(mermaid).toContain('flowchart TB');
    expect(mermaid).toContain('Added');
    expect(mermaid).toContain('Removed');
  }, 60000);

  test('handles empty diff', () => {
    const mermaid = branchCompareMermaid({
      added: [],
      removed: [],
      changed: [],
      summary: { added: 0, removed: 0, changed: 0, totalImpacted: 0, filesAffected: 0 },
    });
    expect(mermaid).toContain('No structural differences');
  });

  test('handles error data', () => {
    const mermaid = branchCompareMermaid({ error: 'something went wrong' });
    expect(mermaid).toBe('something went wrong');
  });
});
