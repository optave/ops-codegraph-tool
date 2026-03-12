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
const _require = createRequire(import.meta.url);

/**
 * Detect whether the current Linux environment uses glibc or musl.
 * Returns 'gnu' for glibc, 'musl' for musl, 'gnu' as fallback.
 */
function detectLibc() {
  try {
    const { readdirSync } = _require('node:fs');
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
 * Resolve the platform-specific npm package name for the native addon.
 * Returns null if the current platform is not supported.
 */
function resolvePlatformPackage() {
  const platform = os.platform();
  const arch = os.arch();
  const key = platform === 'linux' ? `${platform}-${arch}-${detectLibc()}` : `${platform}-${arch}`;
  return PLATFORM_PACKAGES[key] || null;
}

/**
 * Try to load the native napi addon.
 * Returns the module on success, null on failure.
 */
export function loadNative() {
  if (_cached !== undefined) return _cached;

  const pkg = resolvePlatformPackage();
  if (pkg) {
    try {
      _cached = _require(pkg);
      return _cached;
    } catch (err) {
      _loadError = err;
    }
  } else {
    _loadError = new Error(`Unsupported platform: ${os.platform()}-${os.arch()}`);
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
 * Read the version from the platform-specific npm package.json.
 * Returns null if the package is not installed or has no version.
 */
export function getNativePackageVersion() {
  const pkg = resolvePlatformPackage();
  if (!pkg) return null;
  try {
    const pkgJson = _require(`${pkg}/package.json`);
    return pkgJson.version || null;
  } catch {
    return null;
  }
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
