import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = pathToFileURL(resolve(__dirname, 'scripts/ts-resolve-loader.js')).href;
const [major, minor] = process.versions.node.split('.').map(Number);
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6);
const supportsHooks = major > 20 || (major === 20 && minor >= 6);
const existing = process.env.NODE_OPTIONS || '';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    exclude: ['**/node_modules/**', '**/.git/**', '.claude/**'],
    // Register the .ts resolve loader for Node's native ESM resolver.
    // This covers child processes spawned by tests (e.g. CLI integration tests).
    env: {
      NODE_OPTIONS: [
        existing,
        supportsStripTypes &&
        !existing.includes('--experimental-strip-types') &&
        !existing.includes('--strip-types')
          ? (major >= 23 ? '--strip-types' : '--experimental-strip-types')
          : '',
        existing.includes(loaderPath) ? '' : (supportsHooks ? `--import ${loaderPath}` : ''),
      ].filter(Boolean).join(' '),
    },
  },
});
