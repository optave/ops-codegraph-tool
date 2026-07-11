/**
 * Unit tests for scripts/lib/cli-invocation.ts
 *
 * Regression coverage for #1907: scripts/token-benchmark.ts spawned the
 * codegraph CLI via `path.join(root, 'src', 'cli.js')` — a file that never
 * existed (src/ has no compiled .js output; only src/cli.ts) — and, even
 * after fixing the extension, a spawned child `node` process doesn't
 * inherit the --experimental-strip-types / --import <loader> flags the
 * parent script itself needs to run TypeScript source. resolveCliNodeArgs()
 * centralizes the correct invocation so it can be exercised directly.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveCliNodeArgs } from '../../scripts/lib/cli-invocation.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('resolveCliNodeArgs', () => {
  it('resolves the strip-types flag, the loader, and an existing cli.ts entry point', () => {
    const args = resolveCliNodeArgs(repoRoot);

    expect(args[0]).toBe('--experimental-strip-types');
    expect(args[1]).toBe('--import');
    expect(args[2]).toMatch(/^file:.*ts-resolve-loader\.ts$/);
    expect(args[3]).toBe(path.join(repoRoot, 'src', 'cli.ts'));

    // Both the loader and the CLI entry point must exist on disk — this is
    // exactly the class of bug #1907 fixed (paths pointing at files that
    // were never there).
    expect(fs.existsSync(new URL(args[2]))).toBe(true);
    expect(fs.existsSync(args[3])).toBe(true);
  });

  it('spawns the real CLI successfully via the resolved argv (mirrors tests/integration/cli.test.ts)', () => {
    const args = resolveCliNodeArgs(repoRoot);
    const out = execFileSync('node', [...args, '--version'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
