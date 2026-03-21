import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loaderPath = pathToFileURL(resolve(__dirname, 'scripts/ts-resolve-loader.js')).href;

/**
 * During the JS → TS migration, some .js files import from modules that have
 * already been renamed to .ts.  Vite only auto-resolves .js→.ts when the
 * *importer* is itself a .ts file.  This plugin fills the gap: when a .js
 * import target doesn't exist on disk, it tries the .ts counterpart.
 */
function jsToTsResolver() {
  return {
    name: 'js-to-ts-resolver',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.endsWith('.js')) return null;
      // Only handle relative/absolute paths, not bare specifiers
      if (!source.startsWith('.') && !source.startsWith('/')) return null;
      const importerPath = importer.startsWith('file://')
        ? fileURLToPath(importer)
        : importer;
      const fsPath = resolve(dirname(importerPath), source);
      if (!existsSync(fsPath)) {
        const tsPath = fsPath.replace(/\.js$/, '.ts');
        if (existsSync(tsPath)) return tsPath;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [jsToTsResolver()],
  test: {
    globals: true,
    testTimeout: 30000,
    exclude: ['**/node_modules/**', '**/.git/**', '.claude/**'],
    // Register the .js→.ts resolve loader for Node's native ESM resolver.
    // This covers require() calls and child processes spawned by tests.
    env: {
      NODE_OPTIONS: `--experimental-strip-types --import ${loaderPath}`,
    },
  },
});
