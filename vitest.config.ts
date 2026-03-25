import { defineConfig } from 'vitest/config';

const [major, minor] = process.versions.node.split('.').map(Number);
const existing = process.env.NODE_OPTIONS || '';
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6);
const stripFlag = major >= 23 ? '--strip-types' : '--experimental-strip-types';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: ['**/node_modules/**', '**/.git/**', '**/.claude/**'],
    // Ensure child processes spawned by tests (e.g. CLI integration tests)
    // can load .ts files via Node's built-in type stripping.
    env: {
      NODE_OPTIONS: [
        existing,
        supportsStripTypes && !existing.includes('--experimental-strip-types') && !existing.includes('--strip-types')
          ? stripFlag
          : '',
      ].filter(Boolean).join(' '),
    },
  },
});
