/**
 * ESM resolve hook — rewrites .js specifiers to .ts when the .js file
 * does not exist on disk. Needed because TypeScript's moduleResolution
 * "nodenext" convention uses .js extensions in imports, but at runtime
 * the source files are .ts.
 *
 * Loaded via module.register() from ts-resolve-loader.ts.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(
  specifier: string,
  context: { parentURL?: string; conditions: string[] },
  nextResolve: (specifier: string, context?: { parentURL?: string; conditions: string[] }) => Promise<{ url: string; shortCircuit?: boolean }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
  try {
    return await nextResolve(specifier, context);
  } catch (err: any) {
    // Only attempt .js → .ts fallback for file-relative specifiers
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && specifier.endsWith('.js')) {
      const tsSpecifier = specifier.slice(0, -3) + '.ts';
      return nextResolve(tsSpecifier, context);
    }
    throw err;
  }
}
