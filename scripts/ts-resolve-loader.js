/**
 * Node.js ESM loader hook for the JS → TS gradual migration.
 *
 * When a .js import specifier can't be found on disk, this loader tries the
 * corresponding .ts file.  This lets plain .js files import from already-
 * migrated .ts modules without changing their import specifiers.
 *
 * Usage:  node --import ./scripts/ts-resolve-loader.js ...
 *         (or via NODE_OPTIONS / vitest poolOptions.execArgv)
 */

// module.register() requires Node >= 20.6.0
const [_major, _minor] = process.versions.node.split('.').map(Number);
if (_major > 20 || (_major === 20 && _minor >= 6)) {
  const { register } = await import('node:module');
  const hooksURL = new URL('./ts-resolve-hooks.js', import.meta.url);
  register(hooksURL.href, { parentURL: import.meta.url });
}
