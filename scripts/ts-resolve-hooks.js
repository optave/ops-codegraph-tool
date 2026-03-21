/**
 * ESM resolve/load hooks for .js → .ts fallback during gradual migration.
 *
 * - resolve: when a .js specifier resolves to a path that doesn't exist,
 *   check if a .ts version exists and redirect to it.
 * - load: for .ts files, strip type annotations using Node 22's built-in
 *   --experimental-strip-types via a source transform.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Only intercept ERR_MODULE_NOT_FOUND for .js specifiers
    if (err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      try {
        return await nextResolve(tsSpecifier, context);
      } catch {
        // .ts also not found — throw the original error
      }
    }
    throw err;
  }
}
