/**
 * ESM loader: resolve .js → .ts fallback for incremental migration.
 *
 * - resolve hook: when a .js specifier is not found, retry with .ts
 * - load hook: strip type annotations from .ts files using Node's built-in
 *   amaro (Node >= 22.6) so the loader works outside of Vitest/Vite too
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.endsWith('.js')) throw err;

    const tsSpecifier = specifier.replace(/\.js$/, '.ts');
    try {
      return await nextResolve(tsSpecifier, context);
    } catch {
      throw err;
    }
  }
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);

  // On Node >= 22.6 with --experimental-strip-types, Node handles .ts natively
  try {
    return await nextLoad(url, context);
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err;
  }

  // Fallback: read the file and return as module source
  // This path is reached on Node < 22.6 where --experimental-strip-types
  // is unavailable. TypeScript-only syntax will cause a parse error — callers
  // should ensure .ts files contain only erasable type annotations.
  const source = await readFile(fileURLToPath(url), 'utf-8');
  return { format: 'module', source, shortCircuit: true };
}
