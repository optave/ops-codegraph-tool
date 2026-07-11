/**
 * Node.js ESM loader hook for the JS → TS gradual migration.
 *
 * When a .js import specifier can't be found on disk, this loader tries the
 * corresponding .ts file.  This lets plain .js files import from already-
 * migrated .ts modules without changing their import specifiers.
 *
 * Usage:  node --import ./scripts/ts-resolve-loader.js ...
 *         (or via NODE_OPTIONS / vitest poolOptions.execArgv)
 *
 * Prefers module.registerHooks() (synchronous, in-thread, no worker-thread
 * overhead) where available, falling back to the deprecated (DEP0205)
 * module.register() on older Node versions that predate registerHooks()'s
 * availability floor.
 */

import { supportsRegister, supportsRegisterHooks } from './node-version-support.js';

const hooksURL = new URL('./ts-resolve-hooks.js', import.meta.url);

if (supportsRegisterHooks) {
  const { registerHooks } = await import('node:module');
  const { resolveSync, loadSync } = await import(hooksURL.href);
  registerHooks({ resolve: resolveSync, load: loadSync });
} else if (supportsRegister) {
  const { register } = await import('node:module');
  register(hooksURL.href, { parentURL: import.meta.url });
}
