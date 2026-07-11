/**
 * Node.js version-gated feature support, shared between ts-resolve-loader.js
 * and its regression test so the availability floors can't drift out of
 * sync (Greptile review, #1832).
 */

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);

// module.registerHooks() requires Node >= 22.15.0 or >= 23.5.0.
export const supportsRegisterHooks =
  nodeMajor > 23 || (nodeMajor === 23 && nodeMinor >= 5) || (nodeMajor === 22 && nodeMinor >= 15);

// module.register() requires Node >= 20.6.0.
export const supportsRegister = nodeMajor > 20 || (nodeMajor === 20 && nodeMinor >= 6);
