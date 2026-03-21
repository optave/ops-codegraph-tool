/**
 * Node.js module resolution hook for incremental TypeScript migration.
 *
 * Registered via --import. Uses the module.register() API (Node >= 20.6)
 * to install a resolve hook that falls back to .ts when .js is missing.
 */

// module.register() requires Node >= 20.6.0
const [_major, _minor] = process.versions.node.split('.').map(Number);
if (_major > 20 || (_major === 20 && _minor >= 6)) {
  const { register } = await import('node:module');
  register('./ts-resolver-loader.js', import.meta.url);
}
