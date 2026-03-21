#!/usr/bin/env node
/**
 * Test runner wrapper that configures Node.js for the TypeScript migration
 * before spawning vitest. Adds --experimental-strip-types on Node >= 22.6
 * so child processes can execute .ts files natively.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hook = pathToFileURL(resolve(__dirname, 'ts-resolver-hook.js')).href;

const args = process.argv.slice(2);
const vitestBin = resolve(__dirname, '..', 'node_modules', 'vitest', 'vitest.mjs');

const [major, minor] = process.versions.node.split('.').map(Number);
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6);

// Build NODE_OPTIONS: resolver hook + type stripping (Node >= 22.6)
const hookImport = `--import ${hook}`;
const existing = process.env.NODE_OPTIONS || '';
const parts = [
  existing.includes(hookImport) ? null : hookImport,
  supportsStripTypes && !existing.includes('--experimental-strip-types')
    ? '--experimental-strip-types'
    : null,
  existing || null,
].filter(Boolean);

// Spawn vitest via node directly — avoids shell: true and works cross-platform
const result = spawnSync(process.execPath, [vitestBin, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: parts.join(' '),
  },
});

if (result.error) {
  process.stderr.write(`[test runner] Failed to spawn vitest: ${result.error.message}\n`);
  process.exit(1);
}

process.exit(result.status ?? 1);
