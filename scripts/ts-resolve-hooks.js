/**
 * ESM resolve/load hooks for .js → .ts fallback during gradual migration.
 *
 * - resolve: when a .js specifier resolves to a path that doesn't exist,
 *   check if a .ts version exists and redirect to it.
 * - load: for .ts files, delegate to Node's native loader (works on
 *   Node >= 22.6 with --experimental-strip-types). On older Node versions,
 *   throws a clear error instead of returning unparseable TypeScript source.
 *
 * Each hook is exported twice with identical fallback logic:
 * - `resolve`/`load` implement the asynchronous module customization API
 *   consumed by the deprecated module.register().
 * - `resolveSync`/`loadSync` implement the synchronous API consumed by
 *   module.registerHooks(), whose nextResolve/nextLoad return values (and
 *   thrown errors) directly rather than via Promises.
 */

import { fileURLToPath } from 'node:url';

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

export function resolveSync(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (err) {
    // Only intercept ERR_MODULE_NOT_FOUND for .js specifiers
    if (err.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      const tsSpecifier = specifier.replace(/\.js$/, '.ts');
      try {
        return nextResolve(tsSpecifier, context);
      } catch {
        // .ts also not found — throw the original error
      }
    }
    throw err;
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

  throw unsupportedTsError(url);
}

export function loadSync(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);

  // On Node >= 22.6 with --experimental-strip-types, Node handles .ts natively
  try {
    return nextLoad(url, context);
  } catch (err) {
    if (err.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw err;
  }

  throw unsupportedTsError(url);
}

// Node < 22.6 cannot strip TypeScript syntax. Throw a clear error instead
// of returning raw TS source that would produce a confusing SyntaxError.
function unsupportedTsError(url) {
  const filePath = fileURLToPath(url);
  return Object.assign(
    new Error(
      `Cannot load TypeScript file ${filePath} on Node ${process.versions.node}. ` +
      `TypeScript type stripping requires Node >= 22.6 with --experimental-strip-types.`,
    ),
    { code: 'ERR_TS_UNSUPPORTED' },
  );
}
