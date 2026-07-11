/**
 * Regression tests for scripts/ts-resolve-loader.js (issue #1832).
 *
 * Verifies that:
 * - the .js -> .ts fallback resolution still works when loaded via
 *   `--import` in a spawned child process (functional behavior preserved
 *   across the module.register() -> module.registerHooks() migration).
 * - Node's DEP0205 deprecation warning (module.register()) is no longer
 *   printed on Node versions that support module.registerHooks().
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { supportsRegisterHooks } from '../../scripts/node-version-support.js';

const LOADER_URL = new URL('../../scripts/ts-resolve-loader.js', import.meta.url).href;

describe('scripts/ts-resolve-loader.js', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ts-resolve-loader-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves a .js import specifier to the sibling .ts file', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'lib.ts'),
      'export function greet(): string { return "hello"; }\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'main.mjs'),
      "import { greet } from './lib.js';\nconsole.log(greet());\n",
    );

    const stdout = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--import', LOADER_URL, path.join(tmpDir, 'main.mjs')],
      { encoding: 'utf-8', timeout: 30_000 },
    );

    expect(stdout.trim()).toBe('hello');
  });

  it('falls through to the normal ERR_MODULE_NOT_FOUND when neither .js nor .ts exists', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.mjs'), "import './does-not-exist.js';\n");

    expect(() =>
      execFileSync(
        process.execPath,
        ['--experimental-strip-types', '--import', LOADER_URL, path.join(tmpDir, 'main.mjs')],
        { encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    ).toThrow(/ERR_MODULE_NOT_FOUND/);
  });

  it.runIf(supportsRegisterHooks)(
    'does not print the DEP0205 module.register() deprecation warning',
    () => {
      fs.writeFileSync(path.join(tmpDir, 'lib.ts'), 'export const x = 1;\n');
      fs.writeFileSync(path.join(tmpDir, 'main.mjs'), "import './lib.js';\n");

      const result = spawnSync(
        process.execPath,
        ['--experimental-strip-types', '--import', LOADER_URL, path.join(tmpDir, 'main.mjs')],
        { encoding: 'utf-8', timeout: 30_000 },
      );

      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/DEP0205/);
      expect(result.stderr).not.toMatch(/module\.register\(\) is deprecated/);
    },
  );
});
