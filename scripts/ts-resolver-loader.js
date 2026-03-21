/**
 * ESM loader: resolve .js → .ts fallback for incremental migration.
 *
 * - resolve hook: when a .js specifier is not found, retry with .ts
 * - load hook: delegates to Node's built-in type stripping (Node >= 22.6).
 *   On older Node versions, throws a clear error instead of returning
 *   unparseable TypeScript source.
 */

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

  // Node < 22.6 cannot strip TypeScript syntax. Throw a clear error instead
  // of returning raw TS source that would produce a confusing SyntaxError.
  const filePath = fileURLToPath(url);
  throw Object.assign(
    new Error(
      `Cannot load TypeScript file ${filePath} on Node ${process.versions.node}. ` +
      `TypeScript type stripping requires Node >= 22.6 with --experimental-strip-types.`,
    ),
    { code: 'ERR_TS_UNSUPPORTED' },
  );
}
