/**
 * Regression guard for issue #1836: .claude/hooks/update-graph.sh's
 * fallback build path (used when the `codegraph` binary isn't on PATH)
 * invoked `node <project>/src/cli.js`, a file that has never existed —
 * the CLI entry point is TypeScript at src/cli.ts, compiled to dist/cli.js
 * (see package.json's `bin.codegraph`). That branch silently failed
 * (stderr redirected to /dev/null), so BUILD_OK stayed 0 and the graph
 * never rebuilt for contributors without a global codegraph install.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'update-graph.sh');

describe('update-graph.sh hook fallback build path', () => {
  const script = fs.readFileSync(HOOK_PATH, 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const cliEntry = packageJson.bin.codegraph.replace(/^\.\//, '');

  it('never references a nonexistent src/cli.js', () => {
    expect(script).not.toMatch(/\bsrc\/cli\.js\b/);
  });

  it("invokes package.json's bin.codegraph entry point in the fallback branch", () => {
    expect(script).toContain(`/${cliEntry}" build`);
  });
});
