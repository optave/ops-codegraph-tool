/**
 * Unit tests for loadNative() load-order and env-var override.
 *
 * Each test uses vi.resetModules() + vi.doMock() + dynamic import()
 * so every test gets a fresh native module with isolated singleton state
 * (_cached / _loadError reset on each fresh import).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Minimal stand-in for a successfully loaded NativeAddon.
const FAKE_ADDON = Object.freeze({ extractSymbols: () => [] });

/**
 * Build a mock require function that simulates present/absent binaries.
 * Distinguishes local binary calls (absolute filesystem path) from
 * npm package calls (package name starting with '@optave/').
 */
function makeMockRequire({
  localBinaryOk,
  npmPackageOk,
}: {
  localBinaryOk: boolean;
  npmPackageOk: boolean;
}) {
  return vi.fn((path: string) => {
    // Pass-through for Node built-ins (e.g. node:fs used by detectLibc on Linux)
    if (path.startsWith('node:')) return require(path);
    const isAbsolute = path.startsWith('/') || /^[A-Z]:\\/.test(path);
    if (isAbsolute) {
      if (localBinaryOk) return FAKE_ADDON;
      throw new Error(`ENOENT: no such file: ${path}`);
    }
    if (path.startsWith('@optave/')) {
      if (npmPackageOk) return FAKE_ADDON;
      throw new Error(`Cannot find module '${path}'`);
    }
    throw new Error(`Unexpected require call: ${path}`);
  });
}

function mockDeps(
  requireFn: ReturnType<typeof vi.fn>,
  platform = 'darwin',
  arch = 'arm64',
  localBinaryExists = true,
) {
  vi.doMock('node:module', () => ({ createRequire: () => requireFn }));
  vi.doMock('node:os', () => ({ default: { platform: () => platform, arch: () => arch } }));
  vi.doMock('node:fs', () => ({
    existsSync: (p: string) => {
      // existsSync is used for the local dev binary path (absolute filesystem path)
      const isAbsolute = p.startsWith('/') || /^[A-Z]:\\/.test(p);
      if (isAbsolute) return localBinaryExists;
      return false;
    },
  }));
}

describe('loadNative', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('NAPI_RS_NATIVE_LIBRARY_PATH set and valid: returns module and caches it', async () => {
    vi.stubEnv('NAPI_RS_NATIVE_LIBRARY_PATH', '/explicit/addon.node');
    const requireFn = vi.fn((p: string) => {
      if (p === '/explicit/addon.node') return FAKE_ADDON;
      throw new Error(`Unexpected: ${p}`);
    });
    mockDeps(requireFn);

    const { loadNative } = await import('../../src/infrastructure/native.js');

    const r1 = loadNative();
    const r2 = loadNative();

    expect(r1).toBe(FAKE_ADDON);
    expect(r2).toBe(FAKE_ADDON);
    // require was called only once — second call hit the singleton cache
    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledWith('/explicit/addon.node');
  });

  it('NAPI_RS_NATIVE_LIBRARY_PATH set but bad path: warns, returns null, does not fall through', async () => {
    vi.stubEnv('NAPI_RS_NATIVE_LIBRARY_PATH', '/bad/path.node');
    const requireFn = vi.fn((_p: string) => {
      throw new Error('ENOENT: no such file');
    });
    mockDeps(requireFn);

    const { loadNative } = await import('../../src/infrastructure/native.js');

    const result = loadNative();

    expect(result).toBeNull();
    // Only the env-path require was attempted — no fall-through to local or npm
    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledWith('/bad/path.node');
    // A warning mentioning the env var name was emitted to stderr
    const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stderr).toContain('NAPI_RS_NATIVE_LIBRARY_PATH');
    // Null result is cached — second call must not invoke require again
    expect(loadNative()).toBeNull();
    expect(requireFn).toHaveBeenCalledTimes(1);
  });

  it('no env var, local binary present: loads local binary, skips npm package', async () => {
    const requireFn = makeMockRequire({ localBinaryOk: true, npmPackageOk: true });
    // existsSync returns true for local binary path → require is called for local binary
    mockDeps(requireFn, 'darwin', 'arm64', true);

    const { loadNative } = await import('../../src/infrastructure/native.js');

    const result = loadNative();

    expect(result).toBe(FAKE_ADDON);
    // npm package require was never attempted
    expect(requireFn).not.toHaveBeenCalledWith(expect.stringContaining('@optave/'));
    // Result is cached — second call must not invoke require again
    const callsBefore = requireFn.mock.calls.length;
    expect(loadNative()).toBe(FAKE_ADDON);
    expect(requireFn).toHaveBeenCalledTimes(callsBefore);
  });

  it('no env var, no local binary, npm package present: loads npm package', async () => {
    const requireFn = makeMockRequire({ localBinaryOk: false, npmPackageOk: true });
    // existsSync returns false → local binary require is skipped, falls through to npm package
    mockDeps(requireFn, 'darwin', 'arm64', false);

    const { loadNative } = await import('../../src/infrastructure/native.js');

    const result = loadNative();

    expect(result).toBe(FAKE_ADDON);
    // local binary was skipped (existsSync returned false), only npm package require was called
    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(requireFn).toHaveBeenCalledWith('@optave/codegraph-darwin-arm64');
  });

  it('no env var, unsupported platform: returns null and getNative() throws EngineError', async () => {
    // freebsd-x64 is absent from both PLATFORM_LOCAL_BINARIES and
    // PLATFORM_PACKAGES, so no require calls should be made at all.
    const requireFn = vi.fn(() => FAKE_ADDON);
    mockDeps(requireFn, 'freebsd', 'x64');

    const { loadNative, getNative } = await import('../../src/infrastructure/native.js');

    expect(loadNative()).toBeNull();
    expect(requireFn).not.toHaveBeenCalled();
    expect(() => getNative()).toThrow(/Native codegraph-core not available/);
  });
});
