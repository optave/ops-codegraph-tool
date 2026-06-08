/**
 * Native addon loader with graceful fallback to WASM.
 *
 * Tries to load the platform-specific napi-rs binary built from
 * crates/codegraph-core.  If unavailable the caller should fall back
 * to the existing WASM pipeline.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { EngineError, toErrorMessage } from '../shared/errors.js';
import type { NativeAddon } from '../types.js';
import { debug, warn } from './logger.js';

let _cached: NativeAddon | null | undefined; // undefined = not yet tried, null = failed, NativeAddon = module
let _loadError: Error | null = null;
const _require = createRequire(import.meta.url);

/**
 * Detect whether the current Linux environment uses glibc or musl.
 * Returns 'gnu' for glibc, 'musl' for musl, 'gnu' as fallback.
 */
function detectLibc(): 'gnu' | 'musl' {
  try {
    const { readdirSync } = _require('node:fs') as typeof import('node:fs');
    const files = readdirSync('/lib');
    if (files.some((f: string) => f.startsWith('ld-musl-') && f.endsWith('.so.1'))) {
      return 'musl';
    }
  } catch (e) {
    debug(`detectLibc: failed to read /lib: ${toErrorMessage(e)}`);
  }
  return 'gnu';
}

/** Map of (platform-arch[-libc]) → npm package name. */
const PLATFORM_PACKAGES: Record<string, string> = {
  'linux-x64-gnu': '@optave/codegraph-linux-x64-gnu',
  'linux-x64-musl': '@optave/codegraph-linux-x64-musl',
  'linux-arm64-gnu': '@optave/codegraph-linux-arm64-gnu',
  'linux-arm64-musl': '@optave/codegraph-linux-arm64-musl', // not yet published — placeholder for future CI target
  'darwin-arm64': '@optave/codegraph-darwin-arm64',
  'darwin-x64': '@optave/codegraph-darwin-x64',
  'win32-x64': '@optave/codegraph-win32-x64-msvc',
};

/**
 * Map of (platform-arch[-libc]) → locally compiled binary filename.
 * Checked before the npm package so that locally compiled Rust changes
 * are picked up immediately in development without publishing a new release.
 */
const PLATFORM_LOCAL_BINARIES: Record<string, string> = {
  'linux-x64-gnu': 'codegraph-core.linux-x64-gnu.node',
  'linux-x64-musl': 'codegraph-core.linux-x64-musl.node',
  'linux-arm64-gnu': 'codegraph-core.linux-arm64-gnu.node',
  'linux-arm64-musl': 'codegraph-core.linux-arm64-musl.node',
  'darwin-arm64': 'codegraph-core.darwin-arm64.node',
  'darwin-x64': 'codegraph-core.darwin-x64.node',
  'win32-x64': 'codegraph-core.win32-x64-msvc.node',
};

/** Compute the platform key used to index PLATFORM_PACKAGES / PLATFORM_LOCAL_BINARIES. */
function resolvePlatformKey(): string {
  const platform = os.platform();
  const arch = os.arch();
  return platform === 'linux' ? `${platform}-${arch}-${detectLibc()}` : `${platform}-${arch}`;
}

/**
 * Resolve the platform-specific npm package name for the native addon.
 * Returns null if the current platform is not supported.
 */
function resolvePlatformPackage(): string | null {
  return PLATFORM_PACKAGES[resolvePlatformKey()] ?? null;
}

/**
 * Try to load the native napi addon.
 * Returns the module on success, null on failure.
 *
 * Load order:
 *   1. NAPI_RS_NATIVE_LIBRARY_PATH env var (explicit override)
 *   2. locally compiled binary in crates/codegraph-core/ (dev mode — preferred
 *      over the npm package so that Rust changes are picked up immediately
 *      without publishing a new release)
 *   3. npm platform package (production path)
 */
export function loadNative(): NativeAddon | null {
  if (_cached !== undefined) return _cached;

  const platformKey = resolvePlatformKey();

  // 1. Explicit path override — highest priority. Failure is fatal: if the
  //    operator set this variable, silently loading a different binary would
  //    be harder to diagnose than an explicit error.
  const envPath = process.env.NAPI_RS_NATIVE_LIBRARY_PATH;
  if (envPath) {
    try {
      _cached = _require(envPath) as NativeAddon;
      debug(`loadNative: loaded from NAPI_RS_NATIVE_LIBRARY_PATH: ${envPath}`);
      return _cached;
    } catch (err) {
      _loadError = err as Error;
      warn(
        `loadNative: NAPI_RS_NATIVE_LIBRARY_PATH is set but failed to load "${envPath}": ${toErrorMessage(err as Error)}`,
      );
      _cached = null;
      return null;
    }
  }

  // 2. Locally compiled dev binary — preferred over npm package so that Rust
  //    changes are visible without publishing. Only used when the file exists.
  const localFile = PLATFORM_LOCAL_BINARIES[platformKey];
  if (localFile) {
    try {
      const localPath = fileURLToPath(
        new URL(`../../crates/codegraph-core/${localFile}`, import.meta.url),
      );
      _cached = _require(localPath) as NativeAddon;
      debug(`loadNative: loaded local dev binary: ${localPath}`);
      return _cached;
    } catch (err) {
      debug(`loadNative: local dev binary not available: ${toErrorMessage(err as Error)}`);
    }
  }

  // 3. Published npm platform package — production path.
  const pkg = PLATFORM_PACKAGES[platformKey] ?? null;
  if (pkg) {
    try {
      _cached = _require(pkg) as NativeAddon;
      return _cached;
    } catch (err) {
      _loadError = err as Error;
      debug(`loadNative: npm package ${pkg} not available: ${toErrorMessage(err as Error)}`);
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
export function isNativeAvailable(): boolean {
  return loadNative() !== null;
}

/**
 * Read the version from the platform-specific npm package.json.
 * Returns null if the package is not installed or has no version.
 */
export function getNativePackageVersion(): string | null {
  const pkg = resolvePlatformPackage();
  if (!pkg) return null;
  try {
    const pkgJson = _require(`${pkg}/package.json`) as { version?: string };
    return pkgJson.version || null;
  } catch (e) {
    debug(`getNativePackageVersion: failed to read package.json for ${pkg}: ${toErrorMessage(e)}`);
    return null;
  }
}

/**
 * Return the native module or throw if not available.
 */
export function getNative(): NativeAddon {
  const mod = loadNative();
  if (!mod) {
    throw new EngineError(
      `Native codegraph-core not available: ${_loadError?.message || 'unknown error'}. ` +
        'Install the platform package or use --engine wasm.',
      { cause: _loadError ?? undefined },
    );
  }
  return mod;
}
