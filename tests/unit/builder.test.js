/**
 * Unit tests for src/builder.js
 *
 * Tests collectFiles and loadPathAliases.
 * buildGraph integration is tested in tests/integration/build.test.js.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectFiles, loadPathAliases } from '../../src/builder.js';

let tmpDir;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-builder-'));

  // Create a file structure:
  //   src/
  //     app.js
  //     utils.ts
  //     index.tsx
  //     styles.css       (unsupported)
  //   lib/
  //     helper.py
  //   node_modules/
  //     pkg/index.js     (should be ignored)
  //   .git/
  //     config           (should be ignored)
  //   .hidden/
  //     secret.js        (hidden dir, ignored)
  //   vendor/
  //     third.js         (in IGNORE_DIRS)
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'vendor'), { recursive: true });

  fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), 'export default {}');
  fs.writeFileSync(path.join(tmpDir, 'src', 'utils.ts'), 'export const x = 1;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'index.tsx'), 'export default () => <div/>;');
  fs.writeFileSync(path.join(tmpDir, 'src', 'styles.css'), 'body {}');
  fs.writeFileSync(path.join(tmpDir, 'lib', 'helper.py'), 'def helper(): pass');
  fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}');
  fs.writeFileSync(path.join(tmpDir, '.git', 'config'), '[core]');
  fs.writeFileSync(path.join(tmpDir, '.hidden', 'secret.js'), 'export const s = 1;');
  fs.writeFileSync(path.join(tmpDir, 'vendor', 'third.js'), 'export const t = 1;');
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── collectFiles ──────────────────────────────────────────────────

describe('collectFiles', () => {
  it('collects files with supported extensions', () => {
    const files = collectFiles(tmpDir);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).toContain('app.js');
    expect(basenames).toContain('utils.ts');
    expect(basenames).toContain('index.tsx');
    expect(basenames).toContain('helper.py');
  });

  it('skips unsupported extensions', () => {
    const files = collectFiles(tmpDir);
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).not.toContain('styles.css');
    expect(basenames).not.toContain('config');
  });

  it('skips node_modules', () => {
    const files = collectFiles(tmpDir);
    const inNodeModules = files.filter((f) => f.includes('node_modules'));
    expect(inNodeModules).toHaveLength(0);
  });

  it('skips .git directory', () => {
    const files = collectFiles(tmpDir);
    const inGit = files.filter((f) => f.includes('.git'));
    expect(inGit).toHaveLength(0);
  });

  it('skips hidden directories', () => {
    const files = collectFiles(tmpDir);
    const inHidden = files.filter((f) => f.includes('.hidden'));
    expect(inHidden).toHaveLength(0);
  });

  it('skips vendor directory', () => {
    const files = collectFiles(tmpDir);
    const inVendor = files.filter((f) => f.includes('vendor'));
    expect(inVendor).toHaveLength(0);
  });

  it('respects config.ignoreDirs', () => {
    const files = collectFiles(tmpDir, [], { ignoreDirs: ['lib'] });
    const basenames = files.map((f) => path.basename(f));
    expect(basenames).not.toContain('helper.py');
    // src files still present
    expect(basenames).toContain('app.js');
  });

  it('returns empty array for non-existent directory (graceful)', () => {
    const files = collectFiles(path.join(tmpDir, 'does-not-exist'));
    expect(files).toEqual([]);
  });
});

// ─── loadPathAliases ──────────────────────────────────────────────

describe('loadPathAliases', () => {
  it('returns empty aliases when no tsconfig or jsconfig exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-noconfig-'));
    const aliases = loadPathAliases(dir);
    expect(aliases.baseUrl).toBeNull();
    expect(Object.keys(aliases.paths)).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads tsconfig.json paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tsconfig-'));
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: './src',
          paths: {
            '@/*': ['*'],
          },
        },
      }),
    );
    const aliases = loadPathAliases(dir);
    expect(aliases.baseUrl).toContain('src');
    expect(aliases.paths['@/*']).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to jsconfig.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-jsconfig-'));
    fs.writeFileSync(
      path.join(dir, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            'utils/*': ['src/utils/*'],
          },
        },
      }),
    );
    const aliases = loadPathAliases(dir);
    expect(aliases.baseUrl).toBeDefined();
    expect(aliases.paths['utils/*']).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('handles JSON with comments', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-jsonc-'));
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{
  // This is a comment
  "compilerOptions": {
    "baseUrl": "./src",
    /* block comment */
    "paths": {
      "@/*": ["*"],
    }
  }
}`,
    );
    const aliases = loadPathAliases(dir);
    expect(aliases.baseUrl).toContain('src');
    expect(aliases.paths['@/*']).toBeDefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prefers tsconfig.json over jsconfig.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-both-'));
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: './ts-src',
        },
      }),
    );
    fs.writeFileSync(
      path.join(dir, 'jsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: './js-src',
        },
      }),
    );
    const aliases = loadPathAliases(dir);
    expect(aliases.baseUrl).toContain('ts-src');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
