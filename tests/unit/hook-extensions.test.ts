/**
 * Drift guard for .claude/hooks/update-graph.sh's extension allowlist.
 *
 * That PostToolUse hook fires on every Edit/Write and needs a fast
 * (no extra Node-startup) way to decide whether an edited file's extension
 * is one codegraph tracks. It prefers dist/hook-extensions.txt — generated
 * from EXTENSIONS by scripts/gen-hook-extensions.mjs as part of
 * `npm run build` — and falls back to a hardcoded `case "$EXT" in` list for
 * before the first build.
 *
 * That fallback list is a hand-maintained second copy of EXTENSIONS, so it
 * can silently drift out of sync (this is exactly what happened in issue
 * #1736: `.mjs`/`.cjs` were missing, so editing those files never
 * triggered a rebuild). This test fails the moment EXTENSIONS and the
 * hook's fallback list disagree, in either direction.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXTENSIONS } from '../../src/shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HOOK_PATH = path.join(REPO_ROOT, '.claude', 'hooks', 'update-graph.sh');
const DIST_CONSTANTS_PATH = path.join(REPO_ROOT, 'dist', 'shared', 'constants.js');

/** Extracts the `.ext|.ext|...` pattern from the hook's `case "$EXT" in` fallback arm. */
function parseFallbackAllowlist(script: string): string[] {
  const match = script.match(/case "\$EXT" in\s*\n\s*([.\w|]+)\)/);
  if (!match) {
    throw new Error(
      'Could not find `case "$EXT" in <list>)` fallback allowlist in update-graph.sh',
    );
  }
  return match[1].split('|');
}

describe('update-graph.sh hook extension allowlist', () => {
  const script = fs.readFileSync(HOOK_PATH, 'utf8');

  it('fallback allowlist matches EXTENSIONS exactly (no drift)', () => {
    const fallback = new Set(parseFallbackAllowlist(script));

    const missingFromHook = [...EXTENSIONS].filter((ext) => !fallback.has(ext)).sort();
    const staleInHook = [...fallback].filter((ext) => !EXTENSIONS.has(ext)).sort();

    expect(
      missingFromHook,
      `EXTENSIONS has extensions the update-graph.sh fallback allowlist doesn't know ` +
        `about: ${missingFromHook.join(', ')}. Sync the \`case "$EXT" in\` list in ` +
        '.claude/hooks/update-graph.sh with EXTENSIONS (src/shared/constants.ts).',
    ).toEqual([]);
    expect(
      staleInHook,
      `update-graph.sh fallback allowlist has extensions no longer in EXTENSIONS: ` +
        `${staleInHook.join(', ')}. Remove them from the \`case "$EXT" in\` list in ` +
        '.claude/hooks/update-graph.sh.',
    ).toEqual([]);
  });

  it('reads the generated dist/hook-extensions.txt snapshot as its primary source', () => {
    expect(script).toContain('dist/hook-extensions.txt');
    expect(script).toContain('scripts/gen-hook-extensions.mjs');
  });

  // Only meaningful once `npm run build` has produced dist/shared/constants.js.
  // Skipped (not failed) otherwise so this test doesn't require a build step
  // that isn't a normal prerequisite of `npm test` itself.
  it.skipIf(!fs.existsSync(DIST_CONSTANTS_PATH))(
    'scripts/gen-hook-extensions.mjs generates a snapshot covering every EXTENSIONS entry',
    () => {
      const generatedPath = path.join(REPO_ROOT, 'dist', 'hook-extensions.txt');
      execFileSync('node', [path.join(REPO_ROOT, 'scripts', 'gen-hook-extensions.mjs')], {
        cwd: REPO_ROOT,
      });

      expect(fs.existsSync(generatedPath)).toBe(true);
      const generated = new Set(fs.readFileSync(generatedPath, 'utf8').split('\n').filter(Boolean));

      expect([...EXTENSIONS].filter((ext) => !generated.has(ext))).toEqual([]);
      expect([...generated].filter((ext) => !EXTENSIONS.has(ext))).toEqual([]);
    },
  );
});
