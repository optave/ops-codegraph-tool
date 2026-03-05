/**
 * Native addon loader with graceful fallback to WASM.
 *
 * Tries to load the platform-specific napi-rs binary built from
 * crates/codegraph-core.  If unavailable the caller should fall back
 * to the existing WASM pipeline.
 */

import { createRequire } from 'node:module';
import os from 'node:os';

let _cached; // undefined = not yet tried, null = failed, object = module
let _loadError = null;

/**
 * Detect whether the current Linux environment uses glibc or musl.
 * Returns 'gnu' for glibc, 'musl' for musl, 'gnu' as fallback.
 */
function detectLibc() {
  try {
    const { readdirSync } = require('node:fs');
    const files = readdirSync('/lib');
    if (files.some((f) => f.startsWith('ld-musl-') && f.endsWith('.so.1'))) {
      return 'musl';
    }
  } catch {}
  return 'gnu';
}

/** Map of (platform-arch[-libc]) → npm package name. */
const PLATFORM_PACKAGES = {
  'linux-x64-gnu': '@optave/codegraph-linux-x64-gnu',
  'linux-x64-musl': '@optave/codegraph-linux-x64-musl',
  'linux-arm64-gnu': '@optave/codegraph-linux-arm64-gnu',
  'linux-arm64-musl': '@optave/codegraph-linux-arm64-musl', // not yet published — placeholder for future CI target
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

  const platform = os.platform();
  const arch = os.arch();
  const key = platform === 'linux' ? `${platform}-${arch}-${detectLibc()}` : `${platform}-${arch}`;
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
        'Install the platform package or use --engine wasm.',
    );
  }
  return mod;
}
