import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  printUpdateNotification,
  semverCompare,
} from '../../src/infrastructure/update-check.js';

let tmpDir: string;
let cachePath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-update-'));
  cachePath = path.join(tmpDir, '.codegraph', 'update-check.json');
  // Clear CI env so the early-return guard doesn't short-circuit every test
  vi.stubEnv('CI', '');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

// ─── semverCompare ──────────────────────────────────────────────────

describe('semverCompare', () => {
  it('returns 0 for equal versions', () => {
    expect(semverCompare('1.2.3', '1.2.3')).toBe(0);
  });

  it('returns -1 when a < b (patch)', () => {
    expect(semverCompare('1.2.3', '1.2.4')).toBe(-1);
  });

  it('returns 1 when a > b (patch)', () => {
    expect(semverCompare('1.2.4', '1.2.3')).toBe(1);
  });

  it('compares minor versions', () => {
    expect(semverCompare('1.2.0', '1.3.0')).toBe(-1);
    expect(semverCompare('1.3.0', '1.2.0')).toBe(1);
  });

  it('compares major versions', () => {
    expect(semverCompare('1.0.0', '2.0.0')).toBe(-1);
    expect(semverCompare('2.0.0', '1.0.0')).toBe(1);
  });

  it('major takes priority over minor and patch', () => {
    expect(semverCompare('1.9.9', '2.0.0')).toBe(-1);
  });

  it('strips pre-release suffixes before comparing', () => {
    // 3.9.3-dev.6 should be treated as 3.9.3, which is > 3.9.1
    expect(semverCompare('3.9.3-dev.6', '3.9.1')).toBe(1);
    expect(semverCompare('3.9.3-dev.6', '3.9.3')).toBe(0);
    expect(semverCompare('3.9.3-dev.6', '3.9.4')).toBe(-1);
    // Both sides with pre-release
    expect(semverCompare('2.0.0-beta.1', '1.9.9-alpha.3')).toBe(1);
  });
});

// ─── checkForUpdates ────────────────────────────────────────────────

describe('checkForUpdates', () => {
  it('returns null when CI env is set', async () => {
    vi.stubEnv('CI', 'true');
    const result = await checkForUpdates('1.0.0', { cachePath });
    expect(result).toBeNull();
  });

  it('returns null when NO_UPDATE_CHECK env is set', async () => {
    vi.stubEnv('NO_UPDATE_CHECK', '1');
    const result = await checkForUpdates('1.0.0', { cachePath });
    expect(result).toBeNull();
  });

  it('returns null when stderr is not a TTY', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = false;
    try {
      const result = await checkForUpdates('1.0.0', { cachePath });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns { current, latest } when update is available via fetch', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toEqual({ current: '1.0.0', latest: '2.0.0' });
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null when current version is up to date', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('2.0.0', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null when current version is newer than latest', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('3.0.0', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('uses fresh cache without fetching', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      // Write a fresh cache
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '5.0.0' }),
      );

      let fetchCalled = false;
      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => {
          fetchCalled = true;
          return '5.0.0';
        },
      });

      expect(fetchCalled).toBe(false);
      expect(result).toEqual({ current: '1.0.0', latest: '5.0.0' });
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('fetches when cache is stale', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      // Write a stale cache (25 hours old)
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      const staleTime = Date.now() - 25 * 60 * 60 * 1000;
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ lastCheckedAt: staleTime, latestVersion: '1.0.0' }),
      );

      let fetchCalled = false;
      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => {
          fetchCalled = true;
          return '2.0.0';
        },
      });

      expect(fetchCalled).toBe(true);
      expect(result).toEqual({ current: '1.0.0', latest: '2.0.0' });
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('saves cache after successful fetch', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });

      expect(fs.existsSync(cachePath)).toBe(true);
      const cache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      expect(cache.latestVersion).toBe('2.0.0');
      expect(typeof cache.lastCheckedAt).toBe('number');
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null when fetch fails (network error)', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => null,
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null when fetch throws', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => {
          throw new Error('boom');
        },
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('handles corrupt cache file gracefully', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(cachePath, 'not valid json {{{');

      const result = await checkForUpdates('1.0.0', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toEqual({ current: '1.0.0', latest: '2.0.0' });
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null for prerelease versions (e.g. beta)', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('2.0.0-beta.1', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null for dev versions (e.g. -dev)', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const result = await checkForUpdates('1.5.0-dev', {
        cachePath,
        _fetchLatest: async () => '2.0.0',
      });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });

  it('returns null from fresh cache when version is current', async () => {
    const origIsTTY = process.stderr.isTTY;
    process.stderr.isTTY = true;
    try {
      const dir = path.dirname(cachePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        cachePath,
        JSON.stringify({ lastCheckedAt: Date.now(), latestVersion: '1.0.0' }),
      );

      const result = await checkForUpdates('1.0.0', { cachePath });
      expect(result).toBeNull();
    } finally {
      process.stderr.isTTY = origIsTTY;
    }
  });
});

// ─── printUpdateNotification ────────────────────────────────────────

describe('printUpdateNotification', () => {
  it('writes a box to stderr', () => {
    const chunks = [];
    const origWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      chunks.push(chunk);
      return true;
    };
    try {
      printUpdateNotification('1.0.0', '2.0.0');
    } finally {
      process.stderr.write = origWrite;
    }

    const output = chunks.join('');
    expect(output).toContain('Update available: 1.0.0 → 2.0.0');
    expect(output).toContain('npm i -g @optave/codegraph');
    expect(output).toContain('┌');
    expect(output).toContain('└');
  });
});
