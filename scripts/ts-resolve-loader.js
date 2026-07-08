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

const [_major, _minor] = process.versions.node.split('.').map(Number);
const hooksURL = new URL('./ts-resolve-hooks.js', import.meta.url);

// module.registerHooks() requires Node >= 22.15.0 or >= 23.5.0.
const supportsRegisterHooks =
  _major > 23 || (_major === 23 && _minor >= 5) || (_major === 22 && _minor >= 15);
// module.register() requires Node >= 20.6.0.
const supportsRegister = _major > 20 || (_major === 20 && _minor >= 6);

if (supportsRegisterHooks) {
  const { registerHooks } = await import('node:module');
  const { resolveSync, loadSync } = await import(hooksURL.href);
  registerHooks({ resolve: resolveSync, load: loadSync });
} else if (supportsRegister) {
  const { register } = await import('node:module');
  register(hooksURL.href, { parentURL: import.meta.url });
}
