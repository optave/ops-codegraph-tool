/**
 * Native addon loader with graceful fallback to WASM.
 *
 * Tries to load the platform-specific napi-rs binary built from
 * crates/codegraph-core.  If unavailable the caller should fall back
 * to the existing WASM pipeline.
 */

import { createRequire } from 'node:module';
import os from 'node:os';

let _cached = undefined;   // undefined = not yet tried, null = failed, object = module
let _loadError = null;

/** Map of (platform-arch) → npm package name. */
const PLATFORM_PACKAGES = {
  'linux-x64': '@optave/codegraph-linux-x64-gnu',
  'darwin-arm64': '@optave/codegraph-darwin-arm64',
  'darwin-x64': '@optave/codegraph-darwin-x64',
  'win32-x64': '@optave/codegraph-win32-x64-msvc',
};

/**
 * Try to load the native napi addon.
 * Returns the module on success, null on failure.
 */
export function loadNative() {
  if (_cached !== undefined) return _cached;

  const require = createRequire(import.meta.url);

  // Try the umbrella package first (if published as @optave/codegraph-core)
  try {
    _cached = require('@optave/codegraph-core');
    return _cached;
  } catch { /* try platform package */ }

  // Try the platform-specific package
  const key = `${os.platform()}-${os.arch()}`;
  const pkg = PLATFORM_PACKAGES[key];
  if (pkg) {
    try {
      _cached = require(pkg);
      return _cached;
    } catch (err) {
      _loadError = err;
    }
  } else {
    _loadError = new Error(`Unsupported platform: ${key}`);
  }

  _cached = null;
  return null;
}

/**
 * Check whether the native engine is available on this platform.
 */
export function isNativeAvailable() {
  return loadNative() !== null;
}

/**
 * Return the native module or throw if not available.
 */
export function getNative() {
  const mod = loadNative();
  if (!mod) {
    throw new Error(
      `Native codegraph-core not available: ${_loadError?.message || 'unknown error'}. ` +
      'Install the platform package or use --engine wasm.'
    );
  }
  return mod;
}
